// terminal-manager: owns the live xterm.js instances and their PTY connections.
//
// Key design (same trick maiTerm/termul use):
//   We DO NOT destroy an xterm instance when the user switches tabs.
//   Each tab keeps a cached Terminal + pty pair; switching tabs just
//   re-parents the cached DOM node into the visible container.
//   That preserves scrollback and avoids re-spawning shells.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { spawn, type IPty } from "tauri-pty";
import { invoke } from "@tauri-apps/api/core";
import {
  saveScrollback,
  loadScrollback,
  clearScrollback,
} from "./scrollback";
import {
  getTheme,
  getFont,
  toXtermTheme,
  type ThemePalette,
} from "./themes";
import { useSettingsStore } from "../stores/settings-store";

interface Session {
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  pty: IPty;
  /** the detached DOM element that hosts this terminal */
  el: HTMLDivElement;
  disposed: boolean;
  /** the shell process has exited (user typed `exit` or it died) */
  exited: boolean;
}

/**
 * Per-pane callbacks fired when the shell process exits, so the UI can close
 * the dead pane. Registered by PaneTerminal; keyed by pane/tab id.
 */
const exitListeners = new Map<string, (tabId: string) => void>();

/** Register a callback invoked when the given pane's shell process exits. */
export function onSessionExit(tabId: string, cb: (tabId: string) => void) {
  exitListeners.set(tabId, cb);
}

/** Remove a previously registered exit callback. */
export function offSessionExit(tabId: string) {
  exitListeners.delete(tabId);
}

/** Persist a session's current buffer to storage (best effort). */
function persist(id: string, s: Session) {
  if (s.disposed) return;
  try {
    saveScrollback(id, s.serialize.serialize());
  } catch {
    /* serialize can throw on an empty/closed buffer */
  }
}

const sessions = new Map<string, Session>();

/** Push a theme palette onto the app-chrome CSS variables. */
function applyChromeVars(p: ThemePalette) {
  if (typeof document === "undefined") return;
  const r = document.documentElement.style;
  r.setProperty("--bg-dark", p.bgDark);
  r.setProperty("--bg-medium", p.bgMedium);
  r.setProperty("--bg-light", p.bgLight);
  r.setProperty("--fg", p.fg);
  r.setProperty("--fg-dim", p.fgDim);
  r.setProperty("--accent", p.accent);
}

/** Read the current appearance from the settings store. */
function currentAppearance() {
  const { themeId, fontId, fontSize } = useSettingsStore.getState();
  return {
    theme: getTheme(themeId),
    font: getFont(fontId),
    fontSize,
  };
}

function pickShell(): { cmd: string; args: string[] } {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) {
    return { cmd: cachedShell ?? "powershell.exe", args: [] };
  }
  // macOS / Linux: spawn the user's *actual* login shell (resolved from $SHELL
  // by the Rust backend), not a hardcoded /bin/bash. Hardcoding bash breaks
  // accounts whose default shell is zsh — their zsh-only rc files get sourced
  // under bash and throw a wall of syntax errors. `-l` makes it a login shell
  // so the usual profile is loaded.
  const shell = cachedShell ?? "/bin/zsh";
  return { cmd: shell, args: ["-l"] };
}

/** Cached login shell path, resolved once from the Rust backend at startup. */
let cachedShell: string | null = null;

/**
 * Resolve the user's real login shell from the backend and cache it.
 * Call this once at app startup, before any pane spawns. Safe to call again;
 * failures fall back to the platform default inside pickShell().
 */
export async function initShell(): Promise<void> {
  if (cachedShell) return;
  try {
    const sh = await invoke<string>("default_shell");
    if (sh && sh.trim()) cachedShell = sh.trim();
  } catch {
    // leave cachedShell null; pickShell() uses a sane platform default
  }
}

/**
 * Get (or lazily create) the session for a tab.
 * The PTY/shell is only spawned the first time a tab becomes visible.
 */
export function getOrCreateSession(tabId: string, cwd: string): Session {
  let s = sessions.get(tabId);
  if (s && !s.disposed) return s;

  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = "100%";

  const { theme, font, fontSize } = currentAppearance();
  applyChromeVars(theme.palette);

  const term = new Terminal({
    fontFamily: font.stack,
    fontSize,
    cursorBlink: true,
    allowProposedApi: true,
    theme: toXtermTheme(theme.palette),
    scrollback: 10000,
  });
  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(serialize);
  term.loadAddon(search);
  term.open(el);

  // replay any persisted scrollback from a previous launch before wiring the
  // live shell, so old output appears above the fresh prompt.
  const restored = loadScrollback(tabId);
  if (restored) {
    term.write(restored);
    term.write("\r\n\x1b[90m[restored previous session]\x1b[0m\r\n");
  }

  const { cmd, args } = pickShell();
  const resolvedCwd = cwd && cwd !== "~" ? cwd : undefined;

  const pty = spawn(cmd, args, {
    cols: term.cols || 80,
    rows: term.rows || 24,
    cwd: resolvedCwd,
    env: { ...((globalThis as any).process?.env ?? {}), TERM: "xterm-256color" },
  });

  // wire data both directions.
  // tauri-pty emits Uint8Array; xterm's write() accepts Uint8Array directly.
  pty.onData((data: Uint8Array) => term.write(data));
  term.onData((data: string) => pty.write(data));
  term.onResize(({ cols, rows }) => {
    try {
      pty.resize(cols, rows);
    } catch {
      /* pty may have exited */
    }
  });
  pty.onExit(() => {
    if (s) s.exited = true;
    term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    // notify the app so it can close the now-dead pane (standard terminal
    // behavior: exiting the shell closes the split / tab).
    const cb = exitListeners.get(tabId);
    if (cb) cb(tabId);
  });

  s = { term, fit, serialize, search, pty, el, disposed: false, exited: false };
  sessions.set(tabId, s);
  return s;
}

/** Mount the cached terminal element into a visible container and fit it. */
export function attachSession(tabId: string, container: HTMLElement, cwd: string) {
  const s = getOrCreateSession(tabId, cwd);
  if (s.el.parentElement !== container) {
    container.appendChild(s.el);
  }
  // defer fit until layout settles
  requestAnimationFrame(() => {
    try {
      s.fit.fit();
      // don't steal focus from an open rename/search input (xterm's textarea
      // is allowed — that's the terminal itself getting focus).
      const ae = document.activeElement as HTMLElement | null;
      const editing =
        ae &&
        (ae.tagName === "INPUT" ||
          (ae.tagName === "TEXTAREA" && !s.el.contains(ae)));
      if (!editing) s.term.focus();
    } catch {
      /* container not measurable yet */
    }
  });
}

/** Detach (but keep alive) — called when switching away from a tab. */
export function detachSession(tabId: string) {
  const s = sessions.get(tabId);
  if (s && s.el.parentElement) {
    persist(tabId, s);
    s.el.parentElement.removeChild(s.el);
  }
}

/** Permanently kill a tab's shell + terminal (called on tab close). */
export function disposeSession(tabId: string) {
  const s = sessions.get(tabId);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* already dead */
  }
  s.term.dispose();
  s.el.remove();
  s.disposed = true;
  sessions.delete(tabId);
  // a deliberately closed pane should not resurrect on next launch
  clearScrollback(tabId);
}

/** Re-fit the currently mounted terminal (call on window resize). */
export function fitSession(tabId: string) {
  const s = sessions.get(tabId);
  if (s && s.el.parentElement) {
    try {
      // Only resize when the proposed geometry actually differs, so we don't
      // emit redundant PTY resizes (SIGWINCH) that make TUIs repaint.
      const dims = s.fit.proposeDimensions();
      if (
        dims &&
        Number.isFinite(dims.cols) &&
        Number.isFinite(dims.rows) &&
        (dims.cols !== s.term.cols || dims.rows !== s.term.rows)
      ) {
        s.fit.fit();
      }
    } catch {
      /* ignore */
    }
  }
}

/** Decorations used to highlight search hits in the terminal viewport. */
function searchDecorations() {
  return {
    decorations: {
      matchBackground: "#7aa2f7",
      matchOverviewRuler: "#7aa2f7",
      activeMatchBackground: "#ff9e64",
      activeMatchColorOverviewRuler: "#ff9e64",
    },
  };
}

/** Find the next occurrence of `query` in a tab's terminal. */
export function searchNext(tabId: string, query: string): boolean {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return false;
  try {
    return s.search.findNext(query, searchDecorations());
  } catch {
    return false;
  }
}

/** Find the previous occurrence of `query` in a tab's terminal. */
export function searchPrevious(tabId: string, query: string): boolean {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return false;
  try {
    return s.search.findPrevious(query, searchDecorations());
  } catch {
    return false;
  }
}

/** Clear any active search highlight and refocus the terminal. */
export function clearSearch(tabId: string) {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return;
  try {
    s.search.clearDecorations();
  } catch {
    /* ignore */
  }
}

/** Focus a tab's terminal (e.g. after closing the search box). */
export function focusSession(tabId: string) {
  const s = sessions.get(tabId);
  if (s && !s.disposed) {
    try {
      s.term.focus();
    } catch {
      /* not mounted */
    }
  }
}

/** Snapshot every live session to storage. */
export function persistAllSessions() {
  for (const [id, s] of sessions) persist(id, s);
}

/**
 * Apply the current appearance settings to the app chrome and every live
 * terminal. Called whenever theme / font / font size changes so the update is
 * instant, without re-spawning shells.
 */
export function applyAppearance() {
  const { theme, font, fontSize } = currentAppearance();
  applyChromeVars(theme.palette);
  const xtermTheme = toXtermTheme(theme.palette);
  for (const [, s] of sessions) {
    if (s.disposed) continue;
    s.term.options.theme = xtermTheme;
    s.term.options.fontFamily = font.stack;
    s.term.options.fontSize = fontSize;
    try {
      s.fit.fit();
    } catch {
      /* not measurable while detached */
    }
  }
}

// Autosave every 15s and flush once more right before the window goes away,
// so a crash or hard-quit still leaves a recent snapshot to restore.
if (typeof window !== "undefined") {
  window.setInterval(persistAllSessions, 15_000);
  window.addEventListener("beforeunload", persistAllSessions);
}

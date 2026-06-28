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
import { spawn, type IPty } from "tauri-pty";
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
  pty: IPty;
  /** the detached DOM element that hosts this terminal */
  el: HTMLDivElement;
  disposed: boolean;
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
  // Best-effort cross-platform default shell.
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) {
    return { cmd: "powershell.exe", args: [] };
  }
  // macOS / Linux
  const shell = "/bin/bash";
  return { cmd: shell, args: ["-l"] };
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
  term.loadAddon(fit);
  term.loadAddon(serialize);
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
    term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
  });

  s = { term, fit, serialize, pty, el, disposed: false };
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
      s.term.focus();
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
      s.fit.fit();
    } catch {
      /* ignore */
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

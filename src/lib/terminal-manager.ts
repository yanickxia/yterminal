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
import { WebLinksAddon } from "@xterm/addon-web-links";
import { detectIsMac, shouldOpenLink } from "./link-modifier";
import { openUrl } from "./opener";
import { spawn, type IPty } from "./pty";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { resolveScrollback } from "../stores/settings-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { findLeaf } from "./pane-tree";
import { logger } from "./logger";

const isMac = typeof navigator !== "undefined" && detectIsMac();

interface Session {
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  pty: IPty;
  /** the detached DOM element that hosts this terminal */
  el: HTMLDivElement;
  /**
   * Whether xterm's `open()` has been called for this session. xterm's
   * documented contract is that the parent passed to `open()` must already be
   * in the DOM; calling it on a detached node leaves the renderer with zero
   * dimensions and certain addon hooks misbehaving. We therefore defer
   * `open()` until the first real `attachSession` call.
   */
  opened: boolean;
  disposed: boolean;
  /** the shell process has exited (user typed `exit` or it died) */
  exited: boolean;
  /**
   * Viewport scroll state captured at detach so we can restore it on the next
   * attach. We snapshot the `.xterm-viewport` div's raw `scrollTop` rather
   * than xterm's `buffer.viewportY`/`scrollToLine`, because xterm only
   * recomputes `ydisp` from scrollTop when the viewport DOM emits a scroll
   * event — assigning scrollTop directly keeps xterm's internal state in
   * sync, whereas `scrollToLine` can leave `scrollTop` lagging behind on
   * first frame after re-attach and the very next wheel event then snaps to
   * the top because the listener reads a stale (≈0) scrollTop.
   */
  savedScrollTop?: number;
  savedAtBottom?: boolean;
  /**
   * Latest cwd reported by the shell via OSC 7 (`\e]7;file://host/path\a`),
   * refreshed on every prompt. Our native pty layer exposes the OS child pid,
   * so when this signal is stale or absent we can query the process directly.
   */
  shellCwd?: string;
}

interface XtermCoreInternals {
  viewport?: {
    syncScrollArea?: (immediate?: boolean) => void;
    _ignoreNextScrollEvent?: boolean;
  };
  _charSizeService?: { hasValidSize?: boolean; measure?: () => void };
  _renderService?: {
    _observerDisposable?: { clear?: () => void };
    _isPaused?: boolean;
    _needsFullRefresh?: boolean;
    _pausedResizeTask?: { flush?: () => void };
  };
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

function recordPaneCwd(paneId: string, cwd: string) {
  const normalized = cwd.trim();
  if (!normalized) return;
  const store = useWorkspaceStore.getState();
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      const leaf = findLeaf(t.root, paneId);
      if (!leaf) continue;
      const tabCwdAlreadyCurrent =
        paneId !== t.activePaneId || t.cwd === normalized;
      if (leaf.cwd === normalized && tabCwdAlreadyCurrent) return;
      store.updatePaneCwd(w.id, t.id, paneId, normalized);
      return;
    }
  }
}

function closePaneForExitedSession(paneId: string) {
  const store = useWorkspaceStore.getState();
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      if (!findLeaf(t.root, paneId)) continue;
      disposeSession(paneId);
      store.closePane(w.id, t.id, paneId);
      return;
    }
  }
  disposeSession(paneId);
}

function xtermCore(s: Session): XtermCoreInternals | undefined {
  return (s.term as unknown as { _core?: XtermCoreInternals })._core;
}

function resumeXtermRenderer(s: Session) {
  try {
    const core = xtermCore(s);
    const renderService = core?._renderService;
    if (!renderService) return;
    // These terminals are intentionally cached and re-parented between tabs.
    // xterm's IntersectionObserver pause can therefore get stuck in WKWebView;
    // disable that observer and explicitly resume before fitting/refreshing.
    renderService._observerDisposable?.clear?.();
    renderService._isPaused = false;
    if (!core?._charSizeService?.hasValidSize) {
      core?._charSizeService?.measure?.();
    }
    renderService._pausedResizeTask?.flush?.();
    renderService._needsFullRefresh = false;
  } catch {
    /* xterm internals changed; normal refresh below is still best effort */
  }
}

function syncXtermViewport(
  s: Session,
  opts: { immediate?: boolean; clearIgnoredScroll?: boolean } = {}
) {
  if (s.disposed || !s.el.parentElement) return;
  try {
    const viewport = xtermCore(s)?.viewport;
    viewport?.syncScrollArea?.(opts.immediate);
    if (opts.clearIgnoredScroll && viewport) {
      // `syncScrollArea()` may set this before programmatically assigning
      // scrollTop. When we call it immediately before a wheel/restore scroll,
      // clear it so the user's next scroll event is not swallowed.
      viewport._ignoreNextScrollEvent = false;
    }
  } catch {
    /* xterm internals moved; scrolling will fall back to default behavior */
  }
}

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
  applyDividerVars();

  const term = new Terminal({
    fontFamily: font.stack,
    fontSize,
    cursorBlink: true,
    allowProposedApi: true,
    theme: toXtermTheme(theme.palette),
    scrollback: resolveScrollback(useSettingsStore.getState().scrollbackLines),
  });
  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(serialize);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (shouldOpenLink(event, isMac)) {
        void openUrl(uri).catch((err) => {
          console.warn("openUrl failed", uri, err);
        });
      }
    }),
  );
  // NOTE: `term.open(el)` is intentionally deferred to attachSession's first
  // real DOM insertion. The hookups below (parser/key/data wiring, scrollback
  // replay) don't depend on the renderer being live — they touch the parser,
  // the buffer and event emitters, all of which exist from Terminal
  // construction.

  // replay any persisted scrollback from a previous launch before wiring the
  // live shell, so old output appears above the fresh prompt.
  const restored = loadScrollback(tabId);
  if (restored) {
    term.write(restored);
    term.write("\r\n\x1b[90m[restored previous session]\x1b[0m\r\n");
  }

  const { cmd, args } = pickShell();
  // Spawn exactly where the pane says it should spawn. New-tab defaults are
  // applied when the tab is created in the workspace store; restore-on-launch
  // must use the saved pane cwd, otherwise a fixed default path can overwrite
  // the directory shown in the restored scrollback.
  const trimmedCwd = cwd.trim();
  const resolvedCwd = trimmedCwd && trimmedCwd !== "~" ? trimmedCwd : undefined;

  const pty = spawn(cmd, args, {
    cols: term.cols || 80,
    rows: term.rows || 24,
    cwd: resolvedCwd,
    // TERM_PROGRAM=Apple_Terminal makes /etc/zshrc (which on macOS ends with
    // `. /etc/zshrc_$TERM_PROGRAM`) install `update_terminal_cwd` as a precmd
    // hook. That hook emits OSC 7 on every prompt, which the OSC handler
    // below turns into a live `shellCwd` per pane — replacing the previous
    // lsof/pid path that never worked (plugin-pty's `pid` is a handle, not
    // an OS pid). On Linux distros that ship a similar zshrc hook this is a
    // no-op; on bare systems the lsof fallback still kicks in.
    env: {
      ...((globalThis as any).process?.env ?? {}),
      TERM: "xterm-256color",
      TERM_PROGRAM: "Apple_Terminal",
    },
  });

  // Capture OSC 7 (`\e]7;file://host/percent-encoded-path\a`) emitted by the
  // shell on each prompt. Standard mechanism used by Apple Terminal, iTerm2,
  // Wezterm, Kitty, GNOME Terminal (via VTE) etc. Returning true tells xterm
  // we consumed the sequence so it isn't dispatched anywhere else.
  term.parser.registerOscHandler(7, (data) => {
    if (!data.startsWith("file://")) return false;
    const slash = data.indexOf("/", "file://".length);
    if (slash === -1) return false;
    try {
      const path = decodeURIComponent(data.slice(slash));
      if (s?.shellCwd !== path) {
        if (s) s.shellCwd = path;
        recordPaneCwd(tabId, path);
      }
    } catch {
      /* malformed percent-encoding — leave shellCwd untouched */
    }
    return true;
  });

  // Multi-line input bridge for TUIs (Claude Code, Ink-based prompts, fish/zsh
  // continuation, etc.): plain Enter sends CR (submit). Cmd/Ctrl/Shift+Enter
  // sends ESC+CR — the canonical Alt+Enter sequence those apps interpret as
  // "newline within input" rather than submit.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || e.key !== "Enter") return true;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      pty.write("\x1b\r");
      return false; // skip xterm's default \r dispatch
    }
    return true;
  });
  term.attachCustomWheelEventHandler(() => {
    if (s) {
      syncXtermViewport(s, { immediate: true, clearIgnoredScroll: true });
    }
    return true;
  });

  // wire data both directions.
  // pty.onData yields Uint8Array; xterm's write() accepts Uint8Array directly.
  pty.onData((data: Uint8Array) => term.write(data));
  term.onWriteParsed(() => {
    if (s) syncXtermViewport(s);
  });
  // term.onData fires for every keystroke/paste leaving xterm toward the pty.
  // Log size + a rough latency tag so a "can't type" report can be traced from
  // the very first hop (xterm) all the way to the OS write.
  term.onData((data: string) => {
    logger.trace(
      "term",
      `input pane=${tabId} bytes=${data.length}`
    );
    pty.write(data);
  });
  term.onResize(({ cols, rows }) => {
    logger.debug("term", `resize pane=${tabId} cols=${cols} rows=${rows}`);
    try {
      pty.resize(cols, rows);
    } catch (e) {
      logger.warn("term", `resize forward failed pane=${tabId}: ${String(e)}`);
    }
  });
  pty.onExit((e) => {
    logger.info("term", `session exit pane=${tabId} code=${e.exitCode}`);
    if (s?.disposed) return;
    if (s) s.exited = true;
    term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    // notify the app so it can close the now-dead pane (standard terminal
    // behavior: exiting the shell closes the split / tab).
    const cb = exitListeners.get(tabId);
    if (cb) cb(tabId);
    else closePaneForExitedSession(tabId);
  });

  s = { term, fit, serialize, search, pty, el, opened: false, disposed: false, exited: false };
  sessions.set(tabId, s);
  logger.info("term", `session created pane=${tabId} live_sessions=${sessions.size}`);
  return s;
}

/** Mount the cached terminal element into a visible container and fit it. */
export function attachSession(tabId: string, container: HTMLElement, cwd: string) {
  const s = getOrCreateSession(tabId, cwd);
  if (s.el.parentElement !== container) {
    container.appendChild(s.el);
  }
  // First attach: now that `el` is in the DOM, it's finally safe to call
  // `term.open()`. This is what wires up the renderer with real dimensions.
  // Subsequent re-attaches (tab switches) leave the renderer in place.
  if (!s.opened) {
    s.term.open(s.el);
    s.opened = true;
  }
  resumeXtermRenderer(s);
  // defer fit until layout settles
  requestAnimationFrame(() => {
    if (s.disposed || s.el.parentElement !== container) return;
    try {
      resumeXtermRenderer(s);
      s.fit.fit();
      resumeXtermRenderer(s);
      syncXtermViewport(s, { immediate: true, clearIgnoredScroll: true });
      s.term.refresh(0, s.term.rows - 1);
      // Restore the underlying viewport scrollTop. We do this rather than
      // calling `scrollToLine` because scrollTop is the source of truth for
      // xterm's scroll listener; writing it directly fires that listener
      // which then computes `ydisp` consistently with the DOM. Going through
      // scrollToLine can leave the two out of sync on first frame after
      // re-attach so the next wheel event teleports to the top.
      const viewport = s.el.querySelector(".xterm-viewport") as HTMLElement | null;
      if (s.savedAtBottom) {
        s.term.scrollToBottom();
        syncXtermViewport(s, { immediate: true, clearIgnoredScroll: true });
      } else if (viewport && typeof s.savedScrollTop === "number") {
        viewport.scrollTop = s.savedScrollTop;
        viewport.dispatchEvent(new Event("scroll"));
      }
      s.savedScrollTop = undefined;
      s.savedAtBottom = undefined;
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
    try {
      const buf = s.term.buffer.active;
      s.savedAtBottom = buf.viewportY === buf.baseY;
      const viewport = s.el.querySelector(".xterm-viewport") as HTMLElement | null;
      if (viewport) s.savedScrollTop = viewport.scrollTop;
    } catch {
      /* buffer not ready */
    }
    s.el.parentElement.removeChild(s.el);
  }
}

/** Permanently kill a tab's shell + terminal (called on tab close). */
export function disposeSession(tabId: string) {
  const s = sessions.get(tabId);
  if (!s) return;
  logger.info("term", `dispose pane=${tabId} pid=${s.pty.pid ?? "?"}`);
  s.disposed = true;
  sessions.delete(tabId);
  try {
    s.pty.kill();
  } catch {
    /* already dead */
  }
  s.term.dispose();
  s.el.remove();
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
      syncXtermViewport(s, { immediate: true });
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
 * Resolve the real current working directory of a session's shell.
 *
 * Preferred path: ask the OS by pid. Our native pty layer keys sessions by the
 * real child process id, so `s.pty.pid` can be passed to `process_cwd`. OSC 7
 * remains as a fallback for environments where process cwd probing is
 * unsupported.
 */
export async function getSessionCwd(paneId: string): Promise<string | null> {
  const s = sessions.get(paneId);
  if (!s || s.disposed) return null;
  const pid = s.pty.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      const cwd = await invoke<string>("process_cwd", { pid });
      if (cwd && cwd.trim()) return cwd;
    } catch {
      /* fall through to shell-reported cwd */
    }
  }
  return s.shellCwd ?? null;
}

/**
 * Add a new tab in `workspaceId`, inheriting the cwd of that workspace's
 * currently active pane. Probes the real shell cwd first; falls back to the
 * tab's last-known cwd. Inheritance is scoped to the given workspace, so
 * switching workspaces doesn't leak cwd across them.
 */
export async function addTabInheritingCwd(workspaceId: string) {
  const store = useWorkspaceStore.getState();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  let cwd: string | undefined;
  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  if (activeTab) {
    const real = await getSessionCwd(activeTab.activePaneId);
    const activeLeaf = findLeaf(activeTab.root, activeTab.activePaneId);
    if (real) {
      cwd = real;
      store.updatePaneCwd(ws.id, activeTab.id, activeTab.activePaneId, real);
    } else if (activeLeaf?.cwd && activeLeaf.cwd !== "~") {
      cwd = activeLeaf.cwd;
    } else if (activeTab.cwd && activeTab.cwd !== "~") {
      cwd = activeTab.cwd;
    }
  }
  store.addTab(workspaceId, undefined, cwd);
}

/** Walk every live session, query its real cwd, and push it into the store. */
let cwdSnapshotPromise: Promise<void> | null = null;
export async function snapshotAllCwds() {
  if (cwdSnapshotPromise) return cwdSnapshotPromise;
  cwdSnapshotPromise = (async () => {
    const paneIds = Array.from(sessions.keys());
    const cwds = await Promise.all(paneIds.map(getSessionCwd));
    for (let i = 0; i < paneIds.length; i++) {
      const paneId = paneIds[i];
      const cwd = cwds[i];
      if (!cwd) continue;
      recordPaneCwd(paneId, cwd);
    }
  })().finally(() => {
    cwdSnapshotPromise = null;
  });
  return cwdSnapshotPromise;
}

/**
 * Apply the current appearance settings to the app chrome and every live
 * terminal. Called whenever theme / font / font size changes so the update is
 * instant, without re-spawning shells.
 */
export function applyAppearance() {
  const { theme, font, fontSize } = currentAppearance();
  applyChromeVars(theme.palette);
  applyDividerVars();
  const xtermTheme = toXtermTheme(theme.palette);
  const scrollback = resolveScrollback(
    useSettingsStore.getState().scrollbackLines
  );
  for (const [, s] of sessions) {
    if (s.disposed) continue;
    s.term.options.theme = xtermTheme;
    s.term.options.fontFamily = font.stack;
    s.term.options.fontSize = fontSize;
    s.term.options.scrollback = scrollback;
    try {
      s.fit.fit();
    } catch {
      /* not measurable while detached */
    }
  }
}

/** Push divider width/color from settings onto CSS variables. */
function applyDividerVars() {
  if (typeof document === "undefined") return;
  const { dividerWidth, dividerColor } = useSettingsStore.getState();
  const r = document.documentElement.style;
  r.setProperty("--divider-width", `${dividerWidth}px`);
  r.setProperty("--divider-color", dividerColor);
}

// Autosave every 15s and flush once more right before the window goes away,
// so a crash or hard-quit still leaves a recent snapshot to restore. Cwd is
// captured on the same cadence so restoring a session lands in the directory
// the user actually `cd`'d to, not the one the shell was originally spawned in.
if (typeof window !== "undefined") {
  window.setInterval(() => {
    persistAllSessions();
    void snapshotAllCwds();
  }, 15_000);
  window.addEventListener("beforeunload", () => {
    persistAllSessions();
    // beforeunload can't await — fire-and-forget; we rely on the 15s tick to
    // catch the recent state in practice.
    void snapshotAllCwds();
  });

  // Tauri's close event is async-capable. Intercept it once so we can flush the
  // current process cwd before the webview disappears; this closes the gap where
  // the user `cd`s and immediately quits before the 15s autosave tick.
  try {
    const appWindow = getCurrentWindow();
    let closing = false;
    appWindow
      .onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        event.preventDefault();
        try {
          await snapshotAllCwds();
          persistAllSessions();
        } finally {
          await appWindow.destroy();
        }
      })
      .catch(() => {
        /* not running inside Tauri */
      });
  } catch {
    /* not running inside Tauri */
  }
}

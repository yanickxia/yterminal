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
import { WebglAddon } from "@xterm/addon-webgl";
import { detectIsMac, shouldOpenLink } from "./link-modifier";
import { openUrl } from "./opener";
import { clipboardWrite, clipboardRead } from "./clipboard";
import { matchClipboardShortcut } from "./clipboard-shortcut";
import { encodeEnter } from "./enter-key";
import { handleClickedToken } from "./file-link";
import { findPathSpans, pathSpanAtColumn } from "./file-link-classify";
import {
  computeUrlLinks,
  isContinuation,
  urlLinkAtPosition,
  type UrlLink,
  type UrlRow,
} from "./terminal-url-links";
import {
  buildColumnMap,
  offsetToColumn,
  offsetToColumnExclusive,
  columnToOffset,
  type ColumnMap,
  type VisitedCell,
} from "./terminal-cell-columns";
import { cleanTerminalText, stripAnsi } from "./terminal-text";
import { sanitizeTabTitle } from "./tab-title";
import { attachOrphanCompositionEndGuard } from "./terminal-composition-guard";
import { shouldSuppressNativePaste } from "./paste-suppress";
import { shouldSuppressContextMenu } from "./context-menu-suppress";
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
  getUiFont,
  toXtermTheme,
  type ThemePalette,
} from "./themes";
import { useSettingsStore } from "../stores/settings-store";
import { resolveScrollback } from "../stores/settings-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { markAttention } from "../stores/attention-store";
import { markActivity, clearActivity } from "../stores/activity-store";
import { setHookState, clearHookState } from "../stores/hook-state-store";
import { parseAgentHookOsc } from "./agent-hook-osc";
import { playAlertSound } from "./alert-sound";
import { collectLeafIds, findLeaf } from "./pane-tree";
import { getVerbose, logger } from "./logger";
import type { AgentKind, PaneAgent } from "./types";
import { paneProcessTree, agentSessionId, processEnv } from "./agent";
import {
  isRemoteWorkspace,
  transportForWorkspace,
} from "./workspace-sync";
import {
  detectAgent,
  classifyCommandToken,
  buildResumeCommand,
  tokenMatchesKind,
} from "./agent-detect";
import {
  makeInputLineState,
  feedInput,
  firstToken,
  type InputLineState,
} from "./input-line";
import {
  makeSentinel,
  parseResult,
  sentinelCommand,
  scrubCommandEcho,
} from "./agent-run";
import {
  formatLatencySummary,
  makeInputLatencyTracker,
} from "./input-latency";

const isMac = typeof navigator !== "undefined" && detectIsMac();

// Lazily-resolved, cached home directory. Used to expand `~`-prefixed paths in
// clicked terminal tokens. Resolved once on first need; failures (non-Tauri /
// no API) leave it undefined and `~` paths simply aren't expanded.
let homeDirCache: string | undefined;
let homeDirProbe: Promise<void> | null = null;
function primeHomeDir(): void {
  if (homeDirCache !== undefined || homeDirProbe) return;
  homeDirProbe = (async () => {
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      homeDirCache = (await homeDir()).replace(/\/+$/, "");
    } catch {
      /* non-Tauri or unavailable — leave undefined */
    }
  })();
}

// Harvest the per-cell widths of a buffer line the same way xterm's
// `translateToString(true)` walks it, then build the offset↔column map. This is
// what lets us turn the string offsets our pure scanners return into the
// terminal columns xterm's LinkProvider ranges are addressed in — without it a
// wide (CJK) char before a link shifts the clickable range/underline left by
// one cell per char (the "访问地址：http://…" bug). Walk stops at the trimmed
// length so it matches `translateToString(true)` exactly (trailing blanks off).
type BufferLineLike = {
  readonly length: number;
  getCell(
    x: number,
    cell?: unknown
  ): { getWidth(): number; getChars(): string } | undefined;
  translateToString(trim?: boolean): string;
};

function harvestColumnMap(line: BufferLineLike): ColumnMap {
  const cells: VisitedCell[] = [];
  // translateToString(true) trims trailing whitespace; mirror that by capping at
  // the trimmed string length so map bounds line up with the text we scanned.
  const trimmedLen = line.translateToString(true).length;
  let produced = 0;
  for (let x = 0; x < line.length && produced < trimmedLen; ) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    // A width-0 cell is the phantom trailing half of a wide char — skip it, it
    // is not a visited cell and contributes no string char (matches xterm).
    if (width === 0) {
      x += 1;
      continue;
    }
    const chars = cell.getChars();
    const charLen = chars.length || 1; // empty cell still emits one space char
    cells.push({ width, charLen });
    produced += charLen;
    x += width;
  }
  return buildColumnMap(cells);
}

// Bridge xterm's per-line `provideLinks(lineNumber)` to the pure, multi-row
// `computeUrlLinks`. xterm asks about one buffer line at a time (1-based); to
// stitch a hard-wrapped URL we walk UP to the first row of the physical group
// containing `lineNumber`, then DOWN over its continuation rows, feed the slice
// to `computeUrlLinks`, and keep only the links that actually cover the queried
// line (so the same link isn't reported once per row it spans). Row indices in
// the returned links are absolute buffer rows (0-based).
//
// `computeUrlLinks` reasons in string offsets (it only sees the collapsed row
// text); we convert those to terminal columns per row via `harvestColumnMap`,
// because a wide (CJK) char is 1 string char but 2 columns. A multi-row URL
// maps its start through the first row's map and its end through the last row's.
function computeTerminalUrlLinks(
  term: Terminal,
  lineNumber: number
): UrlLink[] {
  const buf = term.buffer.active;
  const cols = term.cols;
  const queried = lineNumber - 1; // 0-based absolute buffer row

  // Walk up to the physical group start: while THIS row is a continuation of
  // the row above it (soft-wrapped, or the row above fills the width).
  let first = queried;
  while (first > 0) {
    const prev = buf.getLine(first - 1);
    const cur = buf.getLine(first);
    if (!prev || !cur) break;
    if (!isContinuation(prev.translateToString(true), cur.isWrapped, cols)) {
      break;
    }
    first--;
  }

  // Collect the group's rows from `first` downward, keeping each row's
  // offset↔column map alongside its text (indices align with `rows`).
  const rows: UrlRow[] = [];
  const maps: ColumnMap[] = [];
  let r = first;
  const firstLine = buf.getLine(r);
  if (!firstLine) return [];
  rows.push({ text: firstLine.translateToString(true), isWrapped: false });
  maps.push(harvestColumnMap(firstLine));
  r++;
  for (;;) {
    const cur = buf.getLine(r);
    if (!cur) break;
    const prevText = rows[rows.length - 1].text;
    if (!isContinuation(prevText, cur.isWrapped, cols)) break;
    rows.push({ text: cur.translateToString(true), isWrapped: cur.isWrapped });
    maps.push(harvestColumnMap(cur));
    r++;
  }

  // Convert string offsets → columns (per row), then map slice-relative rows
  // back to absolute buffer rows, keeping only links that touch the queried row
  // (xterm calls us again for other rows).
  const links = computeUrlLinks(rows, cols).map((l) => ({
    ...l,
    startCol: offsetToColumn(maps[l.startRow], l.startCol),
    endCol: offsetToColumnExclusive(maps[l.endRow], l.endCol),
    startRow: l.startRow + first,
    endRow: l.endRow + first,
  }));
  return links.filter((l) => l.startRow <= queried && queried <= l.endRow);
}

// Git auto-refresh hook. The git sidebar wants to re-read status whenever a
// command that might touch the working tree finishes. The cleanest signal we
// already have is OSC 7 (emitted by the shell's precmd hook on every prompt),
// which fires exactly once per command. We debounce it so a burst of prompts
// (e.g. a script printing several) collapses into a single refresh, and we go
// through a registered callback rather than importing git-store here to keep
// the dependency direction one-way (git-store already imports this module).
let onCommandSettledCb: (() => void) | null = null;
let commandSettledTimer: ReturnType<typeof setTimeout> | null = null;

/** Register the callback invoked (debounced) after each shell prompt. */
export function setOnCommandSettled(cb: (() => void) | null): void {
  onCommandSettledCb = cb;
}

/** Fire the settled callback, debounced ~250ms to coalesce prompt bursts. */
function scheduleCommandSettled(): void {
  if (!onCommandSettledCb) return;
  if (commandSettledTimer) clearTimeout(commandSettledTimer);
  commandSettledTimer = setTimeout(() => {
    commandSettledTimer = null;
    onCommandSettledCb?.();
  }, 250);
}

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
  /**
   * Reconstructed current input line, fed from `term.onData` (user keystrokes
   * only). Lets us capture the literal launch token — including a shell alias —
   * the user typed to start an agent, which the process argv never reveals.
   */
  inputLine: InputLineState;
  /**
   * Launch token, per agent kind, as the user last typed it in this pane.
   * Paired with a live detection at snapshot time to recover the alias.
   */
  typedCommands: Map<AgentKind, string>;
  /**
   * Recent first-tokens of submitted shell lines (newest at the end). We keep
   * a small history rather than a single field so an alias the user typed at
   * a shell prompt survives subsequent in-TUI Enter submissions: the snapshot
   * picks the most recent entry whose basename contains the detected kind.
   */
  recentSubmits: string[];
  /**
   * Resume command queued for a restored pane. Injected once the shell is
   * ready (first OSC 7 prompt, or a timeout fallback for bare shells).
   */
  pendingResume?: string;
  /** Whether the queued resume command has already been injected. */
  resumeInjected: boolean;
  /**
   * Cleanup for the orphan-composition guard, attached on first `open()`. On
   * Linux (webkit2gtk) IMEs commit CJK via an orphan `compositionend` with no
   * matching `compositionstart`, which xterm re-sends as the whole textarea
   * buffer — the "你好 → 你好你你好好…" duplication. See
   * terminal-composition-guard.ts.
   */
  compositionGuardCleanup?: () => void;
  /**
   * The GPU renderer addon, attached on first `open()` for a real speed-up over
   * xterm's default DOM renderer. Kept on the session so we can dispose it on
   * context loss (fall back to DOM) and on session teardown. `undefined` when
   * WebGL is unavailable (headless / no GPU) — xterm then uses the DOM renderer.
   */
  webgl?: WebglAddon;
  /**
   * When a keyboard paste shortcut (Ctrl+Shift+V / Cmd+V) fires, we call
   * `pasteInto` ourselves. On webkit2gtk the same keypress ALSO emits a native
   * `paste` event that xterm handles — pasting twice. We stamp this timestamp
   * on the shortcut and swallow a native `paste` arriving right after it. See
   * paste-suppress.ts.
   */
  pasteViaShortcutAt?: number;
  /** Cleanup for the native-paste de-dupe listener. */
  pasteDedupeCleanup?: () => void;
  /** Cleanup for the tmux/TUI mouse-mode file-link click bridge listener. */
  linkClickBridgeCleanup?: () => void;
  /**
   * When a modified Enter (Ctrl/Cmd/Alt/Shift+Enter) is handled we emit a CSI-u
   * sequence (see enter-key.ts). On macOS, Ctrl is the "secondary click"
   * modifier, so that same keydown ALSO makes WKWebView dispatch a
   * `contextmenu` event — popping the Copy/Paste menu unexpectedly. We stamp
   * this timestamp and swallow a `contextmenu` arriving right after it. See
   * context-menu-suppress.ts.
   */
  modifiedEnterAt?: number;
  /**
   * Latest sanitized-input title the shell/agent reported via OSC 0/2. Kept on
   * the session (not just the onTitleChange closure) so clearing a tab's manual
   * name can immediately re-apply the live title instead of waiting for the next
   * redraw. Empty until the first title event.
   */
  lastTitle?: string;
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
  // The element xterm attaches its own mouse listeners to (rows layer). Used by
  // the tmux/TUI mouse-mode click bridge to map a screen click to a buffer cell.
  screenElement?: HTMLElement;
  // True while a TUI/tmux has enabled terminal mouse reporting; in that mode
  // xterm forwards clicks to the PTY and never fires the LinkProvider.
  coreMouseService?: { areMouseEventsActive?: boolean };
  // Maps a MouseEvent to 1-based [col, row] terminal coordinates within `el`.
  _mouseService?: {
    getCoords?: (
      event: MouseEvent,
      element: HTMLElement,
      cols: number,
      rows: number
    ) => [number, number] | undefined;
  };
  _bufferService?: {
    cols: number;
    rows: number;
    buffer: {
      ydisp: number;
      lines: { length: number };
      getLine: (i: number) => BufferLineLike | undefined;
    };
  };
}

/**
 * Per-pane callbacks fired when the shell process exits, so the UI can close
 * the dead pane. Registered by PaneTerminal; keyed by pane/tab id.
 */
const exitListeners = new Map<string, (tabId: string) => void>();
const controlListeners = new Map<string, (readOnly: boolean) => void>();

/** Register a callback invoked when the given pane's shell process exits. */
export function onSessionExit(tabId: string, cb: (tabId: string) => void) {
  exitListeners.set(tabId, cb);
}

/** Remove a previously registered exit callback. */
export function offSessionExit(tabId: string) {
  exitListeners.delete(tabId);
}

export function onSessionControl(
  tabId: string,
  cb: (readOnly: boolean) => void
) {
  controlListeners.set(tabId, cb);
  const session = sessions.get(tabId);
  if (session) cb(session.pty.readOnly);
}

export function offSessionControl(tabId: string) {
  controlListeners.delete(tabId);
}

/** Persist a session's fully parsed current buffer to storage (best effort). */
async function persist(id: string, s: Session): Promise<void> {
  if (s.disposed) return;
  try {
    await s.pty.waitForParserIdle(2_000);
    if (s.disposed || !s.pty.isParserIdle()) return;
    const snapshot = s.serialize.serialize();
    saveScrollback(id, snapshot);
    // The daemon keeps the authoritative reconnect checkpoint. The local
    // SQLite copy remains as a migration/offline fallback during rollout.
    s.pty.checkpoint(snapshot);
  } catch {
    /* serialize can throw on an empty/closed buffer */
  }
}

const sessions = new Map<string, Session>();

function recordPaneCwd(paneId: string, cwd: string) {
  if (sessions.get(paneId)?.pty.readOnly) return;
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

/** Locate a pane leaf and the workspace/tab it lives in. */
function locatePane(paneId: string) {
  const store = useWorkspaceStore.getState();
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      const leaf = findLeaf(t.root, paneId);
      if (leaf)
        return {
          store,
          workspaceId: w.id,
          hostId: w.hostId ?? "local",
          tabId: t.id,
          leaf,
        };
    }
  }
  return null;
}

/**
 * Push a shell/agent-reported title onto the pane's tab as its auto name.
 * Only the tab's *active* pane may drive the title — a background split in the
 * same tab shouldn't fight it — and the store drops the write when the user
 * pinned a customName or the name is unchanged. Gated by the `autoTabTitle`
 * setting.
 */
function applyPaneTitle(paneId: string, rawTitle: string) {
  if (!useSettingsStore.getState().autoTabTitle) return;
  if (sessions.get(paneId)?.pty.readOnly) return;
  const located = locatePane(paneId);
  if (!located) return;
  const { store, workspaceId, tabId } = located;
  const tab = store.workspaces
    .find((w) => w.id === workspaceId)
    ?.tabs.find((t) => t.id === tabId);
  // File-viewer tabs have no shell; a multi-pane tab follows only its active
  // pane so two panes don't ping-pong the name.
  if (!tab || tab.file || tab.activePaneId !== paneId) return;
  const name = sanitizeTabTitle(rawTitle);
  if (!name) return;
  store.setTabAutoName(workspaceId, tabId, name);
}

/**
 * Re-apply a pane's last shell/agent-reported title as the tab's auto name.
 * Used right after a tab's manual `customName` is cleared, so the tab snaps
 * back to the live title immediately instead of waiting for the next OSC 0/2
 * redraw (an idle shell might not emit one for a while). No-op when the pane
 * never reported a usable title — the tab then keeps its existing auto name.
 */
export function reapplyPaneTitle(paneId: string) {
  const s = sessions.get(paneId);
  if (s?.lastTitle) applyPaneTitle(paneId, s.lastTitle);
}

/**
 * Whether the given pane is the one the user is currently looking at: it must
 * be the active pane of the active tab in the active workspace, AND the app
 * window itself must have focus. A bell here needs no attention flag — the user
 * is already watching. Anything else (a background tab/workspace, or a
 * backgrounded window) does warrant a nudge.
 */
function isPaneFocused(paneId: string): boolean {
  if (typeof document !== "undefined" && !document.hasFocus()) return false;
  const store = useWorkspaceStore.getState();
  const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
  if (!ws || !ws.activeTabId) return false;
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  return tab?.activePaneId === paneId;
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
  const { themeId, fontId, uiFontId, fontSize } = useSettingsStore.getState();
  return {
    theme: getTheme(themeId),
    font: getFont(fontId),
    uiFont: getUiFont(uiFontId),
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
  applyUiFontVar();

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
  const inputLatency = makeInputLatencyTracker();
  term.loadAddon(fit);
  term.loadAddon(serialize);
  term.loadAddon(search);
  // Web-URL link provider. We DON'T use @xterm/addon-web-links: it only stitches
  // a URL back together across *soft*-wrapped rows (`isWrapped`), so a long URL
  // that a CLI program hard-wraps at the terminal width (its own newline, so the
  // continuation row has `isWrapped === false`) is only clickable on its first
  // row. `computeUrlLinks` joins continuation rows when the previous row fills
  // the width too, so the whole URL becomes one multi-row clickable link.
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const links = computeTerminalUrlLinks(term, lineNumber);
      if (links.length === 0) {
        callback(undefined);
        return;
      }
      callback(
        links.map((link) => ({
          // IBufferRange is 1-based; end-inclusive on x, and may span rows.
          range: {
            start: { x: link.startCol + 1, y: link.startRow + 1 },
            end: { x: link.endCol, y: link.endRow + 1 },
          },
          text: link.url,
          activate: (event: MouseEvent, uri: string) => {
            if (
              !shouldOpenLink(
                event,
                isMac,
                useSettingsStore.getState().requireModifierForLinks
              )
            )
              return;
            void openUrl(uri).catch((err) => {
              console.warn("openUrl failed", uri, err);
            });
          },
        }))
      );
    },
  });
  // File-path link provider: makes path-like tokens in terminal output
  // clickable (Cmd/Ctrl+click, same modifier gate as web links). Resolution
  // is relative to the pane's live cwd; a recognized text type opens in the
  // built-in viewer, anything else is handed to the OS.
  primeHomeDir();
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buf = term.buffer.active;
      const bufLine = buf.getLine(lineNumber - 1);
      if (!bufLine) {
        callback(undefined);
        return;
      }
      const text = bufLine.translateToString(true);
      const spans = findPathSpans(text);
      if (spans.length === 0) {
        callback(undefined);
        return;
      }
      // findPathSpans returns string offsets; xterm ranges are terminal columns
      // (a wide CJK char is 1 string char but 2 columns), so translate per line.
      const map = harvestColumnMap(bufLine);
      callback(
        spans.map((span) => ({
          // IBufferRange is 1-based and end-inclusive.
          range: {
            start: { x: offsetToColumn(map, span.start) + 1, y: lineNumber },
            end: { x: offsetToColumnExclusive(map, span.end), y: lineNumber },
          },
          text: span.token,
          activate: (event: MouseEvent, token: string) => {
            if (
              !shouldOpenLink(
                event,
                isMac,
                useSettingsStore.getState().requireModifierForLinks
              )
            )
              return;
            const cur = sessions.get(tabId);
            const cwd = cur?.shellCwd ?? "";
            void handleClickedToken(
              token,
              cwd,
              homeDirCache,
              locatePane(tabId)?.workspaceId
            ).catch((err) => console.warn("file link open failed", token, err));
          },
        }))
      );
    },
  });
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
  const owner = locatePane(tabId);

  const pty = spawn(cmd, args, {
    cols: term.cols || 80,
    rows: term.rows || 24,
    cwd: resolvedCwd,
    workspaceId: owner?.workspaceId ?? "local-default",
    paneId: tabId,
    hostId: owner?.hostId,
    sessionId: owner?.leaf.sessionId,
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

  // A fresh remote attach may require replacing a stale local xterm with the
  // agent checkpoint. Register this before the async attach can replay data.
  pty.onReset(() => {
    try {
      term.reset();
    } catch {
      /* renderer may not be opened yet; the empty terminal is already clean */
    }
  });
  pty.onRemoteResize(({ cols, rows }) => {
    if (term.cols === cols && term.rows === rows) return;
    try {
      term.resize(cols, rows);
    } catch {
      /* terminal may not be open yet */
    }
  });
  pty.onReadOnlyChange((readOnly) => {
    controlListeners.get(tabId)?.(readOnly);
    // Watchers must render with the controller's canonical character grid;
    // fitting to this client's container would reflow output differently.
    // Once control is acquired, fit exactly once so this client establishes
    // the new canonical size through the normal xterm onResize path.
    if (!readOnly) {
      requestAnimationFrame(() => fitSession(tabId));
    }
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
    // OSC 7 fires on every prompt, i.e. right after a command finishes — the
    // moment the working tree may have changed. Nudge the git sidebar to
    // re-read (debounced; no-ops when nothing is listening / panel closed).
    scheduleCommandSettled();
    // The first prompt is the earliest moment the shell is ready to run a
    // command, so this is where we inject a queued agent-resume command.
    if (s) maybeInjectResume(s);
    return true;
  });

  // OSC 777 (agent status): the Claude Code hooks we install (see
  // install_claude_hooks in main.rs) emit `notify;yt-agent;<state>` through the
  // agent's own PTY on each lifecycle event, so the bytes arrive on THIS pane's
  // stream and this handler closure-captures the pane id — no session matching
  // needed. parseAgentHookOsc returns null for any real (non-yterminal) OSC 777
  // notification, which we pass through (return false) untouched.
  term.parser.registerOscHandler(777, (data) => {
    const parsed = parseAgentHookOsc(data);
    if (parsed === null) return false;
    if (parsed === "ended") clearHookState(tabId);
    else setHookState(tabId, parsed);
    return true;
  });

  // Multi-line input bridge for TUIs (Claude Code, Ink-based prompts, fish/zsh
  // continuation, etc.) AND multiplexer key passthrough: plain Enter sends CR
  // (submit). Any modified Enter (Cmd/Ctrl/Alt/Shift) is emitted as its CSI-u
  // ("fixterms") sequence carrying the exact modifier bitmask, so tmux and
  // modern TUIs can tell e.g. Ctrl+Shift+Enter from Shift+Enter and bind them
  // independently — the old ESC+CR collapse made every combo look like
  // Alt+Enter, which a multiplexer just rendered as a newline.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Clipboard shortcuts (Ctrl+Shift+C/V, or Cmd+C/V on mac). Bare Ctrl+C/V
    // never matches here, so SIGINT and literal input still reach the shell.
    const action = matchClipboardShortcut(e, isMac);
    if (action === "copy") {
      void copySelection(tabId);
      return false;
    }
    if (action === "paste") {
      // Stamp the moment so the native `paste` event webkit2gtk fires for this
      // same keypress can be recognized as the duplicate and swallowed.
      if (s) s.pasteViaShortcutAt = Date.now();
      void pasteInto(tabId);
      return false;
    }
    if (e.key !== "Enter") return true;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      // Stamp the moment so the spurious `contextmenu` macOS WKWebView fires
      // for this same Ctrl-modified keydown can be recognized and swallowed
      // (Ctrl is the platform "secondary click" modifier). See
      // context-menu-suppress.ts / PaneTerminal.tsx.
      if (s) s.modifiedEnterAt = Date.now();
      pty.write(encodeEnter(e));
      return false; // skip xterm's default \r dispatch
    }
    return true;
  });
  // Copy-on-select (opt-in): mirror the selection into the clipboard as soon as
  // it changes. The setting is read live so toggling it takes effect without
  // recreating terminals (same stance as requireModifierForLinks).
  term.onSelectionChange(() => {
    if (!useSettingsStore.getState().copyOnSelect) return;
    const sel = term.getSelection();
    if (sel) void clipboardWrite(sel).catch(() => {});
  });
  term.attachCustomWheelEventHandler(() => {
    if (s) {
      syncXtermViewport(s, { immediate: true, clearIgnoredScroll: true });
    }
    return true;
  });

  // Attention bell: CLIs (and coding agents like Claude Code / OpenCode) ring
  // the terminal bell (BEL, \x07) when they pause for user input or hit an
  // error that needs a human. If that happens in a pane the user isn't looking
  // at, flag the pane so the status bar under the tabs surfaces it, and play a
  // chime (gated by the user setting + throttled). A bell in the *focused*
  // pane is ignored — the user is already there.
  term.onBell(() => {
    if (isPaneFocused(tabId)) return;
    markAttention(tabId);
    const { alertSoundEnabled, alertVolume } = useSettingsStore.getState();
    if (alertSoundEnabled) {
      playAlertSound({ volume: alertVolume });
    }
  });

  // Auto tab title: shells and coding agents set the terminal title (OSC 0/2)
  // to their current activity — a cwd, a running command, or (Claude Code /
  // Codex) the step they're on. xterm parses that into onTitleChange; we sink
  // it into the tab's auto name so an un-renamed tab tracks what's happening
  // inside it. Throttled so a TUI redrawing its title on every keystroke can't
  // thrash the store. `customName`/setting checks live in applyPaneTitle.
  let lastTitle = "";
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  term.onTitleChange((title) => {
    if (title === lastTitle) return;
    lastTitle = title;
    if (s) s.lastTitle = title;
    if (titleTimer) return;
    titleTimer = setTimeout(() => {
      titleTimer = undefined;
      applyPaneTitle(tabId, lastTitle);
    }, 150);
  });

  // wire data both directions.
  // pty.onData yields Uint8Array; xterm's write() accepts Uint8Array directly.
  // Each chunk also stamps the activity store so "an agent is producing output
  // right now" (executing) is distinguishable from "idle at a prompt".
  pty.onData((data: Uint8Array) => {
    markActivity(tabId);
    const verbose = getVerbose();
    if (verbose) {
      inputLatency.markOutput(performance.now());
    }
    term.write(data, () => {
      pty.acknowledgeData(data);
      if (verbose) inputLatency.markParsed(performance.now());
    });
  });
  term.onRender(() => {
    if (!getVerbose()) return;
    const summary = inputLatency.markRendered(performance.now());
    if (summary) logger.debug("perf", formatLatencySummary(summary));
  });
  term.onWriteParsed(() => {
    if (s) syncXtermViewport(s);
  });
  // term.onData fires for every keystroke/paste leaving xterm toward the pty.
  term.onData((data: string) => {
    if (getVerbose()) inputLatency.start(performance.now());
    // Reconstruct the user's current input line so we can capture the literal
    // launch token (possibly a shell alias) when a coding agent is started.
    // The running process argv only ever shows the resolved binary, so this is
    // the only place the alias is observable.
    if (s) {
      const { state, submitted } = feedInput(s.inputLine, data);
      s.inputLine = state;
      if (submitted) {
        const token = firstToken(submitted);
        if (token) {
          s.recentSubmits.push(token);
          // Bound the history; agent launches are always near the top.
          if (s.recentSubmits.length > 16) s.recentSubmits.shift();
          const kind = classifyCommandToken(token);
          if (kind) s.typedCommands.set(kind, token);
          // Trigger an early agent re-detection so we capture an alias
          // (e.g. `claude-yolo`) before the user types many TUI lines.
          scheduleQuickAgentSnapshot();
        }
      }
    }
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
    clearActivity(tabId);
    clearHookState(tabId);
    term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    // notify the app so it can close the now-dead pane (standard terminal
    // behavior: exiting the shell closes the split / tab).
    const cb = exitListeners.get(tabId);
    if (cb) cb(tabId);
    else closePaneForExitedSession(tabId);
  });

  s = {
    term,
    fit,
    serialize,
    search,
    pty,
    el,
    opened: false,
    disposed: false,
    exited: false,
    inputLine: makeInputLineState(),
    typedCommands: new Map(),
    recentSubmits: [],
    resumeInjected: false,
  };
  sessions.set(tabId, s);

  // Resume metadata reconstructs a dead agent session. Creating a new xterm
  // does not imply the PTY died: the daemon may have attached it to the still
  // running Claude/Codex TUI. Arm resume only when AgentPty confirms that it
  // had to spawn a replacement shell.
  pty.onFreshSpawn(() => {
    const located = locatePane(tabId);
    if (!located?.leaf.agent || !s || s.disposed) return;
    s.resumeInjected = false;
    s.pendingResume = buildResumeCommand(located.leaf.agent);
    // OSC 7 at the first shell prompt is the preferred trigger. Bare shells
    // without a cwd hook still need a bounded fallback.
    const captured = s;
    window.setTimeout(() => {
      if (!captured.disposed) maybeInjectResume(captured);
    }, 1500);
  });

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
    // GPU renderer: xterm's default DOM renderer repaints per-cell and is the
    // dominant source of keystroke-to-screen lag. Load the WebGL addon now that
    // the terminal is in the DOM (its contract requires open() first). On GPU
    // context loss the addon self-disposes; we drop our handle so xterm falls
    // back to the DOM renderer instead of rendering nothing. Construction can
    // throw when WebGL is unavailable (headless / blocked) — swallow and keep
    // the DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        logger.warn("term", `webgl context lost pane=${tabId}; falling back to DOM`);
        try {
          webgl.dispose();
        } catch {
          /* already disposed */
        }
        if (s.webgl === webgl) s.webgl = undefined;
      });
      s.term.loadAddon(webgl);
      s.webgl = webgl;
    } catch (e) {
      logger.warn("term", `webgl unavailable pane=${tabId}: ${String(e)}`);
    }
    // Attach the orphan-composition guard now that the textarea exists. `s.el`
    // is an ancestor of xterm's textarea, so capture-phase listeners here run
    // before xterm's own. Delivered CJK is written straight to the pty (it
    // never matches an agent launch token, so bypassing feedInput is safe).
    s.compositionGuardCleanup = attachOrphanCompositionEndGuard(s.el, (data) => {
      try {
        s.pty.write(data);
      } catch {
        /* pty gone */
      }
    });
    // De-dupe paste on webkit2gtk: a keyboard paste shortcut runs pasteInto()
    // AND the browser fires a native `paste` event that xterm handles too. We
    // swallow that native duplicate (capture phase, before xterm's textarea
    // handler) only when it lands right after the shortcut fired. Middle-click
    // and menu pastes carry no shortcut stamp, so they pass through untouched.
    const onNativePaste = (e: Event) => {
      if (shouldSuppressNativePaste(s.pasteViaShortcutAt, Date.now())) {
        s.pasteViaShortcutAt = undefined;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    s.el.addEventListener("paste", onNativePaste, true);
    s.pasteDedupeCleanup = () =>
      s.el.removeEventListener("paste", onNativePaste, true);

    // tmux / TUI mouse-mode link click bridge. When a program (tmux with
    // `mouse on`, or a full-screen TUI) turns on terminal mouse reporting,
    // xterm forwards clicks straight to the PTY and calls preventDefault —
    // so its LinkProvider `activate` never fires and Cmd/Ctrl+click on a URL or
    // file path does nothing. We install a capture-phase mousedown that runs
    // BEFORE xterm's own listener: only in mouse-reporting mode, only with the
    // link modifier held, and only when the click lands on a URL or path token,
    // we hit-test the clicked cell ourselves, open the target, and swallow the
    // event so it doesn't reach tmux. Everything else (plain clicks, non-link
    // cells, mouse mode off) passes through untouched — the normal LinkProvider
    // still works.
    const onCaptureMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only
      const core = xtermCore(s);
      if (!core?.coreMouseService?.areMouseEventsActive) return; // mouse mode off → LinkProvider handles it
      if (
        !shouldOpenLink(
          e,
          isMac,
          useSettingsStore.getState().requireModifierForLinks
        )
      )
        return; // modifier gate not satisfied → let tmux have the click
      const bufSvc = core._bufferService;
      const screen = core.screenElement;
      const coords = core._mouseService?.getCoords?.(
        e,
        screen ?? s.el,
        bufSvc?.cols ?? s.term.cols,
        bufSvc?.rows ?? s.term.rows
      );
      if (!coords || !bufSvc) return;
      // getCoords returns 1-based [col, row] within the viewport; map to the
      // absolute buffer line via ydisp and to a 0-based column.
      const col = coords[0] - 1;
      const bufferRow = coords[1] - 1 + bufSvc.buffer.ydisp;
      const line = bufSvc.buffer.getLine(bufferRow);
      if (!line) return;
      // Reuse the LinkProvider's wrapped-row and CJK-aware URL ranges so the
      // mouse-mode path behaves exactly like the normal URL activation path.
      const urlLink = urlLinkAtPosition(
        computeTerminalUrlLinks(s.term, bufferRow + 1),
        bufferRow,
        col
      );
      if (urlLink) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void openUrl(urlLink.url).catch((err) =>
          console.warn("web link open failed (mouse-mode)", urlLink.url, err)
        );
        return;
      }
      // `col` is a terminal column; pathSpanAtColumn hit-tests string offsets
      // (a wide CJK char spans 2 columns but 1 string char), so translate first.
      const text = line.translateToString(true);
      const offset = columnToOffset(harvestColumnMap(line), col);
      const span = pathSpanAtColumn(text, offset);
      if (!span) return; // not over a path → leave the click for tmux
      // We own this click: stop xterm from forwarding it to the PTY.
      e.preventDefault();
      e.stopImmediatePropagation();
      const cwd = sessions.get(tabId)?.shellCwd ?? "";
      void handleClickedToken(
        span.token,
        cwd,
        homeDirCache,
        locatePane(tabId)?.workspaceId
      ).catch((err) =>
        console.warn("file link open failed (mouse-mode)", span.token, err)
      );
    };
    s.el.addEventListener("mousedown", onCaptureMouseDown, true);
    s.linkClickBridgeCleanup = () =>
      s.el.removeEventListener("mousedown", onCaptureMouseDown, true);
  }
  resumeXtermRenderer(s);
  // defer fit until layout settles
  requestAnimationFrame(() => {
    if (s.disposed || s.el.parentElement !== container) return;
    try {
      resumeXtermRenderer(s);
      if (!s.pty.readOnly) s.fit.fit();
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
    void persist(tabId, s);
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
  clearActivity(tabId);
  controlListeners.delete(tabId);
  clearHookState(tabId);
  s.compositionGuardCleanup?.();
  s.pasteDedupeCleanup?.();
  s.linkClickBridgeCleanup?.();
  try {
    s.pty.kill();
  } catch {
    /* already dead */
  }
  // Release the GPU context before tearing down the terminal.
  try {
    s.webgl?.dispose();
  } catch {
    /* already disposed (e.g. after context loss) */
  }
  s.term.dispose();
  s.el.remove();
  // a deliberately closed pane should not resurrect on next launch
  clearScrollback(tabId);
}

/** Drop cached xterms whose authoritative workspace/pane was removed elsewhere. */
export function pruneSessionsToWorkspaceProjection(): void {
  const live = new Set<string>();
  for (const workspace of useWorkspaceStore.getState().workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.file) continue;
      for (const paneId of collectLeafIds(tab.root)) live.add(paneId);
    }
  }
  for (const paneId of Array.from(sessions.keys())) {
    if (!live.has(paneId)) disposeSession(paneId);
  }
}

/** Re-fit the currently mounted terminal (call on window resize). */
export function fitSession(tabId: string) {
  const s = sessions.get(tabId);
  if (s && s.el.parentElement) {
    try {
      // Only resize when the proposed geometry actually differs, so we don't
      // emit redundant PTY resizes (SIGWINCH) that make TUIs repaint.
      const dims = s.pty.readOnly ? undefined : s.fit.proposeDimensions();
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

/**
 * Serialize a tab's terminal buffer to clean plain text for the AI sidebar.
 * Returns "" when the session doesn't exist. Escapes/control chars are stripped
 * and the result is capped to the most recent `maxChars` (tail-biased, since
 * the newest output is the most relevant context).
 */
export function getSessionText(tabId: string, maxChars = 12000): string {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return "";
  try {
    return cleanTerminalText(s.serialize.serialize(), maxChars);
  } catch {
    return "";
  }
}

/**
 * Scroll a pane's terminal to the bottom (newest output). Used when navigating
 * to a tab that rang the attention bell — the user wants to see the latest
 * output (the prompt the agent is waiting on), not wherever they'd left the
 * scrollback parked. Works whether the session is currently on-screen or
 * detached: if it's live we scroll now; either way we clear the saved scroll
 * state and pin `savedAtBottom` so the pending re-attach also lands at bottom.
 */
export function scrollSessionToBottom(paneId: string): void {
  const s = sessions.get(paneId);
  if (!s || s.disposed) return;
  s.savedScrollTop = undefined;
  s.savedAtBottom = true;
  if (s.el.parentElement) {
    try {
      s.term.scrollToBottom();
    } catch {
      /* buffer not ready */
    }
  }
}

/** Whether the pane currently has a non-empty text selection. */
export function hasSelection(tabId: string): boolean {
  const s = sessions.get(tabId);
  return !!s && !s.disposed && s.term.hasSelection();
}

/**
 * Whether a `contextmenu` event for this pane should be ignored because it's
 * the spurious one macOS WKWebView fires alongside a Ctrl-modified Enter (which
 * we turn into a CSI-u sequence). Consumes the timestamp so a genuine
 * right-click immediately after is still honored.
 */
export function shouldIgnoreContextMenu(tabId: string): boolean {
  const s = sessions.get(tabId);
  if (!s) return false;
  const ignore = shouldSuppressContextMenu(s.modifiedEnterAt, Date.now());
  if (ignore) s.modifiedEnterAt = undefined;
  return ignore;
}

/**
 * Copy the pane's current selection to the clipboard. Resolves to true when
 * something was copied, false when there was no selection.
 */
export async function copySelection(tabId: string): Promise<boolean> {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return false;
  const sel = s.term.getSelection();
  if (!sel) return false;
  await clipboardWrite(sel);
  return true;
}

/**
 * Paste clipboard text into the pane. Goes through `term.paste`, which honors
 * the shell's bracketed-paste mode, rather than writing to the pty directly.
 */
export async function pasteInto(tabId: string): Promise<void> {
  const s = sessions.get(tabId);
  if (!s || s.disposed) return;
  const text = await clipboardRead();
  if (text) s.term.paste(text);
}

/** Result of an agent-run command: captured output plus the shell exit code. */
export interface RunCommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Run a shell command in a pane on the AI agent's behalf and capture its
 * output. This is the P3 execution primitive: the command is injected straight
 * into the pty (same path as `maybeInjectResume`, so it doesn't re-enter the
 * input-line reducer), bracketed by a unique sentinel that also carries `$?`.
 * We tap `pty.onData` until the sentinel appears (or the timeout elapses),
 * then strip escapes, drop the echoed command + sentinel lines, and return the
 * middle. Best-effort by design — output may include prompt noise, which is
 * acceptable as an LLM tool result. The pure parsing lives in `agent-run.ts`.
 *
 * Safety is enforced by the caller (the sidebar shows an approval gate before
 * this is ever invoked); this function does not decide whether to run.
 */
export function runCommandInPane(
  tabId: string,
  command: string,
  timeoutMs = 30000
): Promise<RunCommandResult> {
  const s = sessions.get(tabId);
  if (!s || s.disposed || s.exited) {
    return Promise.resolve({ output: "", exitCode: null, timedOut: false });
  }
  const sentinel = makeSentinel();
  const decoder = new TextDecoder();

  return new Promise<RunCommandResult>((resolve) => {
    let raw = "";
    let settled = false;
    let timer: number | undefined;

    const finish = (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      try {
        sub.dispose();
      } catch {
        /* already disposed */
      }
      resolve(result);
    };

    const sub = s.pty.onData((data: Uint8Array) => {
      raw += decoder.decode(data, { stream: true });
      const parsed = parseResult(stripAnsi(raw), sentinel, command);
      if (parsed.done) {
        finish({
          output: parsed.output,
          exitCode: parsed.exitCode,
          timedOut: false,
        });
      }
    });

    timer = window.setTimeout(() => {
      const parsed = parseResult(stripAnsi(raw), sentinel, command);
      finish({
        output: parsed.done
          ? parsed.output
          : scrubCommandEcho(stripAnsi(raw), command),
        exitCode: parsed.exitCode,
        timedOut: !parsed.done,
      });
    }, timeoutMs);

    // Inject: run the command, then print the sentinel with its exit status.
    // Written directly to the pty so feedInput doesn't capture it as a user
    // "launch token".
    try {
      s.pty.write(`${command}\n${sentinelCommand(sentinel.marker)}\r`);
    } catch {
      finish({ output: "", exitCode: null, timedOut: false });
    }
  });
}


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

/** Clear any active search highlight and refocus the terminal. */export function clearSearch(tabId: string) {
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
export async function persistAllSessions(): Promise<void> {
  await Promise.all(
    Array.from(sessions, ([id, session]) => persist(id, session))
  );
  await Promise.all(
    Array.from(sessions.values(), (session) => session.pty.flushCheckpoint())
  );
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
  // OSC 7 describes the interactive shell/TUI's own cwd (including inside
  // tmux) and is therefore more precise than probing the outer PTY child pid.
  if (s.shellCwd?.trim()) return s.shellCwd;
  const located = locatePane(paneId);
  if (located?.leaf.cwd && located.leaf.cwd !== "~") {
    return located.leaf.cwd;
  }
  const agentSessionId = s.pty.sessionId;
  if (located && agentSessionId) {
    try {
      const response = await transportForWorkspace(located.workspaceId)?.request({
        method: "get_cwd",
        params: { session_id: agentSessionId },
      });
      if (response?.kind === "cwd" && response.data.cwd?.trim()) {
        return response.data.cwd;
      }
    } catch {
      if (isRemoteWorkspace(located.workspaceId)) return s.shellCwd ?? null;
    }
  }
  if (located && isRemoteWorkspace(located.workspaceId)) {
    return s.shellCwd ?? null;
  }
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

/**
 * Inject a queued agent-resume command into a restored pane's shell, exactly
 * once. Fired from the first OSC 7 prompt (shell is ready) or a timeout
 * fallback. We write straight to the pty rather than through xterm, so the
 * injected line never re-enters `feedInput` (which would otherwise re-capture
 * our own command as a "typed" launch token).
 */
function maybeInjectResume(s: Session) {
  if (s.disposed || s.exited) return;
  if (!s.pendingResume || s.resumeInjected) return;
  s.resumeInjected = true;
  const cmd = s.pendingResume;
  s.pendingResume = undefined;
  try {
    s.pty.write(cmd + "\r");
  } catch {
    /* pty already gone */
  }
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
 * Walk every live session, detect whether a coding agent (claude/codex/
 * opencode) is currently running in its shell, and persist enough to resume it
 * on next launch: the agent kind, the literal launch token the user typed
 * (preserving an alias), and the agent's current on-disk session id. When no
 * agent is detected the remembered agent is cleared, so a finished agent isn't
 * spuriously resumed.
 */
let agentSnapshotPromise: Promise<void> | null = null;
let quickAgentSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Env-var name prefixes captured from the running agent process and replayed
 * on resume. Covers the keys an alias-style launcher typically sets to route
 * a coding agent at a custom endpoint / model — ANTHROPIC_* / CLAUDE_* for
 * Claude Code, CODEX_* / OPENAI_* for Codex (OpenAI compat), OPENCODE_* for
 * OpenCode. Captured values may include AUTH_TOKEN-style secrets; persisted at
 * the same security level as the user's shell-rc config.
 */
const AGENT_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "OPENCODE_",
];

function filterAgentEnv(
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (AGENT_ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
/**
 * Run an agent snapshot ~1s after the next call, debounced. Used right after
 * the user submits a shell line so we attribute the launch token early — but
 * we don't rely on it: `s.recentSubmits` keeps a history precisely because a
 * slow-starting agent may not be in the process tree at the 1s mark.
 */
function scheduleQuickAgentSnapshot() {
  if (quickAgentSnapshotTimer) return;
  quickAgentSnapshotTimer = setTimeout(() => {
    quickAgentSnapshotTimer = null;
    void snapshotAllAgents();
  }, 1000);
}
export async function snapshotAllAgents() {
  if (agentSnapshotPromise) return agentSnapshotPromise;
  agentSnapshotPromise = (async () => {
    const entries = Array.from(sessions.entries());
    await Promise.all(
      entries.map(async ([paneId, s]) => {
        if (s.disposed || s.exited || s.pty.readOnly) return;
        const pid = s.pty.pid ?? 0;
        if (pid <= 0 && !s.pty.sessionId) return;

        const located = locatePane(paneId);
        if (!located) return;

        const tree = await paneProcessTree(
          pid,
          located.workspaceId,
          s.pty.sessionId
        );
        const detected = detectAgent(tree);
        if (!detected) {
          // No agent running now — clear any stale remembered agent.
          if (located.leaf.agent) {
            located.store.setPaneAgent(
              located.workspaceId,
              located.tabId,
              paneId,
              undefined
            );
          }
          return;
        }

        const cwd =
          (await getSessionCwd(paneId)) ?? located.leaf.cwd ?? s.shellCwd;
        if (!cwd) return;
        // Pass the detected agent pid so the backend pins the exact session
        // file THIS process holds open — several agents sharing one cwd each
        // resolve to their own id, instead of all racing to the newest file.
        const sessionId = await agentSessionId(
          detected.kind,
          cwd,
          detected.pid,
          located.workspaceId
        );
        if (!sessionId) return;

        // Prefer the literal token the user typed (so an alias survives).
        // classifyCommandToken at submit time only stores tokens whose basename
        // exactly equals the kind (e.g. `claude`), so an alias like
        // `claude-yolo` or `claude-by-kimi-...` won't be in typedCommands.
        // Fall back to scanning recentSubmits newest-first for an entry whose
        // basename contains the detected kind — this both recovers aliases and
        // skips in-TUI Enter submissions (their tokens won't contain the kind
        // name). Cache the hit so subsequent ticks are stable.
        let command = s.typedCommands.get(detected.kind);
        if (!command) {
          for (let i = s.recentSubmits.length - 1; i >= 0; i--) {
            const t = s.recentSubmits[i];
            if (tokenMatchesKind(t, detected.kind)) {
              command = t;
              s.typedCommands.set(detected.kind, t);
              break;
            }
          }
        }
        command = command ?? detected.kind;

        // Capture the agent process's env vars (whitelisted prefixes only) so
        // a wrapper alias that mainly exports env config (BASE_URL, MODEL,
        // AUTH_TOKEN, custom headers) replays correctly on resume even when we
        // never recovered the alias name. Skipping prefixes we don't care about
        // keeps the captured map small and avoids persisting unrelated env.
        const rawEnv = await processEnv(detected.pid, located.workspaceId);
        const env = filterAgentEnv(rawEnv);

        const agent: PaneAgent = {
          kind: detected.kind,
          command,
          sessionId,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
        located.store.setPaneAgent(
          located.workspaceId,
          located.tabId,
          paneId,
          agent
        );
      })
    );
  })().finally(() => {
    agentSnapshotPromise = null;
  });
  return agentSnapshotPromise;
}

/**
 * Ensure the terminal font family is actually loaded before we rebuild the
 * WebGL glyph atlas. xterm rasterizes glyphs lazily into the atlas and never
 * awaits the document FontFaceSet, so on macOS WKWebView — where CoreText
 * loads a freshly-picked font asynchronously — the atlas gets baked with the
 * fallback font and the new family never appears: the terminal looks "stuck"
 * on the old font even though the DOM renderer would reflow once the font
 * arrives. Linux webkit2gtk resolves fonts eagerly via fontconfig, so this is
 * a near-no-op there. `document.fonts.load` resolves (does not reject) for
 * missing families, so an unknown/hand-edited font id won't stall the flow.
 */
function ensureTerminalFontLoaded(
  stack: string,
  fontSize: number
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) {
    return Promise.resolve();
  }
  const first = stack
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!first) return Promise.resolve();
  return document.fonts
    .load(`${fontSize}px "${first}"`)
    .then(
      () => undefined,
      () => undefined
    );
}

/** Bumped on every applyAppearance call so a slow font-load from a stale call
 * can't overwrite a newer one (rapid font switching). */
let applyAppearanceToken = 0;

/**
 * Apply the current appearance settings to the app chrome and every live
 * terminal. Called whenever theme / font / font size changes so the update is
 * instant, without re-spawning shells.
 */
export function applyAppearance() {
  const { theme, font, fontSize } = currentAppearance();
  applyChromeVars(theme.palette);
  applyDividerVars();
  applyUiFontVar();
  const xtermTheme = toXtermTheme(theme.palette);
  const scrollback = resolveScrollback(
    useSettingsStore.getState().scrollbackLines
  );
  const token = ++applyAppearanceToken;
  void ensureTerminalFontLoaded(font.stack, fontSize).then(() => {
    if (token !== applyAppearanceToken) return;
    for (const [, s] of sessions) {
      if (s.disposed) continue;
      s.term.options.theme = xtermTheme;
      s.term.options.fontFamily = font.stack;
      s.term.options.fontSize = fontSize;
      s.term.options.scrollback = scrollback;
      try {
        if (!s.pty.readOnly) s.fit.fit();
      } catch {
        /* not measurable while detached */
      }
      // WebGL caches rendered glyphs in a texture atlas keyed by the old font;
      // changing fontFamily/fontSize alone leaves stale glyphs on screen (the
      // DOM renderer reflows automatically, the GPU one does not). Invalidate
      // the atlas so it's rebuilt with the new font and the terminal redraws.
      // This runs after ensureTerminalFontLoaded so the atlas re-rasterizes
      // with the real glyphs, not the fallback the browser used pre-load.
      try {
        s.webgl?.clearTextureAtlas();
      } catch {
        /* addon disposed after context loss → DOM renderer, nothing to clear */
      }
    }
  });
}

/** Push divider width/color from settings onto CSS variables. */
function applyDividerVars() {
  if (typeof document === "undefined") return;
  const { dividerWidth, dividerColor } = useSettingsStore.getState();
  const r = document.documentElement.style;
  r.setProperty("--divider-width", `${dividerWidth}px`);
  r.setProperty("--divider-color", dividerColor);
}

/** Push the interface (app-chrome) font stack + size onto the --ui-font /
 * --ui-font-size CSS variables. */
function applyUiFontVar() {
  if (typeof document === "undefined") return;
  const { uiFontId, uiFontSize } = useSettingsStore.getState();
  const r = document.documentElement.style;
  r.setProperty("--ui-font", getUiFont(uiFontId).stack);
  r.setProperty("--ui-font-size", `${uiFontSize}px`);
}

// Autosave every 15s and flush once more right before the window goes away,
// so a crash or hard-quit still leaves a recent snapshot to restore. Cwd is
// captured on the same cadence so restoring a session lands in the directory
// the user actually `cd`'d to, not the one the shell was originally spawned in.
if (typeof window !== "undefined") {
  window.setInterval(() => {
    void persistAllSessions();
    void snapshotAllCwds();
    void snapshotAllAgents();
  }, 15_000);
  window.addEventListener("beforeunload", () => {
    void persistAllSessions();
    // beforeunload can't await — fire-and-forget; we rely on the 15s tick to
    // catch the recent state in practice.
    void snapshotAllCwds();
    void snapshotAllAgents();
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
          await Promise.all([snapshotAllCwds(), snapshotAllAgents()]);
          await persistAllSessions();
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

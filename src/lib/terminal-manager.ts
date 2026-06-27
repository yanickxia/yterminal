// terminal-manager: owns the live xterm.js instances and their PTY connections.
//
// Key design (same trick maiTerm/termul use):
//   We DO NOT destroy an xterm instance when the user switches tabs.
//   Each tab keeps a cached Terminal + pty pair; switching tabs just
//   re-parents the cached DOM node into the visible container.
//   That preserves scrollback and avoids re-spawning shells.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, type IPty } from "tauri-pty";

interface Session {
  term: Terminal;
  fit: FitAddon;
  pty: IPty;
  /** the detached DOM element that hosts this terminal */
  el: HTMLDivElement;
  disposed: boolean;
}

const sessions = new Map<string, Session>();

const THEME = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#7aa2f7",
  selectionBackground: "#33467c",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
};

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

  const term = new Terminal({
    fontFamily:
      'JetBrainsMono, Menlo, Monaco, "Cascadia Code", "Courier New", monospace',
    fontSize: 14,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
    scrollback: 10000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

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

  s = { term, fit, pty, el, disposed: false };
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

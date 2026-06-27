// scrollback persistence
//
// Each pane's terminal buffer is serialized (with SGR/colors intact) via
// @xterm/addon-serialize and stashed in localStorage, keyed by pane id.
// On the next launch the cached text is replayed into the fresh xterm so the
// user sees their previous output even though the old PTY is gone.
//
// This is the lightweight tier. A future tier (see README roadmap) moves this
// to a Rust + SQLite store for unbounded history and cross-device sync.

const PREFIX = "yterminal-scrollback:";
// keep each pane's snapshot bounded so localStorage can't blow its ~5MB quota
const MAX_CHARS = 200_000;

function key(paneId: string): string {
  return PREFIX + paneId;
}

/** Persist a serialized buffer snapshot for a pane. */
export function saveScrollback(paneId: string, data: string): void {
  try {
    const trimmed =
      data.length > MAX_CHARS ? data.slice(data.length - MAX_CHARS) : data;
    localStorage.setItem(key(paneId), trimmed);
  } catch {
    /* quota exceeded or storage unavailable — best effort only */
  }
}

/** Load a previously saved snapshot, or "" if none. */
export function loadScrollback(paneId: string): string {
  try {
    return localStorage.getItem(key(paneId)) ?? "";
  } catch {
    return "";
  }
}

/** Drop a pane's snapshot (called when the pane is permanently closed). */
export function clearScrollback(paneId: string): void {
  try {
    localStorage.removeItem(key(paneId));
  } catch {
    /* ignore */
  }
}

/**
 * Garbage-collect snapshots whose panes no longer exist. Call on startup with
 * the set of live pane ids so stale keys don't accumulate forever.
 */
export function pruneScrollback(liveIds: Set<string>): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && !liveIds.has(k.slice(PREFIX.length))) {
        stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

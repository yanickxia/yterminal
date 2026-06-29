// scrollback persistence
//
// Each pane's terminal buffer is serialized (with SGR/colors intact) via
// @xterm/addon-serialize and persisted to a single SQLite database owned by
// the Rust backend. Earlier versions stored these in localStorage and were
// capped at ~5MB per origin; this layer lifts that ceiling (the disk is the
// only limit) and moves writes off the UI thread.
//
// The React lifecycle that consumes these snapshots (PaneTerminal mounting →
// getOrCreateSession → loadScrollback) is synchronous, so we bulk-prime an
// in-memory cache at app startup (`preloadScrollbacks`) and serve reads from
// that. Writes flow back to SQLite asynchronously through Tauri commands.

import { invoke } from "@tauri-apps/api/core";

const LEGACY_PREFIX = "yterminal-scrollback:";

let cache: Map<string, string> = new Map();
let preloaded = false;

/**
 * Bulk-fetch every saved snapshot from SQLite into memory. MUST be called
 * (and awaited) at app startup before any pane mounts — otherwise the
 * synchronous `loadScrollback` will see an empty cache and the user will
 * lose their previous scrollback for that launch.
 *
 * Also performs a one-shot migration of any leftover localStorage entries
 * from the pre-SQLite era; after the migration runs once those keys are gone.
 */
export async function preloadScrollbacks(): Promise<void> {
  if (preloaded) return;
  try {
    const all = await invoke<Record<string, string>>("scrollback_load_all");
    cache = new Map(Object.entries(all ?? {}));
  } catch {
    cache = new Map();
  }
  await migrateFromLocalStorage();
  preloaded = true;
}

async function migrateFromLocalStorage(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LEGACY_PREFIX)) keys.push(k);
  }
  for (const k of keys) {
    const paneId = k.slice(LEGACY_PREFIX.length);
    // SQLite wins ties — we only import keys we haven't already seen there.
    if (!cache.has(paneId)) {
      const data = localStorage.getItem(k);
      if (data) {
        cache.set(paneId, data);
        try {
          await invoke("scrollback_save", { paneId, data });
        } catch {
          /* keep the cache copy at least; next save will retry */
        }
      }
    }
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a previously saved snapshot synchronously from the in-memory cache.
 * Returns "" when the pane has no history (new pane, never persisted, or
 * `preloadScrollbacks` hasn't run yet).
 */
export function loadScrollback(paneId: string): string {
  return cache.get(paneId) ?? "";
}

/**
 * Persist a serialized buffer for a pane. The write goes to the in-memory
 * cache immediately (so a subsequent reload-in-place sees the latest value)
 * and is mirrored to SQLite asynchronously — fire-and-forget is acceptable
 * because the next 15s autosave will write a fresh snapshot anyway.
 */
export function saveScrollback(paneId: string, data: string): void {
  cache.set(paneId, data);
  invoke("scrollback_save", { paneId, data }).catch(() => {
    /* best effort */
  });
}

/** Drop a pane's snapshot. Called when the pane is permanently closed. */
export function clearScrollback(paneId: string): void {
  cache.delete(paneId);
  invoke("scrollback_clear", { paneId }).catch(() => {
    /* ignore */
  });
}

/**
 * Garbage-collect snapshots whose panes no longer exist. Call on startup with
 * the set of live pane ids so stale rows don't accumulate forever.
 */
export function pruneScrollback(liveIds: Set<string>): void {
  for (const id of Array.from(cache.keys())) {
    if (!liveIds.has(id)) cache.delete(id);
  }
  invoke("scrollback_prune", {
    livePaneIds: Array.from(liveIds),
  }).catch(() => {
    /* ignore */
  });
}

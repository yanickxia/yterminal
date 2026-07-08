// activity-store: transient, per-pane "recently produced output" signal.
//
// A pane is "active" for a short window after its PTY emits any bytes. Coding
// agents (Claude Code / Codex / OpenCode) stream output while they work — a
// spinner redraw, tokens, tool logs — and fall silent once they pause at a
// prompt waiting for the operator. So "recent output" is a good live proxy for
// "the agent is executing right now" versus "sitting idle at a prompt".
//
// Deliberately NOT persisted (like attention-store): activity is an ephemeral,
// sub-second concern and a stale flag across relaunches would be misleading.
//
// Keyed by pane id (leaf id). terminal-manager stamps `markActivity(paneId)`
// from `pty.onData`; each stamp (re)arms a per-pane timer that drops the pane
// from the `active` set after IDLE_MS of silence, which re-renders any subscriber
// (status bar, workspace rows) back to the steady "idle" look.

import { create } from "zustand";

/** How long after the last PTY byte a pane still counts as "executing". */
export const ACTIVITY_IDLE_MS = 800;

interface ActivityState {
  /** pane ids that produced PTY output within the last ACTIVITY_IDLE_MS. */
  active: Set<string>;
  /** internal: add/remove — use the imperative helpers below from non-React code. */
  _set: (paneId: string, on: boolean) => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  active: new Set<string>(),
  _set: (paneId, on) =>
    set((s) => {
      if (on === s.active.has(paneId)) return s; // no change
      const active = new Set(s.active);
      if (on) active.add(paneId);
      else active.delete(paneId);
      return { active };
    }),
}));

// Per-pane silence timers. A fresh stamp re-arms the timer; when it fires the
// pane drops out of the active set. Kept module-local so the store stays pure.
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Stamp a pane as having just produced output. Marks it active immediately and
 * schedules it to fall idle after ACTIVITY_IDLE_MS of no further stamps. Called
 * on the hot path (every PTY chunk), so it's intentionally cheap: the store
 * no-ops when the pane is already active, so a burst of chunks only re-arms the
 * timer rather than churning React.
 */
export function markActivity(paneId: string): void {
  useActivityStore.getState()._set(paneId, true);
  const existing = timers.get(paneId);
  if (existing) clearTimeout(existing);
  timers.set(
    paneId,
    setTimeout(() => {
      timers.delete(paneId);
      useActivityStore.getState()._set(paneId, false);
    }, ACTIVITY_IDLE_MS)
  );
}

/** Immediately clear a pane's activity (e.g. on dispose/exit). */
export function clearActivity(paneId: string): void {
  const existing = timers.get(paneId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(paneId);
  }
  useActivityStore.getState()._set(paneId, false);
}

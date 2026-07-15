// activity-store: transient, per-pane "recently produced output" signal, plus a
// sticky "has ever produced output this session" signal.
//
// A pane is "active" for a short window after its PTY emits any bytes. Coding
// agents (Claude Code / Codex / OpenCode) stream output while they work — a
// spinner redraw, tokens, tool logs — and fall silent once they pause at a
// prompt waiting for the operator. So "recent output" is a good live proxy for
// "the agent is executing right now" versus "sitting idle at a prompt".
//
// `everActive` is the sticky companion: once a pane has produced ANY output it
// stays in this set for the rest of the session. It lets the agent roll-up tell
// "worked, now silent → waiting for your input" (everActive && !active) apart
// from "freshly launched / restored, never did anything → truly idle" (neither).
// Without it a paused agent — the most important thing to surface — looks
// identical to a dormant one, which is exactly the bug this fixes.
//
// Deliberately NOT persisted (like attention-store): activity is an ephemeral,
// sub-second concern and a stale flag across relaunches would be misleading.
//
// Keyed by pane id (leaf id). terminal-manager stamps `markActivity(paneId)`
// from `pty.onData`; each stamp (re)arms a per-pane timer that drops the pane
// from the `active` set after IDLE_MS of silence, which re-renders any subscriber
// (status bar, workspace rows) back to the steady "idle" look. `everActive` is
// never auto-cleared — only `clearActivity` (dispose/exit) drops a pane.

import { create } from "zustand";

/** How long after the last PTY byte a pane still counts as "executing". */
export const ACTIVITY_IDLE_MS = 800;

interface ActivityState {
  /** pane ids that produced PTY output within the last ACTIVITY_IDLE_MS. */
  active: Set<string>;
  /** pane ids that have produced PTY output at least once this session. */
  everActive: Set<string>;
  /** internal: add/remove — use the imperative helpers below from non-React code. */
  _set: (paneId: string, on: boolean) => void;
  /** internal: drop a pane from both sets (dispose/exit). */
  _drop: (paneId: string) => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  active: new Set<string>(),
  everActive: new Set<string>(),
  _set: (paneId, on) =>
    set((s) => {
      const inActive = s.active.has(paneId);
      // First-ever output for this pane also stamps the sticky everActive set.
      const newlyEver = on && !s.everActive.has(paneId);
      if (on === inActive && !newlyEver) return s; // no change
      const next: Partial<ActivityState> = {};
      if (on !== inActive) {
        const active = new Set(s.active);
        if (on) active.add(paneId);
        else active.delete(paneId);
        next.active = active;
      }
      if (newlyEver) {
        const everActive = new Set(s.everActive);
        everActive.add(paneId);
        next.everActive = everActive;
      }
      return next;
    }),
  _drop: (paneId) =>
    set((s) => {
      const inActive = s.active.has(paneId);
      const inEver = s.everActive.has(paneId);
      if (!inActive && !inEver) return s;
      const active = new Set(s.active);
      active.delete(paneId);
      const everActive = new Set(s.everActive);
      everActive.delete(paneId);
      return { active, everActive };
    }),
}));

interface ActivityTimerState {
  lastActivityAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

// Per-pane silence deadlines. A pane owns at most one timer even during a busy
// output stream; fresh activity only moves the deadline forward.
const timers = new Map<string, ActivityTimerState>();

export function activityIdleDelay(
  now: number,
  lastActivityAt: number,
  idleMs = ACTIVITY_IDLE_MS
): number | null {
  const remaining = idleMs - (now - lastActivityAt);
  return remaining > 0 ? remaining : null;
}

function scheduleIdleCheck(
  paneId: string,
  state: ActivityTimerState,
  delay: number
): void {
  state.timer = setTimeout(() => {
    if (timers.get(paneId) !== state) return;
    const remaining = activityIdleDelay(Date.now(), state.lastActivityAt);
    if (remaining !== null) {
      scheduleIdleCheck(paneId, state, remaining);
      return;
    }
    timers.delete(paneId);
    useActivityStore.getState()._set(paneId, false);
  }, delay);
}

/**
 * Stamp a pane as having just produced output. Marks it active immediately and
 * schedules it to fall idle after ACTIVITY_IDLE_MS of no further stamps. Called
 * on the hot path (every PTY chunk), so a burst only updates one timestamp; the
 * existing timer observes the newer deadline when it fires.
 */
export function markActivity(paneId: string): void {
  useActivityStore.getState()._set(paneId, true);
  const existing = timers.get(paneId);
  const now = Date.now();
  if (existing) {
    existing.lastActivityAt = now;
    return;
  }
  const state = {
    lastActivityAt: now,
  };
  timers.set(paneId, state);
  scheduleIdleCheck(paneId, state, ACTIVITY_IDLE_MS);
}

/** Immediately clear a pane's activity (e.g. on dispose/exit), including its
 * sticky everActive flag — a disposed pane should leave no trace in either set. */
export function clearActivity(paneId: string): void {
  const existing = timers.get(paneId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    timers.delete(paneId);
  }
  useActivityStore.getState()._drop(paneId);
}

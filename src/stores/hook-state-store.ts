// hook-state-store: transient, per-pane agent run-state reported by Claude Code
// hooks (via the OSC 777 sequence they emit — see agent-hook-osc.ts and the
// OSC 777 handler in terminal-manager.ts).
//
// This is the *authoritative* run-state signal for a Claude agent: the agent
// tells us exactly when it starts a turn (working), finishes and awaits input
// (idle), or blocks on a permission prompt (permission). workspace-agents.ts
// prefers this over the PTY-activity heuristic, which stays as the fallback for
// agents without hooks (Codex/OpenCode) or when a hook is missed. Cleared on
// the `ended` signal and on session dispose, so the pane falls back to the
// heuristic rather than showing a stale state.
//
// Deliberately NOT persisted (same stance as attention-store/activity-store):
// run-state is ephemeral and a stale flag across relaunches would mislead.
//
// Keyed by pane id (leaf id).

import { create } from "zustand";
import type { AgentHookState } from "../lib/agent-hook-osc";

export type { AgentHookState };

interface HookStateStore {
  /** pane id -> the last run-state its agent hook reported */
  state: Map<string, AgentHookState>;
  set: (paneId: string, s: AgentHookState) => void;
  clear: (paneId: string) => void;
}

export const useHookStateStore = create<HookStateStore>((set) => ({
  state: new Map(),
  set: (paneId, s) =>
    set((prev) => {
      if (prev.state.get(paneId) === s) return prev; // no change
      const state = new Map(prev.state);
      state.set(paneId, s);
      return { state };
    }),
  clear: (paneId) =>
    set((prev) => {
      if (!prev.state.has(paneId)) return prev;
      const state = new Map(prev.state);
      state.delete(paneId);
      return { state };
    }),
}));

/** Imperative helpers for non-React callers (terminal-manager). */
export const setHookState = (paneId: string, s: AgentHookState) =>
  useHookStateStore.getState().set(paneId, s);
export const clearHookState = (paneId: string) =>
  useHookStateStore.getState().clear(paneId);

// attention-store: transient, per-pane "needs operator attention" state.
//
// A pane earns attention when its shell rings the terminal bell (BEL / \x07) —
// the signal a coding agent (Claude Code, OpenCode, …) emits when it pauses for
// user input or hits an error it can't recover from on its own. This store is
// deliberately NOT persisted: attention is an ephemeral, session-only concern
// and a stale flag across relaunches would be noise.
//
// Keyed by pane id (leaf id). The status bar rolls these up to the owning tab
// via `tabsNeedingAttention`, which walks the live workspace tree. Attention is
// cleared when the user focuses the pane (or activates the tab) — the act of
// looking at it is the acknowledgement.

import { create } from "zustand";

interface AttentionState {
  /** pane ids currently flagged as awaiting operator action */
  waiting: Set<string>;
  /** flag a pane as needing attention (no-op if already flagged) */
  mark: (paneId: string) => void;
  /** clear a single pane's attention flag */
  clear: (paneId: string) => void;
  /** clear several panes at once (e.g. every leaf of an activated tab) */
  clearMany: (paneIds: string[]) => void;
}

export const useAttentionStore = create<AttentionState>((set) => ({
  waiting: new Set<string>(),
  mark: (paneId) =>
    set((s) => {
      if (s.waiting.has(paneId)) return s;
      const waiting = new Set(s.waiting);
      waiting.add(paneId);
      return { waiting };
    }),
  clear: (paneId) =>
    set((s) => {
      if (!s.waiting.has(paneId)) return s;
      const waiting = new Set(s.waiting);
      waiting.delete(paneId);
      return { waiting };
    }),
  clearMany: (paneIds) =>
    set((s) => {
      let changed = false;
      const waiting = new Set(s.waiting);
      for (const id of paneIds) {
        if (waiting.delete(id)) changed = true;
      }
      return changed ? { waiting } : s;
    }),
}));

/** Imperative helpers for non-React callers (terminal-manager, App shortcuts). */
export const markAttention = (paneId: string) =>
  useAttentionStore.getState().mark(paneId);
export const clearAttention = (paneId: string) =>
  useAttentionStore.getState().clear(paneId);
export const clearAttentionMany = (paneIds: string[]) =>
  useAttentionStore.getState().clearMany(paneIds);

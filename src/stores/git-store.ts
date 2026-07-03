// git-store: transient state for the git sidebar. Holds the git status of the
// active tab's working directory (branch + changed files) plus the panel's
// open/refreshing flags. Not persisted beyond the open toggle (which lives in
// layout-store): the status is a live view of the on-disk repo, recomputed
// whenever the active tab changes or the window regains focus.

import { create } from "zustand";
import { gitStatus, type GitStatus } from "../lib/git";
import { getSessionCwd } from "../lib/terminal-manager";
import { useWorkspaceStore } from "./workspace-store";

const OPEN_KEY = "yterminal.git.open";

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(on: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** Resolve the active tab's active pane id, or null (no shell to inspect). */
function activePaneId(): string | null {
  const s = useWorkspaceStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId);
  if (!tab || tab.file) return null;
  return tab.activePaneId ?? null;
}

const EMPTY: GitStatus = { isRepo: false, branch: "", root: "", files: [] };

interface GitState {
  /** whether the git sidebar is open */
  open: boolean;
  /** git status of the current tab's cwd (EMPTY when not a repo / no shell) */
  status: GitStatus;
  /** the cwd the current status was computed for (for display / dedup) */
  cwd: string | null;
  /** true while a refresh is in flight */
  loading: boolean;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  /**
   * Recompute git status for the active tab's cwd. Cheap and idempotent — safe
   * to call on every tab switch / focus. No-ops (clears to EMPTY) when there's
   * no active shell. Skips the work entirely while the panel is closed.
   */
  refresh: () => Promise<void>;
}

// Guards against overlapping refreshes racing to set stale results: only the
// most recent call's result is applied.
let refreshSeq = 0;

export const useGitStore = create<GitState>((set, get) => ({
  open: loadOpen(),
  status: EMPTY,
  cwd: null,
  loading: false,
  toggleOpen: () => {
    const open = !get().open;
    saveOpen(open);
    set({ open });
    if (open) void get().refresh();
  },
  setOpen: (open) => {
    saveOpen(open);
    set({ open });
    if (open) void get().refresh();
  },
  refresh: async () => {
    if (!get().open) return;
    const seq = ++refreshSeq;
    const paneId = activePaneId();
    if (!paneId) {
      if (seq === refreshSeq) set({ status: EMPTY, cwd: null, loading: false });
      return;
    }
    set({ loading: true });
    const cwd = await getSessionCwd(paneId);
    if (seq !== refreshSeq) return; // superseded by a newer refresh
    if (!cwd) {
      set({ status: EMPTY, cwd: null, loading: false });
      return;
    }
    const status = await gitStatus(cwd);
    if (seq !== refreshSeq) return;
    set({ status, cwd, loading: false });
  },
}));

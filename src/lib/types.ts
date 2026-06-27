// Core data model for yterminal.
// Two-level structure: Workspace (sidebar) -> Tab (terminal session).
// A Pane layer can be inserted later for split-screen; MVP keeps it flat.

export interface Tab {
  id: string;
  /** display name; auto-derived from shell title unless customName is set */
  name: string;
  /** user-overridden name; when set it wins over auto title */
  customName?: string;
  /** working directory the shell was spawned in */
  cwd: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** ordered list of tabs that belong to this workspace */
  tabs: Tab[];
  /** id of the currently visible tab inside this workspace */
  activeTabId: string | null;
}

export interface PersistedState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

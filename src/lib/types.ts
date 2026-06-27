// Core data model for yterminal.
//
// Structure (three levels):
//   Workspace (sidebar)
//     └── Tab[]                each tab owns a recursive split tree
//           └── PaneTree       binary-ish split tree of terminal panes
//                 └── PaneLeaf each leaf == one live shell (terminal session)

/** A leaf node: one terminal/shell. Its id is the terminal session key. */
export interface PaneLeaf {
  type: "leaf";
  id: string;
  /** working directory the shell was spawned in */
  cwd: string;
}

/** An internal node: splits its children along one axis. */
export interface SplitNode {
  type: "split";
  id: string;
  /** "row" = side by side (vertical divider); "column" = stacked (horizontal divider) */
  direction: "row" | "column";
  children: PaneTree[];
  /** size of each child as a percentage; sums to 100; same length as children */
  sizes: number[];
}

export type PaneTree = PaneLeaf | SplitNode;

export interface Tab {
  id: string;
  /** display name; auto-derived from shell title unless customName is set */
  name: string;
  /** user-overridden name; when set it wins over auto title */
  customName?: string;
  /** working directory for the tab's first pane */
  cwd: string;
  /** the split tree rooted here */
  root: PaneTree;
  /** id of the currently focused pane (leaf id) */
  activePaneId: string;
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

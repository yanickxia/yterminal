// Core data model for yterminal.
//
// Structure (three levels):
//   Workspace (sidebar)
//     └── Tab[]                each tab owns a recursive split tree
//           └── PaneTree       binary-ish split tree of terminal panes
//                 └── PaneLeaf each leaf == one live shell (terminal session)

/** Coding agents whose session we can resume on tab restore. */
export type AgentKind = "claude" | "codex" | "opencode";

/**
 * A coding agent that was running in a pane when the app was last persisted.
 * Captured on the autosave tick so a restored tab can respawn the agent and
 * resume its prior session.
 */
export interface PaneAgent {
  kind: AgentKind;
  /** literal launch token as the user typed it, e.g. "cc" or "claude". */
  command: string;
  /** the agent's on-disk session id, resolved at snapshot time. */
  sessionId: string;
}

/** A leaf node: one terminal/shell. Its id is the terminal session key. */
export interface PaneLeaf {
  type: "leaf";
  id: string;
  /** working directory the shell was spawned in */
  cwd: string;
  /**
   * Set when a coding agent was live in this pane at the last snapshot. On
   * restore, the shell respawns and this agent is resumed via its CLI's
   * resume flag. Cleared when no agent is running.
   */
  agent?: PaneAgent;
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
  /** optional emoji/icon shown before the name */
  icon?: string;
  /** working directory for the tab's first pane */
  cwd: string;
  /** the split tree rooted here */
  root: PaneTree;
  /** id of the currently focused pane (leaf id) */
  activePaneId: string;
  /** pinned tabs are rendered before unpinned ones and survive bulk-close */
  pinned?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  /** optional emoji/icon shown before the name (and in the collapsed rail) */
  icon?: string;
  /** ordered list of tabs that belong to this workspace */
  tabs: Tab[];
  /** id of the currently visible tab inside this workspace */
  activeTabId: string | null;
  /** pinned workspaces are rendered before unpinned ones and survive bulk-close */
  pinned?: boolean;
}

export interface PersistedState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

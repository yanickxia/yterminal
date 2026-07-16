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
  /**
   * Selected env vars captured from the running agent process (whitelisted
   * prefixes only — ANTHROPIC_/CLAUDE_/CODEX_/OPENCODE_). Replayed on resume
   * so configuration that lived in an alias function (BASE_URL, AUTH_TOKEN,
   * model overrides) carries over without needing to identify the alias name.
   * Treat as sensitive: AUTH_TOKEN-style values may be present.
   */
  env?: Record<string, string>;
}

/** A leaf node: one terminal/shell. Its id is the terminal session key. */
export interface PaneLeaf {
  type: "leaf";
  id: string;
  /** Stable daemon session UUID; OS pid is never persisted as a handle. */
  sessionId?: string;
  /** working directory the shell was spawned in */
  cwd: string;
  /**
   * Set when a coding agent was live in this pane at the last snapshot. On
   * restore, the shell respawns and this agent is resumed via its CLI's
   * resume flag. Cleared when no agent is running.
   */
  agent?: PaneAgent;
  /** Last daemon-observed OSC 777 status, including while no GUI is attached. */
  runtimeStatus?: "working" | "idle" | "permission";
  /** Last OSC 0/2 title observed by the owner daemon for this specific pane. */
  runtimeTitle?: string;
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

/**
 * A read-only file opened inside a tab. When a Tab carries this, it renders the
 * built-in file viewer instead of its terminal pane tree. The `root` leaf is
 * kept as an inert placeholder so the workspace store's tree-walking code
 * (cwd/agent snapshots, leaf collection, session disposal) keeps treating the
 * tab uniformly without spawning a shell — no PaneTerminal ever mounts for it.
 */
export interface TabFile {
  /** absolute path of the file being viewed */
  path: string;
  /** highlight.js language id; "markdown" is rendered rather than highlighted */
  language: string;
  markdown: boolean;
}

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
  /**
   * When set, this tab is a read-only file viewer rather than a terminal. The
   * `root` leaf still exists but is never mounted as a shell.
   */
  file?: TabFile;
}

export interface Workspace {
  id: string;
  /** Client host-profile id. "local" owns workspaces on this machine. */
  hostId?: string;
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

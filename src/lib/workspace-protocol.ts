import type { PaneAgent, PaneTree, Tab, Workspace } from "./types";

export interface SharedTab
  extends Omit<Tab, "activePaneId" | "pinned"> {}

export interface WorkspaceDocument {
  id: string;
  revision: number;
  name: string;
  icon?: string;
  tabs: SharedTab[];
}

export type PublicPaneAgent = Omit<PaneAgent, "env">;

export type WorkspaceOperation =
  | { op: "rename_workspace"; data: { name: string } }
  | { op: "set_workspace_icon"; data: { icon: string | null } }
  | {
      op: "add_tab";
      data: { tab: SharedTab; index: number | null };
    }
  | { op: "remove_tab"; data: { tab_id: string } }
  | { op: "reorder_tab"; data: { tab_id: string; index: number } }
  | { op: "rename_tab"; data: { tab_id: string; name: string } }
  | { op: "clear_tab_custom_name"; data: { tab_id: string } }
  | { op: "set_tab_auto_name"; data: { tab_id: string; name: string } }
  | {
      op: "set_tab_icon";
      data: { tab_id: string; icon: string | null };
    }
  | {
      op: "split_pane";
      data: {
        tab_id: string;
        target_pane_id: string;
        split_id: string;
        new_pane_id: string;
        direction: "row" | "column";
        cwd: string;
      };
    }
  | { op: "close_pane"; data: { tab_id: string; pane_id: string } }
  | {
      op: "set_split_sizes";
      data: { tab_id: string; split_id: string; sizes: number[] };
    }
  | {
      op: "update_pane_cwd";
      data: { tab_id: string; pane_id: string; cwd: string };
    }
  | {
      op: "bind_session";
      data: { pane_id: string; session_id: string };
    }
  | {
      op: "set_pane_agent";
      data: { pane_id: string; agent: PublicPaneAgent | null };
    }
  | {
      op: "set_pane_runtime_status";
      data: {
        pane_id: string;
        status: "working" | "idle" | "permission" | null;
      };
    }
  | {
      op: "set_pane_runtime_title";
      data: { pane_id: string; title: string | null };
    };

export function toWorkspaceDocument(workspace: Workspace): WorkspaceDocument {
  return {
    id: workspace.id,
    revision: 0,
    name: workspace.name,
    icon: workspace.icon,
    tabs: workspace.tabs.map(toSharedTab),
  };
}

export function toSharedTab(tab: Tab): SharedTab {
  const { activePaneId: _active, pinned: _pinned, ...shared } = tab;
  return {
    ...shared,
    root: stripAgentSecrets(shared.root),
  };
}

function stripAgentSecrets(tree: PaneTree): PaneTree {
  if (tree.type === "leaf") {
    if (!tree.agent) return { ...tree };
    const { env: _secret, ...agent } = tree.agent;
    return { ...tree, agent };
  }
  return {
    ...tree,
    children: tree.children.map(stripAgentSecrets),
  };
}

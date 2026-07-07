// Pure roll-up from per-pane agent snapshots + attention flags to the coding
// agents running inside a workspace. No React / no store — just a tree walk so
// the workspace status bar and its unit test share one implementation. Mirrors
// the shape of attention.ts.
//
// Two live signals feed this (both already maintained elsewhere):
//   * PaneLeaf.agent — set by terminal-manager's snapshotAllAgents() every ~15s
//     when a coding agent (claude/codex/opencode) is detected in a pane's
//     process tree; cleared when the agent exits. Presence == "an agent is
//     running in this pane".
//   * the `waiting` set — pane ids that rang the terminal bell while unfocused
//     (an agent pausing for input / finishing / erroring). Presence == "needs
//     the operator". This is our equivalent of cmux's `needsInput` state.
//
// An agent pane is therefore classified as:
//   "attention" — agent present AND pane is in `waiting` (blocked on the user)
//   "running"   — agent present, not waiting (actively working / at rest)

import type { AgentKind, Workspace } from "./types";
import { collectLeaves } from "./pane-tree";

// Re-export so the status-bar UI can pull the agent-kind union from the same
// module it gets the summary from.
export type { AgentKind };

/** Run-state of a single agent pane, coarsest-to-finest for the status bar. */
export type AgentRunState = "running" | "attention";

/** One coding agent detected in a workspace, with its owning tab/pane. */
export interface WorkspaceAgentEntry {
  kind: AgentKind;
  /** the launch command as the user typed it (alias-preserving). */
  command: string;
  tabId: string;
  /** display label for the owning tab (customName wins over auto name). */
  tabName: string;
  tabIcon?: string;
  /** the pane id running the agent — used to jump straight to it. */
  paneId: string;
  state: AgentRunState;
}

/** Aggregate summary for a workspace's status bar. */
export interface WorkspaceAgentSummary {
  entries: WorkspaceAgentEntry[];
  /** total agents running in the workspace. */
  total: number;
  /** how many are blocked waiting for the operator. */
  attention: number;
}

/**
 * Roll every running agent in a workspace up into a flat, stably-ordered list
 * (workspace → tab → left-to-right pane order) plus aggregate counts. File
 * tabs are skipped (their inert leaf never runs a shell). An agent pane that
 * is also in `waiting` is flagged "attention"; otherwise "running".
 */
export function workspaceAgentSummary(
  workspace: Workspace | undefined,
  waiting: Set<string>
): WorkspaceAgentSummary {
  const entries: WorkspaceAgentEntry[] = [];
  if (!workspace) return { entries, total: 0, attention: 0 };
  let attention = 0;
  for (const tab of workspace.tabs) {
    if (tab.file) continue;
    for (const leaf of collectLeaves(tab.root)) {
      if (!leaf.agent) continue;
      const state: AgentRunState = waiting.has(leaf.id)
        ? "attention"
        : "running";
      if (state === "attention") attention++;
      entries.push({
        kind: leaf.agent.kind,
        command: leaf.agent.command,
        tabId: tab.id,
        tabName: tab.customName?.trim() || tab.name,
        tabIcon: tab.icon,
        paneId: leaf.id,
        state,
      });
    }
  }
  return { entries, total: entries.length, attention };
}

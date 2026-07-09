// Pure roll-up from per-pane agent snapshots + attention flags + activity flags
// to the coding agents running inside a workspace. No React / no store — just a
// tree walk so the workspace status bar, the sidebar rows, and their unit tests
// share one implementation. Mirrors the shape of attention.ts.
//
// Three live signals feed this (all maintained elsewhere):
//   * PaneLeaf.agent — set by terminal-manager's snapshotAllAgents() every ~15s
//     when a coding agent (claude/codex/opencode) is detected in a pane's
//     process tree; cleared when the agent exits. Presence == "an agent is
//     running in this pane".
//   * the `waiting` set (attention-store) — pane ids that rang the terminal bell
//     while unfocused (an agent pausing for input / finishing / erroring).
//     Presence == "needs the operator". Our equivalent of cmux's `needsInput`.
//   * the `active` set (activity-store) — pane ids that produced PTY output in
//     the last ~800ms. Presence == "the agent is streaming output right now".
//
// An agent pane is therefore classified, in precedence order:
//   "attention" — agent present AND in `waiting`   (blocked on the user)
//   "executing" — agent present, not waiting, AND in `active` (working now)
//   "idle"      — agent present, not waiting, not active (at rest / at a prompt)

import type { AgentKind, Workspace } from "./types";
import { collectLeaves } from "./pane-tree";

// Re-export so the status-bar UI can pull the agent-kind union from the same
// module it gets the summary from.
export type { AgentKind };

/** Run-state of a single agent pane. */
export type AgentRunState = "executing" | "idle" | "attention";

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
  /** how many are actively producing output right now. */
  executing: number;
}

/** Classify one agent pane from the two ephemeral signal sets. */
function classify(
  paneId: string,
  waiting: Set<string>,
  active: Set<string>
): AgentRunState {
  if (waiting.has(paneId)) return "attention";
  if (active.has(paneId)) return "executing";
  return "idle";
}

/**
 * Roll every running agent in a workspace up into a flat, stably-ordered list
 * (workspace → tab → left-to-right pane order) plus aggregate counts. File
 * tabs are skipped (their inert leaf never runs a shell). Each agent pane is
 * classified attention > executing > idle (see module header).
 */
export function workspaceAgentSummary(
  workspace: Workspace | undefined,
  waiting: Set<string>,
  active: Set<string> = new Set()
): WorkspaceAgentSummary {
  const entries: WorkspaceAgentEntry[] = [];
  if (!workspace) return { entries, total: 0, attention: 0, executing: 0 };
  let attention = 0;
  let executing = 0;
  for (const tab of workspace.tabs) {
    if (tab.file) continue;
    for (const leaf of collectLeaves(tab.root)) {
      if (!leaf.agent) continue;
      const state = classify(leaf.id, waiting, active);
      if (state === "attention") attention++;
      else if (state === "executing") executing++;
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
  return { entries, total: entries.length, attention, executing };
}

/**
 * Per-workspace agent status for the sidebar rows. One entry per workspace that
 * has at least one running agent, carrying the total agent count and the single
 * most-urgent state across its panes (attention > executing > idle) so a row
 * can paint one dot. Independent of which workspace is active, so every row can
 * show its own indicator at a glance (cmux-style).
 */
export interface WorkspaceAgentStatus {
  /** total agents running in the workspace. */
  total: number;
  /** the most urgent state among the workspace's agent panes. */
  state: AgentRunState;
}

/**
 * Map each workspace id to its aggregate agent status. Only workspaces with a
 * *running* agent are included: an agent that is merely present but idle (at
 * its prompt, producing no output) is omitted, so `.has(id)` gates the dot to
 * "an agent is actively working / needs you" rather than "an agent exists".
 * Workspaces whose agents are all idle are dropped entirely.
 */
export function workspacesAgentStatus(
  workspaces: Workspace[],
  waiting: Set<string>,
  active: Set<string>
): Map<string, WorkspaceAgentStatus> {
  const out = new Map<string, WorkspaceAgentStatus>();
  const rank: Record<AgentRunState, number> = {
    idle: 0,
    executing: 1,
    attention: 2,
  };
  for (const ws of workspaces) {
    let total = 0;
    let best: AgentRunState = "idle";
    for (const tab of ws.tabs) {
      if (tab.file) continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (!leaf.agent) continue;
        total++;
        const state = classify(leaf.id, waiting, active);
        if (rank[state] > rank[best]) best = state;
      }
    }
    // Only surface a dot when an agent is actually running (executing) or
    // blocked on the user (attention). All-idle workspaces show nothing.
    if (total > 0 && best !== "idle") out.set(ws.id, { total, state: best });
  }
  return out;
}

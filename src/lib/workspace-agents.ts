import type { AgentKind, PaneLeaf, Workspace } from "./types";
import type { PtyAgentObservation } from "./agent-pty";
import { persistedPtyObservation } from "./agent-pty";
import { collectLeaves } from "./pane-tree";

export type { AgentKind };
export type AgentRunState = PtyAgentObservation["state"];

export const AGENT_STATE_RANK: Record<AgentRunState, number> = {
  unknown: 0, waiting: 1, executing: 2, attention: 3,
};

export interface WorkspaceAgentEntry {
  kind: AgentKind;
  command: string;
  tabId: string;
  tabName: string;
  agentName?: string;
  tabIcon?: string;
  paneId: string;
  state: AgentRunState;
  reason: string;
}

export interface WorkspaceAgentSummary {
  entries: WorkspaceAgentEntry[];
  total: number;
  attention: number;
  executing: number;
  waiting: number;
}

export function classify(
  leaf: PaneLeaf,
  observations: ReadonlyMap<string, PtyAgentObservation> = new Map()
): PtyAgentObservation {
  if (leaf.runtimeStatus === "background") return { state: "unknown", source: "unknown", reason: "Agent process is alive in the background; current screen belongs to another job" };
  const observed = observations.get(leaf.id);
  const local = observed?.instanceId && observed.instanceId !== leaf.agent?.instanceId ? undefined : observed;
  const owner = persistedPtyObservation(leaf);
  return local && local.state !== "unknown" ? local : owner.state !== "unknown" ? owner : local ?? owner;
}

export function workspaceAgentSummary(
  workspace: Workspace | undefined,
  observations: ReadonlyMap<string, PtyAgentObservation> = new Map()
): WorkspaceAgentSummary {
  const entries: WorkspaceAgentEntry[] = [];
  const summary = { entries, total: 0, attention: 0, executing: 0, waiting: 0 };
  if (!workspace) return summary;
  for (const tab of workspace.tabs) {
    if (tab.file) continue;
    for (const leaf of collectLeaves(tab.root)) {
      if (!leaf.agent) continue;
      const observation = classify(leaf, observations);
      entries.push({
        kind: leaf.agent.kind,
        command: leaf.agent.command,
        tabId: tab.id,
        tabName: tab.customName?.trim() || tab.name,
        agentName: leaf.agentName,
        tabIcon: tab.icon,
        paneId: leaf.id,
        state: observation.state,
        reason: observation.reason,
      });
      summary.total++;
      if (observation.state === "attention") summary.attention++;
      if (observation.state === "executing") summary.executing++;
      if (observation.state === "waiting") summary.waiting++;
    }
  }
  return summary;
}

export interface WorkspaceAgentStatus { total: number; state: AgentRunState; }

export function workspacesAgentStatus(
  workspaces: Workspace[],
  observations: ReadonlyMap<string, PtyAgentObservation> = new Map()
): Map<string, WorkspaceAgentStatus> {
  const out = new Map<string, WorkspaceAgentStatus>();
  for (const workspace of workspaces) {
    const summary = workspaceAgentSummary(workspace, observations);
    if (!summary.total) continue;
    let state: AgentRunState = "unknown";
    for (const entry of summary.entries) {
      if (AGENT_STATE_RANK[entry.state] > AGENT_STATE_RANK[state]) state = entry.state;
    }
    out.set(workspace.id, { total: summary.total, state });
  }
  return out;
}

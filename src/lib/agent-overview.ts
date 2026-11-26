import type { Workspace } from "./types";
import type { PtyAgentObservation } from "./agent-pty";
import { workspaceAgentSummary, AGENT_STATE_RANK, type WorkspaceAgentEntry } from "./workspace-agents";

export const OVERVIEW_COLS = 3;

export interface AgentOverviewEntry extends WorkspaceAgentEntry {
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
  hostId: string;
}

export function collectAllAgents(
  workspaces: Workspace[],
  observations: ReadonlyMap<string, PtyAgentObservation> = new Map()
): AgentOverviewEntry[] {
  const entries = workspaces.flatMap((workspace) =>
    workspaceAgentSummary(workspace, observations).entries.map((entry) => ({
      ...entry,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceIcon: workspace.icon,
      hostId: workspace.hostId ?? "local",
    }))
  );
  return entries.sort((a, b) => AGENT_STATE_RANK[b.state] - AGENT_STATE_RANK[a.state]);
}

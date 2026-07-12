// 跨所有 workspace 的全局 agent 聚合，供 Agent 透视图浮层使用。纯函数、无 IO、
// 无 React —— 与 workspace-agents.ts 共享同一套 classify 判定，只是把范围从
// 单个 workspace 扩到全部，并按紧急度排序（需要关注的排最前）。

import type { Workspace } from "./types";
import type { AgentHookState } from "./agent-hook-osc";
import type { WorkspaceAgentEntry } from "./workspace-agents";
import { classify, AGENT_STATE_RANK } from "./workspace-agents";
import { collectLeaves } from "./pane-tree";

/** 透视图卡片网格的固定列数。用固定值让键盘方向键的行/列换算确定、可测。 */
export const OVERVIEW_COLS = 3;

/** 一个 agent 条目，在 WorkspaceAgentEntry 基础上带上归属 workspace 信息。 */
export interface AgentOverviewEntry extends WorkspaceAgentEntry {
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
}

/**
 * 跨所有 workspace 收集每一个运行着 coding agent 的 pane（含空闲）。file tab
 * 跳过。用共享的 classify 判定 state，然后按 attention > executing > waiting >
 * idle 分组降序排序；同组内保持 workspace→tab→pane 的稳定遍历顺序。
 */
export function collectAllAgents(
  workspaces: Workspace[],
  waiting: Set<string>,
  active: Set<string>,
  everActive: Set<string>,
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): AgentOverviewEntry[] {
  const entries: AgentOverviewEntry[] = [];
  for (const ws of workspaces) {
    for (const tab of ws.tabs) {
      if (tab.file) continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (!leaf.agent) continue;
        const state = classify(
          leaf.id,
          waiting,
          active,
          everActive,
          focusedPaneId,
          hookState
        );
        entries.push({
          kind: leaf.agent.kind,
          command: leaf.agent.command,
          tabId: tab.id,
          tabName: tab.customName?.trim() || tab.name,
          tabIcon: tab.icon,
          paneId: leaf.id,
          state,
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceIcon: ws.icon,
        });
      }
    }
  }
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => AGENT_STATE_RANK[b.e.state] - AGENT_STATE_RANK[a.e.state] || a.i - b.i)
    .map(({ e }) => e);
}

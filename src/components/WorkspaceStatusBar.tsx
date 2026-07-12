// WorkspaceStatusBar: a slim strip under the terminal area summarizing the
// coding agents running in the active workspace — inspired by cmux's per-
// workspace agent status. Each agent gets a chip showing its kind and owning
// tab, plus a status dot:
//   * executing (blinking green) — the agent is streaming output right now
//   * idle (steady dim green)    — the agent is running but at rest / at a prompt
//   * attention (pulsing amber)  — blocked waiting for the operator (bell)
// Clicking a chip jumps to that tab/pane and acknowledges its attention flag.
//
// Purely a read-only view over three live signals the app already maintains:
//   * PaneLeaf.agent (snapshotAllAgents, ~15s) — which panes run an agent
//   * attention-store `waiting` — which panes rang the bell (need input)
//   * activity-store `active` — which panes produced PTY output in the last ~800ms
// Renders nothing when the workspace has no running agents, so it stays out of
// the way until there's something to report.

import { useWorkspaceStore } from "../stores/workspace-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { useActivityStore } from "../stores/activity-store";
import { useHookStateStore } from "../stores/hook-state-store";
import {
  workspaceAgentSummary,
  type AgentKind,
  type AgentRunState,
} from "../lib/workspace-agents";
import { collectLeafIds } from "../lib/pane-tree";
import { scrollSessionToBottom } from "../lib/terminal-manager";
import { useFocusedPaneId } from "../lib/use-focused-pane";

/** Short display label per agent kind. */
const KIND_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
};

/** Human words for each run-state, used in chip tooltips. */
const STATE_WORD: Record<AgentRunState, string> = {
  executing: "working",
  waiting: "waiting for input",
  idle: "idle",
  attention: "waiting for you",
};

export function WorkspaceStatusBar({
  onOpenOverview,
}: {
  onOpenOverview: () => void;
}) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const waiting = useAttentionStore((s) => s.waiting);
  const active = useActivityStore((s) => s.active);
  const everActive = useActivityStore((s) => s.everActive);
  const hookState = useHookStateStore((s) => s.state);
  const focusedPaneId = useFocusedPaneId();

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const summary = workspaceAgentSummary(
    workspace,
    waiting,
    active,
    everActive,
    focusedPaneId,
    hookState
  );
  if (summary.total === 0) return null;

  // Jump to the pane running an agent: activate its tab + pane, acknowledge the
  // whole tab's attention, and scroll the pane to the newest output (the prompt
  // the agent is blocking on).
  function jumpTo(tabId: string, paneId: string) {
    if (!workspace) return;
    setActiveTab(workspace.id, tabId);
    setActivePane(workspace.id, tabId, paneId);
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (tab) clearAttentionMany(collectLeafIds(tab.root));
    scrollSessionToBottom(paneId);
  }

  return (
    <div className="ws-statusbar" role="status" aria-live="polite">
      <span className="ws-statusbar-summary">
        <span className="ws-statusbar-title">Agents</span>
        <span className="ws-statusbar-count">{summary.total}</span>
        {summary.attention + summary.waiting > 0 && (
          <span className="ws-statusbar-attention">
            {summary.attention + summary.waiting} waiting
          </span>
        )}
      </span>
      <button
        type="button"
        className="ws-statusbar-overview"
        title="打开 Agent 透视图 (⌘O)"
        onClick={onOpenOverview}
      >
        ⤢
      </button>
      <div className="ws-statusbar-chips">
        {summary.entries.map((e) => (
          <button
            key={e.paneId}
            type="button"
            className={"ws-agent-chip " + e.state}
            title={`${KIND_LABEL[e.kind]} in ${e.tabName} — ${
              STATE_WORD[e.state]
            } (${e.command})`}
            onClick={() => jumpTo(e.tabId, e.paneId)}
          >
            <span className={"ws-agent-dot " + e.state} aria-hidden="true" />
            <span className="ws-agent-kind">{KIND_LABEL[e.kind]}</span>
            {e.tabIcon && <span className="ws-agent-icon">{e.tabIcon}</span>}
            <span className="ws-agent-tab">{e.tabName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

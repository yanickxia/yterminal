// WorkspaceStatusBar: a slim strip under the terminal area summarizing the
// coding agents running in the active workspace — inspired by cmux's per-
// workspace agent status. Each agent gets a chip showing its kind and owning
// tab; a chip pulses when its pane is blocked waiting for the operator (bell).
// Clicking a chip jumps to that tab/pane and acknowledges its attention flag.
//
// Purely a read-only view over two live signals the app already maintains:
//   * PaneLeaf.agent (snapshotAllAgents, ~15s) — which panes run an agent
//   * attention-store `waiting` — which panes rang the bell (need input)
// Renders nothing when the workspace has no running agents, so it stays out of
// the way until there's something to report.

import { useWorkspaceStore } from "../stores/workspace-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { workspaceAgentSummary, type AgentKind } from "../lib/workspace-agents";
import { collectLeafIds } from "../lib/pane-tree";
import { scrollSessionToBottom } from "../lib/terminal-manager";

/** Short display label per agent kind. */
const KIND_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
};

export function WorkspaceStatusBar() {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const waiting = useAttentionStore((s) => s.waiting);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const summary = workspaceAgentSummary(workspace, waiting);
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
        {summary.attention > 0 && (
          <span className="ws-statusbar-attention">
            {summary.attention} waiting
          </span>
        )}
      </span>
      <div className="ws-statusbar-chips">
        {summary.entries.map((e) => (
          <button
            key={e.paneId}
            type="button"
            className={
              "ws-agent-chip" + (e.state === "attention" ? " attention" : "")
            }
            title={
              e.state === "attention"
                ? `${KIND_LABEL[e.kind]} in ${e.tabName} — waiting for you`
                : `${KIND_LABEL[e.kind]} running in ${e.tabName} (${e.command})`
            }
            onClick={() => jumpTo(e.tabId, e.paneId)}
          >
            <span
              className={
                "ws-agent-dot" + (e.state === "attention" ? " attention" : "")
              }
              aria-hidden="true"
            />
            <span className="ws-agent-kind">{KIND_LABEL[e.kind]}</span>
            {e.tabIcon && <span className="ws-agent-icon">{e.tabIcon}</span>}
            <span className="ws-agent-tab">{e.tabName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// AttentionBar: a thin status strip beneath the tab bar that surfaces any tab
// whose pane rang the terminal bell while unfocused — the moment a coding agent
// (Claude Code, OpenCode, …) pauses for input or errors out. Clicking a chip
// jumps to that workspace/tab and clears its flag. Renders nothing when no tab
// is waiting, so it costs zero vertical space in the common case.

import { useWorkspaceStore } from "../stores/workspace-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { tabsNeedingAttention } from "../lib/attention";
import { collectLeafIds } from "../lib/pane-tree";

export function AttentionBar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const waiting = useAttentionStore((s) => s.waiting);

  const entries = tabsNeedingAttention(workspaces, waiting);
  if (entries.length === 0) return null;

  function go(workspaceId: string, tabId: string) {
    setActiveWorkspace(workspaceId);
    setActiveTab(workspaceId, tabId);
    // acknowledge: drop the flag for every pane in the activated tab
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (tab) clearAttentionMany(collectLeafIds(tab.root));
  }

  return (
    <div className="attention-bar" role="status" aria-live="polite">
      <span className="attention-bar-label">
        Waiting for you
        {entries.length > 1 ? ` (${entries.length})` : ""}:
      </span>
      <div className="attention-bar-chips">
        {entries.map((e) => (
          <button
            key={e.tabId}
            type="button"
            className="attention-chip"
            title={`${e.workspaceName} › ${e.tabName} needs attention`}
            onClick={() => go(e.workspaceId, e.tabId)}
          >
            <span className="attention-chip-dot" aria-hidden="true" />
            {e.tabIcon && (
              <span className="attention-chip-icon">{e.tabIcon}</span>
            )}
            <span className="attention-chip-name">{e.tabName}</span>
            {e.count > 1 && (
              <span className="attention-chip-count">{e.count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useAgentPtyStore } from "../stores/agent-pty-store";
import { useHostStore } from "../stores/host-store";
import { clearAttentionMany } from "../stores/attention-store";
import { collectAllAgents, type AgentOverviewEntry } from "../lib/agent-overview";
import { collectLeafIds } from "../lib/pane-tree";
import { focusSession, scrollSessionToBottom } from "../lib/terminal-manager";
import type { AgentKind } from "../lib/types";

const kindLabel: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };
const kindGlyph: Record<AgentKind, string> = { claude: "CC", codex: "CX", opencode: "OC" };
const stateLabel = { executing: "Working", waiting: "Input", attention: "Confirm", unknown: "Unknown" };
type Filter = "all" | "working" | "waiting";

export function AgentsSidebar({ hostLabels }: { hostLabels: ReadonlyMap<string, string> }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const observations = useAgentPtyStore((s) => s.observations);
  const hostRuntime = useHostStore((s) => s.runtime);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const entries = useMemo(() => collectAllAgents(workspaces, observations), [workspaces, observations]);
  const online = (entry: AgentOverviewEntry) => entry.hostId === "local" || hostRuntime[entry.hostId]?.status === "online";
  const working = entries.filter((entry) => online(entry) && entry.state === "executing").length;
  const waiting = entries.filter((entry) => online(entry) && (entry.state === "waiting" || entry.state === "attention")).length;
  const visible = entries.filter((entry) => filter === "all" || (online(entry) && (filter === "working" ? entry.state === "executing" : entry.state === "waiting" || entry.state === "attention")));

  function jump(entry: AgentOverviewEntry) {
    const store = useWorkspaceStore.getState();
    store.setActiveWorkspace(entry.workspaceId);
    store.setActiveTab(entry.workspaceId, entry.tabId);
    store.setActivePane(entry.workspaceId, entry.tabId, entry.paneId);
    const tab = workspaces.find((workspace) => workspace.id === entry.workspaceId)?.tabs.find((tab) => tab.id === entry.tabId);
    if (tab) clearAttentionMany(collectLeafIds(tab.root));
    scrollSessionToBottom(entry.paneId);
    requestAnimationFrame(() => {
      const current = useWorkspaceStore.getState().activeWorkspace();
      const activeTab = current?.tabs.find((tab) => tab.id === current.activeTabId);
      if (activeTab?.activePaneId === entry.paneId) focusSession(entry.paneId);
    });
  }

  return (
    <section className="agents-sidebar" aria-label="Agents">
      <button className="agents-sidebar-heading" type="button" aria-expanded={!collapsed} aria-controls="agents-sidebar-list" onClick={() => setCollapsed(!collapsed)}>
        <svg className={"agents-sidebar-chevron" + (collapsed ? " collapsed" : "")} viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
        <span>AGENTS</span><span className="agents-sidebar-count">{entries.length}</span>
        {working > 0 && <span className="agents-sidebar-live">{working} working</span>}
      </button>
      <div id="agents-sidebar-list" hidden={collapsed}>
        <div className="agents-sidebar-filters" aria-label="Filter agents">
          {([ ["all", "All", entries.length], ["working", "Working", working], ["waiting", "Waiting", waiting] ] as const).map(([value, label, count]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>
          ))}
        </div>
        <div className="agents-sidebar-entries">
          {visible.map((entry) => {
            const connected = online(entry);
            const state = connected ? entry.state : "unknown";
            const workspace = workspaces.find((workspace) => workspace.id === entry.workspaceId);
            const tab = workspace?.tabs.find((tab) => tab.id === entry.tabId);
            const selected = activeWorkspaceId === entry.workspaceId && workspace?.activeTabId === entry.tabId && tab?.activePaneId === entry.paneId;
            return <button key={`${entry.hostId}:${entry.paneId}`} type="button" className={"agents-sidebar-entry" + (selected ? " selected" : "")} aria-current={selected ? "location" : undefined} onClick={() => jump(entry)} title={`${kindLabel[entry.kind]} · ${entry.workspaceName} / ${entry.tabName}\n${connected ? entry.reason : "Host is offline; last detected agent"}`}>
              <span className={`agents-sidebar-glyph ${entry.kind}`}>{kindGlyph[entry.kind]}</span>
              <span className="agents-sidebar-copy">
                <span className="agents-sidebar-name">{kindLabel[entry.kind]} · {entry.tabName}</span>
                <span className="agents-sidebar-location">{entry.workspaceName} / {hostLabels.get(entry.hostId) ?? "Remote"}</span>
              </span>
              <span className={`agents-sidebar-state ${state}`}><span className="agents-sidebar-dot" />{connected ? stateLabel[state] : "Offline"}</span>
            </button>;
          })}
          {visible.length === 0 && <p className="agents-sidebar-empty">{entries.length ? "No agents in this category" : "Run Claude, Codex or OpenCode in a terminal"}</p>}
        </div>
      </div>
    </section>
  );
}

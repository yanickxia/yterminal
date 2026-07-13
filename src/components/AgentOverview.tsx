// 全局 Agent 透视图浮层：跨所有 workspace 以卡片网格展示每一个运行着 coding
// agent 的 pane（含空闲），每卡内嵌该 pane 的终端尾部静态文本快照。点击 / 回车
// 跳转到该 agent（切换 workspace/tab/pane、清除 attention、滚到底）并关闭浮层。
//
// 预览是静态快照：仅在挂载时对每个 pane 抓一次 getSessionText，取尾部若干行。
// 复用 WorkspacePalette 的 .modal-backdrop 浮层范式；网格用固定列数 OVERVIEW_COLS
// 以让方向键的行/列换算确定。

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { useActivityStore } from "../stores/activity-store";
import { useHookStateStore } from "../stores/hook-state-store";
import { useFocusedPaneId } from "../lib/use-focused-pane";
import { collectAllAgents, OVERVIEW_COLS } from "../lib/agent-overview";
import { type AgentKind } from "../lib/workspace-agents";
import { collectLeafIds } from "../lib/pane-tree";
import { getSessionText, scrollSessionToBottom } from "../lib/terminal-manager";

const KIND_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
};

/** 预览取终端尾部的行数（长预览）。 */
const PREVIEW_LINES = 24;

export function AgentOverview({ onClose }: { onClose: () => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const waiting = useAttentionStore((s) => s.waiting);
  const active = useActivityStore((s) => s.active);
  const everActive = useActivityStore((s) => s.everActive);
  const hookState = useHookStateStore((s) => s.state);
  const focusedPaneId = useFocusedPaneId();

  const entries = useMemo(
    () =>
      collectAllAgents(
        workspaces,
        waiting,
        active,
        everActive,
        focusedPaneId,
        hookState
      ),
    [workspaces, waiting, active, everActive, focusedPaneId, hookState]
  );

  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 静态快照：仅挂载时抓一次每个 pane 的终端尾部文本。
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      const text = getSessionText(e.paneId);
      const tail = text.split("\n").slice(-PREVIEW_LINES).join("\n").trim();
      map.set(e.paneId, tail);
    }
    return map;
    // 故意只依赖挂载（entries 首帧）——不随信号变化重抓。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载后聚焦浮层容器以接管键盘。
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // cursor 越界时收敛（entries 变短的极端情况）。
  useEffect(() => {
    if (cursor > entries.length - 1) setCursor(Math.max(0, entries.length - 1));
  }, [entries.length, cursor]);

  // 保持选中卡片可见。
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function jumpTo(e: (typeof entries)[number]) {
    setActiveWorkspace(e.workspaceId);
    setActiveTab(e.workspaceId, e.tabId);
    setActivePane(e.workspaceId, e.tabId, e.paneId);
    const targetWs = workspaces.find((w) => w.id === e.workspaceId);
    const targetTab = targetWs?.tabs.find((t) => t.id === e.tabId);
    if (targetTab) clearAttentionMany(collectLeafIds(targetTab.root));
    scrollSessionToBottom(e.paneId);
    onClose();
  }

  function onKeyDown(ev: React.KeyboardEvent) {
    if (!entries.length) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
      return;
    }
    const n = entries.length;
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const pick = entries[cursor];
      if (pick) jumpTo(pick);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      setCursor((c) => (c + 1) % n);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      setCursor((c) => (c - 1 + n) % n);
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setCursor((c) => Math.min(n - 1, c + OVERVIEW_COLS));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setCursor((c) => Math.max(0, c - OVERVIEW_COLS));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="agent-overview"
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="agent-overview-head">
          <span className="agent-overview-title">Agents</span>
          <span className="agent-overview-count">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="agent-overview-empty">当前没有运行中的 agent</div>
        ) : (
          <div
            className="agent-overview-grid"
            ref={listRef}
            style={{ gridTemplateColumns: `repeat(${OVERVIEW_COLS}, 1fr)` }}
          >
            {entries.map((e, i) => (
              <button
                key={e.paneId}
                type="button"
                className={
                  "agent-card " + e.state + (i === cursor ? " active" : "")
                }
                aria-label={`${KIND_LABEL[e.kind]} in ${e.tabName}, ${e.workspaceName}`}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  jumpTo(e);
                }}
              >
                <div className="agent-card-head">
                  <span className={"agent-card-dot " + e.state} aria-hidden="true" />
                  <span className="agent-card-kind">{KIND_LABEL[e.kind]}</span>
                  <span className="agent-card-ws">
                    {e.workspaceIcon && (
                      <span className="agent-card-ws-icon">{e.workspaceIcon}</span>
                    )}
                    {e.workspaceName}
                  </span>
                </div>
                <div className="agent-card-tab">
                  {e.tabIcon && <span className="agent-card-tab-icon">{e.tabIcon}</span>}
                  {e.tabName}
                </div>
                <pre className="agent-card-preview" aria-hidden="true">
                  {previews.get(e.paneId) || "（无输出）"}
                </pre>
              </button>
            ))}
          </div>
        )}
        <div className="agent-overview-hint">
          ↑↓←→ navigate · ↵ jump · esc close
        </div>
      </div>
    </div>
  );
}

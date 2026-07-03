import { useState, useRef, type MouseEvent } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useAiStore } from "../stores/ai-store";
import { useGitStore } from "../stores/git-store";
import { useLayoutStore } from "../stores/layout-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { tabsNeedingAttention } from "../lib/attention";
import { SettingsPanel } from "./SettingsPanel";
import { EmojiPicker } from "./EmojiPicker";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { Workspace } from "../lib/types";
import { disposeSession, scrollSessionToBottom } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";

/** Glyph shown in the collapsed rail: the emoji icon, else the first letter. */
function railGlyph(name: string, icon?: string): string {
  if (icon) return icon;
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

export function WorkspaceSidebar({
  onOpenPalette,
}: {
  onOpenPalette: () => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const setWorkspaceIcon = useWorkspaceStore((s) => s.setWorkspaceIcon);
  const toggleWorkspacePin = useWorkspaceStore((s) => s.toggleWorkspacePin);
  const closeOtherWorkspaces = useWorkspaceStore(
    (s) => s.closeOtherWorkspaces
  );
  const closeWorkspacesBefore = useWorkspaceStore(
    (s) => s.closeWorkspacesBefore
  );
  const closeWorkspacesAfter = useWorkspaceStore(
    (s) => s.closeWorkspacesAfter
  );
  const toggleAi = useAiStore((s) => s.toggleOpen);
  const toggleGit = useGitStore((s) => s.toggleOpen);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // Drop target plus which side of it the cursor is on. Sidebar is vertical,
  // so "before" / "after" map to top half / bottom half of the row.
  const [over, setOver] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    wsId: string;
    x: number;
    y: number;
  } | null>(null);
  // manual double-click detection: WebKit (macOS WKWebView) does NOT fire the
  // native `dblclick` event on `draggable` elements, so we time clicks here.
  const lastClick = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  // id of the workspace whose emoji picker is open (null = none), plus the
  // screen anchor (bottom-left of the trigger) for the fixed-position popover.
  const [iconPicker, setIconPicker] = useState<{
    id: string;
    anchor: { x: number; y: number };
  } | null>(null);
  // collapsed state + width live in the shared layout store (persisted there),
  // so the app-level divider can resize this panel and the collapse toggle
  // stays in sync with App's divider visibility.
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);

  // Attention roll-up: which tabs rang the bell while unfocused (a coding agent
  // pausing for input / erroring). Surfaced here in the workspace area — a
  // per-row badge plus a jump list — rather than as a strip inside the tab
  // area, so it's visible no matter which workspace is active.
  const waiting = useAttentionStore((s) => s.waiting);
  const attentionEntries = tabsNeedingAttention(workspaces, waiting);
  const attentionByWs = new Map<string, number>();
  for (const e of attentionEntries) {
    attentionByWs.set(e.workspaceId, (attentionByWs.get(e.workspaceId) ?? 0) + 1);
  }

  /**
   * Navigate to a waiting tab: activate its workspace + tab, acknowledge the
   * attention on every pane in it, and scroll each pane to the newest output
   * (the prompt the agent is blocking on) rather than wherever the scrollback
   * was parked.
   */
  function goToAttention(workspaceId: string, tabId: string) {
    setActive(workspaceId);
    setActiveTab(workspaceId, tabId);
    const ws = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === workspaceId);
    const tab = ws?.tabs.find((t) => t.id === tabId);
    if (tab) {
      const leaves = collectLeafIds(tab.root);
      clearAttentionMany(leaves);
      for (const id of leaves) scrollSessionToBottom(id);
    }
  }

  function commitRename(id: string) {
    if (draft.trim()) renameWorkspace(id, draft.trim());
    setEditingId(null);
  }

  function beginEdit(id: string, name: string) {
    setEditingId(id);
    setDraft(name);
  }

  // single click selects the workspace; a second click on the same row within
  // 400ms enters rename mode (manual dblclick because draggable swallows it).
  function onRowClick(id: string, name: string) {
    setActive(id);
    const now = Date.now();
    const prev = lastClick.current;
    if (prev.id === id && now - prev.t < 400) {
      beginEdit(id, name);
      lastClick.current = { id: "", t: 0 };
    } else {
      lastClick.current = { id, t: now };
    }
  }

  function onDrop(targetId: string, side: "before" | "after") {
    if (dragId && dragId !== targetId) {
      reorderWorkspace(dragId, targetId, side);
    }
    setDragId(null);
    setOver(null);
  }

  function toggleIconPicker(wsId: string, e: MouseEvent) {
    e.stopPropagation();
    if (iconPicker?.id === wsId) {
      setIconPicker(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setIconPicker({ id: wsId, anchor: { x: r.left, y: r.bottom } });
  }

  /** Dispose every pty session inside a workspace's tabs before dropping it. */
  function disposeWorkspaces(list: Workspace[]) {
    for (const w of list) {
      for (const t of w.tabs)
        for (const id of collectLeafIds(t.root)) disposeSession(id);
    }
  }

  function buildMenu(w: Workspace, allowRename: boolean): MenuItem[] {
    const idx = workspaces.findIndex((x) => x.id === w.id);
    const closableOthers = workspaces.filter(
      (x) => x.id !== w.id && !x.pinned
    );
    const closableBefore = workspaces.filter(
      (x, i) => i < idx && !x.pinned
    );
    const closableAfter = workspaces.filter(
      (x, i) => i > idx && !x.pinned
    );
    return [
      {
        label: w.pinned ? "Unpin" : "Pin",
        onClick: () => toggleWorkspacePin(w.id),
      },
      {
        label: "Rename",
        disabled: !allowRename,
        onClick: () => beginEdit(w.id, w.name),
      },
      { separator: true },
      {
        label: "Close",
        danger: true,
        onClick: () => {
          disposeWorkspaces([w]);
          removeWorkspace(w.id);
        },
      },
      {
        label: "Close Others",
        disabled: closableOthers.length === 0,
        onClick: () => {
          disposeWorkspaces(closableOthers);
          closeOtherWorkspaces(w.id);
        },
      },
      {
        label: "Close Before",
        disabled: closableBefore.length === 0,
        onClick: () => {
          disposeWorkspaces(closableBefore);
          closeWorkspacesBefore(w.id);
        },
      },
      {
        label: "Close After",
        disabled: closableAfter.length === 0,
        onClick: () => {
          disposeWorkspaces(closableAfter);
          closeWorkspacesAfter(w.id);
        },
      },
    ];
  }

  // collapsed rail: a narrow strip of workspace icons (emoji or first letter)
  // plus the expand + settings affordances, so the chrome stays usable.
  if (collapsed) {
    return (
      <div className="sidebar collapsed">
        <button
          className="icon-btn sidebar-expand"
          title="Show workspaces"
          onClick={() => setCollapsed(false)}
        >
          »
        </button>
        <button
          className="icon-btn rail-search"
          title="Search workspaces & tabs (⌘K)"
          onClick={onOpenPalette}
        >
          ⌕
        </button>
        <div className="rail-list">
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={
                "rail-item" +
                (w.id === activeId ? " active" : "") +
                (w.pinned ? " pinned" : "")
              }
              title={w.pinned ? `${w.name} (pinned)` : w.name}
              onClick={() => setActive(w.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActive(w.id);
                setCtxMenu({ wsId: w.id, x: e.clientX, y: e.clientY });
              }}
            >
              {railGlyph(w.name, w.icon)}
              {attentionByWs.has(w.id) && (
                <span
                  className="rail-attention-dot"
                  aria-label="waiting for you"
                />
              )}
            </button>
          ))}
        </div>
        <button
          className="icon-btn rail-git"
          title="Toggle git sidebar"
          onClick={() => toggleGit()}
        >
          ⑂
        </button>
        <button
          className="icon-btn rail-ai"
          title="Toggle AI sidebar (⌘I)"
          onClick={() => toggleAi()}
        >
          ✦
        </button>
        <button
          className="icon-btn rail-settings"
          title="Appearance settings"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
        {showSettings && (
          <SettingsPanel onClose={() => setShowSettings(false)} />
        )}
        {ctxMenu && (() => {
          const w = workspaces.find((x) => x.id === ctxMenu.wsId);
          if (!w) return null;
          return (
            <ContextMenu
              items={buildMenu(w, false)}
              x={ctxMenu.x}
              y={ctxMenu.y}
              onClose={() => setCtxMenu(null)}
            />
          );
        })()}
      </div>
    );
  }

  return (
    <div
      className="sidebar"
      style={{ width: sidebarWidth, minWidth: sidebarWidth }}
    >
      <div className="sidebar-header">
        <span>WORKSPACES</span>
        <div className="sidebar-header-actions">
          <button
            className="icon-btn"
            title="Search workspaces & tabs (⌘K)"
            onClick={onOpenPalette}
          >
            ⌕
          </button>
          <button
            className="icon-btn"
            title="New workspace"
            onClick={() => addWorkspace()}
          >
            +
          </button>
          <button
            className="icon-btn"
            title="Toggle git sidebar"
            onClick={() => toggleGit()}
          >
            ⑂
          </button>
          <button
            className="icon-btn"
            title="Toggle AI sidebar (⌘I)"
            onClick={() => toggleAi()}
          >
            ✦
          </button>
          <button
            className="icon-btn"
            title="Hide sidebar"
            onClick={() => setCollapsed(true)}
          >
            «
          </button>
        </div>
      </div>
      <div className="ws-list">
        {attentionEntries.length > 0 && (
          <div className="ws-attention" role="status" aria-live="polite">
            <div className="ws-attention-label">
              Waiting for you
              {attentionEntries.length > 1
                ? ` (${attentionEntries.length})`
                : ""}
            </div>
            {attentionEntries.map((e) => (
              <button
                key={e.tabId}
                type="button"
                className="ws-attention-chip"
                title={`${e.workspaceName} › ${e.tabName} needs attention`}
                onClick={() => goToAttention(e.workspaceId, e.tabId)}
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
        )}
        {workspaces.map((w) => {
          const isOver = over?.id === w.id && dragId && w.id !== dragId;
          const dragSrc = dragId
            ? workspaces.find((x) => x.id === dragId)
            : null;
          // Cross-segment drops (pinned vs unpinned) are rejected by the store
          // to preserve the "pinned items render before unpinned" invariant —
          // mirror it here so we don't paint a misleading insertion line.
          const allowed =
            !dragSrc || Boolean(dragSrc.pinned) === Boolean(w.pinned);
          return (
          <div
            key={w.id}
            className={
              "ws-item" +
              (w.id === activeId ? " active" : "") +
              (w.id === dragId ? " dragging" : "") +
              (isOver && allowed && over!.side === "before" ? " drag-over-before" : "") +
              (isOver && allowed && over!.side === "after" ? " drag-over-after" : "") +
              (w.pinned ? " pinned" : "")
            }
            draggable={editingId !== w.id}
            onDragStart={(e) => {
              setDragId(w.id);
              e.dataTransfer.effectAllowed = "move";
              // WKWebView swallows the drop event unless setData is called at
              // least once during dragstart — see TabBar for the same fix.
              e.dataTransfer.setData("text/plain", w.id);
            }}
            onDragOver={(e) => {
              if (!allowed) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "none";
                if (over) setOver(null);
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const r = e.currentTarget.getBoundingClientRect();
              const side: "before" | "after" =
                e.clientY < r.top + r.height / 2 ? "before" : "after";
              if (over?.id !== w.id || over?.side !== side) {
                setOver({ id: w.id, side });
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (!allowed || !over) {
                setDragId(null);
                setOver(null);
                return;
              }
              onDrop(w.id, over.side);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOver(null);
            }}
            onClick={() => onRowClick(w.id, w.name)}
            onDoubleClick={() => beginEdit(w.id, w.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              setActive(w.id);
              setCtxMenu({ wsId: w.id, x: e.clientX, y: e.clientY });
            }}
          >
            {editingId === w.id ? (
              <input
                autoFocus
                className="ws-rename"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(w.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(w.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <button
                  className="ws-icon"
                  title="Right-click to set icon"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleIconPicker(w.id, e);
                  }}
                >
                  {railGlyph(w.name, w.icon)}
                </button>
                <span className="ws-name">
                  {w.pinned && <span className="ws-pin" title="Pinned">📌</span>}
                  {w.name}
                </span>
                {attentionByWs.has(w.id) && (
                  <span
                    className="ws-attention-dot"
                    title={`${attentionByWs.get(w.id)} tab(s) waiting for you`}
                    aria-label="waiting for you"
                  />
                )}
                <span className="ws-count">{w.tabs.length}</span>
                <button
                  className="icon-btn ws-close"
                  title="Delete workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    disposeWorkspaces([w]);
                    removeWorkspace(w.id);
                  }}
                >
                  ×
                </button>
                {iconPicker?.id === w.id && (
                  <EmojiPicker
                    anchor={iconPicker.anchor}
                    onPick={(emoji) => setWorkspaceIcon(w.id, emoji)}
                    onClose={() => setIconPicker(null)}
                  />
                )}
              </>
            )}
          </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button
          className="settings-btn"
          title="Appearance settings"
          onClick={() => setShowSettings(true)}
        >
          <span className="gear">⚙</span> Settings
        </button>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {ctxMenu && (() => {
        const w = workspaces.find((x) => x.id === ctxMenu.wsId);
        if (!w) return null;
        return (
          <ContextMenu
            items={buildMenu(w, true)}
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </div>
  );
}

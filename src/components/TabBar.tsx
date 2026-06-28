import { useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { Workspace } from "../lib/types";
import { disposeSession } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";

export function TabBar({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const renameTab = useWorkspaceStore((s) => s.renameTab);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const reorderTab = useWorkspaceStore((s) => s.reorderTab);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function commitRename(tabId: string) {
    if (draft.trim()) renameTab(workspace.id, tabId, draft.trim());
    setEditingId(null);
  }

  function closeTab(tabId: string) {
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (tab) {
      // kill every shell in this tab's split tree
      for (const paneId of collectLeafIds(tab.root)) disposeSession(paneId);
    }
    removeTab(workspace.id, tabId);
  }

  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) {
      reorderTab(workspace.id, dragId, targetId);
    }
    setDragId(null);
    setOverId(null);
  }

  return (
    <div className="tabbar">
      {workspace.tabs.map((t) => (
        <div
          key={t.id}
          className={
            "tab" +
            (t.id === workspace.activeTabId ? " active" : "") +
            (t.id === dragId ? " dragging" : "") +
            (t.id === overId && dragId && t.id !== dragId ? " drag-over" : "")
          }
          draggable={editingId !== t.id}
          onDragStart={(e) => {
            setDragId(t.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (overId !== t.id) setOverId(t.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDrop(t.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOverId(null);
          }}
          onClick={() => setActiveTab(workspace.id, t.id)}
          onDoubleClick={() => {
            setEditingId(t.id);
            setDraft(t.name);
          }}
        >
          {editingId === t.id ? (
            <input
              autoFocus
              className="tab-rename"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commitRename(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(t.id);
                if (e.key === "Escape") setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="tab-name">{t.name}</span>
              <button
                className="icon-btn tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
      <button
        className="icon-btn tab-add"
        title="New tab"
        onClick={() => addTab(workspace.id)}
      >
        +
      </button>

      <div className="tabbar-spacer" />

      {workspace.activeTabId && (
        <>
          <button
            className="icon-btn"
            title="Split right (Cmd/Ctrl+D)"
            onClick={() =>
              splitActivePane(workspace.id, workspace.activeTabId!, "row")
            }
          >
            ▮▮
          </button>
          <button
            className="icon-btn"
            title="Split down (Cmd/Ctrl+Shift+D)"
            onClick={() =>
              splitActivePane(workspace.id, workspace.activeTabId!, "column")
            }
          >
            ⬓
          </button>
        </>
      )}
    </div>
  );
}

import { useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { Workspace } from "../lib/types";
import { disposeSession } from "../lib/terminal-manager";

export function TabBar({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const renameTab = useWorkspaceStore((s) => s.renameTab);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename(tabId: string) {
    if (draft.trim()) renameTab(workspace.id, tabId, draft.trim());
    setEditingId(null);
  }

  function closeTab(tabId: string) {
    disposeSession(tabId);
    removeTab(workspace.id, tabId);
  }

  return (
    <div className="tabbar">
      {workspace.tabs.map((t) => (
        <div
          key={t.id}
          className={"tab" + (t.id === workspace.activeTabId ? " active" : "")}
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
    </div>
  );
}

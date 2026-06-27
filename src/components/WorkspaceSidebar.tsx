import { useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function commitRename(id: string) {
    if (draft.trim()) renameWorkspace(id, draft.trim());
    setEditingId(null);
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>WORKSPACES</span>
        <button
          className="icon-btn"
          title="New workspace"
          onClick={() => addWorkspace()}
        >
          +
        </button>
      </div>
      <div className="ws-list">
        {workspaces.map((w) => (
          <div
            key={w.id}
            className={"ws-item" + (w.id === activeId ? " active" : "")}
            onClick={() => setActive(w.id)}
            onDoubleClick={() => {
              setEditingId(w.id);
              setDraft(w.name);
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
                <span className="ws-name">{w.name}</span>
                <span className="ws-count">{w.tabs.length}</span>
                <button
                  className="icon-btn ws-close"
                  title="Delete workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWorkspace(w.id);
                  }}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

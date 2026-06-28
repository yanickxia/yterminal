import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { SettingsPanel } from "./SettingsPanel";

const COLLAPSE_KEY = "yterminal.sidebar.collapsed";

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // collapsed state persists across launches; restored synchronously so the
  // sidebar doesn't flash open on startup.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  function commitRename(id: string) {
    if (draft.trim()) renameWorkspace(id, draft.trim());
    setEditingId(null);
  }

  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) reorderWorkspace(dragId, targetId);
    setDragId(null);
    setOverId(null);
  }

  // collapsed rail: just a button to expand again, kept narrow so the
  // terminal area reclaims the space.
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
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>WORKSPACES</span>
        <div className="sidebar-header-actions">
          <button
            className="icon-btn"
            title="New workspace"
            onClick={() => addWorkspace()}
          >
            +
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
        {workspaces.map((w) => (
          <div
            key={w.id}
            className={
              "ws-item" +
              (w.id === activeId ? " active" : "") +
              (w.id === dragId ? " dragging" : "") +
              (w.id === overId && dragId && w.id !== dragId ? " drag-over" : "")
            }
            draggable={editingId !== w.id}
            onDragStart={(e) => {
              setDragId(w.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overId !== w.id) setOverId(w.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(w.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
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
    </div>
  );
}

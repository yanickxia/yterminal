import { useEffect, useState, useRef, type MouseEvent } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { SettingsPanel } from "./SettingsPanel";
import { EmojiPicker } from "./EmojiPicker";

const COLLAPSE_KEY = "yterminal.sidebar.collapsed";

/** Glyph shown in the collapsed rail: the emoji icon, else the first letter. */
function railGlyph(name: string, icon?: string): string {
  if (icon) return icon;
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

export function WorkspaceSidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const reorderWorkspace = useWorkspaceStore((s) => s.reorderWorkspace);
  const setWorkspaceIcon = useWorkspaceStore((s) => s.setWorkspaceIcon);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // manual double-click detection: WebKit (macOS WKWebView) does NOT fire the
  // native `dblclick` event on `draggable` elements, so we time clicks here.
  const lastClick = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  // id of the workspace whose emoji picker is open (null = none), plus the
  // screen anchor (bottom-left of the trigger) for the fixed-position popover.
  const [iconPicker, setIconPicker] = useState<{
    id: string;
    anchor: { x: number; y: number };
  } | null>(null);
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

  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) reorderWorkspace(dragId, targetId);
    setDragId(null);
    setOverId(null);
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
        <div className="rail-list">
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={"rail-item" + (w.id === activeId ? " active" : "")}
              title={w.name}
              onClick={() => setActive(w.id)}
            >
              {railGlyph(w.name, w.icon)}
            </button>
          ))}
        </div>
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
            onClick={() => onRowClick(w.id, w.name)}
            onDoubleClick={() => beginEdit(w.id, w.name)}
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
                  title="Set icon"
                  onClick={(e) => toggleIconPicker(w.id, e)}
                >
                  {railGlyph(w.name, w.icon)}
                </button>
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

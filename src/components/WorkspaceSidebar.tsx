import { useEffect, useState, useRef, type MouseEvent } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { SettingsPanel } from "./SettingsPanel";
import { EmojiPicker } from "./EmojiPicker";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { Workspace } from "../lib/types";
import { disposeSession } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";

const COLLAPSE_KEY = "yterminal.sidebar.collapsed";

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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
    <div className="sidebar">
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
              (w.id === overId && dragId && w.id !== dragId ? " drag-over" : "") +
              (w.pinned ? " pinned" : "")
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

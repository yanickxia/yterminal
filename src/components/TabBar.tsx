import { useState, useRef, type MouseEvent } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { Workspace } from "../lib/types";
import { disposeSession } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";
import { EmojiPicker } from "./EmojiPicker";

export function TabBar({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const renameTab = useWorkspaceStore((s) => s.renameTab);
  const setTabIcon = useWorkspaceStore((s) => s.setTabIcon);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const reorderTab = useWorkspaceStore((s) => s.reorderTab);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // manual double-click detection: WebKit (macOS WKWebView) does NOT fire the
  // native `dblclick` event on `draggable` elements, so we time consecutive
  // clicks ourselves to trigger rename.
  const lastClick = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  // id of the tab whose emoji picker is open (null = none), plus the screen
  // anchor (bottom-left of the trigger) so the fixed-position popover lands
  // under the icon and isn't clipped by the tab bar's horizontal scroll.
  const [iconPicker, setIconPicker] = useState<{
    id: string;
    anchor: { x: number; y: number };
  } | null>(null);

  function toggleIconPicker(tabId: string, e: MouseEvent) {
    e.stopPropagation();
    if (iconPicker?.id === tabId) {
      setIconPicker(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setIconPicker({ id: tabId, anchor: { x: r.left, y: r.bottom } });
  }

  function commitRename(tabId: string) {
    if (draft.trim()) renameTab(workspace.id, tabId, draft.trim());
    setEditingId(null);
  }

  function beginEdit(tabId: string, name: string) {
    setEditingId(tabId);
    setDraft(name);
  }

  // single click activates the tab; a second click on the same tab within
  // 400ms enters rename mode (manual dblclick because draggable swallows it).
  function onTabClick(tabId: string, name: string) {
    setActiveTab(workspace.id, tabId);
    const now = Date.now();
    const prev = lastClick.current;
    if (prev.id === tabId && now - prev.t < 400) {
      beginEdit(tabId, name);
      lastClick.current = { id: "", t: 0 };
    } else {
      lastClick.current = { id: tabId, t: now };
    }
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
          onClick={() => onTabClick(t.id, t.name)}
          onDoubleClick={() => beginEdit(t.id, t.name)}
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
              {t.icon ? (
                <button
                  className="tab-icon"
                  title="Change icon"
                  onClick={(e) => toggleIconPicker(t.id, e)}
                >
                  {t.icon}
                </button>
              ) : (
                <button
                  className="tab-icon tab-icon-add"
                  title="Set icon"
                  onClick={(e) => toggleIconPicker(t.id, e)}
                >
                  ☺
                </button>
              )}
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
              {iconPicker?.id === t.id && (
                <EmojiPicker
                  anchor={iconPicker.anchor}
                  onPick={(emoji) => setTabIcon(workspace.id, t.id, emoji)}
                  onClose={() => setIconPicker(null)}
                />
              )}
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

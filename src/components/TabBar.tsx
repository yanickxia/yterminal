import { useState, useRef, type MouseEvent } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { Tab, Workspace } from "../lib/types";
import { addTabInheritingCwd, disposeSession } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";
import { EmojiPicker } from "./EmojiPicker";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export function TabBar({ workspace }: { workspace: Workspace }) {
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const renameTab = useWorkspaceStore((s) => s.renameTab);
  const setTabIcon = useWorkspaceStore((s) => s.setTabIcon);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const reorderTab = useWorkspaceStore((s) => s.reorderTab);
  const toggleTabPin = useWorkspaceStore((s) => s.toggleTabPin);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const closeTabsBefore = useWorkspaceStore((s) => s.closeTabsBefore);
  const closeTabsAfter = useWorkspaceStore((s) => s.closeTabsAfter);

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
  const [ctxMenu, setCtxMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
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

  /** Dispose all sessions in a set of tabs (used by bulk-close menu items). */
  function disposeTabs(tabs: Tab[]) {
    for (const t of tabs) {
      for (const paneId of collectLeafIds(t.root)) disposeSession(paneId);
    }
  }

  function buildMenu(tab: Tab): MenuItem[] {
    const idx = workspace.tabs.findIndex((t) => t.id === tab.id);
    const closableOthers = workspace.tabs.filter(
      (t) => t.id !== tab.id && !t.pinned
    );
    const closableBefore = workspace.tabs.filter(
      (t, i) => i < idx && !t.pinned
    );
    const closableAfter = workspace.tabs.filter(
      (t, i) => i > idx && !t.pinned
    );
    return [
      {
        label: tab.pinned ? "Unpin" : "Pin",
        onClick: () => toggleTabPin(workspace.id, tab.id),
      },
      {
        label: "Rename",
        onClick: () => beginEdit(tab.id, tab.name),
      },
      { separator: true },
      {
        label: "Close",
        danger: true,
        onClick: () => closeTab(tab.id),
      },
      {
        label: "Close Others",
        disabled: closableOthers.length === 0,
        onClick: () => {
          disposeTabs(closableOthers);
          closeOtherTabs(workspace.id, tab.id);
        },
      },
      {
        label: "Close Before",
        disabled: closableBefore.length === 0,
        onClick: () => {
          disposeTabs(closableBefore);
          closeTabsBefore(workspace.id, tab.id);
        },
      },
      {
        label: "Close After",
        disabled: closableAfter.length === 0,
        onClick: () => {
          disposeTabs(closableAfter);
          closeTabsAfter(workspace.id, tab.id);
        },
      },
    ];
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
            (t.id === overId && dragId && t.id !== dragId ? " drag-over" : "") +
            (t.pinned ? " pinned" : "")
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
          onContextMenu={(e) => {
            e.preventDefault();
            setActiveTab(workspace.id, t.id);
            setCtxMenu({ tabId: t.id, x: e.clientX, y: e.clientY });
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
              {t.pinned && <span className="tab-pin" title="Pinned">📌</span>}
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
        title="New tab (⌘T)"
        onClick={() => addTabInheritingCwd(workspace.id)}
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

      {ctxMenu && (() => {
        const tab = workspace.tabs.find((t) => t.id === ctxMenu.tabId);
        if (!tab) return null;
        return (
          <ContextMenu
            items={buildMenu(tab)}
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
          />
        );
      })()}
    </div>
  );
}

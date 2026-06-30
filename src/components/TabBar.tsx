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
  // The drop target plus which side of it the cursor is on. Encoding "anchor +
  // side" (instead of a single index) gives symmetric drop semantics: the left
  // half of any tab inserts before it, the right half after it.
  const [over, setOver] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);
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

  function onDrop(targetId: string, side: "before" | "after") {
    if (dragId && dragId !== targetId) {
      reorderTab(workspace.id, dragId, targetId, side);
    }
    setDragId(null);
    setOver(null);
  }

  return (
    <div className="tabbar">
      {workspace.tabs.map((t) => {
        const isOver = over?.id === t.id && dragId && t.id !== dragId;
        const dragSrc = dragId
          ? workspace.tabs.find((x) => x.id === dragId)
          : null;
        // Cross-segment drops (pinned vs unpinned) are rejected — see store.
        // We mirror that here so the indicator stays hidden and the dropEffect
        // shows "no entry" before the user even releases.
        const allowed =
          !dragSrc || Boolean(dragSrc.pinned) === Boolean(t.pinned);
        return (
        <div
          key={t.id}
          className={
            "tab" +
            (t.id === workspace.activeTabId ? " active" : "") +
            (t.id === dragId ? " dragging" : "") +
            (isOver && allowed && over!.side === "before" ? " drag-over-before" : "") +
            (isOver && allowed && over!.side === "after" ? " drag-over-after" : "") +
            (t.pinned ? " pinned" : "")
          }
          draggable={editingId !== t.id}
          onDragStart={(e) => {
            setDragId(t.id);
            e.dataTransfer.effectAllowed = "move";
            // WebKit (WKWebView) silently cancels the drop event unless
            // setData was called at least once during dragstart. The actual
            // payload doesn't matter — we read state from React, not from
            // dataTransfer — but the call has to happen.
            e.dataTransfer.setData("text/plain", t.id);
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
              e.clientX < r.left + r.width / 2 ? "before" : "after";
            if (over?.id !== t.id || over?.side !== side) {
              setOver({ id: t.id, side });
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (!allowed || !over) {
              setDragId(null);
              setOver(null);
              return;
            }
            onDrop(t.id, over.side);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOver(null);
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
                  title="Right-click to change icon"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleIconPicker(t.id, e);
                  }}
                >
                  {t.icon}
                </button>
              ) : (
                <button
                  className="tab-icon tab-icon-add"
                  title="Right-click to set icon"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    toggleIconPicker(t.id, e);
                  }}
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
        );
      })}
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

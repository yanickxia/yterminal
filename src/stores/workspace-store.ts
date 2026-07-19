// workspace-store: owns the workspace -> tab -> pane-tree structure + persistence.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Tab,
  Workspace,
  PaneAgent,
  PaneTree,
  TabFile,
} from "../lib/types";
import { uid } from "../lib/uid";
import {
  collectLeafIds,
  findLeaf,
  makeLeaf,
  splitPane,
  removePane,
  setSizesAt,
  setLeafCwd,
  setLeafAgent,
} from "../lib/pane-tree";
import { useSettingsStore } from "./settings-store";
import type {
  WorkspaceDocument,
  WorkspaceOperation,
} from "../lib/workspace-protocol";
import { toSharedTab } from "../lib/workspace-protocol";
import {
  queueCreateWorkspace,
  queueDeleteWorkspace,
  queueWorkspaceOperation,
} from "../lib/workspace-sync";

function defaultCwd(): string {
  return "~";
}

function configuredDefaultCwd(): string {
  const { defaultCwdMode, defaultCwdFixed } = useSettingsStore.getState();
  if (defaultCwdMode === "home") return "~";
  if (defaultCwdMode === "fixed") return defaultCwdFixed.trim() || "~";
  return defaultCwd();
}

function makeTab(name: string, cwd?: string): Tab {
  // An explicit cwd is authoritative. The default-cwd setting is only a
  // fallback for brand new workspaces or cases where no active pane can supply
  // a directory. This keeps cwd inheritance scoped to the current workspace.
  const resolved = cwd && cwd.trim() ? cwd : configuredDefaultCwd();
  const leaf = makeLeaf(resolved);
  return {
    id: uid("tab"),
    name,
    cwd: resolved,
    root: leaf,
    activePaneId: leaf.id,
  };
}

/** Last path segment, e.g. "/a/b/notes.md" -> "notes.md". */
function fileTabName(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const seg = norm.split(/[\\/]/).pop() ?? norm;
  return seg || norm;
}

function makeFileTab(file: TabFile): Tab {
  // File tabs keep an inert placeholder leaf so the tree-walking store/snapshot
  // code treats every tab uniformly; it's never mounted as a shell.
  const leaf = makeLeaf("~");
  return {
    id: uid("tab"),
    name: fileTabName(file.path),
    cwd: "~",
    root: leaf,
    activePaneId: leaf.id,
    file,
  };
}

function makeWorkspace(name: string, hostId = "local"): Workspace {
  // A client-local fixed default path is meaningless on another machine.
  // New remote workspaces always begin at the remote account's home.
  const firstTab = makeTab("shell", hostId === "local" ? undefined : "~");
  return {
    id: uid("ws"),
    hostId,
    name,
    tabs: [firstTab],
    activeTabId: firstTab.id,
  };
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  // ---- workspace ops ----
  addWorkspace: (name?: string) => void;
  addWorkspaceOnHost: (hostId: string, name?: string) => void;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceIcon: (id: string, icon: string) => void;
  setActiveWorkspace: (id: string) => void;
  reorderWorkspace: (
    fromId: string,
    anchorId: string,
    side: "before" | "after"
  ) => void;
  toggleWorkspacePin: (id: string) => void;
  closeOtherWorkspaces: (keepId: string) => void;
  closeWorkspacesBefore: (anchorId: string) => void;
  closeWorkspacesAfter: (anchorId: string) => void;

  // ---- tab ops ----
  addTab: (workspaceId: string, name?: string, cwd?: string) => void;
  /**
   * Open a read-only file viewer tab in the given workspace. If a file tab for
   * the same path already exists there, it's activated instead of duplicated.
   * Returns the tab id that ended up active.
   */
  openFileTab: (workspaceId: string, file: TabFile) => string;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, name: string) => void;
  /**
   * Clear a tab's manual `customName` so the shell/agent title stream (OSC 0/2)
   * drives `Tab.name` again — the "let Claude control the tab name" reset. The
   * caller (TabBar) re-applies the pane's last reported title right after, so
   * the tab snaps back to the live title instead of stalling on the old name.
   */
  clearTabCustomName: (workspaceId: string, tabId: string) => void;
  /**
   * Update a tab's *auto* display name (Tab.name) without touching customName.
   * Fed by the shell/agent title stream (OSC 0/2). A tab the user renamed by
   * hand has a customName, which always wins, so this is a no-op there.
   */
  setTabAutoName: (workspaceId: string, tabId: string, name: string) => void;
  setTabIcon: (workspaceId: string, tabId: string, icon: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;
  reorderTab: (
    workspaceId: string,
    fromId: string,
    anchorId: string,
    side: "before" | "after"
  ) => void;
  toggleTabPin: (workspaceId: string, tabId: string) => void;
  closeOtherTabs: (workspaceId: string, keepTabId: string) => void;
  closeTabsBefore: (workspaceId: string, anchorTabId: string) => void;
  closeTabsAfter: (workspaceId: string, anchorTabId: string) => void;

  // ---- pane ops ----
  splitActivePane: (
    workspaceId: string,
    tabId: string,
    direction: "row" | "column"
  ) => void;
  closePane: (workspaceId: string, tabId: string, paneId: string) => void;
  setActivePane: (workspaceId: string, tabId: string, paneId: string) => void;
  resizeSplit: (
    workspaceId: string,
    tabId: string,
    splitId: string,
    sizes: number[]
  ) => void;
  /** record the *current* shell cwd on a leaf so a restart respawns there. */
  updatePaneCwd: (
    workspaceId: string,
    tabId: string,
    paneId: string,
    cwd: string
  ) => void;
  /** record (or clear) the agent running in a leaf so a restart resumes it. */
  setPaneAgent: (
    workspaceId: string,
    tabId: string,
    paneId: string,
    agent: PaneAgent | undefined
  ) => void;

  // ---- selectors ----
  activeWorkspace: () => Workspace | undefined;

  // Agent projection hooks. These never emit mutations back to the agent.
  applyAgentSnapshot: (hostId: string, documents: WorkspaceDocument[]) => void;
  applyAgentWorkspace: (hostId: string, document: WorkspaceDocument) => void;
  removeAgentWorkspace: (hostId: string, workspaceId: string) => void;
}

function syncOp(workspaceId: string, operation: WorkspaceOperation): void {
  queueWorkspaceOperation(workspaceId, operation);
}

function mergeAgentWorkspace(
  existing: Workspace | undefined,
  document: WorkspaceDocument,
  hostId: string
): Workspace {
  const tabs: Tab[] = document.tabs.map((shared) => {
    const previous = existing?.tabs.find((tab) => tab.id === shared.id);
    const leafIds = collectLeafIds(shared.root);
    const activePaneId =
      previous && leafIds.includes(previous.activePaneId)
        ? previous.activePaneId
        : (leafIds[0] ?? "");
    const root = mergeAgentPaneTree(previous?.root, shared.root);
    const runtimeTitle = findLeaf(root, activePaneId)?.runtimeTitle?.trim();
    return {
      ...shared,
      root,
      name:
        !shared.customName && runtimeTitle ? runtimeTitle : shared.name,
      customName: shared.customName ?? undefined,
      icon: shared.icon ?? undefined,
      file: shared.file ?? undefined,
      pinned: previous?.pinned,
      activePaneId,
    };
  });
  const activeTabId =
    existing?.activeTabId && tabs.some((tab) => tab.id === existing.activeTabId)
      ? existing.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    id: document.id,
    hostId,
    name: document.name,
    icon: document.icon ?? undefined,
    tabs,
    activeTabId,
    pinned: existing?.pinned,
  };
}

function mergeAgentPaneTree(
  previous: PaneTree | undefined,
  shared: PaneTree
): PaneTree {
  if (shared.type === "leaf") {
    if (previous?.type !== "leaf" || previous.id !== shared.id) {
      return {
        ...shared,
        sessionId: shared.sessionId ?? undefined,
        agent: shared.agent ?? undefined,
        runtimeStatus: shared.runtimeStatus ?? undefined,
        runtimeTitle: shared.runtimeTitle ?? undefined,
      };
    }
    const sameAgent =
      previous.agent &&
      shared.agent &&
      previous.agent.kind === shared.agent.kind &&
      previous.agent.sessionId === shared.agent.sessionId;
    return {
      ...shared,
      sessionId: shared.sessionId ?? undefined,
      runtimeStatus: shared.runtimeStatus ?? undefined,
      runtimeTitle: shared.runtimeTitle ?? undefined,
      agent: sameAgent
        ? { ...shared.agent!, env: previous.agent!.env }
        : (shared.agent ?? undefined),
    };
  }
  const previousChildren =
    previous?.type === "split" ? previous.children : [];
  const keepLocalSizes =
    previous?.type === "split" &&
    previous.id === shared.id &&
    previous.children.length === shared.children.length &&
    previous.children.every(
      (child, index) => child.id === shared.children[index]?.id
    ) &&
    previous.sizes.length === shared.sizes.length;
  return {
    ...shared,
    // Split proportions are client view state. Preserve this window's local
    // override while the authoritative child structure remains identical.
    sizes: keepLocalSizes ? previous.sizes : shared.sizes,
    children: shared.children.map((child) =>
      mergeAgentPaneTree(
        previousChildren.find((candidate) => candidate.id === child.id),
        child
      )
    ),
  };
}

/** helper: map over a specific tab inside a specific workspace */
function mapTab(
  workspaces: Workspace[],
  workspaceId: string,
  tabId: string,
  fn: (t: Tab) => Tab
): Workspace[] {
  return workspaces.map((w) =>
    w.id !== workspaceId
      ? w
      : { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }
  );
}

/**
 * Move `fromId` to the slot immediately before/after `anchorId`.
 *
 * Why this signature instead of a single target index: the UI needs symmetric
 * drop behavior — dropping on the left half of an item should land before it,
 * the right half after, regardless of which side the item came from. Encoding
 * "anchor + side" lets the caller speak in those visual terms; the splice
 * math (which has to compensate for the anchor shifting after `from` is
 * removed) lives here once.
 */
export function insertAtAnchor<T extends { id: string }>(
  list: T[],
  fromId: string,
  anchorId: string,
  side: "before" | "after"
): T[] {
  if (fromId === anchorId) return list;
  const from = list.findIndex((x) => x.id === fromId);
  const anchor = list.findIndex((x) => x.id === anchorId);
  if (from === -1 || anchor === -1) return list;

  const next = [...list];
  const [moved] = next.splice(from, 1);
  // anchor index shifts left by 1 if we removed an item before it
  const anchorAfter = from < anchor ? anchor - 1 : anchor;
  const insertAt = side === "before" ? anchorAfter : anchorAfter + 1;
  // landing in the original slot is a no-op (e.g. dropping A "before" B when
  // A was already directly before B)
  if (insertAt === from) return list;
  next.splice(insertAt, 0, moved);
  return next;
}

/**
 * Toggle `pinned` on the item with `id` and reinsert it at the boundary
 * between pinned and unpinned segments — so pinned items always appear before
 * unpinned ones in render order, with relative order otherwise preserved.
 */
function togglePinAndReorder<T extends { id: string; pinned?: boolean }>(
  list: T[],
  id: string
): T[] {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return list;
  const next = [...list];
  const flipped = { ...next[idx], pinned: !next[idx].pinned };
  next.splice(idx, 1);
  // boundary is the index of the first unpinned item in the remaining list;
  // both "newly pinned" and "newly unpinned" land at this exact index, which
  // places them at the end of the pinned segment / start of the unpinned one.
  let boundary = next.findIndex((x) => !x.pinned);
  if (boundary === -1) boundary = next.length;
  next.splice(boundary, 0, flipped);
  return next;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,

      addWorkspace: (name) => {
        const count = get().workspaces.length + 1;
        const ws = makeWorkspace(name ?? `workspace ${count}`);
        set((s) => ({
          workspaces: [...s.workspaces, ws],
          activeWorkspaceId: ws.id,
        }));
        queueCreateWorkspace(ws);
      },

      addWorkspaceOnHost: (hostId, name) => {
        const count = get().workspaces.filter(
          (workspace) => (workspace.hostId ?? "local") === hostId
        ).length + 1;
        const ws = makeWorkspace(name ?? `workspace ${count}`, hostId);
        set((state) => ({
          workspaces: [...state.workspaces, ws],
          activeWorkspaceId: ws.id,
        }));
        queueCreateWorkspace(ws);
      },

      removeWorkspace: (id) => {
        set((s) => {
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          let activeWorkspaceId = s.activeWorkspaceId;
          if (activeWorkspaceId === id) {
            activeWorkspaceId = workspaces[0]?.id ?? null;
          }
          return { workspaces, activeWorkspaceId };
        });
        queueDeleteWorkspace(id);
      },

      renameWorkspace: (id, name) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name } : w
          ),
        }));
        syncOp(id, { op: "rename_workspace", data: { name } });
      },

      setWorkspaceIcon: (id, icon) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, icon: icon || undefined } : w
          ),
        }));
        syncOp(id, {
          op: "set_workspace_icon",
          data: { icon: icon || null },
        });
      },

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
      reorderWorkspace: (fromId, anchorId, side) =>
        set((s) => {
          // pinned-segment guard: refuse drops that would cross the pinned
          // boundary, so the invariant "pinned items render before unpinned"
          // (maintained by togglePinAndReorder) is preserved.
          const src = s.workspaces.find((w) => w.id === fromId);
          const anc = s.workspaces.find((w) => w.id === anchorId);
          if (!src || !anc) return s;
          if ((src.hostId ?? "local") !== (anc.hostId ?? "local")) return s;
          if (Boolean(src.pinned) !== Boolean(anc.pinned)) return s;
          return {
            workspaces: insertAtAnchor(s.workspaces, fromId, anchorId, side),
          };
        }),

      toggleWorkspacePin: (id) =>
        set((s) => ({ workspaces: togglePinAndReorder(s.workspaces, id) })),

      closeOtherWorkspaces: (keepId) => {
        const current = get().workspaces;
        const keep = current.find((workspace) => workspace.id === keepId);
        if (!keep) return;
        const hostId = keep.hostId ?? "local";
        const removed = current.filter(
          (workspace) =>
            (workspace.hostId ?? "local") === hostId &&
            workspace.id !== keepId &&
            !workspace.pinned
        );
        set((s) => {
          const workspaces = s.workspaces.filter(
            (w) =>
              (w.hostId ?? "local") !== hostId ||
              w.id === keepId ||
              w.pinned
          );
          const activeWorkspaceId = workspaces.some(
            (w) => w.id === s.activeWorkspaceId
          )
            ? s.activeWorkspaceId
            : keepId;
          return { workspaces, activeWorkspaceId };
        });
        for (const workspace of removed) queueDeleteWorkspace(workspace.id);
      },

      closeWorkspacesBefore: (anchorId) => {
        const current = get().workspaces;
        const anchorIndex = current.findIndex((workspace) => workspace.id === anchorId);
        const hostId = current[anchorIndex]?.hostId ?? "local";
        const removed = anchorIndex < 0 ? [] : current.filter(
          (workspace, index) =>
            (workspace.hostId ?? "local") === hostId &&
            index < anchorIndex &&
            !workspace.pinned
        );
        set((s) => {
          const idx = s.workspaces.findIndex((w) => w.id === anchorId);
          if (idx === -1) return s;
          const workspaces = s.workspaces.filter(
            (w, i) =>
              (w.hostId ?? "local") !== hostId || i >= idx || w.pinned
          );
          const activeWorkspaceId = workspaces.some(
            (w) => w.id === s.activeWorkspaceId
          )
            ? s.activeWorkspaceId
            : anchorId;
          return { workspaces, activeWorkspaceId };
        });
        for (const workspace of removed) queueDeleteWorkspace(workspace.id);
      },

      closeWorkspacesAfter: (anchorId) => {
        const current = get().workspaces;
        const anchorIndex = current.findIndex((workspace) => workspace.id === anchorId);
        const hostId = current[anchorIndex]?.hostId ?? "local";
        const removed = anchorIndex < 0 ? [] : current.filter(
          (workspace, index) =>
            (workspace.hostId ?? "local") === hostId &&
            index > anchorIndex &&
            !workspace.pinned
        );
        set((s) => {
          const idx = s.workspaces.findIndex((w) => w.id === anchorId);
          if (idx === -1) return s;
          const workspaces = s.workspaces.filter(
            (w, i) =>
              (w.hostId ?? "local") !== hostId || i <= idx || w.pinned
          );
          const activeWorkspaceId = workspaces.some(
            (w) => w.id === s.activeWorkspaceId
          )
            ? s.activeWorkspaceId
            : anchorId;
          return { workspaces, activeWorkspaceId };
        });
        for (const workspace of removed) queueDeleteWorkspace(workspace.id);
      },

      addTab: (workspaceId, name, cwd) => {
        const tab = makeTab(name ?? "shell", cwd);
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
          }),
        }));
        syncOp(workspaceId, {
          op: "add_tab",
          data: { tab: toSharedTab(tab), index: null },
        });
      },

      openFileTab: (workspaceId, file) => {
        let resultId = "";
        let created: Tab | undefined;
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            // reuse an existing file tab for the same path instead of stacking
            // duplicates — just re-activate it.
            const existing = w.tabs.find((t) => t.file?.path === file.path);
            if (existing) {
              resultId = existing.id;
              return { ...w, activeTabId: existing.id };
            }
            const tab = makeFileTab(file);
            created = tab;
            resultId = tab.id;
            return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
          }),
        }));
        if (created) {
          syncOp(workspaceId, {
            op: "add_tab",
            data: { tab: toSharedTab(created), index: null },
          });
        }
        return resultId;
      },

      removeTab: (workspaceId, tabId) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const tabs = w.tabs.filter((t) => t.id !== tabId);
            let activeTabId = w.activeTabId;
            if (activeTabId === tabId) {
              activeTabId = tabs[tabs.length - 1]?.id ?? null;
            }
            return { ...w, tabs, activeTabId };
          }),
        }));
        syncOp(workspaceId, { op: "remove_tab", data: { tab_id: tabId } });
      },

      renameTab: (workspaceId, tabId, name) => {
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            name,
            customName: name,
          })),
        }));
        syncOp(workspaceId, {
          op: "rename_tab",
          data: { tab_id: tabId, name },
        });
      },

      clearTabCustomName: (workspaceId, tabId) => {
        let changed = false;
        set((s) => {
          const ws = s.workspaces.find((w) => w.id === workspaceId);
          const tab = ws?.tabs.find((t) => t.id === tabId);
          if (!tab || tab.customName === undefined) return s;
          changed = true;
          return {
            workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => {
              const { customName: _drop, ...rest } = t;
              return rest;
            }),
          };
        });
        if (changed) {
          syncOp(workspaceId, {
            op: "clear_tab_custom_name",
            data: { tab_id: tabId },
          });
        }
      },

      setTabAutoName: (workspaceId, tabId, name) => {
        let changed = false;
        set((s) => {
          // customName is an explicit user override — it always wins, so an
          // auto title never clobbers it. Also skip no-op writes so a chatty
          // agent redrawing the same title doesn't churn the store (and every
          // subscribed component) on each identical update.
          const ws = s.workspaces.find((w) => w.id === workspaceId);
          const tab = ws?.tabs.find((t) => t.id === tabId);
          if (!tab || tab.customName || tab.name === name) return s;
          changed = true;
          return {
            workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
              ...t,
              name,
            })),
          };
        });
        if (changed) {
          syncOp(workspaceId, {
            op: "set_tab_auto_name",
            data: { tab_id: tabId, name },
          });
        }
      },

      setTabIcon: (workspaceId, tabId, icon) => {
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            icon: icon || undefined,
          })),
        }));
        syncOp(workspaceId, {
          op: "set_tab_icon",
          data: { tab_id: tabId, icon: icon || null },
        });
      },

      setActiveTab: (workspaceId, tabId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, activeTabId: tabId } : w
          ),
        })),

      reorderTab: (workspaceId, fromId, anchorId, side) => {
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const src = w.tabs.find((t) => t.id === fromId);
            const anc = w.tabs.find((t) => t.id === anchorId);
            if (!src || !anc) return w;
            if (Boolean(src.pinned) !== Boolean(anc.pinned)) return w;
            return { ...w, tabs: insertAtAnchor(w.tabs, fromId, anchorId, side) };
          }),
        }));
        const workspace = get().workspaces.find((item) => item.id === workspaceId);
        const index = workspace?.tabs.findIndex((tab) => tab.id === fromId) ?? -1;
        if (index >= 0) {
          syncOp(workspaceId, {
            op: "reorder_tab",
            data: { tab_id: fromId, index },
          });
        }
      },

      toggleTabPin: (workspaceId, tabId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId
              ? { ...w, tabs: togglePinAndReorder(w.tabs, tabId) }
              : w
          ),
        })),

      closeOtherTabs: (workspaceId, keepTabId) => {
        const workspace = get().workspaces.find((item) => item.id === workspaceId);
        const removed = workspace?.tabs.filter(
          (tab) => tab.id !== keepTabId && !tab.pinned
        ) ?? [];
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const tabs = w.tabs.filter((t) => t.id === keepTabId || t.pinned);
            const activeTabId = tabs.some((t) => t.id === w.activeTabId)
              ? w.activeTabId
              : keepTabId;
            return { ...w, tabs, activeTabId };
          }),
        }));
        for (const tab of removed) {
          syncOp(workspaceId, { op: "remove_tab", data: { tab_id: tab.id } });
        }
      },

      closeTabsBefore: (workspaceId, anchorTabId) => {
        const workspace = get().workspaces.find((item) => item.id === workspaceId);
        const anchorIndex = workspace?.tabs.findIndex((tab) => tab.id === anchorTabId) ?? -1;
        const removed = anchorIndex < 0 ? [] : (workspace?.tabs.filter(
          (tab, index) => index < anchorIndex && !tab.pinned
        ) ?? []);
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const idx = w.tabs.findIndex((t) => t.id === anchorTabId);
            if (idx === -1) return w;
            const tabs = w.tabs.filter((t, i) => i >= idx || t.pinned);
            const activeTabId = tabs.some((t) => t.id === w.activeTabId)
              ? w.activeTabId
              : anchorTabId;
            return { ...w, tabs, activeTabId };
          }),
        }));
        for (const tab of removed) {
          syncOp(workspaceId, { op: "remove_tab", data: { tab_id: tab.id } });
        }
      },

      closeTabsAfter: (workspaceId, anchorTabId) => {
        const workspace = get().workspaces.find((item) => item.id === workspaceId);
        const anchorIndex = workspace?.tabs.findIndex((tab) => tab.id === anchorTabId) ?? -1;
        const removed = anchorIndex < 0 ? [] : (workspace?.tabs.filter(
          (tab, index) => index > anchorIndex && !tab.pinned
        ) ?? []);
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const idx = w.tabs.findIndex((t) => t.id === anchorTabId);
            if (idx === -1) return w;
            const tabs = w.tabs.filter((t, i) => i <= idx || t.pinned);
            const activeTabId = tabs.some((t) => t.id === w.activeTabId)
              ? w.activeTabId
              : anchorTabId;
            return { ...w, tabs, activeTabId };
          }),
        }));
        for (const tab of removed) {
          syncOp(workspaceId, { op: "remove_tab", data: { tab_id: tab.id } });
        }
      },

      splitActivePane: (workspaceId, tabId, direction) => {
        const current = get()
          .workspaces.find((workspace) => workspace.id === workspaceId)
          ?.tabs.find((tab) => tab.id === tabId);
        if (!current) return;
        const targetPaneId = current.activePaneId;
        const activeLeaf = findLeaf(current.root, targetPaneId);
        const cwd = activeLeaf?.cwd ?? current.cwd;
        const { tree, newLeafId, newSplitId } = splitPane(
          current.root,
          targetPaneId,
          direction,
          cwd
        );
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (tab) => ({
            ...tab,
            root: tree,
            activePaneId: newLeafId,
          })),
        }));
        syncOp(workspaceId, {
          op: "split_pane",
          data: {
            tab_id: tabId,
            target_pane_id: targetPaneId,
            split_id: newSplitId,
            new_pane_id: newLeafId,
            direction,
            cwd,
          },
        });
      },

      closePane: (workspaceId, tabId, paneId) => {
        set((s) => {
          let removeWholeTab = false;
          const workspaces = mapTab(s.workspaces, workspaceId, tabId, (t) => {
            const { tree, nextActiveId } = removePane(t.root, paneId);
            if (tree === null) {
              removeWholeTab = true;
              return t; // handled below
            }
            return {
              ...t,
              root: tree,
              activePaneId: nextActiveId ?? t.activePaneId,
            };
          });
          if (removeWholeTab) {
            // last pane closed -> close the tab itself
            return {
              workspaces: workspaces.map((w) => {
                if (w.id !== workspaceId) return w;
                const tabs = w.tabs.filter((t) => t.id !== tabId);
                let activeTabId = w.activeTabId;
                if (activeTabId === tabId)
                  activeTabId = tabs[tabs.length - 1]?.id ?? null;
                return { ...w, tabs, activeTabId };
              }),
            };
          }
          return { workspaces };
        });
        syncOp(workspaceId, {
          op: "close_pane",
          data: { tab_id: tabId, pane_id: paneId },
        });
      },

      setActivePane: (workspaceId, tabId, paneId) =>
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            activePaneId: paneId,
          })),
        })),

      resizeSplit: (workspaceId, tabId, splitId, sizes) => {
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            root: setSizesAt(t.root, splitId, sizes),
          })),
        }));
      },

      updatePaneCwd: (workspaceId, tabId, paneId, cwd) => {
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            root: setLeafCwd(t.root, paneId, cwd),
            // also bump tab.cwd when the snapshot is for the tab's active pane,
            // so future new-tab calls fall back to the most relevant directory
            cwd: paneId === t.activePaneId ? cwd : t.cwd,
          })),
        }));
        syncOp(workspaceId, {
          op: "update_pane_cwd",
          data: { tab_id: tabId, pane_id: paneId, cwd },
        });
      },

      setPaneAgent: (workspaceId, tabId, paneId, agent) => {
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            root: setLeafAgent(t.root, paneId, agent),
          })),
        }));
        const publicAgent = agent
          ? {
              kind: agent.kind,
              command: agent.command,
              sessionId: agent.sessionId,
            }
          : null;
        syncOp(workspaceId, {
          op: "set_pane_agent",
          data: { pane_id: paneId, agent: publicAgent },
        });
      },

      activeWorkspace: () => {
        const s = get();
        return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      },

      applyAgentSnapshot: (hostId, documents) =>
        set((state) => {
          const existing = new Map(
            state.workspaces.map((workspace) => [workspace.id, workspace])
          );
          const localOrder = new Map(
            state.workspaces
              .filter(
                (workspace) => (workspace.hostId ?? "local") === hostId
              )
              .map((workspace, index) => [workspace.id, index])
          );
          const retained = state.workspaces.filter(
            (workspace) => (workspace.hostId ?? "local") !== hostId
          );
          const projected = documents
            .map((document, agentIndex) => ({
              workspace: mergeAgentWorkspace(
                existing.get(document.id),
                document,
                hostId
              ),
              order:
                localOrder.get(document.id) ??
                localOrder.size + agentIndex,
            }))
            .sort((a, b) => a.order - b.order)
            .map((item) => item.workspace);
          const workspaces = [...retained, ...projected];
          const activeWorkspaceId =
            state.activeWorkspaceId &&
            workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
              ? state.activeWorkspaceId
              : (workspaces[0]?.id ?? null);
          return { workspaces, activeWorkspaceId };
        }),

      applyAgentWorkspace: (hostId, document) =>
        set((state) => {
          const index = state.workspaces.findIndex(
            (workspace) => workspace.id === document.id
          );
          const merged = mergeAgentWorkspace(
            index >= 0 ? state.workspaces[index] : undefined,
            document,
            hostId
          );
          if (index < 0) {
            return {
              workspaces: [...state.workspaces, merged],
              activeWorkspaceId: state.activeWorkspaceId ?? merged.id,
            };
          }
          const workspaces = state.workspaces.slice();
          workspaces[index] = merged;
          return { workspaces };
        }),

      removeAgentWorkspace: (hostId, workspaceId) =>
        set((state) => {
          const workspaces = state.workspaces.filter(
            (workspace) =>
              workspace.id !== workspaceId ||
              (workspace.hostId ?? "local") !== hostId
          );
          return {
            workspaces,
            activeWorkspaceId:
              state.activeWorkspaceId === workspaceId
                ? (workspaces[0]?.id ?? null)
                : state.activeWorkspaceId,
          };
        }),
    }),
    {
      name: "yterminal-workspaces",
      version: 6,
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
      }),
      // v1 (flat tabs, no pane tree) -> v2: rebuild tabs with a single leaf.
      // v2 -> v3: PaneLeaf.agent is additive/optional; nothing to rewrite.
      // v3 -> v4: PaneAgent.env is additive/optional; nothing to rewrite.
      // v4 -> v5: Tab.file is additive/optional; nothing to rewrite.
      // v5 -> v6: Workspace.hostId, PaneLeaf.sessionId/runtimeStatus are additive.
      migrate: (persisted: any, version) => {
        if (!persisted) return persisted;
        if (version < 6) {
          // Keep one immutable copy of the pre-agent authority document. The
          // live Zustand entry becomes an offline projection after import, so
          // this separate key is the rollback source if first-run migration
          // is interrupted or an older build must be restored.
          try {
            const key = "yterminal-workspaces.pre-agent-backup.v5";
            if (!localStorage.getItem(key)) {
              localStorage.setItem(
                key,
                JSON.stringify({ version, state: persisted })
              );
            }
          } catch {
            /* storage unavailable; the agent import still remains safe */
          }
        }
        if (version < 2 && Array.isArray(persisted.workspaces)) {
          persisted.workspaces = persisted.workspaces.map((w: any) => ({
            ...w,
            tabs: (w.tabs ?? []).map((t: any) => {
              if (t.root) return t;
              const leaf = makeLeaf(t.cwd ?? "~");
              return {
                id: t.id,
                name: t.name,
                customName: t.customName,
                cwd: t.cwd ?? "~",
                root: leaf,
                activePaneId: leaf.id,
              };
            }),
          }));
        }
        return persisted;
      },
    }
  )
);

/** Ensure there is always at least one workspace on first launch. */
export function ensureSeedWorkspace() {
  const s = useWorkspaceStore.getState();
  const local = s.workspaces.filter(
    (workspace) => (workspace.hostId ?? "local") === "local"
  );
  if (local.length === 0) {
    s.addWorkspace("workspace 1");
  } else if (!s.activeWorkspaceId) {
    s.setActiveWorkspace(local[0].id);
  }
}

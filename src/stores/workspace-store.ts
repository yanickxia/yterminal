// workspace-store: owns the workspace -> tab -> pane-tree structure + persistence.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tab, Workspace } from "../lib/types";
import { uid } from "../lib/uid";
import { makeLeaf, splitPane, removePane, setSizesAt } from "../lib/pane-tree";

function defaultCwd(): string {
  return "~";
}

function makeTab(name: string, cwd = defaultCwd()): Tab {
  const leaf = makeLeaf(cwd);
  return {
    id: uid("tab"),
    name,
    cwd,
    root: leaf,
    activePaneId: leaf.id,
  };
}

function makeWorkspace(name: string): Workspace {
  const firstTab = makeTab("shell");
  return {
    id: uid("ws"),
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
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setActiveWorkspace: (id: string) => void;

  // ---- tab ops ----
  addTab: (workspaceId: string, name?: string) => void;
  removeTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, name: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;

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

  // ---- selectors ----
  activeWorkspace: () => Workspace | undefined;
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

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,

      addWorkspace: (name) =>
        set((s) => {
          const count = s.workspaces.length + 1;
          const ws = makeWorkspace(name ?? `workspace ${count}`);
          return {
            workspaces: [...s.workspaces, ws],
            activeWorkspaceId: ws.id,
          };
        }),

      removeWorkspace: (id) =>
        set((s) => {
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          let activeWorkspaceId = s.activeWorkspaceId;
          if (activeWorkspaceId === id) {
            activeWorkspaceId = workspaces[0]?.id ?? null;
          }
          return { workspaces, activeWorkspaceId };
        }),

      renameWorkspace: (id, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name } : w
          ),
        })),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      addTab: (workspaceId, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            const tab = makeTab(name ?? "shell");
            return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
          }),
        })),

      removeTab: (workspaceId, tabId) =>
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
        })),

      renameTab: (workspaceId, tabId, name) =>
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            name,
            customName: name,
          })),
        })),

      setActiveTab: (workspaceId, tabId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, activeTabId: tabId } : w
          ),
        })),

      splitActivePane: (workspaceId, tabId, direction) =>
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => {
            const { tree, newLeafId } = splitPane(
              t.root,
              t.activePaneId,
              direction,
              t.cwd
            );
            return { ...t, root: tree, activePaneId: newLeafId };
          }),
        })),

      closePane: (workspaceId, tabId, paneId) =>
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
        }),

      setActivePane: (workspaceId, tabId, paneId) =>
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            activePaneId: paneId,
          })),
        })),

      resizeSplit: (workspaceId, tabId, splitId, sizes) =>
        set((s) => ({
          workspaces: mapTab(s.workspaces, workspaceId, tabId, (t) => ({
            ...t,
            root: setSizesAt(t.root, splitId, sizes),
          })),
        })),

      activeWorkspace: () => {
        const s = get();
        return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      },
    }),
    {
      name: "yterminal-workspaces",
      version: 2,
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
      }),
      // v1 (flat tabs, no pane tree) -> v2: rebuild tabs with a single leaf.
      migrate: (persisted: any, version) => {
        if (!persisted) return persisted;
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
  if (s.workspaces.length === 0) {
    s.addWorkspace("workspace 1");
  } else if (!s.activeWorkspaceId) {
    s.setActiveWorkspace(s.workspaces[0].id);
  }
}

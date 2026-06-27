// workspace-store: owns the workspace + tab tree and persistence.
// This is the heart of yterminal's "sidebar of workspaces, tabs inside each" model.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Tab, Workspace } from "../lib/types";
import { uid } from "../lib/uid";

/** default home dir used when spawning a fresh tab */
function defaultCwd(): string {
  // The backend resolves "~" / empty to the user's home; keep it simple here.
  return "~";
}

function makeTab(name: string, cwd = defaultCwd()): Tab {
  return { id: uid("tab"), name, cwd };
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

  // ---- selectors ----
  activeWorkspace: () => Workspace | undefined;
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
            return {
              ...w,
              tabs: [...w.tabs, tab],
              activeTabId: tab.id,
            };
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
          workspaces: s.workspaces.map((w) => {
            if (w.id !== workspaceId) return w;
            return {
              ...w,
              tabs: w.tabs.map((t) =>
                t.id === tabId ? { ...t, name, customName: name } : t
              ),
            };
          }),
        })),

      setActiveTab: (workspaceId, tabId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, activeTabId: tabId } : w
          ),
        })),

      activeWorkspace: () => {
        const s = get();
        return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      },
    }),
    {
      name: "yterminal-workspaces",
      // Only persist the tree, not the action functions.
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
      }),
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

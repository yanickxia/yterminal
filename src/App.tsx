import { useEffect, useState } from "react";
import { useWorkspaceStore, ensureSeedWorkspace } from "./stores/workspace-store";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TabBar } from "./components/TabBar";
import { PaneRenderer, refitTree } from "./components/PaneRenderer";
import { disposeSession, applyAppearance, initShell } from "./lib/terminal-manager";
import { collectLeafIds } from "./lib/pane-tree";
import { pruneScrollback } from "./lib/scrollback";
import { loadConfigFromDisk } from "./lib/config";

export default function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  // gate the UI until the real login shell is resolved, so the first pane
  // doesn't spawn against a fallback shell before $SHELL is known.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initShell();
      if (cancelled) return;
      // load appearance from the on-disk JSON config (synced/hand-editable);
      // falls back to localStorage-persisted settings if the file is absent
      await loadConfigFromDisk();
      if (cancelled) return;
      ensureSeedWorkspace();
      // sync app-chrome colors to the saved theme before any terminal opens
      applyAppearance();
      // drop scrollback snapshots whose panes no longer exist in the store
      const live = new Set<string>();
      for (const w of useWorkspaceStore.getState().workspaces) {
        for (const t of w.tabs) for (const id of collectLeafIds(t.root)) live.add(id);
      }
      pruneScrollback(live);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // re-read the config file whenever the window regains focus, so syncing the
  // file in (git pull / Dropbox / hand edit) updates the running app live.
  useEffect(() => {
    if (!ready) return;
    async function reload() {
      const changed = await loadConfigFromDisk();
      if (changed) applyAppearance();
    }
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [ready]);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeTab = ws?.tabs.find((t) => t.id === ws.activeTabId);

  // keyboard shortcuts: split / close pane
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !ws || !ws.activeTabId) return;
      const key = e.key.toLowerCase();
      if (key === "d") {
        e.preventDefault();
        splitActivePane(ws.id, ws.activeTabId, e.shiftKey ? "column" : "row");
      } else if (key === "w" && e.shiftKey) {
        // Cmd/Ctrl+Shift+W: close the focused pane
        e.preventDefault();
        const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
        if (tab) {
          disposeSession(tab.activePaneId);
          closePane(ws.id, ws.activeTabId, tab.activePaneId);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, splitActivePane, closePane]);

  // refit terminals whenever the active tab's tree changes
  useEffect(() => {
    if (activeTab) {
      const id = requestAnimationFrame(() => refitTree(activeTab.root));
      return () => cancelAnimationFrame(id);
    }
  }, [activeTab?.root]);

  return (
    <div className="app">
      <WorkspaceSidebar />
      <div className="main">
        {!ready ? (
          <div className="empty">Starting…</div>
        ) : ws ? (
          <>
            <TabBar workspace={ws} />
            <div className="terminal-area">
              {activeTab ? (
                <PaneRenderer
                  node={activeTab.root}
                  activePaneId={activeTab.activePaneId}
                  onFocusPane={(paneId) =>
                    setActivePane(ws.id, activeTab.id, paneId)
                  }
                  onExitPane={(paneId) => {
                    // shell exited -> tear down its session and close the pane
                    disposeSession(paneId);
                    closePane(ws.id, activeTab.id, paneId);
                  }}
                  onResize={(splitId, sizes) => {
                    resizeSplit(ws.id, activeTab.id, splitId, sizes);
                    requestAnimationFrame(() => refitTree(activeTab.root));
                  }}
                />
              ) : (
                <div className="empty">No tab. Press + to open a shell.</div>
              )}
            </div>
          </>
        ) : (
          <div className="empty">No workspace.</div>
        )}
      </div>
    </div>
  );
}

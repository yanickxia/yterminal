import { useEffect } from "react";
import { useWorkspaceStore, ensureSeedWorkspace } from "./stores/workspace-store";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TabBar } from "./components/TabBar";
import { PaneRenderer, refitTree } from "./components/PaneRenderer";
import { disposeSession } from "./lib/terminal-manager";

export default function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  useEffect(() => {
    ensureSeedWorkspace();
  }, []);

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
        {ws ? (
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

import { useEffect } from "react";
import { useWorkspaceStore, ensureSeedWorkspace } from "./stores/workspace-store";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";

export default function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    ensureSeedWorkspace();
  }, []);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeTab = ws?.tabs.find((t) => t.id === ws.activeTabId);

  return (
    <div className="app">
      <WorkspaceSidebar />
      <div className="main">
        {ws ? (
          <>
            <TabBar workspace={ws} />
            <div className="terminal-area">
              {activeTab ? (
                <TerminalView key={activeTab.id} tab={activeTab} />
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

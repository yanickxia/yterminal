import { useCallback, useEffect, useState } from "react";
import { useWorkspaceStore, ensureSeedWorkspace } from "./stores/workspace-store";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TabBar } from "./components/TabBar";
import { PaneRenderer, refitTree } from "./components/PaneRenderer";
import { SearchBox } from "./components/SearchBox";
import { WorkspacePalette } from "./components/WorkspacePalette";
import { disposeSession, applyAppearance, initShell, addTabInheritingCwd } from "./lib/terminal-manager";
import { collectLeafIds } from "./lib/pane-tree";
import { pruneScrollback, preloadScrollbacks } from "./lib/scrollback";
import { loadConfigFromDisk } from "./lib/config";
import { registerSystemFonts } from "./lib/themes";
import { detectSystemFonts } from "./lib/system-fonts";
import { scheduleAutoCheck } from "./lib/updater-auto-check";
import { useUpdaterStore } from "./stores/updater-store";
import { UpdateDialog } from "./components/UpdateDialog";

export default function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  // gate the UI until the real login shell is resolved, so the first pane
  // doesn't spawn against a fallback shell before $SHELL is known.
  const [ready, setReady] = useState(false);
  // when set, the in-terminal search box is open for this pane id
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initShell();
      if (cancelled) return;
      // load appearance from the on-disk JSON config (synced/hand-editable);
      // falls back to localStorage-persisted settings if the file is absent.
      // A saved system-font id that isn't catalogued yet is preserved as-is
      // (config.ts keeps any non-empty string), so we can defer font detection
      // to after the UI is up.
      await loadConfigFromDisk();
      if (cancelled) return;
      // Prime the in-memory scrollback cache from SQLite BEFORE any pane mounts,
      // so loadScrollback (which the React lifecycle calls synchronously) sees
      // the saved data. Also handles the one-time localStorage migration.
      await preloadScrollbacks();
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
      scheduleAutoCheck();

      // probe installed monospace fonts in the background — the native call is
      // cached to disk on the Rust side so subsequent launches are ~instant,
      // but the very first one can take 1-2s. Off the critical path: the
      // Settings picker reads getAllFonts() on open, which sees the updated
      // list once this resolves.
      detectSystemFonts().then((fonts) => {
        if (!cancelled) registerSystemFonts(fonts);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Suppress the WKWebView native context menu (Cut/Copy/Paste/Spelling/…)
  // globally. macOS treats Ctrl+click — and sometimes Ctrl-modified keys on
  // editable text — as a secondary click, which would otherwise pop the
  // system menu on top of the terminal. Our own right-click menus (TabBar,
  // WorkspaceSidebar) handle onContextMenu themselves, so blocking the
  // default here doesn't break them.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
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

  // Subscribe to store; show dialog when an update becomes available.
  useEffect(() => {
    return useUpdaterStore.subscribe((s, prev) => {
      if (s.state === "available" && prev.state !== "available") {
        setUpdateDialogOpen(true);
      }
    });
  }, []);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeTab = ws?.tabs.find((t) => t.id === ws.activeTabId);

  // keyboard shortcuts: split / close pane
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      // Cmd/Ctrl+K: workspace/tab quick switcher. Works regardless of whether
      // a workspace or tab is currently focused.
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Cmd/Ctrl+N: new workspace. Independent of any active workspace/tab
      // so it works from a fully empty state too.
      if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        addWorkspace();
        return;
      }
      // Cmd/Ctrl+T: new tab in the current workspace, inheriting the active
      // pane's cwd. Cwd inheritance is scoped to this workspace only.
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        if (ws) void addTabInheritingCwd(ws.id);
        return;
      }
      if (!ws || !ws.activeTabId) return;
      if (key === "d") {
        e.preventDefault();
        splitActivePane(ws.id, ws.activeTabId, e.shiftKey ? "column" : "row");
      } else if (key === "f") {
        // Cmd/Ctrl+F: open in-terminal search for the focused pane
        e.preventDefault();
        const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
        if (tab) setSearchPaneId(tab.activePaneId);
      } else if (key === "w" && e.shiftKey) {
        // Cmd/Ctrl+Shift+W: close the focused pane
        e.preventDefault();
        const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
        if (tab) {
          disposeSession(tab.activePaneId);
          closePane(ws.id, ws.activeTabId, tab.activePaneId);
        }
      } else if (key === "w") {
        // Cmd/Ctrl+W: cascade close — pane → tab → workspace.
        // preventDefault stops the OS/webview from closing the window.
        e.preventDefault();
        const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
        if (!tab) return;
        const leafIds = collectLeafIds(tab.root);
        if (leafIds.length > 1) {
          disposeSession(tab.activePaneId);
          closePane(ws.id, ws.activeTabId, tab.activePaneId);
        } else if (ws.tabs.length > 1) {
          for (const id of leafIds) disposeSession(id);
          removeTab(ws.id, ws.activeTabId);
        } else if (workspaces.length > 1) {
          for (const t of ws.tabs)
            for (const id of collectLeafIds(t.root)) disposeSession(id);
          removeWorkspace(ws.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, workspaces, splitActivePane, closePane, removeTab, removeWorkspace, addWorkspace]);

  // refit terminals whenever the active tab's tree changes
  useEffect(() => {
    if (activeTab) {
      const id = requestAnimationFrame(() => refitTree(activeTab.root));
      return () => cancelAnimationFrame(id);
    }
  }, [activeTab?.root]);

  // Stable callbacks passed into PaneRenderer / PaneTerminal. Without these,
  // every App re-render (e.g. the 15s cwd snapshot tick that updates the
  // workspace store) would hand PaneTerminal fresh arrow refs and trip its
  // useEffect deps, tearing down and re-mounting the xterm session.
  const wsId = ws?.id;
  const tabId = activeTab?.id;
  const tabRoot = activeTab?.root;
  const onFocusPane = useCallback(
    (paneId: string) => {
      if (!wsId || !tabId) return;
      setActivePane(wsId, tabId, paneId);
    },
    [wsId, tabId, setActivePane]
  );
  const onExitPane = useCallback(
    (paneId: string) => {
      if (!wsId || !tabId) return;
      // shell exited -> tear down its session and close the pane
      disposeSession(paneId);
      closePane(wsId, tabId, paneId);
    },
    [wsId, tabId, closePane]
  );
  const onResizePane = useCallback(
    (splitId: string, sizes: number[]) => {
      if (!wsId || !tabId || !tabRoot) return;
      resizeSplit(wsId, tabId, splitId, sizes);
      requestAnimationFrame(() => refitTree(tabRoot));
    },
    [wsId, tabId, tabRoot, resizeSplit]
  );
  return (
    <div className="app">
      <WorkspaceSidebar onOpenPalette={() => setPaletteOpen(true)} />
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
                  onFocusPane={onFocusPane}
                  onExitPane={onExitPane}
                  onResize={onResizePane}
                />
              ) : (
                <div className="empty">No tab. Press + to open a shell.</div>
              )}
              {searchPaneId &&
                activeTab &&
                collectLeafIds(activeTab.root).includes(searchPaneId) && (
                  <SearchBox
                    key={searchPaneId}
                    paneId={searchPaneId}
                    onClose={() => setSearchPaneId(null)}
                  />
                )}
            </div>
          </>
        ) : (
          <div className="empty">No workspace.</div>
        )}
      </div>
      {paletteOpen && (
        <WorkspacePalette onClose={() => setPaletteOpen(false)} />
      )}
      <UpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
      />
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore, ensureSeedWorkspace } from "./stores/workspace-store";
import { useSettingsStore } from "./stores/settings-store";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TabBar } from "./components/TabBar";
import { PaneRenderer, refitTree } from "./components/PaneRenderer";
import { SearchBox } from "./components/SearchBox";
import { WorkspacePalette } from "./components/WorkspacePalette";
import { AgentOverview } from "./components/AgentOverview";
import { disposeSession, applyAppearance, initShell, addTabInheritingCwd, setOnCommandSettled, pruneSessionsToWorkspaceProjection } from "./lib/terminal-manager";
import { collectLeafIds } from "./lib/pane-tree";
import { pruneScrollback, preloadScrollbacks } from "./lib/scrollback";
import { loadConfigFromDisk } from "./lib/config";
import { installClaudeHooks } from "./lib/agent-hooks";
import { registerSystemFonts } from "./lib/themes";
import { detectSystemFonts } from "./lib/system-fonts";
import { scheduleAutoCheck } from "./lib/updater-auto-check";
import { useUpdaterStore } from "./stores/updater-store";
import { UpdateDialog } from "./components/UpdateDialog";
import { FileViewer } from "./components/FileViewer";
import { AiSidebar } from "./components/AiSidebar";
import { GitSidebar } from "./components/GitSidebar";
import { WorkspaceStatusBar } from "./components/WorkspaceStatusBar";
import { AppDivider } from "./components/AppDivider";
import { useViewerStore } from "./stores/viewer-store";
import { useAiStore } from "./stores/ai-store";
import { useGitStore } from "./stores/git-store";
import { useLayoutStore } from "./stores/layout-store";
import { clearAttention } from "./stores/attention-store";
import { logger, installGlobalErrorLogging, setVerbose } from "./lib/logger";
import { matchAppShortcut } from "./lib/app-shortcut";
import { detectIsMac } from "./lib/link-modifier";
import {
  configureWorkspaceProjection,
  startWorkspaceSync,
} from "./lib/workspace-sync";
import { startConfiguredRemoteHosts } from "./lib/remote-host-manager";

// Platform detected once at module load (same source as the link modifier).
// Drives the shortcut modifier split: Cmd on macOS, Ctrl+Shift elsewhere.
const isMac = detectIsMac();

export default function App() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const splitActivePane = useWorkspaceStore((s) => s.splitActivePane);
  const closePane = useWorkspaceStore((s) => s.closePane);
  const removeTab = useWorkspaceStore((s) => s.removeTab);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  // gate the UI until the real login shell is resolved, so the first pane
  // doesn't spawn against a fallback shell before $SHELL is known.
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  // when set, the in-terminal search box is open for this pane id
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const aiOpen = useAiStore((s) => s.open);
  const aiWidth = useLayoutStore((s) => s.aiWidth);
  const setAiWidth = useLayoutStore((s) => s.setAiWidth);
  const gitOpen = useGitStore((s) => s.open);
  const gitWidth = useLayoutStore((s) => s.gitWidth);
  const setGitWidth = useLayoutStore((s) => s.setGitWidth);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      installGlobalErrorLogging();
      // The persisted user setting is the source of truth for verbosity (the
      // backend's flag resets to its default each launch). Push it both ways.
      const wantVerbose = useSettingsStore.getState().debugVerbose;
      setVerbose(wantVerbose);
      try {
        await invoke("set_log_verbose", { verbose: wantVerbose });
      } catch {
        /* non-Tauri — ignore */
      }
      logger.info("app", "startup begin");
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
      configureWorkspaceProjection({
        replaceHost: (hostId, documents) => {
          useWorkspaceStore.getState().applyAgentSnapshot(hostId, documents);
          pruneSessionsToWorkspaceProjection();
        },
        upsert: (hostId, document) => {
          useWorkspaceStore.getState().applyAgentWorkspace(hostId, document);
          pruneSessionsToWorkspaceProjection();
        },
        remove: (hostId, workspaceId) => {
          useWorkspaceStore.getState().removeAgentWorkspace(hostId, workspaceId);
          pruneSessionsToWorkspaceProjection();
        },
      });
      await startWorkspaceSync(useWorkspaceStore.getState().workspaces);
      if (cancelled) return;
      // Load every face before the first terminal opens. Otherwise open() can
      // measure fallback metrics and WebGL can bake fallback glyphs on macOS.
      await applyAppearance();
      if (cancelled) return;
      // drop scrollback snapshots whose panes no longer exist in the store
      const live = new Set<string>();
      for (const w of useWorkspaceStore.getState().workspaces) {
        for (const t of w.tabs) for (const id of collectLeafIds(t.root)) live.add(id);
      }
      pruneScrollback(live);
      setReady(true);
      logger.info("app", "startup ready");
      startConfiguredRemoteHosts();
      scheduleAutoCheck();

      // probe installed monospace fonts in the background — the native call is
      // cached to disk on the Rust side so subsequent launches are ~instant,
      // but the very first one can take 1-2s. Off the critical path: the
      // Settings picker reads getAllFonts() on open, which sees the updated
      // list once this resolves.
      detectSystemFonts().then((fonts) => {
        if (!cancelled) registerSystemFonts(fonts);
      });
    })().catch((error) => {
      if (cancelled) return;
      const message = String(error);
      logger.error("app", `startup failed: ${message}`);
      setStartupError(message);
    });
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

  // Install (or remove) the Claude Code agent-status hooks in
  // ~/.claude/settings.json whenever the setting changes — and once at boot
  // after the config has loaded (which may flip the setting from disk). The
  // Rust side is idempotent and preserves the user's own hooks; the wrapper
  // never throws.
  const agentStatusHooks = useSettingsStore((s) => s.agentStatusHooks);
  useEffect(() => {
    if (!ready) return;
    void installClaudeHooks(agentStatusHooks);
  }, [ready, agentStatusHooks]);

  // re-read the config file whenever the window regains focus, so syncing the
  // file in (git pull / Dropbox / hand edit) updates the running app live. Also
  // refresh the git sidebar — the working tree may have changed in another app.
  useEffect(() => {
    if (!ready) return;
    async function reload() {
      const changed = await loadConfigFromDisk();
      if (changed) await applyAppearance();
      void useGitStore.getState().refresh();
    }
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [ready]);

  // Auto-refresh the git sidebar after every command: the shell emits OSC 7 on
  // each prompt, which terminal-manager debounces into this callback. The store
  // no-ops while the panel is closed, so this is free when the sidebar is hidden.
  useEffect(() => {
    setOnCommandSettled(() => {
      void useGitStore.getState().refresh();
    });
    return () => setOnCommandSettled(null);
  }, []);

  // Foreground only the decisions that need the user: a manually discovered
  // update, and the install/restart prompt after any background download.
  useEffect(() => {
    return useUpdaterStore.subscribe((s, prev) => {
      if (
        s.state === "available" &&
        prev.state !== "available" &&
        !s.backgroundDownload
      ) {
        setUpdateDialogOpen(true);
      }
      if (s.state === "ready" && prev.state !== "ready") {
        setUpdateDialogOpen(true);
      }
    });
  }, []);

  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const activeTab = ws?.tabs.find((t) => t.id === ws.activeTabId);

  // keyboard shortcuts: split / close pane
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // All bindings classified in one pure place. macOS uses Cmd(+Shift for
      // sub-variants); Linux/Windows use Ctrl+Shift(+Alt for sub-variants) —
      // bare Ctrl+letter is deliberately NOT matched so terminal control chars
      // (Ctrl+W delete-word, Ctrl+T, …) still reach the shell. See app-shortcut.ts.
      const sc = matchAppShortcut(e, isMac);
      if (!sc) return;
      // `consume` marks the shortcut as handled: preventDefault stops the
      // OS/webview default, and stopPropagation is what makes these bindings
      // work at all — the listener is registered in the CAPTURE phase (below)
      // so it runs on `window` before the focused xterm textarea, and halting
      // propagation here keeps xterm from also acting on the keystroke.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (sc.action) {
        case "palette":
          consume();
          setOverviewOpen(false);
          setPaletteOpen((open) => !open);
          return;
        case "overview":
          consume();
          setPaletteOpen(false);
          setOverviewOpen((open) => !open);
          return;
        case "aiSidebar":
          consume();
          useAiStore.getState().toggleOpen();
          return;
        case "newWorkspace":
          consume();
          addWorkspace();
          return;
        case "newTab":
          consume();
          if (ws) void addTabInheritingCwd(ws.id);
          return;
        case "switchWorkspace": {
          // Jump to the Nth workspace in sidebar order (visual order).
          const target = workspaces[sc.n - 1];
          if (target) {
            consume();
            if (target.id !== activeWorkspaceId) setActiveWorkspace(target.id);
          }
          return;
        }
        case "switchTab": {
          // Jump to the Nth tab of the current workspace (visual order).
          if (!ws) return;
          const target = ws.tabs[sc.n - 1];
          if (target) {
            consume();
            if (target.id !== ws.activeTabId) setActiveTab(ws.id, target.id);
          }
          return;
        }
      }
      // Remaining actions need an active tab.
      if (!ws || !ws.activeTabId) return;
      const curTab = ws.tabs.find((t) => t.id === ws.activeTabId);
      // File-viewer tabs have no shell: split/search don't apply, and close
      // skips session disposal (just forgets the cached content).
      if (curTab?.file) {
        if (sc.action === "closeCascade" || sc.action === "closePane") {
          consume();
          useViewerStore.getState().drop(curTab.id);
          if (ws.tabs.length > 1 || workspaces.length > 1) {
            removeTab(ws.id, ws.activeTabId);
          }
        }
        return;
      }
      switch (sc.action) {
        case "split":
          consume();
          splitActivePane(ws.id, ws.activeTabId, sc.column ? "column" : "row");
          return;
        case "search": {
          // open in-terminal search for the focused pane
          consume();
          const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
          if (tab) setSearchPaneId(tab.activePaneId);
          return;
        }
        case "closePane": {
          // close the focused pane
          consume();
          const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
          if (tab) {
            disposeSession(tab.activePaneId);
            closePane(ws.id, ws.activeTabId, tab.activePaneId);
          }
          return;
        }
        case "closeCascade": {
          // cascade close — pane → tab → workspace.
          consume();
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
          return;
        }
      }
    }
    // Capture phase (true): run on `window` before the focused xterm textarea.
    // Only Cmd (mac) / Ctrl+Shift(+Alt) (Linux/Win) chords are consumed; every
    // other key — including bare Ctrl+letter control chars — passes through to
    // the terminal untouched. See matchAppShortcut.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ws, workspaces, activeWorkspaceId, splitActivePane, closePane, removeTab, removeWorkspace, addWorkspace, setActiveWorkspace, setActiveTab]);

  // refit terminals whenever the active tab's tree changes
  useEffect(() => {
    if (activeTab) {
      const id = requestAnimationFrame(() => refitTree(activeTab.root));
      return () => cancelAnimationFrame(id);
    }
  }, [activeTab?.root]);

  // Whenever the active tab changes (switch via click / Cmd+K / new tab), its
  // focused pane is now on screen, so acknowledge any pending attention on it.
  useEffect(() => {
    if (activeTab?.activePaneId) clearAttention(activeTab.activePaneId);
  }, [activeTab?.id, activeTab?.activePaneId]);

  // Recompute git status when the active tab (or its focused pane) changes, and
  // when the git sidebar is opened — the panel tracks the active tab's cwd. The
  // store no-ops while the panel is closed, so this is cheap.
  useEffect(() => {
    void useGitStore.getState().refresh();
  }, [activeTab?.id, activeTab?.activePaneId, gitOpen]);

  // opening/closing the AI sidebar or dragging either app divider changes the
  // terminal area's width, so refit the active tab's panes once layout settles.
  useEffect(() => {
    if (activeTab) {
      const id = requestAnimationFrame(() => refitTree(activeTab.root));
      return () => cancelAnimationFrame(id);
    }
  }, [aiOpen, aiWidth, sidebarWidth, sidebarCollapsed, gitOpen, gitWidth]);

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
      // focusing a pane acknowledges any pending attention flag on it
      clearAttention(paneId);
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

  // Refit the active tab's panes after an app-divider drag commits its width.
  const refitActive = useCallback(() => {
    if (tabRoot) requestAnimationFrame(() => refitTree(tabRoot));
  }, [tabRoot]);
  return (
    <div className="app">
      <WorkspaceSidebar onOpenPalette={() => setPaletteOpen(true)} />
      {!sidebarCollapsed && (
        <AppDivider
          side="left"
          onDrag={(dx) => setSidebarWidth(sidebarWidth + dx)}
          onDragEnd={refitActive}
        />
      )}
      <div className="main">
        {!ready ? (
          <div className="empty">
            {startupError ? `Agent startup failed: ${startupError}` : "Starting…"}
          </div>
        ) : ws ? (
          <>
            <TabBar workspace={ws} />
            <div className="terminal-area">
              {activeTab ? (
                activeTab.file ? (
                  <FileViewer
                    tabId={activeTab.id}
                    file={activeTab.file}
                    workspaceId={ws.id}
                  />
                ) : (
                  <PaneRenderer
                    node={activeTab.root}
                    activePaneId={activeTab.activePaneId}
                    onFocusPane={onFocusPane}
                    onExitPane={onExitPane}
                    onResize={onResizePane}
                  />
                )
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
            <WorkspaceStatusBar onOpenOverview={() => setOverviewOpen(true)} />
          </>
        ) : (
          <div className="empty">No workspace.</div>
        )}
      </div>
      {gitOpen && (
        <AppDivider
          side="right"
          onDrag={(dx) => setGitWidth(gitWidth - dx)}
          onDragEnd={refitActive}
        />
      )}
      {gitOpen && <GitSidebar />}
      {aiOpen && (
        <AppDivider
          side="right"
          onDrag={(dx) => setAiWidth(aiWidth - dx)}
          onDragEnd={refitActive}
        />
      )}
      {aiOpen && <AiSidebar />}
      {paletteOpen && (
        <WorkspacePalette
          onClose={() => setPaletteOpen(false)}
          onOpenOverview={() => setOverviewOpen(true)}
        />
      )}
      {overviewOpen && <AgentOverview onClose={() => setOverviewOpen(false)} />}
      <UpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
      />
    </div>
  );
}

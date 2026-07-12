// Which pane the user is currently looking at, as a reactive value for the
// agent-status roll-ups (workspace-agents.ts). The "focused pane" is the active
// pane of the active tab in the active workspace — but ONLY while the app window
// itself has focus. When the window is backgrounded there is no pane the user is
// looking at, so this returns undefined and a worked-then-quiet agent is allowed
// to surface as `waiting` again (you switched away, now it's genuinely waiting).
//
// Mirrors the DOM-side `isPaneFocused` gate in terminal-manager (used by the
// bell path); this is its reactive twin so the sidebar dot / status bar recompute
// when focus moves. Kept as a hook (not a store) because window focus is a pure
// DOM signal with no other consumers.

import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";

/** The pane id the user is looking at, or undefined when the window is blurred. */
export function useFocusedPaneId(): string | undefined {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const [windowFocused, setWindowFocused] = useState(
    typeof document === "undefined" ? true : document.hasFocus()
  );
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!windowFocused) return undefined;
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws || !ws.activeTabId) return undefined;
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  return tab?.activePaneId;
}

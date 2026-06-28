import { useEffect, useRef } from "react";
import type { PaneLeaf } from "../lib/types";
import {
  attachSession,
  detachSession,
  fitSession,
  onSessionExit,
  offSessionExit,
} from "../lib/terminal-manager";

/**
 * One leaf == one live terminal. Mounts the cached xterm DOM node for this
 * pane id. Unlike the old single-terminal view, many of these are mounted at
 * once (one per visible pane).
 */
export function PaneTerminal({
  pane,
  active,
  onFocus,
  onExit,
}: {
  pane: PaneLeaf;
  active: boolean;
  onFocus: () => void;
  onExit: (paneId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // close this pane when its shell process exits (e.g. user types `exit`)
    onSessionExit(pane.id, onExit);
    attachSession(pane.id, container, pane.cwd);
    return () => {
      offSessionExit(pane.id);
      detachSession(pane.id);
    };
  }, [pane.id, pane.cwd, onExit]);

  // refit when activation/layout may have changed
  useEffect(() => {
    const id = requestAnimationFrame(() => fitSession(pane.id));
    return () => cancelAnimationFrame(id);
  });

  return (
    <div
      className={"pane-leaf" + (active ? " active" : "")}
      onMouseDown={onFocus}
    >
      <div className="pane-host" ref={containerRef} />
    </div>
  );
}

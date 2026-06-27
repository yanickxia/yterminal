import { useEffect, useRef } from "react";
import type { PaneLeaf } from "../lib/types";
import {
  attachSession,
  detachSession,
  fitSession,
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
}: {
  pane: PaneLeaf;
  active: boolean;
  onFocus: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    attachSession(pane.id, container, pane.cwd);
    return () => detachSession(pane.id);
  }, [pane.id, pane.cwd]);

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

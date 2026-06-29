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
  // Hold onExit behind a ref so the effect below only re-runs when the pane
  // itself changes — NOT on every parent render that recreates the callback
  // arrow inline. Without this, every App.tsx re-render (e.g. the 15s cwd
  // snapshot tick) tears down and re-mounts the xterm session, which raced
  // with the user's wheel events and made scroll jump around mid-browse.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Capture the initial cwd in a ref. After the session is spawned (first
  // attach), this value is irrelevant — getOrCreateSession early-returns and
  // ignores the cwd arg. Pulling it out of the effect deps means a later
  // `cd` (which updates pane.cwd via the snapshot tick) won't gratuitously
  // tear down and re-mount the running xterm session.
  const initialCwdRef = useRef(pane.cwd);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // close this pane when its shell process exits (e.g. user types `exit`)
    onSessionExit(pane.id, (id) => onExitRef.current(id));
    attachSession(pane.id, container, initialCwdRef.current);
    return () => {
      offSessionExit(pane.id);
      detachSession(pane.id);
    };
  }, [pane.id]);

  // Refit only when the container is actually resized, not on every React
  // render. Re-fitting on every render fires spurious PTY resizes (SIGWINCH),
  // which makes full-screen TUIs (Claude Code, vim, htop) redraw repeatedly and
  // leave stacked/garbled output. A ResizeObserver fires only on real size
  // changes; fitSession itself is a no-op when cols/rows are unchanged.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitSession(pane.id));
    });
    ro.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [pane.id]);

  return (
    <div
      className={"pane-leaf" + (active ? " active" : "")}
      onMouseDown={onFocus}
    >
      <div className="pane-host" ref={containerRef} />
    </div>
  );
}

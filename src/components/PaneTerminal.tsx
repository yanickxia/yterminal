import { useEffect, useRef, useState } from "react";
import type { PaneLeaf } from "../lib/types";
import {
  attachSession,
  detachSession,
  fitSession,
  onSessionExit,
  offSessionExit,
  copySelection,
  pasteInto,
  hasSelection,
} from "../lib/terminal-manager";
import { ContextMenu, type MenuItem } from "./ContextMenu";

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
  // Mirror pane.cwd through a ref. Pane.cwd changes (the 15s snapshot tick,
  // OSC 7 updates) must NOT trigger the effect below — that would tear down a
  // live shell. But when the same PaneTerminal instance is reused for a
  // different pane (React reconciliation: activeTab switch, no `key`), the
  // effect re-runs with the new pane.id and needs the *new* pane's cwd to
  // spawn its shell in the right place. Refreshing the ref on every render
  // gives us both: the effect deps stay `[pane.id]` (no spurious re-runs) but
  // we read the latest cwd when the effect actually fires.
  const cwdRef = useRef(pane.cwd);
  cwdRef.current = pane.cwd;

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // close this pane when its shell process exits (e.g. user types `exit`)
    onSessionExit(pane.id, (id) => onExitRef.current(id));
    attachSession(pane.id, container, cwdRef.current);
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
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="pane-host" ref={containerRef} />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
              {
                label: "Copy",
                disabled: !hasSelection(pane.id),
                onClick: () => {
                  void copySelection(pane.id);
                },
              },
              {
                label: "Paste",
                onClick: () => {
                  void pasteInto(pane.id);
                },
              },
            ] satisfies MenuItem[]
          }
        />
      )}
    </div>
  );
}

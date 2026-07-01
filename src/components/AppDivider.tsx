// AppDivider: a slim, draggable vertical handle placed between the app's
// top-level flex columns (workspace sidebar ↔ main, main ↔ AI sidebar). Unlike
// PaneRenderer's percent-based split Divider, these resize a single fixed-width
// panel, so the drag reports an absolute pixel delta and the caller clamps +
// persists it. The window mousemove/mouseup listeners mirror the split Divider,
// and we route the callback through a ref so each move calls the latest closure.

import { useRef } from "react";

export function AppDivider({
  onDrag,
  onDragEnd,
  /** which panel edge this handle drives — "left" resizes the left panel. */
  side,
}: {
  /** Called on each move with the horizontal pixel delta since the last move. */
  onDrag: (deltaPx: number) => void;
  /** Called once when the drag finishes (e.g. to refit terminals). */
  onDragEnd?: () => void;
  side: "left" | "right";
}) {
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const onEndRef = useRef(onDragEnd);
  onEndRef.current = onDragEnd;

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    let last = e.clientX;
    // Suppress text selection / iframe capture during the drag.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    function onMove(ev: MouseEvent) {
      const cur = ev.clientX;
      const deltaPx = cur - last;
      last = cur;
      if (deltaPx !== 0) onDragRef.current(deltaPx);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      onEndRef.current?.();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className={"app-divider app-divider-" + side}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  );
}

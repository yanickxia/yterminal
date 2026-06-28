import { useRef } from "react";
import type { PaneTree } from "../lib/types";
import { PaneTerminal } from "./PaneTerminal";
import { fitSession } from "../lib/terminal-manager";
import { collectLeafIds } from "../lib/pane-tree";

interface RenderProps {
  node: PaneTree;
  activePaneId: string;
  onFocusPane: (paneId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  onExitPane: (paneId: string) => void;
}

export function PaneRenderer(props: RenderProps) {
  const { node, activePaneId, onFocusPane, onResize, onExitPane } = props;

  if (node.type === "leaf") {
    return (
      <PaneTerminal
        pane={node}
        active={node.id === activePaneId}
        onFocus={() => onFocusPane(node.id)}
        onExit={onExitPane}
      />
    );
  }

  const isRow = node.direction === "row";
  return (
    <div className={"split " + (isRow ? "split-row" : "split-col")}>
      {node.children.map((child, i) => (
        <div
          className="split-cell"
          key={child.type === "leaf" ? child.id : child.id}
          style={{ flexBasis: `${node.sizes[i]}%` }}
        >
          <PaneRenderer {...props} node={child} />
          {i < node.children.length - 1 && (
            <Divider
              direction={node.direction}
              onDrag={(deltaPct) => {
                const sizes = [...node.sizes];
                const a = sizes[i] + deltaPct;
                const b = sizes[i + 1] - deltaPct;
                if (a < 8 || b < 8) return; // min size guard
                sizes[i] = a;
                sizes[i + 1] = b;
                onResize(node.id, sizes);
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Divider({
  direction,
  onDrag,
}: {
  direction: "row" | "column";
  onDrag: (deltaPct: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const parent = ref.current?.parentElement?.parentElement; // .split
    if (!parent) return;
    const isRow = direction === "row";
    const total = isRow ? parent.clientWidth : parent.clientHeight;
    let last = isRow ? e.clientX : e.clientY;

    function onMove(ev: MouseEvent) {
      const cur = isRow ? ev.clientX : ev.clientY;
      const deltaPx = cur - last;
      last = cur;
      onDrag((deltaPx / total) * 100);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // sizes are committed to the store on every move; App.tsx refits the
      // whole tree whenever activeTab.root changes, so nothing to do here.
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={ref}
      className={
        "divider " + (direction === "row" ? "divider-v" : "divider-h")
      }
      onMouseDown={onMouseDown}
    />
  );
}

/** Re-fit every leaf in a tree (used after resize commits). */
export function refitTree(node: PaneTree) {
  for (const id of collectLeafIds(node)) fitSession(id);
}

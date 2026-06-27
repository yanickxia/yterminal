// Pure functions for manipulating a Tab's pane split tree.
// No React / no store here — just immutable tree transforms.

import type { PaneTree, PaneLeaf, SplitNode } from "./types";
import { uid } from "./uid";

export function makeLeaf(cwd: string): PaneLeaf {
  return { type: "leaf", id: uid("pane"), cwd };
}

/** Collect all leaf ids in left-to-right order. */
export function collectLeafIds(node: PaneTree, out: string[] = []): string[] {
  if (node.type === "leaf") {
    out.push(node.id);
  } else {
    for (const c of node.children) collectLeafIds(c, out);
  }
  return out;
}

/** Find the leaf object by id. */
export function findLeaf(node: PaneTree, id: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  for (const c of node.children) {
    const found = findLeaf(c, id);
    if (found) return found;
  }
  return null;
}

/**
 * Split the pane `targetId` into two, inserting a new leaf next to it.
 * If the target's parent already splits along the same axis, the new leaf is
 * appended as a sibling (so repeated splits stay flat, like iTerm/tmux).
 * Returns { tree, newLeafId }.
 */
export function splitPane(
  root: PaneTree,
  targetId: string,
  direction: "row" | "column",
  cwd: string
): { tree: PaneTree; newLeafId: string } {
  const newLeaf = makeLeaf(cwd);

  function recur(node: PaneTree, parent: SplitNode | null): PaneTree {
    if (node.type === "leaf") {
      if (node.id !== targetId) return node;
      // If parent splits the same way, caller handles sibling-append; here we
      // wrap the leaf in a fresh split of the requested direction.
      if (parent && parent.direction === direction) {
        // signal to parent via marker; handled below in split branch
        return node; // replaced by parent logic
      }
      const split: SplitNode = {
        type: "split",
        id: uid("split"),
        direction,
        children: [node, newLeaf],
        sizes: [50, 50],
      };
      return split;
    }

    // split node
    if (node.direction === direction) {
      // check if a direct child is the target leaf -> append sibling here (flat)
      const idx = node.children.findIndex(
        (c) => c.type === "leaf" && c.id === targetId
      );
      if (idx !== -1) {
        const n = node.children.length + 1;
        const evenSize = 100 / n;
        const children = [...node.children];
        children.splice(idx + 1, 0, newLeaf);
        return {
          ...node,
          children,
          sizes: children.map(() => evenSize),
        };
      }
    }
    return {
      ...node,
      children: node.children.map((c) => recur(c, node)),
    };
  }

  const tree = recur(root, null);
  return { tree, newLeafId: newLeaf.id };
}

/**
 * Remove a leaf by id. Collapses single-child splits.
 * Returns { tree, nextActiveId } where nextActiveId is a surviving leaf to
 * focus next (or null if the whole tree is gone).
 */
export function removePane(
  root: PaneTree,
  targetId: string
): { tree: PaneTree | null; nextActiveId: string | null } {
  // figure out a sensible next-focus before mutating
  const order = collectLeafIds(root);
  const removedIdx = order.indexOf(targetId);
  const nextActiveId =
    order.filter((id) => id !== targetId)[
      Math.max(0, removedIdx - 1)
    ] ?? null;

  function recur(node: PaneTree): PaneTree | null {
    if (node.type === "leaf") {
      return node.id === targetId ? null : node;
    }
    const children = node.children
      .map(recur)
      .filter((c): c is PaneTree => c !== null);

    if (children.length === 0) return null;
    if (children.length === 1) return children[0]; // collapse

    const evenSize = 100 / children.length;
    // keep relative sizes where possible; simplest: re-even them
    return { ...node, children, sizes: children.map(() => evenSize) };
  }

  const tree = recur(root);
  return { tree, nextActiveId: tree ? nextActiveId : null };
}

/** Update the sizes array of the split node that has these exact children. */
export function setSizesAt(
  root: PaneTree,
  splitId: string,
  sizes: number[]
): PaneTree {
  function recur(node: PaneTree): PaneTree {
    if (node.type === "leaf") return node;
    if (node.id === splitId) return { ...node, sizes };
    return { ...node, children: node.children.map(recur) };
  }
  return recur(root);
}

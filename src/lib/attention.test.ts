import { describe, it, expect } from "vitest";
import { tabsNeedingAttention } from "./attention";
import { makeLeaf } from "./pane-tree";
import type { SplitNode, Tab, Workspace } from "./types";

function tab(id: string, root: Tab["root"], extra: Partial<Tab> = {}): Tab {
  return {
    id,
    name: id,
    cwd: "~",
    root,
    activePaneId: root.type === "leaf" ? root.id : "",
    ...extra,
  };
}

function ws(id: string, tabs: Tab[]): Workspace {
  return { id, name: id, tabs, activeTabId: tabs[0]?.id ?? null };
}

describe("tabsNeedingAttention", () => {
  it("returns nothing when no pane is waiting", () => {
    const leaf = makeLeaf("~");
    const wss = [ws("w1", [tab("t1", leaf)])];
    expect(tabsNeedingAttention(wss, new Set())).toEqual([]);
  });

  it("flags the tab that owns a single waiting leaf", () => {
    const leaf = makeLeaf("~");
    const wss = [ws("w1", [tab("t1", leaf)])];
    const out = tabsNeedingAttention(wss, new Set([leaf.id]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workspaceId: "w1", tabId: "t1", count: 1 });
  });

  it("counts multiple waiting panes within one split tab", () => {
    const a = makeLeaf("~/a");
    const b = makeLeaf("~/b");
    const split: SplitNode = {
      type: "split",
      id: "s1",
      direction: "row",
      children: [a, b],
      sizes: [50, 50],
    };
    const wss = [ws("w1", [tab("t1", split)])];
    const out = tabsNeedingAttention(wss, new Set([a.id, b.id]));
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it("prefers customName and carries the icon", () => {
    const leaf = makeLeaf("~");
    const wss = [
      ws("w1", [tab("t1", leaf, { name: "auto", customName: "mine", icon: "🔥" })]),
    ];
    const out = tabsNeedingAttention(wss, new Set([leaf.id]));
    expect(out[0].tabName).toBe("mine");
    expect(out[0].tabIcon).toBe("🔥");
  });

  it("skips file-viewer tabs", () => {
    const leaf = makeLeaf("~");
    const wss = [
      ws("w1", [
        tab("t1", leaf, {
          file: { path: "/x", language: "markdown", markdown: true },
        }),
      ]),
    ];
    expect(tabsNeedingAttention(wss, new Set([leaf.id]))).toEqual([]);
  });

  it("lists entries in workspace then tab order", () => {
    const a = makeLeaf("~/a");
    const b = makeLeaf("~/b");
    const wss = [
      ws("w1", [tab("t1", a)]),
      ws("w2", [tab("t2", b)]),
    ];
    const out = tabsNeedingAttention(wss, new Set([b.id, a.id]));
    expect(out.map((e) => e.tabId)).toEqual(["t1", "t2"]);
  });
});

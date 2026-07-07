import { describe, it, expect } from "vitest";
import { workspaceAgentSummary } from "./workspace-agents";
import type { PaneAgent, PaneTree, Tab, Workspace } from "./types";

function agent(kind: PaneAgent["kind"], command: string = kind): PaneAgent {
  return { kind, command, sessionId: `${kind}-sess` };
}

function leaf(id: string, opts: { agent?: PaneAgent } = {}): PaneTree {
  return { type: "leaf", id, cwd: "~", agent: opts.agent };
}

function split(direction: "row" | "column", children: PaneTree[]): PaneTree {
  return {
    type: "split",
    id: `split-${children.map((c) => c.id).join("-")}`,
    direction,
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

function tab(id: string, root: PaneTree, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    name: id,
    cwd: "~",
    root,
    activePaneId: root.type === "leaf" ? root.id : root.children[0].id,
    ...extra,
  };
}

function ws(tabs: Tab[]): Workspace {
  return { id: "w1", name: "Work", tabs, activeTabId: tabs[0]?.id ?? null };
}

describe("workspaceAgentSummary", () => {
  it("returns an empty summary for an undefined workspace", () => {
    const s = workspaceAgentSummary(undefined, new Set());
    expect(s).toEqual({ entries: [], total: 0, attention: 0 });
  });

  it("returns an empty summary when no pane has an agent", () => {
    const w = ws([tab("t1", leaf("p1"))]);
    const s = workspaceAgentSummary(w, new Set());
    expect(s.total).toBe(0);
    expect(s.entries).toEqual([]);
  });

  it("lists one entry per agent pane across tabs, in workspace→tab order", () => {
    const w = ws([
      tab("t1", leaf("p1", { agent: agent("claude") })),
      tab("t2", leaf("p2", { agent: agent("codex") })),
    ]);
    const s = workspaceAgentSummary(w, new Set());
    expect(s.total).toBe(2);
    expect(s.entries.map((e) => e.kind)).toEqual(["claude", "codex"]);
    expect(s.entries.map((e) => e.paneId)).toEqual(["p1", "p2"]);
    expect(s.entries.every((e) => e.state === "running")).toBe(true);
  });

  it("walks split trees left-to-right and finds nested agent panes", () => {
    const w = ws([
      tab(
        "t1",
        split("row", [
          leaf("p1", { agent: agent("claude") }),
          split("column", [leaf("p2"), leaf("p3", { agent: agent("opencode") })]),
        ])
      ),
    ]);
    const s = workspaceAgentSummary(w, new Set());
    expect(s.entries.map((e) => e.paneId)).toEqual(["p1", "p3"]);
  });

  it("flags a waiting agent pane as attention and counts it", () => {
    const w = ws([
      tab("t1", leaf("p1", { agent: agent("claude") })),
      tab("t2", leaf("p2", { agent: agent("codex") })),
    ]);
    const s = workspaceAgentSummary(w, new Set(["p2"]));
    expect(s.total).toBe(2);
    expect(s.attention).toBe(1);
    expect(s.entries.find((e) => e.paneId === "p2")?.state).toBe("attention");
    expect(s.entries.find((e) => e.paneId === "p1")?.state).toBe("running");
  });

  it("does not count a waiting pane that has no agent", () => {
    const w = ws([tab("t1", leaf("p1"))]);
    const s = workspaceAgentSummary(w, new Set(["p1"]));
    expect(s.total).toBe(0);
    expect(s.attention).toBe(0);
  });

  it("skips file-viewer tabs even if their inert leaf carries an agent", () => {
    const w = ws([
      tab("t1", leaf("p1", { agent: agent("claude") }), {
        file: { path: "/a.md", language: "markdown", markdown: true },
      }),
    ]);
    const s = workspaceAgentSummary(w, new Set());
    expect(s.total).toBe(0);
  });

  it("prefers a tab's customName over its auto name and carries the icon", () => {
    const w = ws([
      tab("t1", leaf("p1", { agent: agent("claude", "cc") }), {
        name: "auto",
        customName: "  My Agent ",
        icon: "🤖",
      }),
    ]);
    const [e] = workspaceAgentSummary(w, new Set()).entries;
    expect(e.tabName).toBe("My Agent");
    expect(e.tabIcon).toBe("🤖");
    expect(e.command).toBe("cc");
  });
});

import { describe, it, expect } from "vitest";
import {
  workspaceAgentSummary,
  workspacesAgentStatus,
} from "./workspace-agents";
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

function ws(tabs: Tab[], id = "w1", name = "Work"): Workspace {
  return { id, name, tabs, activeTabId: tabs[0]?.id ?? null };
}

describe("workspaceAgentSummary", () => {
  it("returns an empty summary for an undefined workspace", () => {
    const s = workspaceAgentSummary(undefined, new Set());
    expect(s).toEqual({ entries: [], total: 0, attention: 0, executing: 0 });
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
    // no active set given → both fall to "idle".
    expect(s.entries.every((e) => e.state === "idle")).toBe(true);
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
    expect(s.entries.find((e) => e.paneId === "p1")?.state).toBe("idle");
  });

  it("flags an active (not waiting) agent pane as executing and counts it", () => {
    const w = ws([
      tab("t1", leaf("p1", { agent: agent("claude") })),
      tab("t2", leaf("p2", { agent: agent("codex") })),
    ]);
    const s = workspaceAgentSummary(w, new Set(), new Set(["p1"]));
    expect(s.executing).toBe(1);
    expect(s.attention).toBe(0);
    expect(s.entries.find((e) => e.paneId === "p1")?.state).toBe("executing");
    expect(s.entries.find((e) => e.paneId === "p2")?.state).toBe("idle");
  });

  it("prefers attention over executing when a pane is both waiting and active", () => {
    const w = ws([tab("t1", leaf("p1", { agent: agent("claude") }))]);
    const s = workspaceAgentSummary(w, new Set(["p1"]), new Set(["p1"]));
    expect(s.attention).toBe(1);
    expect(s.executing).toBe(0);
    expect(s.entries[0].state).toBe("attention");
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

describe("workspacesAgentStatus", () => {
  it("omits workspaces with no running agent", () => {
    const a = ws([tab("t1", leaf("p1"))], "w1");
    const b = ws([tab("t2", leaf("p2", { agent: agent("claude") }))], "w2");
    const m = workspacesAgentStatus([a, b], new Set(), new Set());
    expect(m.has("w1")).toBe(false);
    expect(m.get("w2")).toEqual({ total: 1, state: "idle" });
  });

  it("counts all agent panes in a workspace and takes the most urgent state", () => {
    const w = ws(
      [
        tab("t1", leaf("p1", { agent: agent("claude") })),
        tab("t2", leaf("p2", { agent: agent("codex") })),
      ],
      "w1"
    );
    // p1 executing, p2 waiting → most urgent = attention, total 2.
    const m = workspacesAgentStatus([w], new Set(["p2"]), new Set(["p1"]));
    expect(m.get("w1")).toEqual({ total: 2, state: "attention" });
  });

  it("reports executing when some pane is active and none are waiting", () => {
    const w = ws(
      [
        tab("t1", leaf("p1", { agent: agent("claude") })),
        tab("t2", leaf("p2", { agent: agent("codex") })),
      ],
      "w1"
    );
    const m = workspacesAgentStatus([w], new Set(), new Set(["p2"]));
    expect(m.get("w1")).toEqual({ total: 2, state: "executing" });
  });

  it("skips file tabs when counting", () => {
    const w = ws(
      [
        tab("t1", leaf("p1", { agent: agent("claude") }), {
          file: { path: "/a.md", language: "markdown", markdown: true },
        }),
      ],
      "w1"
    );
    const m = workspacesAgentStatus([w], new Set(), new Set());
    expect(m.has("w1")).toBe(false);
  });
});

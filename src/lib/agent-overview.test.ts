import { describe, it, expect } from "vitest";
import { collectAllAgents, OVERVIEW_COLS } from "./agent-overview";
import type { Workspace, PaneLeaf, PaneTree } from "./types";

// 造一个带 agent 的 leaf
function leaf(id: string, agentKind?: "claude" | "codex" | "opencode"): PaneLeaf {
  return {
    type: "leaf",
    id,
    cwd: "/tmp",
    ...(agentKind
      ? { agent: { kind: agentKind, command: agentKind, sessionId: "s" } }
      : {}),
  } as PaneLeaf;
}

function ws(id: string, name: string, roots: PaneTree[]): Workspace {
  return {
    id,
    name,
    tabs: roots.map((root, i) => ({
      id: `${id}-t${i}`,
      name: `tab${i}`,
      cwd: "/tmp",
      root,
      activePaneId: (root as PaneLeaf).id,
    })),
    activeTabId: `${id}-t0`,
  } as Workspace;
}

const empty = new Set<string>();

describe("collectAllAgents", () => {
  it("空输入返回空数组", () => {
    expect(collectAllAgents([], empty, empty, empty)).toEqual([]);
  });

  it("跨多 workspace 聚合所有 agent（含空闲）", () => {
    const workspaces = [
      ws("w1", "Alpha", [leaf("p1", "claude"), leaf("p2", "codex")]),
      ws("w2", "Beta", [leaf("p3", "opencode")]),
    ];
    const out = collectAllAgents(workspaces, empty, empty, empty);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.paneId).sort()).toEqual(["p1", "p2", "p3"]);
    expect(out.every((e) => e.state === "idle")).toBe(true);
    const p1 = out.find((e) => e.paneId === "p1")!;
    expect(p1.workspaceId).toBe("w1");
    expect(p1.workspaceName).toBe("Alpha");
  });

  it("跳过没有 agent 的 pane 和 file tab", () => {
    const workspaces = [ws("w1", "Alpha", [leaf("p1"), leaf("p2", "claude")])];
    const out = collectAllAgents(workspaces, empty, empty, empty);
    expect(out.map((e) => e.paneId)).toEqual(["p2"]);
  });

  it("按紧急度排序 attention > executing > waiting > idle", () => {
    const workspaces = [
      ws("w1", "Alpha", [
        leaf("idle1", "claude"),
        leaf("exec1", "claude"),
        leaf("attn1", "claude"),
        leaf("wait1", "claude"),
      ]),
    ];
    const waiting = new Set(["attn1"]);
    const active = new Set(["exec1"]);
    const everActive = new Set(["wait1"]);
    const out = collectAllAgents(workspaces, waiting, active, everActive);
    expect(out.map((e) => e.paneId)).toEqual(["attn1", "exec1", "wait1", "idle1"]);
  });

  it("导出固定网格列数常量", () => {
    expect(OVERVIEW_COLS).toBe(3);
  });
});

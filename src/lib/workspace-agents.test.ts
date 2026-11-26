import { describe, it, expect } from "vitest";
import { classify, workspaceAgentSummary, workspacesAgentStatus } from "./workspace-agents";
import type { PaneLeaf, Workspace } from "./types";
import type { PtyAgentObservation } from "./agent-pty";
import { setPtyObservation, useAgentPtyStore } from "../stores/agent-pty-store";

const leaf = (id: string, runtimeStatus?: PaneLeaf["runtimeStatus"]): PaneLeaf => ({
  type: "leaf", id, cwd: "/tmp", agent: { kind: "claude", command: "cc", sessionId: "", instanceId: id }, runtimeStatus,
});
const workspace = (leaves: PaneLeaf[]): Workspace => ({
  id: "w", name: "Work", activeTabId: "t",
  tabs: [{ id: "t", name: "Terminal", customName: "Auth service", cwd: "/tmp", activePaneId: leaves[0]?.id ?? "",
    root: { type: "split", id: "split", direction: "row", children: leaves, sizes: leaves.map(() => 100 / leaves.length) } }],
});
const observation = (state: PtyAgentObservation["state"]): PtyAgentObservation => ({ state, source: "screen", reason: "live controls" });

describe("PTY agent roll-up", () => {
  it("keeps an agent present without a resumable session, with unknown status", () => {
    const summary = workspaceAgentSummary(workspace([leaf("p")]));
    expect(summary.total).toBe(1);
    expect(summary.entries[0]).toMatchObject({ state: "unknown", command: "cc", tabName: "Auth service" });
    expect(summary.waiting).toBe(0);
  });
  it("does not infer waiting from silence or executing from terminal activity", () => {
    expect(classify(leaf("p")).state).toBe("unknown");
    expect(workspacesAgentStatus([workspace([leaf("p")])]).get("w")).toEqual({ total: 1, state: "unknown" });
  });
  it("uses screen evidence for attached terminals and owner title evidence otherwise", () => {
    const leaves = [leaf("screen", "working"), leaf("owner", "permission"), leaf("idle", "idle")];
    const summary = workspaceAgentSummary(workspace(leaves), new Map([["screen", observation("waiting")]]));
    expect(summary.entries.map((entry) => entry.state)).toEqual(["waiting", "attention", "waiting"]);
    expect(summary).toMatchObject({ total: 3, attention: 1, waiting: 2, executing: 0 });
  });
  it("does not apply the foreground screen to a backgrounded agent", () => {
    expect(classify(leaf("p", "background"), new Map([["p", observation("executing")]])).state).toBe("unknown");
  });
  it("retains owner evidence when an attached screen has no recognized controls", () => {
    expect(classify(leaf("p", "permission"), new Map([["p", observation("unknown")]])).state).toBe("attention");
  });
  it("ignores persisted hook status from older daemons", () => {
    const old = leaf("p", "working");
    delete old.agent!.instanceId;
    expect(classify(old).state).toBe("unknown");
  });
  it("does not apply screen evidence from a previous process generation", () => {
    const pane = leaf("p", "working");
    const old = { ...observation("attention"), instanceId: "previous" };
    expect(classify(pane, new Map([["p", old]])).state).toBe("executing");
    expect(classify(pane, new Map([["p", { ...old, instanceId: "p" }]])).state).toBe("attention");
  });
  it("publishes a replacement process even when its status label is unchanged", () => {
    try {
      setPtyObservation("p", { ...observation("waiting"), instanceId: "previous" });
      setPtyObservation("p", { ...observation("waiting"), instanceId: "p" });
      expect(classify(leaf("p"), useAgentPtyStore.getState().observations).state).toBe("waiting");
    } finally {
      setPtyObservation("p");
    }
  });
  it("keeps state independent of which pane is focused", () => {
    const w = workspace([leaf("a"), leaf("b")]);
    const observations = new Map([["a", observation("waiting")], ["b", observation("executing")]]);
    const before = workspaceAgentSummary(w, observations);
    w.tabs[0].activePaneId = "b";
    expect(workspaceAgentSummary(w, observations)).toEqual(before);
  });
  it("rolls up urgency without dropping idle or unknown agents", () => {
    const observations = new Map([["a", observation("waiting")], ["b", observation("attention")]]);
    expect(workspacesAgentStatus([workspace([leaf("a"), leaf("b")])], observations).get("w")).toEqual({ total: 2, state: "attention" });
  });
  it("skips ordinary terminals and file tabs", () => {
    const w = workspace([{ type: "leaf", id: "shell", cwd: "/tmp" }]);
    expect(workspaceAgentSummary(w).total).toBe(0);
    w.tabs[0].file = { path: "/tmp/a.md", language: "markdown", markdown: true };
    w.tabs[0].root = leaf("file");
    expect(workspaceAgentSummary(w).total).toBe(0);
    expect(workspaceAgentSummary(undefined)).toEqual({ entries: [], total: 0, attention: 0, executing: 0, waiting: 0 });
  });
});

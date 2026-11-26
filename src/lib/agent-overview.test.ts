import { describe, it, expect } from "vitest";
import { collectAllAgents, OVERVIEW_COLS } from "./agent-overview";
import type { Workspace } from "./types";
import type { PtyAgentObservation } from "./agent-pty";

const ws = (id: string, kind: "claude" | "codex" | "opencode", hostId = "local"): Workspace => ({
  id, name: id, hostId, activeTabId: id + "-tab",
  tabs: [{ id: id + "-tab", name: "Terminal", cwd: "/tmp", activePaneId: id + "-pane",
    root: { type: "leaf", id: id + "-pane", cwd: "/tmp", agent: { kind, command: kind, sessionId: "", instanceId: id } } }],
});
describe("global PTY agents", () => {
  it("collects agents across hosts and workspaces, including unknown states", () => {
    const entries = collectAllAgents([ws("local", "claude"), ws("remote", "codex", "desktop")]);
    expect(entries.map((entry) => [entry.workspaceId, entry.hostId, entry.state])).toEqual([
      ["local", "local", "unknown"], ["remote", "desktop", "unknown"],
    ]);
  });
  it("sorts by evidence-derived urgency and preserves traversal order for ties", () => {
    const observations = new Map<string, PtyAgentObservation>([
      ["working-pane", { state: "executing", source: "title", reason: "spinner" }],
      ["blocked-pane", { state: "attention", source: "screen", reason: "confirmation" }],
    ]);
    expect(collectAllAgents([ws("unknown", "claude"), ws("working", "codex"), ws("blocked", "opencode"), ws("unknown2", "claude")], observations).map((entry) => entry.workspaceId)).toEqual(["blocked", "working", "unknown", "unknown2"]);
    expect(collectAllAgents([])).toEqual([]);
    expect(OVERVIEW_COLS).toBe(3);
  });
  it("uses daemon state for terminals never opened by this client", () => {
    const workspace = ws("remote", "codex", "desktop");
    if (workspace.tabs[0].root.type === "leaf") workspace.tabs[0].root.runtimeStatus = "permission";
    expect(collectAllAgents([workspace])[0].state).toBe("attention");
  });
});

import { describe, it, expect } from "vitest";
import { makeLeaf, setLeafAgent } from "./pane-tree";
import type { PaneAgent, SplitNode } from "./types";

const agent: PaneAgent = {
  kind: "claude",
  command: "cc",
  sessionId: "sess-1",
};

describe("setLeafAgent", () => {
  it("sets the agent on a matching leaf", () => {
    const leaf = makeLeaf("~");
    const next = setLeafAgent(leaf, leaf.id, agent);
    expect(next.type).toBe("leaf");
    if (next.type === "leaf") expect(next.agent).toEqual(agent);
  });

  it("clears the agent when passed undefined", () => {
    const leaf = makeLeaf("~");
    const withAgent = setLeafAgent(leaf, leaf.id, agent);
    const cleared = setLeafAgent(withAgent, leaf.id, undefined);
    if (cleared.type === "leaf") expect(cleared.agent).toBeUndefined();
  });

  it("only touches the targeted leaf inside a split", () => {
    const a = makeLeaf("~/a");
    const b = makeLeaf("~/b");
    const tree: SplitNode = {
      type: "split",
      id: "split-1",
      direction: "row",
      children: [a, b],
      sizes: [50, 50],
    };
    const next = setLeafAgent(tree, b.id, agent) as SplitNode;
    const [na, nb] = next.children;
    if (na.type === "leaf") expect(na.agent).toBeUndefined();
    if (nb.type === "leaf") expect(nb.agent).toEqual(agent);
  });

  it("is a no-op for an unknown id", () => {
    const leaf = makeLeaf("~");
    const next = setLeafAgent(leaf, "nope", agent);
    if (next.type === "leaf") expect(next.agent).toBeUndefined();
  });
});

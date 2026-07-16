import { describe, it, expect, beforeEach, vi } from "vitest";

// the store imports terminal-manager via the App side; mock the parts that
// pull in @tauri-apps/api so this file can run in node without a Tauri host.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "test" }),
}));

// zustand persist touches localStorage at import time. node has none, so
// stub a minimal in-memory shim before the store loads.
const memStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i: number) => Array.from(memStore.keys())[i] ?? null,
  get length() {
    return memStore.size;
  },
};

import { insertAtAnchor, useWorkspaceStore } from "./workspace-store";

type Item = { id: string; pinned?: boolean };
const ids = (xs: Item[]) => xs.map((x) => x.id);

describe("insertAtAnchor", () => {
  const list: Item[] = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
  ];

  it("from < anchor, side=before lands the source one slot left of anchor", () => {
    expect(ids(insertAtAnchor(list, "a", "c", "before"))).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("from < anchor, side=after lands the source one slot right of anchor", () => {
    expect(ids(insertAtAnchor(list, "a", "c", "after"))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("from > anchor, side=before lands the source directly before anchor", () => {
    expect(ids(insertAtAnchor(list, "d", "b", "before"))).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("from > anchor, side=after lands the source directly after anchor", () => {
    expect(ids(insertAtAnchor(list, "d", "b", "after"))).toEqual([
      "a",
      "b",
      "d",
      "c",
    ]);
  });

  it("dropping side=before on the immediately-following neighbor is a no-op", () => {
    // a is already directly before b — moving a "before b" would keep order
    expect(insertAtAnchor(list, "a", "b", "before")).toBe(list);
  });

  it("dropping side=after on the immediately-preceding neighbor is a no-op", () => {
    expect(insertAtAnchor(list, "b", "a", "after")).toBe(list);
  });

  it("from === anchor is a no-op", () => {
    expect(insertAtAnchor(list, "b", "b", "before")).toBe(list);
    expect(insertAtAnchor(list, "b", "b", "after")).toBe(list);
  });

  it("unknown ids are a no-op", () => {
    expect(insertAtAnchor(list, "zz", "a", "before")).toBe(list);
    expect(insertAtAnchor(list, "a", "zz", "before")).toBe(list);
  });
});

// ----- store-level pinned-segment guard -----

beforeEach(() => {
  // wipe any persisted state from a prior test
  localStorage.clear();
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

function seedWorkspaces(items: Item[]) {
  useWorkspaceStore.setState({
    workspaces: items.map((it) => ({
      id: it.id,
      name: it.id,
      tabs: [],
      activeTabId: null,
      pinned: it.pinned,
    })) as any,
    activeWorkspaceId: items[0]?.id ?? null,
  });
}

describe("reorderWorkspace pinned guard", () => {
  it("allows reordering within the unpinned segment", () => {
    seedWorkspaces([{ id: "a" }, { id: "b" }, { id: "c" }]);
    useWorkspaceStore.getState().reorderWorkspace("a", "c", "after");
    expect(
      useWorkspaceStore.getState().workspaces.map((w) => w.id)
    ).toEqual(["b", "c", "a"]);
  });

  it("allows reordering within the pinned segment", () => {
    seedWorkspaces([
      { id: "p1", pinned: true },
      { id: "p2", pinned: true },
      { id: "u1" },
    ]);
    useWorkspaceStore.getState().reorderWorkspace("p1", "p2", "after");
    expect(
      useWorkspaceStore.getState().workspaces.map((w) => w.id)
    ).toEqual(["p2", "p1", "u1"]);
  });

  it("rejects dropping an unpinned item onto a pinned anchor", () => {
    seedWorkspaces([
      { id: "p1", pinned: true },
      { id: "u1" },
      { id: "u2" },
    ]);
    useWorkspaceStore.getState().reorderWorkspace("u2", "p1", "after");
    expect(
      useWorkspaceStore.getState().workspaces.map((w) => w.id)
    ).toEqual(["p1", "u1", "u2"]);
  });

  it("rejects dropping a pinned item onto an unpinned anchor", () => {
    seedWorkspaces([
      { id: "p1", pinned: true },
      { id: "u1" },
    ]);
    useWorkspaceStore.getState().reorderWorkspace("p1", "u1", "before");
    expect(
      useWorkspaceStore.getState().workspaces.map((w) => w.id)
    ).toEqual(["p1", "u1"]);
  });
});

describe("reorderTab pinned guard", () => {
  function seedTabs(tabs: Item[]) {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "w",
          name: "w",
          tabs: tabs.map((t) => ({
            id: t.id,
            name: t.id,
            cwd: "~",
            root: { id: t.id + "-leaf", kind: "leaf", cwd: "~" },
            activePaneId: t.id + "-leaf",
            pinned: t.pinned,
          })),
          activeTabId: tabs[0]?.id ?? null,
        },
      ] as any,
      activeWorkspaceId: "w",
    });
  }

  it("rejects cross-segment tab drops", () => {
    seedTabs([
      { id: "p", pinned: true },
      { id: "u1" },
      { id: "u2" },
    ]);
    useWorkspaceStore.getState().reorderTab("w", "u1", "p", "after");
    const tabs = useWorkspaceStore.getState().workspaces[0].tabs;
    expect(tabs.map((t) => t.id)).toEqual(["p", "u1", "u2"]);
  });

  it("allows same-segment tab drops", () => {
    seedTabs([{ id: "u1" }, { id: "u2" }, { id: "u3" }]);
    useWorkspaceStore.getState().reorderTab("w", "u3", "u1", "before");
    const tabs = useWorkspaceStore.getState().workspaces[0].tabs;
    expect(tabs.map((t) => t.id)).toEqual(["u3", "u1", "u2"]);
  });
});

describe("tab name: manual override vs auto title", () => {
  function seedOneTab() {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "w",
          name: "w",
          tabs: [
            {
              id: "t",
              name: "shell",
              cwd: "~",
              root: { id: "t-leaf", kind: "leaf", cwd: "~" },
              activePaneId: "t-leaf",
            },
          ],
          activeTabId: "t",
        },
      ] as any,
      activeWorkspaceId: "w",
    });
  }
  const tab = () => useWorkspaceStore.getState().workspaces[0].tabs[0];

  it("setTabAutoName drives Tab.name while there is no customName", () => {
    seedOneTab();
    useWorkspaceStore.getState().setTabAutoName("w", "t", "claude");
    expect(tab().name).toBe("claude");
    expect(tab().customName).toBeUndefined();
  });

  it("renameTab pins customName and blocks the auto title", () => {
    seedOneTab();
    useWorkspaceStore.getState().renameTab("w", "t", "My Tab");
    expect(tab().name).toBe("My Tab");
    expect(tab().customName).toBe("My Tab");
    // auto title is now suppressed
    useWorkspaceStore.getState().setTabAutoName("w", "t", "claude");
    expect(tab().name).toBe("My Tab");
  });

  it("clearTabCustomName lets the auto title take over again", () => {
    seedOneTab();
    useWorkspaceStore.getState().renameTab("w", "t", "My Tab");
    useWorkspaceStore.getState().clearTabCustomName("w", "t");
    expect(tab().customName).toBeUndefined();
    // name is unchanged until the next title arrives
    expect(tab().name).toBe("My Tab");
    // and the auto title now flows through
    useWorkspaceStore.getState().setTabAutoName("w", "t", "claude");
    expect(tab().name).toBe("claude");
  });

  it("clearTabCustomName is a no-op when there is no customName", () => {
    seedOneTab();
    const before = useWorkspaceStore.getState().workspaces;
    useWorkspaceStore.getState().clearTabCustomName("w", "t");
    // same object reference back => store did not churn
    expect(useWorkspaceStore.getState().workspaces).toBe(before);
  });
});

describe("agent workspace projection", () => {
  it("preserves each client's workspace order when an agent snapshot is reordered", () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "second-in-agent",
          hostId: "host-b",
          name: "First locally",
          tabs: [],
          activeTabId: null,
        },
        {
          id: "first-in-agent",
          hostId: "host-b",
          name: "Second locally",
          tabs: [],
          activeTabId: null,
        },
      ],
      activeWorkspaceId: "second-in-agent",
    });
    useWorkspaceStore.getState().applyAgentSnapshot("host-b", [
      {
        id: "first-in-agent",
        revision: 2,
        name: "Second locally",
        tabs: [],
      },
      {
        id: "second-in-agent",
        revision: 3,
        name: "First locally",
        tabs: [],
      },
    ]);
    expect(
      useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id)
    ).toEqual(["second-in-agent", "first-in-agent"]);
  });

  it("keeps client-private resume env while applying public runtime updates", () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "remote-w",
          hostId: "host-b",
          name: "Remote",
          tabs: [
            {
              id: "tab",
              name: "shell",
              cwd: "/work",
              root: {
                type: "leaf",
                id: "pane",
                cwd: "/work",
                agent: {
                  kind: "claude",
                  command: "claude-company",
                  sessionId: "agent-session",
                  env: { ANTHROPIC_AUTH_TOKEN: "private" },
                },
              },
              activePaneId: "pane",
            },
          ],
          activeTabId: "tab",
        },
      ],
      activeWorkspaceId: "remote-w",
    });
    useWorkspaceStore.getState().applyAgentWorkspace("host-b", {
      id: "remote-w",
      revision: 2,
      name: "Remote",
      tabs: [
        {
          id: "tab",
          name: "claude",
          cwd: "/work/new",
          root: {
            type: "leaf",
            id: "pane",
            cwd: "/work/new",
            runtimeStatus: "working",
            runtimeTitle: "remote build",
            agent: {
              kind: "claude",
              command: "claude-company",
              sessionId: "agent-session",
            },
          },
        },
      ],
    });
    const leaf = useWorkspaceStore.getState().workspaces[0].tabs[0].root;
    expect(leaf.type).toBe("leaf");
    if (leaf.type !== "leaf") throw new Error("expected leaf");
    expect(leaf.runtimeStatus).toBe("working");
    expect(useWorkspaceStore.getState().workspaces[0].tabs[0].name).toBe(
      "remote build"
    );
    expect(leaf.agent?.env).toEqual({ ANTHROPIC_AUTH_TOKEN: "private" });
  });

  it("preserves client-local split sizes until the shared structure changes", () => {
    const leaf = (id: string) => ({
      type: "leaf" as const,
      id,
      cwd: "/work",
    });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "remote-w",
          hostId: "host-b",
          name: "Remote",
          tabs: [
            {
              id: "tab",
              name: "shell",
              cwd: "/work",
              root: {
                type: "split",
                id: "split",
                direction: "row",
                children: [leaf("a"), leaf("b")],
                sizes: [25, 75],
              },
              activePaneId: "a",
            },
          ],
          activeTabId: "tab",
        },
      ],
      activeWorkspaceId: "remote-w",
    });

    useWorkspaceStore.getState().applyAgentWorkspace("host-b", {
      id: "remote-w",
      revision: 2,
      name: "Remote",
      tabs: [
        {
          id: "tab",
          name: "shell",
          cwd: "/work",
          root: {
            type: "split",
            id: "split",
            direction: "row",
            children: [leaf("a"), leaf("b")],
            sizes: [50, 50],
          },
        },
      ],
    });
    let root = useWorkspaceStore.getState().workspaces[0].tabs[0].root;
    expect(root.type === "split" ? root.sizes : []).toEqual([25, 75]);

    useWorkspaceStore.getState().applyAgentWorkspace("host-b", {
      id: "remote-w",
      revision: 3,
      name: "Remote",
      tabs: [
        {
          id: "tab",
          name: "shell",
          cwd: "/work",
          root: {
            type: "split",
            id: "split",
            direction: "row",
            children: [leaf("a"), leaf("b"), leaf("c")],
            sizes: [34, 33, 33],
          },
        },
      ],
    });
    root = useWorkspaceStore.getState().workspaces[0].tabs[0].root;
    expect(root.type === "split" ? root.sizes : []).toEqual([34, 33, 33]);
  });
});

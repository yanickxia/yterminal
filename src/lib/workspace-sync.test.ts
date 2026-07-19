import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDocument, WorkspaceOperation } from "./workspace-protocol";

const mock = vi.hoisted(() => {
  const base: WorkspaceDocument = {
    id: "w",
    revision: 1,
    name: "workspace",
    tabs: [
      {
        id: "old-tab",
        name: "shell",
        cwd: "~",
        root: { type: "leaf", id: "old-pane", cwd: "~" },
      },
    ],
  };
  return {
    document: base,
    workspaceListeners: [] as Array<(event: any) => void>,
  };
});

vi.mock("./host-transport", () => {
  class HostRequestError extends Error {
    code: string;
    retryable: boolean;
    constructor(code: string, message: string, retryable = false) {
      super(message);
      this.code = code;
      this.retryable = retryable;
    }
  }

  const connection = {
    hello: { deviceId: "device" },
    request: vi.fn(async (request: any) => {
      if (request.method === "import_workspaces") {
        return { kind: "workspaces", data: { workspaces: [mock.document] } };
      }
      if (request.method === "apply_workspace_op") {
        const operation = request.params.operation as WorkspaceOperation;
        if (operation.op === "update_pane_cwd") {
          mock.document = {
            ...mock.document,
            revision: mock.document.revision + 1,
            tabs: mock.document.tabs.map((tab) => ({
              ...tab,
              cwd: operation.data.cwd,
              root: { ...tab.root, cwd: operation.data.cwd },
            })),
          };
        } else if (operation.op === "add_tab") {
          mock.document = {
            ...mock.document,
            revision: mock.document.revision + 1,
            tabs: [...mock.document.tabs, operation.data.tab],
          };
        }
        return { kind: "workspace", data: { workspace: mock.document } };
      }
      throw new Error(`unexpected request ${request.method}`);
    }),
    ensureControl: vi.fn(async () => 1),
    subscribeWorkspaces: vi.fn((listener: (event: any) => void) => {
      mock.workspaceListeners.push(listener);
      return () => {};
    }),
    subscribeStatus: vi.fn(() => () => {}),
    disconnect: vi.fn(async () => {}),
  };

  return {
    HostRequestError,
    HostTransport: { connect: vi.fn(async () => connection) },
    localHost: vi.fn(async () => connection),
    resetLocalHost: vi.fn(),
  };
});

import {
  configureWorkspaceProjection,
  flushWorkspaceOperations,
  hostIdForWorkspace,
  queueCreateWorkspace,
  queueWorkspaceOperation,
  startWorkspaceSync,
} from "./workspace-sync";

describe("workspace optimistic projection", () => {
  it("does not project an intermediate response over a queued new tab", async () => {
    const upserts: WorkspaceDocument[] = [];
    configureWorkspaceProjection({
      replaceHost: () => {},
      upsert: (_hostId, workspace) => upserts.push(workspace),
      remove: () => {},
    });
    await startWorkspaceSync([]);

    queueWorkspaceOperation("w", {
      op: "update_pane_cwd",
      data: { tab_id: "old-tab", pane_id: "old-pane", cwd: "/tmp" },
    });
    queueWorkspaceOperation("w", {
      op: "add_tab",
      data: {
        tab: {
          id: "new-tab",
          name: "shell",
          cwd: "/tmp",
          root: { type: "leaf", id: "new-pane", cwd: "/tmp" },
        },
        index: null,
      },
    });

    await flushWorkspaceOperations("w");
    await Promise.resolve();

    expect(upserts).toHaveLength(1);
    expect(upserts[0].revision).toBe(3);
    expect(upserts[0].tabs.map((tab) => tab.id)).toEqual([
      "old-tab",
      "new-tab",
    ]);
  });

  it("owns a newly created workspace synchronously so its first pane routes to the right host", async () => {
    configureWorkspaceProjection({
      replaceHost: () => {},
      upsert: () => {},
      remove: () => {},
    });
    await startWorkspaceSync([]);

    // A workspace created on a remote host must resolve to that host
    // immediately — before the create request round-trips. Otherwise the
    // pane's session (constructed synchronously when the tab renders) reads a
    // still-empty owner map, falls back to LOCAL, and binds to the wrong
    // daemon — the "new remote tab can't take control until restart" bug.
    queueCreateWorkspace({
      id: "remote-ws",
      name: "workspace",
      hostId: "ssh-host",
      tabs: [
        {
          id: "t",
          name: "shell",
          root: { type: "leaf", id: "p", cwd: "~" },
          activePaneId: "p",
        },
      ],
      activeTabId: "t",
    } as never);

    expect(hostIdForWorkspace("remote-ws")).toBe("ssh-host");
  });
});

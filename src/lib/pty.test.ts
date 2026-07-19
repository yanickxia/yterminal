import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let controlListener: ((epoch: number | null) => void) | undefined;
  const host = {
    connectionId: "connection",
    ensureControl: vi.fn(async () => 1),
    request: vi.fn(async (request: { method: string }) => {
      if (request.method === "attach_session") return { kind: "ack" };
      if (request.method === "list_sessions") {
        return {
          kind: "sessions",
          data: { sessions: [{ sessionId: "session", pid: 123 }] },
        };
      }
      if (request.method === "detach_session") return { kind: "ack" };
      throw new Error(`unexpected request ${request.method}`);
    }),
    notify: vi.fn(async () => {}),
    subscribeControl: vi.fn(
      (_workspaceId: string, listener: (epoch: number | null) => void) => {
        controlListener = listener;
        return () => {};
      }
    ),
    subscribeSession: vi.fn(() => () => {}),
  };
  return {
    host,
    fireControl: (epoch: number | null) => controlListener?.(epoch),
    reset: () => {
      controlListener = undefined;
      host.ensureControl.mockClear();
      host.request.mockClear();
      host.notify.mockClear();
      host.subscribeControl.mockClear();
      host.subscribeSession.mockClear();
    },
  };
});

vi.mock("./host-transport", () => ({
  HostRequestError: class extends Error {},
  localHost: vi.fn(async () => mocks.host),
}));

vi.mock("./workspace-sync", () => ({
  flushWorkspaceOperations: vi.fn(async () => {}),
  subscribeHostTransport: vi.fn(() => () => {}),
  transportForWorkspace: vi.fn(() => mocks.host),
}));

vi.mock("./logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { spawn } from "./pty";

describe("AgentPty control takeover", () => {
  beforeEach(() => mocks.reset());

  it("stays read-only instead of force-reacquiring after another GUI takes control", async () => {
    const pty = spawn("/bin/sh", [], {
      workspaceId: "workspace",
      paneId: "pane",
      hostId: "local",
      sessionId: "session",
    });
    await vi.waitFor(() => expect(mocks.host.ensureControl).toHaveBeenCalledTimes(1));

    const readOnly: boolean[] = [];
    pty.onReadOnlyChange((value) => readOnly.push(value));
    mocks.fireControl(null);
    await Promise.resolve();

    expect(pty.readOnly).toBe(true);
    expect(readOnly[readOnly.length - 1]).toBe(true);
    expect(mocks.host.ensureControl).toHaveBeenCalledTimes(1);
    pty.detach();
  });
});

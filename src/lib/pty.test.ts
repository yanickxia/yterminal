import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./host-transport";

const mocks = vi.hoisted(() => {
  class MockHostRequestError extends Error {
    readonly code: string;
    readonly retryable: boolean;

    constructor(code: string, message: string, retryable = false) {
      super(message);
      this.code = code;
      this.retryable = retryable;
    }
  }

  let controlListener: ((epoch: number | null) => void) | undefined;
  let sessionListener: ((event: AgentEvent) => void) | undefined;
  let resizeHandler:
    | ((request: { method: string; params?: any }) => Promise<{ kind: string }>)
    | undefined;
  let ensureControlHandler: (() => Promise<number>) | undefined;
  const host = {
    connectionId: "connection",
    ensureControl: vi.fn(() => ensureControlHandler?.() ?? Promise.resolve(1)),
    request: vi.fn(async (request: { method: string; params?: any }) => {
      if (request.method === "attach_session") return { kind: "ack" };
      if (request.method === "list_sessions") {
        return {
          kind: "sessions",
          data: {
            sessions: [
              {
                sessionId: "session",
                pid: 123,
                cols: 100,
                rows: 30,
              },
            ],
          },
        };
      }
      if (request.method === "resize") {
        return resizeHandler?.(request) ?? { kind: "ack" };
      }
      if (request.method === "detach_session") return { kind: "ack" };
      throw new Error(`unexpected request ${request.method}`);
    }),
    notify: vi.fn(async () => {}),
    invalidateControlLease: vi.fn(() => {
      controlListener?.(null);
      return true;
    }),
    subscribeControl: vi.fn(
      (_workspaceId: string, listener: (epoch: number | null) => void) => {
        controlListener = listener;
        return () => {};
      }
    ),
    subscribeSession: vi.fn(
      (_sessionId: string, listener: (event: AgentEvent) => void) => {
        sessionListener = listener;
        return () => {
          if (sessionListener === listener) sessionListener = undefined;
        };
      }
    ),
  };
  return {
    host,
    MockHostRequestError,
    fireControl: (epoch: number | null) => controlListener?.(epoch),
    fireSession: (event: AgentEvent) => sessionListener?.(event),
    setResizeHandler: (handler: typeof resizeHandler) => {
      resizeHandler = handler;
    },
    setEnsureControlHandler: (handler: typeof ensureControlHandler) => {
      ensureControlHandler = handler;
    },
    reset: () => {
      controlListener = undefined;
      sessionListener = undefined;
      resizeHandler = undefined;
      ensureControlHandler = undefined;
      host.ensureControl.mockClear();
      host.request.mockClear();
      host.notify.mockClear();
      host.invalidateControlLease.mockClear();
      host.subscribeControl.mockClear();
      host.subscribeSession.mockClear();
    },
  };
});

vi.mock("./host-transport", () => ({
  HostRequestError: mocks.MockHostRequestError,
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

  it("projects the agent's canonical resize even before control state catches up", async () => {
    const pty = spawn("/bin/sh", [], {
      workspaceId: "workspace",
      paneId: "pane",
      hostId: "local",
      sessionId: "session",
      cols: 100,
      rows: 30,
    });
    await vi.waitFor(() => expect(mocks.host.subscribeSession).toHaveBeenCalled());
    expect(pty.readOnly).toBe(false);

    const sizes: Array<{ cols: number; rows: number }> = [];
    pty.onRemoteResize((size) => sizes.push(size));
    mocks.fireSession({
      event: "size_changed",
      data: { session_id: "session", cols: 132, rows: 41 },
    });

    expect(pty.cols).toBe(132);
    expect(pty.rows).toBe(41);
    expect(sizes).toEqual([{ cols: 132, rows: 41 }]);
    // Receiving the authoritative projection must not itself re-send a resize.
    expect(mocks.host.notify).not.toHaveBeenCalled();
    pty.detach();
  });

  it("attaches with the latest fitted grid instead of constructor defaults", async () => {
    let releaseControl!: (epoch: number) => void;
    const control = new Promise<number>((resolve) => {
      releaseControl = resolve;
    });
    mocks.setEnsureControlHandler(() => control);
    const pty = spawn("/bin/sh", [], {
      workspaceId: "workspace",
      paneId: "pane",
      hostId: "local",
      sessionId: "session",
      cols: 80,
      rows: 24,
    });

    pty.resize(140, 40);
    await vi.waitFor(() => expect(mocks.host.ensureControl).toHaveBeenCalled());
    releaseControl(1);
    await vi.waitFor(() =>
      expect(
        mocks.host.request.mock.calls.some(
          ([request]) =>
            request.method === "attach_session" &&
            request.params.cols === 140 &&
            request.params.rows === 40
        )
      ).toBe(true)
    );

    pty.detach();
  });

  it("waits for resize ACKs and coalesces a drag burst to the newest grid", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    mocks.setResizeHandler(async (request) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      mocks.fireSession({
        event: "size_changed",
        data: {
          session_id: "session",
          cols: request.params.cols,
          rows: request.params.rows,
        },
      });
      return { kind: "ack" };
    });
    const pty = spawn("/bin/sh", [], {
      workspaceId: "workspace",
      paneId: "pane",
      hostId: "local",
      sessionId: "session",
      cols: 100,
      rows: 30,
    });
    await vi.waitFor(() => expect(mocks.host.subscribeSession).toHaveBeenCalled());
    const projected: Array<{ cols: number; rows: number }> = [];
    pty.onRemoteResize((size) => projected.push(size));

    pty.resize(110, 31);
    await vi.waitFor(() => expect(calls).toBe(1));
    pty.resize(120, 32);
    pty.resize(130, 33);
    releaseFirst?.();
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(pty.cols).toBe(130));

    const requests = mocks.host.request.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === "resize");
    expect(requests.map((request) => request.params)).toEqual([
      expect.objectContaining({ cols: 110, rows: 31 }),
      expect.objectContaining({ cols: 130, rows: 33 }),
    ]);
    expect(projected).toEqual([{ cols: 130, rows: 33 }]);
    pty.detach();
  });

  it("turns read-only and restores the canonical grid when resize loses control", async () => {
    mocks.setResizeHandler(async () => {
      throw new mocks.MockHostRequestError(
        "stale_control_lease",
        "workspace"
      );
    });
    const pty = spawn("/bin/sh", [], {
      workspaceId: "workspace",
      paneId: "pane",
      hostId: "local",
      sessionId: "session",
      cols: 100,
      rows: 30,
    });
    await vi.waitFor(() => expect(mocks.host.subscribeSession).toHaveBeenCalled());
    const sizes: Array<{ cols: number; rows: number }> = [];
    pty.onRemoteResize((size) => sizes.push(size));

    pty.resize(140, 40);
    await vi.waitFor(() =>
      expect(mocks.host.invalidateControlLease).toHaveBeenCalledWith(
        "workspace",
        1
      )
    );
    await vi.waitFor(() => expect(pty.cols).toBe(100));

    expect(pty.readOnly).toBe(true);
    expect(pty.rows).toBe(30);
    expect(sizes).toEqual([{ cols: 100, rows: 30 }]);
    pty.detach();
  });
});

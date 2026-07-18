import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  invoke: mocks.invoke,
}));

import { HostTransport } from "./host-transport";

describe("HostTransport control leases", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    let epoch = 0;
    mocks.invoke.mockImplementation(async (method: string, args: any) => {
      if (method === "host_connect") {
        return {
          connectionId: "conn",
          hello: {
            selectedProtocol: 1,
            agentVersion: "test",
            deviceId: "device",
            hostname: "host",
            os: "linux",
            arch: "x86_64",
            capabilities: [],
          },
        };
      }
      if (method === "host_request") {
        if (args.request.method === "acquire_control") {
          epoch += 1;
          return {
            kind: "control_acquired",
            data: { workspace_id: "w", lease_epoch: epoch },
          };
        }
        if (args.request.method === "control_heartbeat") {
          return { kind: "ack" };
        }
      }
      if (method === "host_disconnect") return undefined;
      throw new Error(`unexpected invoke ${method}`);
    });
  });

  it("reuses cached control unless force is requested", async () => {
    const transport = await HostTransport.connect({ kind: "local" });
    const first = await transport.ensureControl("w");
    const cached = await transport.ensureControl("w");
    const forced = await transport.ensureControl("w", true);

    expect(first).toBe(1);
    expect(cached).toBe(1);
    expect(forced).toBe(2);
    expect(
      mocks.invoke.mock.calls.filter(
        ([method, args]) =>
          method === "host_request" &&
          args.request.method === "acquire_control"
      )
    ).toHaveLength(2);

    await transport.disconnect();
  });

  it("times out a stuck control request", async () => {
    vi.useFakeTimers();
    try {
      const transport = await HostTransport.connect({ kind: "local" });
      mocks.invoke.mockImplementation(async (method: string, args: any) => {
        if (method === "host_request" && args.request.method === "acquire_control") {
          return new Promise(() => {});
        }
        if (
          method === "host_request" &&
          args.request.method === "control_heartbeat"
        ) {
          return { kind: "ack" };
        }
        if (method === "host_disconnect") return undefined;
        throw new Error(`unexpected invoke ${method}`);
      });

      const pending = expect(
        transport.ensureControl("w", true)
      ).rejects.toMatchObject({
        code: "request_timeout",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await pending;

      await transport.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

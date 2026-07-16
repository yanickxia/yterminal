import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./workspace-sync", () => ({
  isRemoteWorkspace: () => true,
  transportForWorkspace: () => ({ request: mocks.request }),
}));

import { paneProcessTree, agentSessionId, processEnv } from "./agent";
import { pathIsFile, readTextFile } from "./file-reader";
import { gitDiff, gitStatus } from "./git";

describe("owner-host routing", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (request: { method: string }) => {
      switch (request.method) {
        case "process_tree":
          return {
            kind: "processes",
            data: { processes: [{ pid: 2, ppid: 1, argv: ["claude"] }] },
          };
        case "resolve_agent_session":
          return { kind: "agent_session", data: { session_id: "remote-session" } };
        case "path_is_file":
          return { kind: "boolean", data: { value: true } };
        case "read_text_file":
          return {
            kind: "file_chunk",
            data: {
              bytes: Array.from(new TextEncoder().encode("remote")),
              total_bytes: 6,
              eof: true,
            },
          };
        case "git_status":
          return {
            kind: "git_status",
            data: {
              status: {
                isRepo: true,
                branch: "remote-main",
                root: "/remote/repo",
                files: [],
              },
            },
          };
        case "git_diff":
          return { kind: "text", data: { text: "remote diff" } };
        default:
          throw new Error(`unexpected request ${request.method}`);
      }
    });
  });

  it("routes process and coding-agent inspection to the owner agent", async () => {
    expect(await paneProcessTree(99, "workspace", "session")).toEqual([
      { pid: 2, ppid: 1, argv: ["claude"] },
    ]);
    expect(await agentSessionId("claude", "/remote", 2, "workspace")).toBe(
      "remote-session"
    );
    expect(await processEnv(2, "workspace")).toEqual({});
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "process_env" })
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("routes file reads and Git operations without a local invoke fallback", async () => {
    expect(await pathIsFile("/remote/file", "workspace")).toBe(true);
    expect(await readTextFile("/remote/file", "workspace")).toEqual({
      text: "remote",
      bytes: 6,
    });
    expect(await gitStatus("/remote/repo", "workspace")).toMatchObject({
      isRepo: true,
      branch: "remote-main",
    });
    expect(await gitDiff("/remote/repo", "a.ts", "workspace")).toBe(
      "remote diff"
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("fails closed when the remote owner is offline", async () => {
    mocks.request.mockRejectedValue(new Error("offline"));
    expect(await pathIsFile("/same/path/on-local", "workspace")).toBe(false);
    expect(await gitStatus("/same/path/on-local", "workspace")).toMatchObject({
      isRepo: false,
    });
    await expect(readTextFile("/same/path/on-local", "workspace")).rejects.toThrow(
      "offline"
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

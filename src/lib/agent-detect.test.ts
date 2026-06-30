import { describe, it, expect } from "vitest";
import {
  classifyArgv,
  classifyCommandToken,
  detectAgent,
  buildResumeCommand,
  type ProcInfo,
} from "./agent-detect";
import type { PaneAgent } from "./types";

describe("classifyArgv", () => {
  it("matches a bare binary basename", () => {
    expect(classifyArgv(["claude"])).toBe("claude");
    expect(classifyArgv(["/usr/local/bin/codex", "resume"])).toBe("codex");
    expect(classifyArgv(["opencode"])).toBe("opencode");
  });

  it("strips a windows executable suffix", () => {
    expect(classifyArgv(["C:\\bin\\claude.exe"])).toBe("claude");
  });

  it("matches node-wrapper launch forms anywhere in argv", () => {
    expect(
      classifyArgv(["node", "/home/u/.npm/@anthropic-ai/claude-code/cli.js"])
    ).toBe("claude");
    expect(
      classifyArgv(["node", "/opt/lib/node_modules/@openai/codex/bin.js"])
    ).toBe("codex");
    expect(
      classifyArgv(["node", "/usr/lib/opencode-ai/dist/index.js"])
    ).toBe("opencode");
  });

  it("returns null for unrelated processes", () => {
    expect(classifyArgv(["vim", "file.txt"])).toBeNull();
    expect(classifyArgv(["git", "codex-review"])).toBeNull();
  });
});

describe("classifyCommandToken", () => {
  it("matches an exact basename only", () => {
    expect(classifyCommandToken("claude")).toBe("claude");
    expect(classifyCommandToken("/opt/bin/codex")).toBe("codex");
    expect(classifyCommandToken("opencode")).toBe("opencode");
  });

  it("does not substring-match user input", () => {
    expect(classifyCommandToken("codex-review")).toBeNull();
    expect(classifyCommandToken("git")).toBeNull();
  });
});

describe("detectAgent", () => {
  it("returns null on an empty tree", () => {
    expect(detectAgent([])).toBeNull();
  });

  it("finds the single matching descendant", () => {
    const tree: ProcInfo[] = [
      { pid: 100, ppid: 1, argv: ["-zsh"] },
      { pid: 101, ppid: 100, argv: ["claude"] },
    ];
    expect(detectAgent(tree)).toEqual({ kind: "claude", pid: 101 });
  });

  it("prefers the deepest match when several agents appear", () => {
    // a wrapper shell launches node, which launches the real claude cli.
    const tree: ProcInfo[] = [
      { pid: 100, ppid: 1, argv: ["-zsh"] },
      { pid: 101, ppid: 100, argv: ["claude"] }, // shallow shim
      {
        pid: 102,
        ppid: 101,
        argv: ["node", "/x/@anthropic-ai/claude-code/cli.js"],
      },
    ];
    expect(detectAgent(tree)).toEqual({ kind: "claude", pid: 102 });
  });
});

describe("buildResumeCommand", () => {
  const make = (over: Partial<PaneAgent>): PaneAgent => ({
    kind: "claude",
    command: "claude",
    sessionId: "abc",
    ...over,
  });

  it("builds claude resume", () => {
    expect(buildResumeCommand(make({ kind: "claude", command: "claude" }))).toBe(
      "claude --resume abc"
    );
  });

  it("builds codex resume", () => {
    expect(buildResumeCommand(make({ kind: "codex", command: "codex" }))).toBe(
      "codex resume abc"
    );
  });

  it("builds opencode resume", () => {
    expect(
      buildResumeCommand(make({ kind: "opencode", command: "opencode" }))
    ).toBe("opencode --session abc");
  });

  it("preserves a remembered alias as the launch token", () => {
    expect(buildResumeCommand(make({ command: "cc" }))).toBe("cc --resume abc");
  });

  it("falls back to the agent kind when the command is blank", () => {
    expect(buildResumeCommand(make({ command: "  " }))).toBe(
      "claude --resume abc"
    );
  });

  it("shell-quotes a non-id-safe session id defensively", () => {
    expect(
      buildResumeCommand(make({ sessionId: "a b;rm" }))
    ).toBe("claude --resume 'a b;rm'");
  });
});

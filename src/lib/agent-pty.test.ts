import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { detectPtyAgent, readAgentScreen } from "./agent-pty";

describe("agent UI evidence", () => {
  it("recognizes Claude's composer between separators", () => {
    expect(detectPtyAgent("claude", "Completed changes\n────────────\n❯ \n────────────\n? for shortcuts")?.state).toBe("waiting");
  });
  it("a persistent busy control remains working without new bytes", () => {
    const screen = "✻ Thinking… (12s · 100 tokens)\n────────────\n❯ \n────────────";
    expect(detectPtyAgent("claude", screen)?.state).toBe("executing");
    expect(detectPtyAgent("claude", screen)?.state).toBe("executing");
    expect(detectPtyAgent("claude", "❯ ", "◐ Implement auth")?.state).toBe("executing");
  });
  it("requires live confirmation controls", () => {
    const approval = "────────────\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel";
    expect(detectPtyAgent("claude", approval)?.state).toBe("attention");
    expect(detectPtyAgent("claude", "❯ Explain the phrase 'do you want to proceed?'")?.state).not.toBe("attention");
  });
  it("recognizes a dialogue above the blank rows of a tall terminal", () => {
    const approval = "Do you want to proceed?\n1. Yes\n2. No\nEnter to select · Esc to cancel";
    expect(detectPtyAgent("claude", approval + "\n".repeat(32))?.state).toBe("attention");
    expect(detectPtyAgent("claude", approval + "\n".repeat(32) + "[tmux] 0:claude*")?.state).toBe("attention");
  });
  it("rejects historical approval controls above the current composer", () => {
    const stale = "Do you want to proceed?\n1. Yes\nEnter to select · Esc to cancel\n• Completed.\n────────────\n❯ \n────────────\n? for shortcuts";
    expect(detectPtyAgent("claude", stale)?.state).not.toBe("attention");
  });
  it("recognizes Codex busy and action-required titles", () => {
    expect(detectPtyAgent("codex", "", "Codex ⠋ Working")?.state).toBe("executing");
    expect(detectPtyAgent("codex", "", "Action Required")?.state).toBe("attention");
  });
  it("recognizes a Codex selection menu that requests confirmation", () => {
    const menu = "› 1. Try new model\n  2. Use existing model\n\n  enter/esc confirm · ⌃c quit";
    expect(detectPtyAgent("codex", menu)?.state).toBe("attention");
  });
  it("does not treat hook bytes or arbitrary output as lifecycle evidence", async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 60, rows: 8 });
    try {
      await new Promise<void>((resolve) => term.write("\x1b]777;notify;yt-agent;working\x07ordinary output", resolve));
      expect(detectPtyAgent("claude", readAgentScreen(term))?.state).toBe("unknown");
    } finally { term.dispose(); }
  });
  it("recognizes Codex live timer while queued input is visible", () => {
    expect(detectPtyAgent("codex", "• Working (12s • esc to interrupt)\n› next request\n100% context left")?.state).toBe("executing");
  });
  it("does not treat an old elapsed timer as current work after a response", () => {
    expect(detectPtyAgent("codex", "• Working (12s • esc to interrupt)\n• Done.\n› Ask Codex to do anything\n100% context left")?.state).toBe("waiting");
  });
  it("keeps ordinary duration-bearing output unknown", () => {
    expect(detectPtyAgent("codex", "• Build completed (12s)")?.state).toBe("unknown");
  });
  it("recognizes OpenCode controls and leaves unrelated logs unknown", () => {
    expect(detectPtyAgent("opencode", "esc interrupt")?.state).toBe("executing");
    expect(detectPtyAgent("opencode", "server started\nreceived 100 messages")?.state).toBe("unknown");
    expect(detectPtyAgent("codex", "", "/home/user/project")?.state).toBe("unknown");
  });
  it("recognizes OpenCode questions and ready-to-type controls", () => {
    expect(detectPtyAgent("opencode", "△ Permission required\nesc dismiss · enter confirm")?.state).toBe("attention");
    expect(detectPtyAgent("opencode", "Choose an option\n↑↓ select · ⇆ tab · enter submit · esc dismiss")?.state).toBe("attention");
    expect(detectPtyAgent("opencode", "Build  Model name\ntab agents · ctrl+p commands")?.state).toBe("waiting");
    expect(detectPtyAgent("opencode", "┃ Ask anything, / for commands, @ for context…\nBuild · Model · OpenCode · ctrl+p menu")?.state).toBe("waiting");
    expect(detectPtyAgent("opencode", "┃\nBuild · Model · 18 (0%) · OpenAI · ctrl+p menu")?.state).toBe("waiting");
    expect(detectPtyAgent("opencode", "┃\n🯦 esc interrupt · Build · Model · OpenAI · ctrl+p menu")?.state).toBe("executing");
    expect(detectPtyAgent("opencode", "Build · Model · OpenCode · ctrl+p menu")?.state).toBe("unknown");
  });
  it("does not change state while a transcript overlay shows old output", () => {
    expect(detectPtyAgent("claude", "Showing detailed transcript · ctrl+o to toggle")).toBeNull();
  });
});

describe("PTY screen extraction", () => {
  async function terminal(output: string, check: (term: Terminal) => void) {
    const term = new Terminal({ allowProposedApi: true, cols: 60, rows: 8, scrollback: 100 });
    try {
      await new Promise<void>((resolve) => term.write(output, resolve));
      check(term);
    } finally { term.dispose(); }
  }
  it("reads the live buffer rather than the scrolled viewport", async () => {
    await terminal(Array.from({ length: 20 }, (_, i) => "old line " + i).join("\r\n") + "\r\n────────────\r\n❯ \r\n────────────\r\n? for shortcuts", (term) => {
      term.scrollToTop();
      expect(detectPtyAgent("claude", readAgentScreen(term))?.state).toBe("waiting");
      expect(readAgentScreen(term)).not.toContain("old line 0\n");
    });
  });
  it("uses the rendered alternate screen and honors erase/redraw", async () => {
    await terminal("\x1b[?1049hDo you want to proceed?\r\n1. Yes\r\nEnter to select · Esc to cancel\x1b[2J\x1b[Hesc interrupt", (term) => {
      expect(readAgentScreen(term)).not.toContain("proceed");
      expect(detectPtyAgent("opencode", readAgentScreen(term))?.state).toBe("executing");
      const buffer = term.buffer.active;
      const original = buffer.getLine.bind(buffer);
      vi.spyOn(buffer, "getLine").mockImplementation((index) => {
        if (index >= buffer.length) throw new Error("out-of-bounds buffer access");
        return original(index);
      });
      expect(() => readAgentScreen(term)).not.toThrow();
    });
  });
});

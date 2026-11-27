import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { registerClipboardOsc } from "./terminal-clipboard-osc";

const utf8 = new TextEncoder();
const encodedText = (text: string) => btoa(String.fromCharCode(...utf8.encode(text)));

function write(terminal: Terminal, data: string | Uint8Array) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

describe("terminal OSC 52 clipboard", () => {
  it("decodes fragmented OSC 52 output as UTF-8 for BEL and ST terminators", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    registerClipboardOsc(terminal.parser, () => true, writeText, vi.fn());
    try {
      const text = "远端复制 👋\n第二行";
      const payload = encodedText(text);
      await write(terminal, utf8.encode(`\x1b]52;c;${payload.slice(0, 7)}`));
      expect(writeText).not.toHaveBeenCalled();
      await write(terminal, utf8.encode(`${payload.slice(7)}\x07`));
      await write(terminal, `\x1b]52;;${payload}\x1b\\`);
      expect(writeText.mock.calls).toEqual([[text], [text]]);
    } finally {
      terminal.dispose();
    }
  });

  it("does not read the clipboard, clear it on invalid content, or write when copying is blocked", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const response = vi.fn();
    terminal.onData(response);
    let canCopy = true;
    registerClipboardOsc(terminal.parser, () => canCopy, writeText, vi.fn());
    try {
      await write(terminal, "\x1b]52;c;?\x07\x1b]52;c;\x07\x1b]52;c;*\x07\x1b]52;c;/w==\x07");
      canCopy = false;
      await write(terminal, `\x1b]52;c;${encodedText("history")}\x07`);
      expect(response).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
    }
  });
});

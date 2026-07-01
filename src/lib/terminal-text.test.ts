import { describe, it, expect } from "vitest";
import { stripAnsi, cleanTerminalText } from "./terminal-text";

describe("stripAnsi", () => {
  it("removes SGR color sequences but keeps the text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("removes cursor-move / CSI sequences", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1;5Hc")).toBe("abc");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("\x1b]0;window title\x07done")).toBe("done");
  });

  it("removes OSC sequences terminated by ST (ESC backslash)", () => {
    expect(stripAnsi("\x1b]7;file:///tmp\x1b\\home")).toBe("home");
  });

  it("removes lone charset-select escapes", () => {
    expect(stripAnsi("\x1b(Bplain")).toBe("plain");
  });

  it("strips C0 control chars but keeps tab and newline", () => {
    expect(stripAnsi("a\x00b\x07c\td\ne")).toBe("abc\td\ne");
  });

  it("strips the DEL char", () => {
    expect(stripAnsi("a\x7fb")).toBe("ab");
  });

  it("leaves clean text untouched", () => {
    expect(stripAnsi("just plain text")).toBe("just plain text");
  });
});

describe("cleanTerminalText", () => {
  it("collapses CRLF to a single newline (CR is stripped as a control char)", () => {
    // stripAnsi drops bare CR (0x0d) as a C0 control char, so CRLF becomes a
    // lone LF and a bare CR simply vanishes rather than becoming a newline.
    expect(cleanTerminalText("a\r\nb\rc")).toBe("a\nbc");
  });

  it("collapses 3+ blank lines into a single blank line", () => {
    expect(cleanTerminalText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims trailing whitespace on lines", () => {
    expect(cleanTerminalText("a   \nb\t\n")).toBe("a\nb");
  });

  it("strips ANSI escapes before normalizing", () => {
    expect(cleanTerminalText("\x1b[32m$ ls\x1b[0m\r\nfile")).toBe(
      "$ ls\nfile"
    );
  });

  it("trims the trailing end", () => {
    expect(cleanTerminalText("hello\n\n\n")).toBe("hello");
  });

  it("returns text unchanged when under the cap", () => {
    const text = "short output";
    expect(cleanTerminalText(text, 100)).toBe(text);
  });

  it("keeps the tail and marks truncation when over the cap", () => {
    const raw = "x".repeat(50) + "TAIL";
    const out = cleanTerminalText(raw, 10);
    expect(out.startsWith("…(truncated)…\n")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    // the kept slice is exactly maxChars long
    expect(out.slice("…(truncated)…\n".length).length).toBe(10);
  });

  it("handles empty input", () => {
    expect(cleanTerminalText("")).toBe("");
  });
});

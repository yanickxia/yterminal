import { describe, it, expect } from "vitest";
import {
  makeSentinel,
  sentinelCommand,
  parseResult,
  scrubCommandEcho,
  dropSentinelEcho,
} from "./agent-run";

describe("makeSentinel", () => {
  it("builds a marker and a matching regex", () => {
    const s = makeSentinel(() => "abc123");
    expect(s.marker).toBe("__YT_DONE_abc123__");
    const m = "__YT_DONE_abc123__:0".match(s.re);
    expect(m?.[1]).toBe("0");
  });

  it("captures negative exit codes", () => {
    const s = makeSentinel(() => "z");
    const m = "__YT_DONE_z__:-5".match(s.re);
    expect(m?.[1]).toBe("-5");
  });

  it("produces distinct markers by default", () => {
    expect(makeSentinel().marker).not.toBe(makeSentinel().marker);
  });
});

describe("sentinelCommand", () => {
  it("emits a printf carrying the marker and $?", () => {
    // literal backslash-n in the printf format, leading space, marker + $?,
    // then an ANSI cursor-up + clear that erases the sentinel's own lines.
    expect(sentinelCommand("M")).toBe(
      ` printf '\\nM:%s\\n\\033[3A\\r\\033[0J' "$?"`
    );
  });

  it("references the exit status", () => {
    expect(sentinelCommand("M")).toContain(`"$?"`);
    expect(sentinelCommand("M")).toContain("M:%s");
  });

  it("includes the self-erase escape sequence", () => {
    // cursor up 3, carriage return, clear to end of screen
    expect(sentinelCommand("M")).toContain("\\033[3A\\r\\033[0J");
  });
});

describe("parseResult", () => {
  it("returns not-done when the sentinel is absent", () => {
    const s = makeSentinel(() => "x");
    const r = parseResult("some output without marker", s, "ls");
    expect(r.done).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.output).toBe("");
  });

  it("parses the exit code and output before the sentinel", () => {
    const s = makeSentinel(() => "x");
    const cleaned = "ls\nfile-a\nfile-b\n__YT_DONE_x__:0\n";
    const r = parseResult(cleaned, s, "ls");
    expect(r.done).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("file-a\nfile-b");
  });

  it("captures a nonzero exit code", () => {
    const s = makeSentinel(() => "x");
    const cleaned = "false\n__YT_DONE_x__:1\n";
    const r = parseResult(cleaned, s, "false");
    expect(r.done).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  it("strips the echoed sentinel command line from the output", () => {
    const s = makeSentinel(() => "x");
    // The shell echoes the sentinel printf (carrying the marker) before the
    // real marker line; it must not leak into the captured output.
    const cleaned =
      "ls\nfile-a\n printf '\\n__YT_DONE_x__:%s\\n' \"$?\"\n__YT_DONE_x__:0\n";
    const r = parseResult(cleaned, s, "ls");
    expect(r.done).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("file-a");
    expect(r.output).not.toContain("__YT_DONE_x__");
  });

  it("yields null exit code on an unparseable number", () => {
    const s = { marker: "M", re: /M:(-?\w+)/ };
    const r = parseResult("out\nM:abc\n", s, "cmd");
    expect(r.done).toBe(true);
    expect(r.exitCode).toBeNull();
  });
});

describe("scrubCommandEcho", () => {
  it("drops the leading echoed command line", () => {
    expect(scrubCommandEcho("ls\nfile-a\nfile-b", "ls")).toBe("file-a\nfile-b");
  });

  it("drops an echoed command line prefixed by a prompt", () => {
    expect(scrubCommandEcho("$ ls\nfile-a", "ls")).toBe("file-a");
  });

  it("collapses 3+ blank lines and trims", () => {
    expect(scrubCommandEcho("cmd\n\n\n\nout\n\n", "cmd")).toBe("out");
  });

  it("normalizes CRLF to LF", () => {
    expect(scrubCommandEcho("cmd\r\nout\r\n", "cmd")).toBe("out");
  });

  it("keeps everything when the command line is not found in the first rows", () => {
    // command echo would appear later than row 3, so nothing is dropped
    const text = "a\nb\nc\nls\nd";
    expect(scrubCommandEcho(text, "ls")).toBe("a\nb\nc\nls\nd");
  });
});

describe("dropSentinelEcho", () => {
  it("drops any line carrying the marker token", () => {
    const text = "out-a\n printf '\\n__M__:%s\\n' \"$?\"\nout-b";
    expect(dropSentinelEcho(text, "__M__")).toBe("out-a\nout-b");
  });

  it("drops the resolved marker line too", () => {
    expect(dropSentinelEcho("out\n__M__:0", "__M__")).toBe("out");
  });

  it("normalizes CRLF before filtering", () => {
    expect(dropSentinelEcho("out\r\n__M__:0\r\n", "__M__")).toBe("out\n");
  });

  it("leaves text untouched when the marker is empty", () => {
    expect(dropSentinelEcho("out\nmore", "")).toBe("out\nmore");
  });

  it("leaves text untouched when the marker is absent", () => {
    expect(dropSentinelEcho("out\nmore", "__M__")).toBe("out\nmore");
  });
});

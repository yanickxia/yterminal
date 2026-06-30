import { describe, it, expect } from "vitest";
import { makeInputLineState, feedInput, firstToken } from "./input-line";

describe("feedInput", () => {
  it("accumulates printable characters without submitting", () => {
    let st = makeInputLineState();
    const r = feedInput(st, "claude");
    expect(r.submitted).toBeUndefined();
    expect(r.state.buffer).toBe("claude");
  });

  it("submits the trimmed line on carriage return", () => {
    const r = feedInput(makeInputLineState(), "claude --resume\r");
    expect(r.submitted).toBe("claude --resume");
    expect(r.state.buffer).toBe("");
  });

  it("submits on newline too", () => {
    const r = feedInput(makeInputLineState(), "cc\n");
    expect(r.submitted).toBe("cc");
  });

  it("handles backspace (DEL and BS)", () => {
    let st = feedInput(makeInputLineState(), "claudx").state;
    st = feedInput(st, "\x7f").state; // DEL erases 'x'
    expect(st.buffer).toBe("claud");
    st = feedInput(st, "\x08").state; // BS erases 'd'
    expect(st.buffer).toBe("clau");
  });

  it("kills the line on Ctrl-U", () => {
    let st = feedInput(makeInputLineState(), "garbage").state;
    st = feedInput(st, "\x15").state;
    expect(st.buffer).toBe("");
  });

  it("abandons the line on Ctrl-C", () => {
    let st = feedInput(makeInputLineState(), "half").state;
    st = feedInput(st, "\x03").state;
    expect(st.buffer).toBe("");
  });

  it("strips bracketed-paste markers", () => {
    const r = feedInput(
      makeInputLineState(),
      "\x1b[200~codex resume\x1b[201~\r"
    );
    expect(r.submitted).toBe("codex resume");
  });

  it("skips arrow-key escape sequences instead of buffering them", () => {
    // left arrow = ESC [ D
    let st = feedInput(makeInputLineState(), "ab").state;
    st = feedInput(st, "\x1b[D").state;
    expect(st.buffer).toBe("ab");
  });

  it("treats input after a newline as a fresh line", () => {
    const r = feedInput(makeInputLineState(), "first\rsecond");
    expect(r.submitted).toBe("first");
    expect(r.state.buffer).toBe("second");
  });
});

describe("firstToken", () => {
  it("returns the first whitespace-delimited token", () => {
    expect(firstToken("claude --resume abc")).toBe("claude");
    expect(firstToken("  cc  arg")).toBe("cc");
  });

  it("returns empty string for blank input", () => {
    expect(firstToken("   ")).toBe("");
    expect(firstToken("")).toBe("");
  });
});

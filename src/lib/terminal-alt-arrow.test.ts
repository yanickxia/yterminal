import { describe, expect, it } from "vitest";
import { encodeAltArrow } from "./terminal-alt-arrow";

const optionLeft = {
  key: "ArrowLeft",
  altKey: true,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
};

describe("xterm Alt-arrow compatibility", () => {
  it("sends readline word movement on macOS", () => {
    expect(encodeAltArrow(optionLeft, true)).toBe("\x1bb");
    expect(encodeAltArrow({ ...optionLeft, key: "ArrowRight" }, true)).toBe("\x1bf");
    expect(encodeAltArrow({ ...optionLeft, key: "ArrowUp" }, true)).toBeUndefined();
  });

  it("preserves the Ctrl-arrow sequence on other platforms", () => {
    expect(encodeAltArrow(optionLeft, false)).toBe("\x1b[1;5D");
    expect(encodeAltArrow({ ...optionLeft, key: "ArrowUp" }, false)).toBe("\x1b[1;5A");
  });

  it("leaves other modifiers and composition to xterm", () => {
    expect(encodeAltArrow({ ...optionLeft, altKey: false }, true)).toBeUndefined();
    expect(encodeAltArrow({ ...optionLeft, shiftKey: true }, true)).toBeUndefined();
    expect(encodeAltArrow({ ...optionLeft, isComposing: true }, true)).toBeUndefined();
    expect(encodeAltArrow({ ...optionLeft, key: "constructor" }, false)).toBeUndefined();
  });
});

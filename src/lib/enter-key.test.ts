import { describe, it, expect } from "vitest";
import { encodeEnter, type EnterKeyLike } from "./enter-key";

function key(mods: Partial<EnterKeyLike> = {}): EnterKeyLike {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

describe("encodeEnter", () => {
  it("sends a bare CR when no modifier is held (submit)", () => {
    expect(encodeEnter(key())).toBe("\r");
  });

  it("encodes Shift+Enter as the Claude Code multiline sequence", () => {
    expect(encodeEnter(key({ shiftKey: true }))).toBe("\x1b\r");
  });

  it("encodes Alt/Option+Enter as the same multiline sequence", () => {
    expect(encodeEnter(key({ altKey: true }))).toBe("\x1b\r");
  });

  it("encodes Ctrl+Enter as the same multiline sequence", () => {
    expect(encodeEnter(key({ ctrlKey: true }))).toBe("\x1b\r");
  });

  it("encodes Meta/Cmd+Enter as the same multiline sequence", () => {
    expect(encodeEnter(key({ metaKey: true }))).toBe("\x1b\r");
  });

  it("normalizes combined modifiers too", () => {
    expect(encodeEnter(key({ ctrlKey: true, shiftKey: true }))).toBe("\x1b\r");
  });

  it("normalizes all four modifiers", () => {
    expect(
      encodeEnter(
        key({ shiftKey: true, altKey: true, ctrlKey: true, metaKey: true })
      )
    ).toBe("\x1b\r");
  });
});

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

  it("encodes Shift+Enter as CSI-u with modifier 2", () => {
    expect(encodeEnter(key({ shiftKey: true }))).toBe("\x1b[13;2u");
  });

  it("encodes Alt+Enter as CSI-u with modifier 3", () => {
    expect(encodeEnter(key({ altKey: true }))).toBe("\x1b[13;3u");
  });

  it("encodes Ctrl+Enter as CSI-u with modifier 5", () => {
    expect(encodeEnter(key({ ctrlKey: true }))).toBe("\x1b[13;5u");
  });

  it("encodes Meta/Cmd+Enter as CSI-u with modifier 9", () => {
    expect(encodeEnter(key({ metaKey: true }))).toBe("\x1b[13;9u");
  });

  it("encodes Ctrl+Shift+Enter distinctly (modifier 6) so tmux can bind it", () => {
    const ctrlShift = encodeEnter(key({ ctrlKey: true, shiftKey: true }));
    expect(ctrlShift).toBe("\x1b[13;6u");
    // must differ from plain Shift+Enter — the whole point of the fix.
    expect(ctrlShift).not.toBe(encodeEnter(key({ shiftKey: true })));
  });

  it("combines all four modifiers (modifier 16)", () => {
    expect(
      encodeEnter(
        key({ shiftKey: true, altKey: true, ctrlKey: true, metaKey: true })
      )
    ).toBe("\x1b[13;16u");
  });
});

import { describe, it, expect } from "vitest";
import { shouldOpenLink } from "./link-modifier";

function mkEvent(opts: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  metaState?: boolean;
  ctrlState?: boolean;
}): MouseEvent {
  return {
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    getModifierState(key: string) {
      if (key === "Meta") return opts.metaState ?? false;
      if (key === "Control") return opts.ctrlState ?? false;
      return false;
    },
  } as unknown as MouseEvent;
}

describe("shouldOpenLink", () => {
  describe("on macOS (isMac=true)", () => {
    it("returns true when metaKey is set", () => {
      expect(shouldOpenLink(mkEvent({ metaKey: true }), true)).toBe(true);
    });
    it("returns true when getModifierState('Meta') is set", () => {
      expect(shouldOpenLink(mkEvent({ metaState: true }), true)).toBe(true);
    });
    it("returns false when only ctrlKey is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlKey: true }), true)).toBe(false);
    });
    it("returns false when no modifier is set", () => {
      expect(shouldOpenLink(mkEvent({}), true)).toBe(false);
    });
  });

  describe("on Linux/Windows (isMac=false)", () => {
    it("returns true when ctrlKey is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlKey: true }), false)).toBe(true);
    });
    it("returns true when getModifierState('Control') is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlState: true }), false)).toBe(true);
    });
    it("returns false when only metaKey is set", () => {
      expect(shouldOpenLink(mkEvent({ metaKey: true }), false)).toBe(false);
    });
    it("returns false when no modifier is set", () => {
      expect(shouldOpenLink(mkEvent({}), false)).toBe(false);
    });
  });

  describe("requireModifier=false (plain-click sniffing)", () => {
    it("returns true with no modifier on macOS", () => {
      expect(shouldOpenLink(mkEvent({}), true, false)).toBe(true);
    });
    it("returns true with no modifier on Linux/Windows", () => {
      expect(shouldOpenLink(mkEvent({}), false, false)).toBe(true);
    });
    it("returns true regardless of any modifier state", () => {
      expect(shouldOpenLink(mkEvent({ ctrlKey: true }), true, false)).toBe(true);
      expect(shouldOpenLink(mkEvent({ metaKey: true }), false, false)).toBe(
        true
      );
    });
  });

  describe("requireModifier defaults to true", () => {
    it("still gates on the modifier when omitted", () => {
      expect(shouldOpenLink(mkEvent({}), true)).toBe(false);
      expect(shouldOpenLink(mkEvent({ metaKey: true }), true)).toBe(true);
    });
  });
});

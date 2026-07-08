import { describe, it, expect } from "vitest";
import { matchAppShortcut, type KeyLike } from "./app-shortcut";

/** Build a KeyLike with all modifiers off, then apply overrides. */
function ev(over: Partial<KeyLike>): KeyLike {
  return {
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

describe("matchAppShortcut — macOS (Cmd, Shift = sub)", () => {
  const mac = true;
  it("maps Cmd+letter base actions", () => {
    expect(matchAppShortcut(ev({ code: "KeyK", metaKey: true }), mac)).toEqual({
      action: "palette",
    });
    expect(matchAppShortcut(ev({ code: "KeyN", metaKey: true }), mac)).toEqual({
      action: "newWorkspace",
    });
    expect(matchAppShortcut(ev({ code: "KeyT", metaKey: true }), mac)).toEqual({
      action: "newTab",
    });
    expect(matchAppShortcut(ev({ code: "KeyW", metaKey: true }), mac)).toEqual({
      action: "closeCascade",
    });
    expect(matchAppShortcut(ev({ code: "KeyD", metaKey: true }), mac)).toEqual({
      action: "split",
      column: false,
    });
  });
  it("uses Shift as the sub-variant", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyW", metaKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "closePane" });
    expect(
      matchAppShortcut(ev({ code: "KeyD", metaKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "split", column: true });
  });
  it("switches workspace vs tab by digit + Shift", () => {
    expect(matchAppShortcut(ev({ code: "Digit3", metaKey: true }), mac)).toEqual(
      { action: "switchWorkspace", n: 3 }
    );
    expect(
      matchAppShortcut(ev({ code: "Digit3", metaKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "switchTab", n: 3 });
  });
  it("rejects sub chord on no-sub actions", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyK", metaKey: true, shiftKey: true }), mac)
    ).toBeNull();
    expect(
      matchAppShortcut(ev({ code: "KeyN", metaKey: true, shiftKey: true }), mac)
    ).toBeNull();
  });
  it("rejects when Ctrl or Alt are also held, or Cmd is missing", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyK", metaKey: true, ctrlKey: true }), mac)
    ).toBeNull();
    expect(
      matchAppShortcut(ev({ code: "KeyK", metaKey: true, altKey: true }), mac)
    ).toBeNull();
    expect(matchAppShortcut(ev({ code: "KeyK", ctrlKey: true }), mac)).toBeNull();
  });
});

describe("matchAppShortcut — Linux/Windows (Ctrl+Shift, Alt = sub)", () => {
  const mac = false;
  it("requires Ctrl+Shift for base actions", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyN", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "newWorkspace" });
    expect(
      matchAppShortcut(ev({ code: "KeyT", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "newTab" });
    expect(
      matchAppShortcut(ev({ code: "KeyW", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "closeCascade" });
    expect(
      matchAppShortcut(ev({ code: "KeyK", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "palette" });
  });
  it("NEVER matches bare Ctrl+letter (control chars reach the shell)", () => {
    for (const code of ["KeyW", "KeyN", "KeyT", "KeyD", "KeyK", "KeyF", "KeyI"]) {
      expect(matchAppShortcut(ev({ code, ctrlKey: true }), mac)).toBeNull();
    }
  });
  it("does not match Cmd on Linux", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyN", metaKey: true, shiftKey: true }), mac)
    ).toBeNull();
  });
  it("uses Alt as the sub-variant", () => {
    expect(
      matchAppShortcut(
        ev({ code: "KeyW", ctrlKey: true, shiftKey: true, altKey: true }),
        mac
      )
    ).toEqual({ action: "closePane" });
    expect(
      matchAppShortcut(
        ev({ code: "KeyD", ctrlKey: true, shiftKey: true, altKey: true }),
        mac
      )
    ).toEqual({ action: "split", column: true });
    // base split (no Alt) is a row split
    expect(
      matchAppShortcut(ev({ code: "KeyD", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "split", column: false });
  });
  it("switches workspace vs tab by digit + Alt", () => {
    expect(
      matchAppShortcut(ev({ code: "Digit2", ctrlKey: true, shiftKey: true }), mac)
    ).toEqual({ action: "switchWorkspace", n: 2 });
    expect(
      matchAppShortcut(
        ev({ code: "Digit2", ctrlKey: true, shiftKey: true, altKey: true }),
        mac
      )
    ).toEqual({ action: "switchTab", n: 2 });
  });
  it("rejects sub chord (Alt) on no-sub actions", () => {
    expect(
      matchAppShortcut(
        ev({ code: "KeyK", ctrlKey: true, shiftKey: true, altKey: true }),
        mac
      )
    ).toBeNull();
    expect(
      matchAppShortcut(
        ev({ code: "KeyN", ctrlKey: true, shiftKey: true, altKey: true }),
        mac
      )
    ).toBeNull();
  });
  it("ignores unmapped letters and non-key codes", () => {
    expect(
      matchAppShortcut(ev({ code: "KeyZ", ctrlKey: true, shiftKey: true }), mac)
    ).toBeNull();
    expect(
      matchAppShortcut(ev({ code: "Escape", ctrlKey: true, shiftKey: true }), mac)
    ).toBeNull();
    expect(
      matchAppShortcut(ev({ code: "Digit0", ctrlKey: true, shiftKey: true }), mac)
    ).toBeNull();
  });
});

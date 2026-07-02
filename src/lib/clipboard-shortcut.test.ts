import { describe, it, expect } from "vitest";
import { matchClipboardShortcut, type KeyLike } from "./clipboard-shortcut";

function key(overrides: Partial<KeyLike>): KeyLike {
  return {
    key: "c",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("matchClipboardShortcut — non-mac", () => {
  it("Ctrl+Shift+C is copy", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", ctrlKey: true, shiftKey: true }), false)
    ).toBe("copy");
  });

  it("Ctrl+Shift+V is paste", () => {
    expect(
      matchClipboardShortcut(key({ key: "v", ctrlKey: true, shiftKey: true }), false)
    ).toBe("paste");
  });

  it("bare Ctrl+C is left untouched (SIGINT)", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", ctrlKey: true }), false)
    ).toBeNull();
  });

  it("bare Ctrl+V is left untouched", () => {
    expect(
      matchClipboardShortcut(key({ key: "v", ctrlKey: true }), false)
    ).toBeNull();
  });

  it("Cmd+C does not trigger on non-mac", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", metaKey: true }), false)
    ).toBeNull();
  });
});

describe("matchClipboardShortcut — mac", () => {
  it("Cmd+C is copy", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", metaKey: true }), true)
    ).toBe("copy");
  });

  it("Cmd+V is paste", () => {
    expect(
      matchClipboardShortcut(key({ key: "v", metaKey: true }), true)
    ).toBe("paste");
  });

  it("bare Ctrl+C is left untouched on mac too (SIGINT)", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", ctrlKey: true }), true)
    ).toBeNull();
  });

  it("Cmd+Ctrl+C does not trigger (Ctrl present)", () => {
    expect(
      matchClipboardShortcut(key({ key: "c", metaKey: true, ctrlKey: true }), true)
    ).toBeNull();
  });
});

describe("matchClipboardShortcut — irrelevant keys", () => {
  it("other keys return null", () => {
    expect(
      matchClipboardShortcut(key({ key: "a", ctrlKey: true, shiftKey: true }), false)
    ).toBeNull();
  });

  it("Alt modifier disqualifies", () => {
    expect(
      matchClipboardShortcut(
        key({ key: "c", ctrlKey: true, shiftKey: true, altKey: true }),
        false
      )
    ).toBeNull();
  });
});

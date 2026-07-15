import { describe, expect, it } from "vitest";
import {
  isViewerCopyShortcut,
  selectionTextWithin,
  type ViewerCopyKeyLike,
  type ViewerSelectionLike,
} from "./file-viewer-copy";

function key(overrides: Partial<ViewerCopyKeyLike>): ViewerCopyKeyLike {
  return {
    key: "c",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isViewerCopyShortcut", () => {
  it("uses Cmd+C on macOS", () => {
    expect(isViewerCopyShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isViewerCopyShortcut(key({ ctrlKey: true }), true)).toBe(false);
  });

  it("uses Ctrl+C on Linux and Windows", () => {
    expect(isViewerCopyShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isViewerCopyShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it("rejects modified chords and other keys", () => {
    expect(
      isViewerCopyShortcut(key({ ctrlKey: true, shiftKey: true }), false)
    ).toBe(false);
    expect(
      isViewerCopyShortcut(key({ metaKey: true, altKey: true }), true)
    ).toBe(false);
    expect(
      isViewerCopyShortcut(key({ key: "v", ctrlKey: true }), false)
    ).toBe(false);
  });
});

describe("selectionTextWithin", () => {
  const insideA = {} as Node;
  const insideB = {} as Node;
  const outside = {} as Node;
  const contains = (node: Node) => node === insideA || node === insideB;

  function selection(
    overrides: Partial<ViewerSelectionLike> = {}
  ): ViewerSelectionLike {
    return {
      isCollapsed: false,
      anchorNode: insideA,
      focusNode: insideB,
      toString: () => "selected text",
      ...overrides,
    };
  }

  it("returns text only when both selection endpoints are inside", () => {
    expect(selectionTextWithin(selection(), contains)).toBe("selected text");
    expect(
      selectionTextWithin(selection({ focusNode: outside }), contains)
    ).toBe("");
  });

  it("rejects missing, collapsed, and empty selections", () => {
    expect(selectionTextWithin(null, contains)).toBe("");
    expect(
      selectionTextWithin(selection({ isCollapsed: true }), contains)
    ).toBe("");
    expect(
      selectionTextWithin(selection({ anchorNode: null }), contains)
    ).toBe("");
    expect(
      selectionTextWithin(selection({ toString: () => "" }), contains)
    ).toBe("");
  });
});

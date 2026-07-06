import { describe, it, expect } from "vitest";
import { shouldSuppressContextMenu } from "./context-menu-suppress";

// On macOS, Ctrl is the "secondary click" modifier, so a Ctrl+Enter keydown
// (which we now turn into a CSI-u sequence for tmux, see enter-key.ts) ALSO
// makes WKWebView dispatch a `contextmenu` event — popping the Copy/Paste menu
// unexpectedly. We suppress that `contextmenu` only when it arrives right after
// a modified Enter fired. A self-expiring timestamp (not a sticky flag) avoids
// swallowing a later, genuine right-click.

describe("shouldSuppressContextMenu", () => {
  it("suppresses a contextmenu right after a modified Enter fired", () => {
    expect(shouldSuppressContextMenu(1000, 1000)).toBe(true);
    expect(shouldSuppressContextMenu(1000, 1050)).toBe(true); // 50ms later
  });

  it("does not suppress once the window has elapsed", () => {
    expect(shouldSuppressContextMenu(1000, 1200)).toBe(false); // 200ms > 100
  });

  it("does not suppress a genuine right-click (no modified-Enter timestamp)", () => {
    expect(shouldSuppressContextMenu(undefined, 1000)).toBe(false);
  });

  it("honors a custom window", () => {
    expect(shouldSuppressContextMenu(1000, 1080, 50)).toBe(false);
    expect(shouldSuppressContextMenu(1000, 1040, 50)).toBe(true);
  });

  it("never suppresses when now precedes the timestamp (clock skew guard)", () => {
    expect(shouldSuppressContextMenu(1000, 900)).toBe(false);
  });
});

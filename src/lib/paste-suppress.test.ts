import { describe, it, expect } from "vitest";
import { shouldSuppressNativePaste } from "./paste-suppress";

// On webkit2gtk a keyboard paste shortcut (Ctrl+Shift+V) triggers BOTH our
// pasteInto() and a native `paste` event that xterm handles itself — pasting
// twice. We suppress the native one only when it arrives right after the
// shortcut fired. A self-expiring timestamp (not a sticky flag) avoids
// swallowing a later, unrelated middle-click paste if the native event never
// came on some platform.

describe("shouldSuppressNativePaste", () => {
  it("suppresses a native paste right after the shortcut fired", () => {
    expect(shouldSuppressNativePaste(1000, 1000)).toBe(true);
    expect(shouldSuppressNativePaste(1000, 1200)).toBe(true); // 200ms later
  });

  it("does not suppress once the window has elapsed", () => {
    expect(shouldSuppressNativePaste(1000, 1600)).toBe(false); // 600ms > 500
  });

  it("does not suppress a middle-click / menu paste (no shortcut timestamp)", () => {
    expect(shouldSuppressNativePaste(undefined, 1000)).toBe(false);
  });

  it("honors a custom window", () => {
    expect(shouldSuppressNativePaste(1000, 1100, 50)).toBe(false);
    expect(shouldSuppressNativePaste(1000, 1040, 50)).toBe(true);
  });

  it("never suppresses when now precedes the timestamp (clock skew guard)", () => {
    expect(shouldSuppressNativePaste(1000, 900)).toBe(false);
  });
});

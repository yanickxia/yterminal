import { describe, it, expect } from "vitest";
import { SHOW_CURSOR, shouldRestoreCursor } from "./cursor-visibility";

describe("cursor-visibility", () => {
  it("SHOW_CURSOR is the DECTCEM show sequence", () => {
    expect(SHOW_CURSOR).toBe("\x1b[?25h");
  });

  it("restores on the normal buffer (shell prompt)", () => {
    expect(shouldRestoreCursor("normal")).toBe(true);
  });

  it("does not touch the alternate buffer (full-screen TUI)", () => {
    expect(shouldRestoreCursor("alternate")).toBe(false);
  });
});

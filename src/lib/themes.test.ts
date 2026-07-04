import { describe, it, expect } from "vitest";
import { getUiFont, UI_FONTS, DEFAULT_UI_FONT_ID } from "./themes";

describe("getUiFont", () => {
  it("resolves a known preset by id", () => {
    const inter = getUiFont("inter");
    expect(inter.id).toBe("inter");
    expect(inter.stack).toContain("Inter");
  });

  it("falls back to the system preset for an empty id", () => {
    expect(getUiFont("").id).toBe(DEFAULT_UI_FONT_ID);
  });

  it("synthesizes a sans-serif stack for an unknown, hand-edited id", () => {
    const custom = getUiFont("My Custom UI Font");
    expect(custom.id).toBe("My Custom UI Font");
    expect(custom.stack).toBe('"My Custom UI Font", sans-serif');
  });

  it("exposes the system default as the first preset", () => {
    expect(UI_FONTS[0].id).toBe(DEFAULT_UI_FONT_ID);
  });
});

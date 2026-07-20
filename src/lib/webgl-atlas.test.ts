import { describe, expect, it, vi } from "vitest";
import { clearTextureAtlases } from "./webgl-atlas";

describe("clearTextureAtlases", () => {
  it("invalidates every renderer that can own a shared atlas", () => {
    const sharedAtlas = new Map([["A", 0]]);
    const modelValid = [true, true];
    const renderers = modelValid.map((_, index) => ({
      clearTextureAtlas() {
        sharedAtlas.clear();
        modelValid[index] = false;
      },
    }));

    clearTextureAtlases(renderers);

    expect(sharedAtlas.size).toBe(0);
    expect(modelValid).toEqual([false, false]);
  });

  it("continues after a renderer was disposed by context loss", () => {
    const live = { clearTextureAtlas: vi.fn() };
    clearTextureAtlases([
      {
        clearTextureAtlas: () => {
          throw new Error("disposed");
        },
      },
      undefined,
      live,
    ]);

    expect(live.clearTextureAtlas).toHaveBeenCalledOnce();
  });
});

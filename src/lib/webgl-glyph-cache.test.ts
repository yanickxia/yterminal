import { describe, expect, it, vi } from "vitest";
import {
  glyphCacheBackgroundKey,
  installWebglGlyphCacheStabilizer,
  patchWebglGlyphAtlas,
} from "./webgl-glyph-cache";

function makeAtlas() {
  const context = {} as CanvasRenderingContext2D;
  const replacement = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  const oldCanvas = {
    width: 40,
    height: 50,
    ownerDocument: { createElement: vi.fn(() => replacement) },
    remove: vi.fn(),
  };
  const cacheGet = vi.fn(
    (_first: unknown, _bg: number, _fg: number, _fourth: number) => undefined
  );
  const cacheSet = vi.fn(
    (
      _first: unknown,
      _bg: number,
      _fg: number,
      _fourth: number,
      _value: unknown
    ) => undefined
  );
  const cache = {
    get: cacheGet,
    set: cacheSet,
  };
  const combined = {
    get: vi.fn(
      (_first: unknown, _bg: number, _fg: number, _fourth: number) => undefined
    ),
    set: vi.fn(
      (
        _first: unknown,
        _bg: number,
        _fg: number,
        _fourth: number,
        _value: unknown
      ) => undefined
    ),
  };
  const atlas = {
    _config: { allowTransparency: false },
    _cacheMap: cache,
    _cacheMapCombined: combined,
    _tmpCanvas: oldCanvas,
    _tmpCtx: {} as CanvasRenderingContext2D,
    _drawToCache: vi.fn(function (this: typeof atlas) {
      return this._config.allowTransparency;
    }),
  };
  return {
    atlas,
    cache,
    cacheGet,
    combined,
    oldCanvas,
    replacement,
    context,
  };
}

describe("glyphCacheBackgroundKey", () => {
  it("drops only background color bits for ordinary glyphs", () => {
    expect(glyphCacheBackgroundKey(0x03aabbcc, 0)).toBe(0);
    expect(glyphCacheBackgroundKey(0x0baabbcc, 0)).toBe(0x08000000);
  });

  it("keeps the full background when reverse video makes it the foreground", () => {
    expect(glyphCacheBackgroundKey(0x03aabbcc, 0x04000000)).toBe(
      0x03aabbcc
    );
  });
});

describe("patchWebglGlyphAtlas", () => {
  it("uses an alpha canvas and shares glyphs across background colors", () => {
    const { atlas, cache, cacheGet, oldCanvas, replacement, context } =
      makeAtlas();
    const addon = { _renderer: { _charAtlas: atlas } };

    expect(patchWebglGlyphAtlas(addon)).toBe(true);
    expect(atlas._tmpCanvas).toBe(replacement);
    expect(atlas._tmpCtx).toBe(context);
    expect(replacement.width).toBe(40);
    expect(replacement.height).toBe(50);
    expect(oldCanvas.remove).toHaveBeenCalledOnce();

    cache.get("A", 0x03112233, 0, 0);
    expect(cacheGet).toHaveBeenLastCalledWith("A", 0, 0, 0);
    expect(atlas._drawToCache()).toBe(true);
    expect(atlas._config.allowTransparency).toBe(false);

    expect(patchWebglGlyphAtlas(addon)).toBe(false);
  });
});

describe("installWebglGlyphCacheStabilizer", () => {
  it("patches replacement atlases and stops after cleanup", async () => {
    const first = makeAtlas().atlas;
    const second = makeAtlas().atlas;
    let listener: ((canvas: HTMLCanvasElement) => void) | undefined;
    const dispose = vi.fn();
    const onPatched = vi.fn();
    const addon = {
      _renderer: { _charAtlas: first },
      onChangeTextureAtlas(cb: (canvas: HTMLCanvasElement) => void) {
        listener = cb;
        return { dispose };
      },
    };

    const cleanup = installWebglGlyphCacheStabilizer(addon, onPatched);
    expect(onPatched).toHaveBeenCalledOnce();

    addon._renderer._charAtlas = second;
    listener?.({} as HTMLCanvasElement);
    await Promise.resolve();
    expect(onPatched).toHaveBeenCalledTimes(2);

    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

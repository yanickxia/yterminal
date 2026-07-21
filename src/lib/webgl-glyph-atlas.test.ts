import { describe, expect, it, vi } from "vitest";
import {
  glyphCacheBackgroundKey,
  installWebglGlyphAtlas,
  patchWebglGlyphAtlas,
} from "./webgl-glyph-atlas";

function makeAtlas() {
  const nativeFillText = vi.fn();
  const context = {
    font: "30px Maple Mono",
    textBaseline: "ideographic" as CanvasTextBaseline,
    fillText: nativeFillText,
    measureText: vi.fn((text: string) =>
      ({
        actualBoundingBoxAscent: text === "永" ? 34 : text === "一" ? 22 : 32,
        actualBoundingBoxDescent: text === "一" ? -19 : -7,
      }) as TextMetrics
    ),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
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
  const cache = { get: cacheGet, set: cacheSet };
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
  const drawToCache = vi.fn(function (
    this: { _config: { allowTransparency: boolean }; _tmpCtx: CanvasRenderingContext2D },
    raw: unknown = "A",
    ..._rest: unknown[]
  ) {
    const text =
      typeof raw === "number" ? String.fromCodePoint(raw) : String(raw);
    this._tmpCtx.fillText(text, 4, 40);
    return {
      transparent: this._config.allowTransparency,
      size: { x: 28, y: text === "一" ? 4 : 29 },
      offset: { x: -4, y: text === "永" ? -5 : text === "一" ? 8 : -3 },
    };
  });
  const atlas = {
    _config: { allowTransparency: false },
    _cacheMap: cache,
    _cacheMapCombined: combined,
    _tmpCanvas: oldCanvas,
    _tmpCtx: {} as CanvasRenderingContext2D,
    _drawToCache: drawToCache,
  };
  return {
    atlas,
    cache,
    cacheGet,
    combined,
    oldCanvas,
    replacement,
    context,
    drawToCache,
    cacheSet,
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
  it("uses a detached alpha canvas and shares glyphs across background colors", () => {
    const {
      atlas,
      cache,
      cacheGet,
      oldCanvas,
      replacement,
      context,
      drawToCache,
    } =
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
    const terminalElement = {} as HTMLElement;
    expect(
      atlas._drawToCache("A", 0, 0, 0, false, terminalElement).transparent
    ).toBe(true);
    expect(drawToCache).toHaveBeenLastCalledWith(
      "A",
      0,
      0,
      0,
      false,
      undefined
    );
    expect(atlas._config.allowTransparency).toBe(false);

    expect(patchWebglGlyphAtlas(addon)).toBe(false);
  });

  it("aligns full-height Han metadata to a same-style reference glyph", () => {
    const { atlas, drawToCache, cacheSet } = makeAtlas();
    const addon = { _renderer: { _charAtlas: atlas } };

    patchWebglGlyphAtlas(addon);
    const glyph = atlas._drawToCache("不", 0x03112233, 0, 0, false);

    expect(glyph.offset.y).toBe(-5);
    expect(drawToCache).toHaveBeenCalledTimes(2);
    expect(cacheSet).toHaveBeenCalledWith(
      "永".codePointAt(0),
      0,
      0,
      0,
      expect.objectContaining({ offset: { x: -4, y: -5 } })
    );
  });

  it("leaves intentionally short Han glyph metadata unchanged", () => {
    const { atlas, drawToCache, cacheSet } = makeAtlas();
    const addon = { _renderer: { _charAtlas: atlas } };

    patchWebglGlyphAtlas(addon);
    const glyph = atlas._drawToCache("一", 0, 0, 0, false);

    expect(glyph.offset.y).toBe(8);
    expect(drawToCache).toHaveBeenCalledOnce();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("leaves an unknown private atlas shape untouched", () => {
    const addon = {
      _renderer: {
        _charAtlas: {
          _config: { allowTransparency: false },
          _cacheMap: { get: vi.fn(), set: vi.fn() },
          _cacheMapCombined: { get: vi.fn(), set: vi.fn() },
          _drawToCache: vi.fn(),
        },
      },
    };

    expect(patchWebglGlyphAtlas(addon)).toBe(false);
  });
});

describe("installWebglGlyphAtlas", () => {
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

    const cleanup = installWebglGlyphAtlas(addon, onPatched);
    expect(onPatched).toHaveBeenCalledOnce();

    addon._renderer._charAtlas = second;
    listener?.({} as HTMLCanvasElement);
    await Promise.resolve();
    expect(onPatched).toHaveBeenCalledTimes(2);

    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

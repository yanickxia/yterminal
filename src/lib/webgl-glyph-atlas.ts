import { installHanGlyphNormalization } from "./han-glyph-normalization";

const COLOR_BITS_MASK = 0x03ffffff;
const INVERSE_FLAG = 0x04000000;
const HAN_REFERENCE_GLYPH = "永";
const HAN_REFERENCE_CODEPOINT = HAN_REFERENCE_GLYPH.codePointAt(0)!;

interface DisposableLike {
  dispose(): void;
}

interface GlyphCacheLike {
  get(first: unknown, bg: number, fg: number, fourth: number): unknown;
  set(
    first: unknown,
    bg: number,
    fg: number,
    fourth: number,
    value: unknown
  ): void;
}

interface AtlasConfigLike {
  allowTransparency: boolean;
}

interface RasterizedGlyphLike {
  offset: { x: number; y: number };
  size: { x: number; y: number };
}

interface CanvasLike {
  width: number;
  height: number;
  ownerDocument: {
    createElement(tag: "canvas"): HTMLCanvasElement;
  };
  remove(): void;
}

interface TextureAtlasLike {
  _config: AtlasConfigLike;
  _cacheMap: GlyphCacheLike;
  _cacheMapCombined: GlyphCacheLike;
  _tmpCanvas: CanvasLike | HTMLCanvasElement;
  _tmpCtx: CanvasRenderingContext2D;
  _drawToCache(...args: unknown[]): unknown;
}

interface WebglAddonLike {
  _renderer?: {
    _charAtlas?: TextureAtlasLike;
    _gl?: WebglContextLike;
  };
  onChangeTextureAtlas(
    listener: (canvas: HTMLCanvasElement) => void
  ): DisposableLike;
}

interface WebglContextLike {
  TEXTURE_2D: number;
  TEXTURE_MIN_FILTER: number;
  TEXTURE_MAG_FILTER: number;
  LINEAR: number;
  generateMipmap(target: number): void;
  texParameteri(target: number, pname: number, param: number): void;
}

const patchedAtlases = new WeakSet<object>();
const patchedCaches = new WeakSet<object>();

/**
 * Backport xterm.js#5987 for addon-webgl 0.19.
 *
 * Its atlas upload path calls `generateMipmap`, even though terminal glyphs
 * are sampled pixel-for-pixel. Some GPU/WebView stacks reject or corrupt that
 * live texture update without losing the WebGL context, so xterm's
 * `onContextLoss` fallback never runs and the screen briefly shows unrelated
 * atlas fragments. Upstream removed mipmaps and selected LINEAR filtering.
 * Intercept the dedicated renderer context until a release containing that
 * fix can replace 0.19.
 */
export function installWebglAtlasNoMipmap(addon: object): () => void {
  const gl = (addon as WebglAddonLike)._renderer?._gl;
  if (
    !gl ||
    typeof gl.generateMipmap !== "function" ||
    typeof gl.texParameteri !== "function" ||
    typeof gl.TEXTURE_2D !== "number" ||
    typeof gl.TEXTURE_MIN_FILTER !== "number" ||
    typeof gl.TEXTURE_MAG_FILTER !== "number" ||
    typeof gl.LINEAR !== "number"
  ) {
    return () => {};
  }

  const generateMipmap = gl.generateMipmap;
  const noMipmap = function (this: WebglContextLike, target: number) {
    if (target !== this.TEXTURE_2D) {
      generateMipmap.call(this, target);
      return;
    }
    this.texParameteri(target, this.TEXTURE_MIN_FILTER, this.LINEAR);
    this.texParameteri(target, this.TEXTURE_MAG_FILTER, this.LINEAR);
  };
  try {
    gl.generateMipmap = noMipmap;
  } catch {
    return () => {};
  }
  if (gl.generateMipmap !== noMipmap) return () => {};

  return () => {
    if (gl.generateMipmap !== noMipmap) return;
    try {
      gl.generateMipmap = generateMipmap;
    } catch {
      /* the renderer owns and will dispose this context */
    }
  };
}

function atlasText(value: unknown): string {
  if (typeof value === "number") return String.fromCodePoint(value);
  return typeof value === "string" ? value : "";
}

function isRasterizedGlyph(value: unknown): value is RasterizedGlyphLike {
  const glyph = value as Partial<RasterizedGlyphLike> | undefined;
  return (
    typeof glyph?.offset?.x === "number" &&
    typeof glyph.offset.y === "number" &&
    typeof glyph.size?.x === "number" &&
    typeof glyph.size.y === "number"
  );
}

/**
 * The foreground bitmap is independent of the cell background unless reverse
 * video is active. Preserve style flags (dim, italic, extended underline), but
 * drop the RGB/index and color-mode bits so selected and unselected cells hit
 * the same cache entry.
 */
export function glyphCacheBackgroundKey(bg: number, fg: number): number {
  if ((fg & INVERSE_FLAG) !== 0) return bg;
  return (bg & ~COLOR_BITS_MASK) >>> 0;
}

function patchCache(cache: GlyphCacheLike): void {
  if (patchedCaches.has(cache)) return;

  const get = cache.get;
  const set = cache.set;
  cache.get = function (first, bg, fg, fourth) {
    return get.call(this, first, glyphCacheBackgroundKey(bg, fg), fg, fourth);
  };
  cache.set = function (first, bg, fg, fourth, value) {
    set.call(
      this,
      first,
      glyphCacheBackgroundKey(bg, fg),
      fg,
      fourth,
      value
    );
  };
  patchedCaches.add(cache);
}

/**
 * Install yterminal's glyph rasterization policy on one addon-webgl atlas.
 *
 * The stock atlas bakes the cell background into each glyph and tightly crops
 * every result. This adapter gives it an alpha canvas, shares foreground
 * bitmaps across background colors, and optically normalizes full-height Han
 * outlines before the atlas computes their bounding boxes. Cell geometry and
 * Unicode width remain owned by xterm; only the cached foreground bitmap is
 * changed.
 *
 * This targets the private addon-webgl 0.19 shape. Unknown future shapes are
 * left untouched instead of receiving a partial patch.
 */
export function patchWebglGlyphAtlas(addon: object): boolean {
  const atlas = (addon as WebglAddonLike)._renderer?._charAtlas;
  if (!atlas || patchedAtlases.has(atlas)) return false;
  if (
    typeof atlas._config?.allowTransparency !== "boolean" ||
    typeof atlas._tmpCanvas?.ownerDocument?.createElement !== "function" ||
    typeof atlas._tmpCanvas?.remove !== "function" ||
    typeof atlas._drawToCache !== "function" ||
    typeof atlas._cacheMap?.get !== "function" ||
    typeof atlas._cacheMap?.set !== "function" ||
    typeof atlas._cacheMapCombined?.get !== "function" ||
    typeof atlas._cacheMapCombined?.set !== "function"
  ) {
    return false;
  }

  const oldCanvas = atlas._tmpCanvas;
  const canvas = oldCanvas.ownerDocument.createElement(
    "canvas"
  ) as HTMLCanvasElement;
  canvas.width = oldCanvas.width;
  canvas.height = oldCanvas.height;
  const context = canvas.getContext("2d", {
    alpha: true,
    willReadFrequently: true,
  });
  if (!context) return false;

  // Selection/cache stabilization can still work on a browser that does not
  // expose assignable canvas methods; Han normalization then degrades alone.
  const hanNormalization = installHanGlyphNormalization(context);

  const drawToCache = atlas._drawToCache;
  atlas._tmpCanvas = canvas;
  atlas._tmpCtx = context;
  atlas._drawToCache = function (...args: unknown[]) {
    const previous = this._config.allowTransparency;
    this._config.allowTransparency = true;
    try {
      // addon-webgl normally moves its shared temporary canvas into whichever
      // terminal requested the glyph so it can inherit CSS font features. In
      // WKWebView, moving that canvas between connected and detached tab trees
      // can resolve the same local font string to different faces. Keep the
      // private canvas detached so every cache miss uses one stable CoreText
      // resolution. yterminal does not set per-terminal font-feature-settings.
      const rasterArgs = args.slice();
      rasterArgs[5] = undefined;
      const result = drawToCache.apply(this, rasterArgs);
      const text = atlasText(args[0]);
      const rasterization = hanNormalization?.takeRasterization(text);
      if (
        rasterization?.normalizeOffset &&
        isRasterizedGlyph(result) &&
        typeof args[1] === "number" &&
        typeof args[2] === "number" &&
        typeof args[3] === "number"
      ) {
        let reference: unknown =
          text === HAN_REFERENCE_GLYPH
            ? result
            : this._cacheMap.get(
                HAN_REFERENCE_CODEPOINT,
                args[1],
                args[2],
                args[3]
              );
        if (!isRasterizedGlyph(reference)) {
          const referenceArgs = [
            HAN_REFERENCE_CODEPOINT,
            ...rasterArgs.slice(1),
          ];
          reference = drawToCache.apply(this, referenceArgs);
          hanNormalization?.takeRasterization(HAN_REFERENCE_GLYPH);
          if (isRasterizedGlyph(reference)) {
            this._cacheMap.set(
              HAN_REFERENCE_CODEPOINT,
              args[1],
              args[2],
              args[3],
              reference
            );
          }
        }
        if (isRasterizedGlyph(reference)) {
          result.offset.y = reference.offset.y;
        }
      }
      return result;
    } finally {
      this._config.allowTransparency = previous;
    }
  };
  patchCache(atlas._cacheMap);
  patchCache(atlas._cacheMapCombined);
  oldCanvas.remove();
  patchedAtlases.add(atlas);
  return true;
}

/** Patch the current atlas and every replacement acquired by the renderer. */
export function installWebglGlyphAtlas(
  addon: WebglAddonLike,
  onAtlasPatched: () => void
): () => void {
  let disposed = false;
  const restoreMipmap = installWebglAtlasNoMipmap(addon);
  const patchCurrent = () => {
    if (!disposed && patchWebglGlyphAtlas(addon)) onAtlasPatched();
  };

  patchCurrent();
  const subscription = addon.onChangeTextureAtlas(() => {
    // addon-webgl fires before assigning `_charAtlas`; inspect it afterwards.
    queueMicrotask(patchCurrent);
  });
  return () => {
    disposed = true;
    subscription.dispose();
    restoreMipmap();
  };
}

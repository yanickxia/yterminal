const COLOR_BITS_MASK = 0x03ffffff;
const INVERSE_FLAG = 0x04000000;

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
  };
  onChangeTextureAtlas(
    listener: (canvas: HTMLCanvasElement) => void
  ): DisposableLike;
}

const patchedAtlases = new WeakSet<object>();
const patchedCaches = new WeakSet<object>();

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
 * Make xterm's private WebGL glyph atlas background-independent.
 *
 * addon-webgl normally rasterizes text on the cell background, removes pixels
 * close to that background, then caches the result by foreground + background.
 * A selection therefore creates a second rasterization of the same letter,
 * and CoreText rounding can leave a different one-device-pixel edge. Drawing
 * on a transparent temporary canvas preserves coverage as alpha; normal cells
 * and selected cells can then share the exact same cached bitmap.
 *
 * This intentionally targets the private shape used by addon-webgl 0.19. If a
 * future addon changes that shape, it returns false and leaves the renderer's
 * stock behavior intact rather than partially patching it.
 */
export function patchWebglGlyphAtlas(addon: object): boolean {
  const atlas = (addon as WebglAddonLike)._renderer?._charAtlas;
  if (!atlas || patchedAtlases.has(atlas)) return false;
  if (
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

  const drawToCache = atlas._drawToCache;
  atlas._tmpCanvas = canvas;
  atlas._tmpCtx = context;
  atlas._drawToCache = function (...args: unknown[]) {
    const previous = this._config.allowTransparency;
    this._config.allowTransparency = true;
    try {
      return drawToCache.apply(this, args);
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

/**
 * Patch the current atlas and every replacement acquired after a font, theme,
 * geometry, or DPR change. `onAtlasPatched` lets the owner invalidate all
 * render models sharing the atlas after its cache semantics change.
 */
export function installWebglGlyphCacheStabilizer(
  addon: WebglAddonLike,
  onAtlasPatched: () => void
): () => void {
  let disposed = false;
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
  };
}

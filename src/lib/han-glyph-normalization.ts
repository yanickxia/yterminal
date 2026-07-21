const HAN_GLYPH = /^\p{Script=Han}$/u;

const REFERENCE_GLYPH = "永";
const MIN_REFERENCE_COVERAGE = 0.9;
const MAX_SCALE_Y = 1.08;
const MIN_SCALE_DELTA = 0.005;
const MIN_TRANSLATION_DELTA = 0.05;

export interface GlyphInkMetrics {
  ascent: number;
  descent: number;
}

export interface GlyphOpticalTransform {
  scaleY: number;
  translateY: number;
}

export interface HanGlyphRasterization {
  text: string;
  normalizeOffset: boolean;
}

export interface HanGlyphNormalization {
  takeRasterization(text: string): HanGlyphRasterization | undefined;
}

interface TextContextLike {
  font: string;
  textBaseline: CanvasTextBaseline;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): TextMetrics;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}

export function isSingleHanGlyph(text: string): boolean {
  return HAN_GLYPH.test(text);
}

export function readGlyphInkMetrics(
  metrics: Pick<TextMetrics, "actualBoundingBoxAscent" | "actualBoundingBoxDescent">
): GlyphInkMetrics | undefined {
  const ascent = metrics.actualBoundingBoxAscent;
  const descent = metrics.actualBoundingBoxDescent;
  // actualBoundingBoxDescent is signed relative to the active textBaseline.
  // With the ideographic baseline used by xterm, Han glyphs normally return a
  // negative descent because their ink bottom remains above that baseline.
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) {
    return undefined;
  }
  if (ascent + descent <= 0) return undefined;
  return { ascent, descent };
}

export function isFullHeightHanGlyph(
  current: GlyphInkMetrics,
  reference: GlyphInkMetrics
): boolean {
  const currentHeight = current.ascent + current.descent;
  const referenceHeight = reference.ascent + reference.descent;
  return (
    Number.isFinite(currentHeight) &&
    Number.isFinite(referenceHeight) &&
    currentHeight > 0 &&
    referenceHeight > 0 &&
    currentHeight >= referenceHeight * MIN_REFERENCE_COVERAGE
  );
}

/**
 * Raise a shorter full-height Han glyph toward the reference ideograph ink box.
 *
 * Monospace fonts only standardize advance width. Their merged CJK outlines
 * can still differ by several percent in vertical ink extent, which becomes a
 * visible 1-2 device-pixel jump at common Retina terminal sizes. A bounded
 * optical correction removes that rasterization jump without touching cell
 * width or the shared baseline. Taller outlines are never compressed.
 *
 * Deliberately short glyphs such as 一/二 and punctuation stay unchanged. They
 * cover less than 90% of the reference ink height and must retain their
 * intentional shape rather than being stretched to fill the em square.
 */
export function calculateHanGlyphTransform(
  current: GlyphInkMetrics,
  reference: GlyphInkMetrics
): GlyphOpticalTransform | undefined {
  const currentHeight = current.ascent + current.descent;
  const referenceHeight = reference.ascent + reference.descent;
  if (!isFullHeightHanGlyph(current, reference) || currentHeight >= referenceHeight) {
    return undefined;
  }

  const scaleY = Math.min(MAX_SCALE_Y, referenceHeight / currentHeight);
  const currentCenter = (current.descent - current.ascent) / 2;
  const referenceCenter = (reference.descent - reference.ascent) / 2;
  const translateY = referenceCenter - currentCenter * scaleY;

  if (
    Math.abs(scaleY - 1) < MIN_SCALE_DELTA &&
    Math.abs(translateY) < MIN_TRANSLATION_DELTA
  ) {
    return undefined;
  }
  return { scaleY, translateY };
}

/**
 * Wrap a canvas text context so single Han glyphs use the optical ink-box
 * correction above. The wrapper is installed on the atlas-private context,
 * therefore it runs only on cache misses and adds no per-frame render cost.
 */
export function installHanGlyphNormalization(
  context: TextContextLike
): HanGlyphNormalization | undefined {
  if (
    typeof context.fillText !== "function" ||
    typeof context.measureText !== "function" ||
    typeof context.save !== "function" ||
    typeof context.restore !== "function" ||
    typeof context.translate !== "function" ||
    typeof context.scale !== "function"
  ) {
    return undefined;
  }

  const nativeFillText = context.fillText;
  let lastRasterization: HanGlyphRasterization | undefined;

  const normalizedFillText = function (
    this: TextContextLike,
    text: string,
    x: number,
    y: number,
    maxWidth?: number
  ): void {
    lastRasterization = undefined;
    if (!isSingleHanGlyph(text)) {
      if (maxWidth === undefined) nativeFillText.call(this, text, x, y);
      else nativeFillText.call(this, text, x, y, maxWidth);
      return;
    }

    // Re-measure on every atlas cache miss. WKWebView can resolve the same font
    // string to fallback metrics while a local face is loading; retaining a
    // transform across an atlas clear would permanently mix those generations.
    const reference = readGlyphInkMetrics(this.measureText(REFERENCE_GLYPH));
    const current = readGlyphInkMetrics(this.measureText(text));
    lastRasterization = {
      text,
      normalizeOffset: !!(
        current &&
        reference &&
        isFullHeightHanGlyph(current, reference)
      ),
    };
    const transform =
      current && reference
        ? calculateHanGlyphTransform(current, reference)
        : undefined;

    if (!transform) {
      if (maxWidth === undefined) nativeFillText.call(this, text, x, y);
      else nativeFillText.call(this, text, x, y, maxWidth);
      return;
    }

    this.save();
    try {
      this.translate(x, y + transform.translateY);
      this.scale(1, transform.scaleY);
      if (maxWidth === undefined) nativeFillText.call(this, text, 0, 0);
      else nativeFillText.call(this, text, 0, 0, maxWidth);
    } finally {
      this.restore();
    }
  };
  try {
    context.fillText = normalizedFillText;
  } catch {
    return undefined;
  }
  if (context.fillText !== normalizedFillText) return undefined;

  return {
    takeRasterization(text: string) {
      const rasterization = lastRasterization;
      lastRasterization = undefined;
      return rasterization?.text === text ? rasterization : undefined;
    },
  };
}

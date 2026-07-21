import { describe, expect, it, vi } from "vitest";
import {
  calculateHanGlyphTransform,
  installHanGlyphNormalization,
  isFullHeightHanGlyph,
  isSingleHanGlyph,
  readGlyphInkMetrics,
} from "./han-glyph-normalization";

function textMetrics(ascent: number, descent: number): TextMetrics {
  return {
    actualBoundingBoxAscent: ascent,
    actualBoundingBoxDescent: descent,
  } as TextMetrics;
}

describe("isSingleHanGlyph", () => {
  it("matches one Han codepoint and rejects other text", () => {
    expect(isSingleHanGlyph("不")).toBe(true);
    expect(isSingleHanGlyph("𠀀")).toBe(true);
    expect(isSingleHanGlyph("，")).toBe(false);
    expect(isSingleHanGlyph("A")).toBe(false);
    expect(isSingleHanGlyph("中文")).toBe(false);
  });
});

describe("readGlyphInkMetrics", () => {
  it("accepts finite ink metrics only", () => {
    expect(readGlyphInkMetrics(textMetrics(23, -3))).toEqual({
      ascent: 23,
      descent: -3,
    });
    expect(readGlyphInkMetrics(textMetrics(Number.NaN, 3))).toBeUndefined();
    expect(readGlyphInkMetrics(textMetrics(0, 0))).toBeUndefined();
  });
});

describe("calculateHanGlyphTransform", () => {
  const reference = { ascent: 34.08, descent: -6.6 };

  it("fits a full-height glyph to the reference ink box", () => {
    const transform = calculateHanGlyphTransform(
      { ascent: 32.16, descent: -6.6 },
      reference
    );

    expect(transform?.scaleY).toBeCloseTo(1.0751, 3);
    expect(transform?.translateY).toBeCloseTo(0.4958, 3);
  });

  it("caps correction so an unusual outline cannot be distorted", () => {
    const transform = calculateHanGlyphTransform(
      { ascent: 31, descent: -6 },
      reference
    );
    expect(transform?.scaleY).toBe(1.08);
  });

  it("leaves intentionally short ideographs unchanged", () => {
    expect(
      calculateHanGlyphTransform({ ascent: 22.08, descent: -19.32 }, reference)
    ).toBeUndefined();
  });

  it("does not shrink an outline taller than the reference", () => {
    expect(
      calculateHanGlyphTransform(
        { ascent: 34.23, descent: -6.6 },
        reference
      )
    ).toBeUndefined();
  });

  it("does nothing when the glyph already matches the reference", () => {
    expect(calculateHanGlyphTransform(reference, reference)).toBeUndefined();
  });
});

describe("isFullHeightHanGlyph", () => {
  const reference = { ascent: 34.08, descent: -6.6 };

  it("separates full-height outlines from intentionally short ideographs", () => {
    expect(
      isFullHeightHanGlyph({ ascent: 32.16, descent: -6.6 }, reference)
    ).toBe(true);
    expect(
      isFullHeightHanGlyph({ ascent: 22.08, descent: -19.32 }, reference)
    ).toBe(false);
  });
});

describe("installHanGlyphNormalization", () => {
  it("normalizes full-height Han glyphs and remeasures every atlas draw", () => {
    const nativeFillText = vi.fn();
    const measureText = vi.fn((text: string) => {
      if (text === "永") return textMetrics(34, -7);
      if (text === "不") return textMetrics(32, -7);
      return textMetrics(22, -19);
    });
    const context = {
      font: "30px Maple Mono",
      textBaseline: "ideographic" as CanvasTextBaseline,
      fillText: nativeFillText,
      measureText,
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
    };

    const normalization = installHanGlyphNormalization(context);
    expect(normalization).toBeDefined();
    context.fillText("不", 4, 20);
    expect(normalization?.takeRasterization("不")).toEqual({
      text: "不",
      normalizeOffset: true,
    });
    context.fillText("不", 4, 20);
    expect(normalization?.takeRasterization("不")).toEqual({
      text: "不",
      normalizeOffset: true,
    });

    expect(context.save).toHaveBeenCalledTimes(2);
    expect(context.scale).toHaveBeenLastCalledWith(1, 1.08);
    const lastTranslate =
      context.translate.mock.calls[context.translate.mock.calls.length - 1];
    expect(lastTranslate[0]).toBe(4);
    expect(lastTranslate[1]).toBeCloseTo(20.56, 6);
    expect(nativeFillText).toHaveBeenLastCalledWith("不", 0, 0);
    expect(context.restore).toHaveBeenCalledTimes(2);
    expect(measureText).toHaveBeenCalledTimes(4);
  });

  it("passes short Han glyphs and non-Han text through unchanged", () => {
    const nativeFillText = vi.fn();
    const context = {
      font: "30px Maple Mono",
      textBaseline: "ideographic" as CanvasTextBaseline,
      fillText: nativeFillText,
      measureText: vi.fn((text: string) =>
        text === "永" ? textMetrics(34, -7) : textMetrics(22, -19)
      ),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
    };

    const normalization = installHanGlyphNormalization(context);
    context.fillText("一", 4, 20);
    expect(normalization?.takeRasterization("一")).toEqual({
      text: "一",
      normalizeOffset: false,
    });
    context.fillText("A", 8, 20, 10);
    expect(normalization?.takeRasterization("A")).toBeUndefined();

    expect(nativeFillText).toHaveBeenNthCalledWith(1, "一", 4, 20);
    expect(nativeFillText).toHaveBeenNthCalledWith(2, "A", 8, 20, 10);
    expect(context.scale).not.toHaveBeenCalled();
  });
});

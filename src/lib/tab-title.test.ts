import { describe, it, expect } from "vitest";
import { sanitizeTabTitle, MAX_TAB_TITLE_LEN } from "./tab-title";

describe("sanitizeTabTitle", () => {
  it("keeps a plain title", () => {
    expect(sanitizeTabTitle("claude")).toBe("claude");
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeTabTitle("  npm   run   dev  ")).toBe("npm run dev");
  });

  it("strips control chars (BEL/ESC) that leak into a title", () => {
    expect(sanitizeTabTitle("run\x07\x1bdev")).toBe("run dev");
  });

  it("reduces a bare path to its last segment", () => {
    expect(sanitizeTabTitle("/Users/me/code/yterminal")).toBe("yterminal");
    expect(sanitizeTabTitle("~/dev/app/")).toBe("app");
    expect(sanitizeTabTitle("C:\\Users\\me\\proj")).toBe("proj");
  });

  it("leaves multi-word titles that contain a path untouched", () => {
    expect(sanitizeTabTitle("vim ~/notes.md")).toBe("vim ~/notes.md");
  });

  it("returns empty for a title that is blank after cleaning", () => {
    expect(sanitizeTabTitle("")).toBe("");
    expect(sanitizeTabTitle("   ")).toBe("");
    expect(sanitizeTabTitle("\x07\x1b")).toBe("");
  });

  it("truncates over-long titles with an ellipsis", () => {
    const long = "a".repeat(100);
    const out = sanitizeTabTitle(long);
    expect(out.length).toBe(MAX_TAB_TITLE_LEN);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is defensive about non-string input", () => {
    expect(sanitizeTabTitle(undefined as unknown as string)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { acceptOutputSequence } from "./remote-sequence";

describe("acceptOutputSequence", () => {
  it("accepts contiguous bytes", () => {
    expect(acceptOutputSequence(4, 4, new Uint8Array([5, 6]))).toMatchObject({
      kind: "data",
      start: 4,
      end: 6,
    });
  });

  it("drops full duplicates and trims partial overlap", () => {
    expect(acceptOutputSequence(5, 1, new Uint8Array([1, 2, 3, 4]))).toEqual({
      kind: "duplicate",
    });
    const result = acceptOutputSequence(5, 3, new Uint8Array([3, 4, 5, 6]));
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(Array.from(result.data)).toEqual([5, 6]);
      expect(result.end).toBe(7);
    }
  });

  it("reports a gap without accepting later bytes", () => {
    expect(acceptOutputSequence(8, 10, new Uint8Array([10]))).toEqual({
      kind: "gap",
      expected: 8,
      actual: 10,
    });
  });
});

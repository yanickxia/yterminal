import { describe, it, expect } from "vitest";
import {
  buildColumnMap,
  offsetToColumn,
  offsetRangeToColumns,
  columnToOffset,
  type VisitedCell,
} from "./terminal-cell-columns";

/** Build the visited-cell list for a plain ASCII string (every cell width 1). */
function ascii(s: string): VisitedCell[] {
  return Array.from(s, () => ({ width: 1, charLen: 1 }));
}

/** Mixed string where each char is tagged as narrow (1) or wide (2 cols). */
function cells(spec: Array<[string, 1 | 2]>): VisitedCell[] {
  return spec.map(([, w]) => ({ width: w, charLen: 1 }));
}

describe("buildColumnMap", () => {
  it("is identity for pure ASCII", () => {
    const map = buildColumnMap(ascii("hello"));
    expect(map.columnOfOffset).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 5; i++) expect(offsetToColumn(map, i)).toBe(i);
  });

  it("counts each wide (CJK) char as two columns", () => {
    // "访问" = two wide chars, each 1 string char but 2 columns.
    const map = buildColumnMap(cells([["访", 2], ["问", 2]]));
    expect(map.columnOfOffset).toEqual([0, 2]);
    expect(offsetToColumn(map, 0)).toBe(0);
    expect(offsetToColumn(map, 1)).toBe(2);
  });

  it("shifts ASCII following a CJK prefix by the extra columns", () => {
    // The reported bug: "访问地址：http" — 5 wide chars (10 cols) then ASCII.
    const prefix: Array<[string, 1 | 2]> = [
      ["访", 2],
      ["问", 2],
      ["地", 2],
      ["址", 2],
      ["：", 2],
    ];
    const map = buildColumnMap(cells([...prefix, ...Array.from("http", (c) => [c, 1] as [string, 1])]));
    // 5 wide chars occupy string offsets 0..4, columns 0,2,4,6,8.
    // "h" is string offset 5 but column 10 (not 5) — the whole point.
    expect(offsetToColumn(map, 5)).toBe(10);
    expect(offsetToColumn(map, 6)).toBe(11);
  });
});

describe("offsetRangeToColumns", () => {
  it("maps an ASCII URL after a CJK prefix to the right columns", () => {
    const prefix = "访问地址："; // 5 wide chars → 10 columns
    const url = "http://x.io"; // 11 ASCII chars
    const spec: Array<[string, 1 | 2]> = [
      ...Array.from(prefix, (c) => [c, 2] as [string, 2]),
      ...Array.from(url, (c) => [c, 1] as [string, 1]),
    ];
    const map = buildColumnMap(cells(spec));
    const startOffset = prefix.length; // 5
    const endExclusive = prefix.length + url.length; // 16
    const { startCol, endColExclusive } = offsetRangeToColumns(
      map,
      startOffset,
      endExclusive
    );
    expect(startCol).toBe(10);
    expect(endColExclusive).toBe(10 + url.length); // 21
  });

  it("handles a wide char inside the range end", () => {
    // token ending on a wide char: "a好" → cols a@0(w1), 好@1(w2)
    const map = buildColumnMap(cells([["a", 1], ["好", 2]]));
    const { startCol, endColExclusive } = offsetRangeToColumns(map, 0, 2);
    expect(startCol).toBe(0);
    expect(endColExclusive).toBe(3); // 好 ends at column 3 (exclusive)
  });
});

describe("columnToOffset (inverse, for mouse-mode hit-test)", () => {
  it("is identity for ASCII", () => {
    const map = buildColumnMap(ascii("hello"));
    for (let c = 0; c < 5; c++) expect(columnToOffset(map, c)).toBe(c);
  });

  it("maps a click on a column after a CJK prefix back to the string offset", () => {
    const prefix = "访问地址："; // 10 columns
    const path = "/tmp/a.txt";
    const spec: Array<[string, 1 | 2]> = [
      ...Array.from(prefix, (c) => [c, 2] as [string, 2]),
      ...Array.from(path, (c) => [c, 1] as [string, 1]),
    ];
    const map = buildColumnMap(cells(spec));
    // Clicking column 10 (the "/" of the path) must map to string offset 5.
    expect(columnToOffset(map, 10)).toBe(5);
    expect(columnToOffset(map, 11)).toBe(6);
  });

  it("maps both columns of a wide char to that char's single offset", () => {
    const map = buildColumnMap(cells([["a", 1], ["好", 2], ["b", 1]]));
    // 好 occupies columns 1 and 2; both hit-test to offset 1.
    expect(columnToOffset(map, 0)).toBe(0);
    expect(columnToOffset(map, 1)).toBe(1);
    expect(columnToOffset(map, 2)).toBe(1);
    expect(columnToOffset(map, 3)).toBe(2);
  });

  it("returns past-end for a column beyond the content", () => {
    const map = buildColumnMap(ascii("ab"));
    expect(columnToOffset(map, 5)).toBe(2); // == length → no span hit
  });
});

describe("combining chars (one cell → multiple string chars)", () => {
  it("keeps later offsets aligned when a cell emits two string chars", () => {
    // A combined grapheme in the prefix: 1 cell (width 1) but 2 string chars.
    const combined: VisitedCell[] = [{ width: 1, charLen: 2 }];
    const map = buildColumnMap([...combined, ...ascii("http")]);
    // Both combined string chars sit at column 0; "h" is offset 2, column 1.
    expect(offsetToColumn(map, 0)).toBe(0);
    expect(offsetToColumn(map, 1)).toBe(0);
    expect(offsetToColumn(map, 2)).toBe(1);
  });
});

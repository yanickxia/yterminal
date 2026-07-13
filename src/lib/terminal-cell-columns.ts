// Map between xterm string offsets and terminal columns for a single buffer row.
//
// The problem: `IBufferLine.translateToString()` emits ONE string character per
// non-zero-width cell, but a wide (CJK) glyph occupies TWO columns while a
// combining sequence can pack SEVERAL string chars into ONE cell. So a string
// offset returned by our pure URL/path scanners (`computeUrlLinks`,
// `findPathSpans` — which see only the collapsed string) does NOT equal the
// terminal column that xterm's LinkProvider ranges are addressed in. With any
// wide char before a link on the same row, the offset lags the real column by
// the number of extra cells, so the clickable range / underline drifts left
// (the "访问地址：http://…" underline-offset bug).
//
// This module rebuilds the offset↔column relationship from the per-cell widths
// that `translateToString` walked over. Pure, no xterm dependency: the caller
// harvests cell widths from the buffer line and feeds them here. Unit-tested.

/**
 * One cell as `translateToString` visited it: how many columns the cell spans
 * (1 normal, 2 wide/CJK; the trailing 0-width cell of a wide char is NOT a
 * separate visit) and how many string characters it contributed (usually 1, but
 * >1 for a combined grapheme). Mirrors xterm's own `t += width || 1` step.
 */
export interface VisitedCell {
  width: number;
  charLen: number;
}

/**
 * Precomputed maps for one row:
 *  - `columnOfOffset[o]` = starting terminal column of string offset `o`.
 *  - `offsetOfColumn[c]` = string offset of the cell covering column `c`.
 *  - `totalColumns` / `totalOffsets` = the row's exclusive upper bounds.
 */
export interface ColumnMap {
  columnOfOffset: number[];
  offsetOfColumn: number[];
  totalColumns: number;
  totalOffsets: number;
}

/**
 * Build the offset↔column map from the ordered cells `translateToString`
 * visited. ASCII rows produce an identity map; wide chars advance the column by
 * 2 per cell; combined graphemes advance the offset by >1 per cell.
 */
export function buildColumnMap(cells: VisitedCell[]): ColumnMap {
  const columnOfOffset: number[] = [];
  const offsetOfColumn: number[] = [];
  let col = 0;
  let offset = 0;
  for (const cell of cells) {
    const w = cell.width || 1;
    const len = cell.charLen || 1;
    // Every string char this cell contributed starts at this cell's column.
    for (let k = 0; k < len; k++) columnOfOffset.push(col);
    // Every column this cell spans maps back to this cell's first offset.
    for (let k = 0; k < w; k++) offsetOfColumn.push(offset);
    col += w;
    offset += len;
  }
  return {
    columnOfOffset,
    offsetOfColumn,
    totalColumns: col,
    totalOffsets: offset,
  };
}

/** Terminal column at which string offset `offset` begins. */
export function offsetToColumn(map: ColumnMap, offset: number): number {
  if (offset < 0) return 0;
  if (offset < map.columnOfOffset.length) return map.columnOfOffset[offset];
  // Past the last cell: continue in single-width columns (trailing spaces).
  return map.totalColumns + (offset - map.totalOffsets);
}

/**
 * The exclusive column boundary for a range whose last included string offset
 * is `endOffsetExclusive - 1`. A range ending on a wide char extends the full 2
 * columns. Split out because a multi-row URL maps its start and end through
 * different per-row maps, so the caller needs the end boundary alone.
 */
export function offsetToColumnExclusive(
  map: ColumnMap,
  endOffsetExclusive: number
): number {
  const lastOffset = endOffsetExclusive - 1;
  const lastCol = offsetToColumn(map, lastOffset);
  // Width of the last included cell (2 for a wide char, else 1).
  const lastWidth = offsetToColumn(map, lastOffset + 1) - lastCol;
  return lastCol + Math.max(1, lastWidth);
}

/**
 * Convert a half-open string-offset range `[startOffset, endOffsetExclusive)`
 * into a half-open column range `[startCol, endColExclusive)`. The end maps
 * through the LAST included offset so a range ending on a wide char extends the
 * full 2 columns.
 */
export function offsetRangeToColumns(
  map: ColumnMap,
  startOffset: number,
  endOffsetExclusive: number
): { startCol: number; endColExclusive: number } {
  return {
    startCol: offsetToColumn(map, startOffset),
    endColExclusive: offsetToColumnExclusive(map, endOffsetExclusive),
  };
}

/**
 * Inverse: the string offset of the cell that renders at terminal column
 * `col`. Both columns of a wide char map to that char's single offset. Used by
 * the mouse-mode click bridge, which knows the clicked terminal column and must
 * hit-test it against string-offset path spans.
 */
export function columnToOffset(map: ColumnMap, col: number): number {
  if (col < 0) return 0;
  if (col < map.offsetOfColumn.length) return map.offsetOfColumn[col];
  // Past the row's content (trailing trimmed whitespace): no string char lives
  // there, so saturate at the length — the caller's hit-test then finds no span.
  return map.totalOffsets;
}

// Pure URL detection across wrapped terminal rows. The stock
// @xterm/addon-web-links only stitches a URL back together when the buffer rows
// are *soft* wrapped (`line.isWrapped === true`, i.e. xterm reflowed a long
// logical line to fit the width). But a CLI program that prints a long URL and
// hard-wraps it itself — emitting its own newline once the text reaches the
// terminal width — leaves the continuation row with `isWrapped === false`. The
// stock addon then linkifies only the first row's fragment, so a long MR/PR URL
// becomes unclickable past the first line.
//
// This module reconstructs URLs across BOTH cases: it joins a continuation row
// when the row is soft-wrapped OR when the previous row physically fills the
// terminal width (the hard-wrap signal). Pure string/offset math — no IO, no
// xterm dependency — so the wrapping rules are fully unit-testable. The caller
// (terminal-manager) feeds it buffer rows and maps the returned coordinates to
// xterm link ranges.

/** xterm WebLinksAddon's URL matcher (verbatim), matched case-insensitively. */
const URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;

/** A single buffer row as far as URL detection cares. */
export interface UrlRow {
  /** Row text, trailing whitespace already trimmed (xterm translateToString(true)). */
  text: string;
  /** xterm soft-wrap flag: this row is a reflow continuation of the previous. */
  isWrapped: boolean;
}

/** A URL found in the buffer, with a possibly multi-row character range.
 *  Coordinates are 0-based; `endCol` is exclusive; `endRow` inclusive. Rows are
 *  indices into the `rows` array passed to {@link computeUrlLinks}. */
export interface UrlLink {
  url: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Validate that a regex hit is a real URL the browser would accept, and that
 * the matched text starts with the canonical `scheme://[user@]host` prefix.
 * Mirrors the guard inside @xterm/addon-web-links so we don't linkify things
 * like `https://` alone or malformed authority sections.
 */
export function isValidUrl(candidate: string): boolean {
  try {
    const u = new URL(candidate);
    const prefix = u.username
      ? `${u.protocol}//${u.username}@${u.host}`
      : `${u.protocol}//${u.host}`;
    return candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
  } catch {
    return false;
  }
}

/**
 * Is `curRow` a continuation of the row directly above it? True when xterm
 * soft-wrapped it, OR when the previous row physically fills the terminal width
 * (`prevText.length >= cols`) — the signal that a program hard-wrapped its own
 * output at the right edge with no intervening space.
 */
export function isContinuation(
  prevText: string,
  curIsWrapped: boolean,
  cols: number
): boolean {
  return curIsWrapped || (cols > 0 && prevText.length >= cols);
}

/**
 * Find every URL in a contiguous slice of buffer rows, reconstructing URLs that
 * span multiple rows (soft- or hard-wrapped). Returns links with slice-relative
 * row indices. Assumes URL characters are single-width cells (URLs are ASCII),
 * so a character offset maps directly to a column.
 */
export function computeUrlLinks(rows: UrlRow[], cols: number): UrlLink[] {
  const links: UrlLink[] = [];
  let i = 0;
  while (i < rows.length) {
    // Grow a group of physically-joined rows starting at `i`.
    const groupStart = i;
    let group = rows[i].text;
    // per-row start offset within the joined `group` string
    const offsets: number[] = [0];
    let j = i + 1;
    while (
      j < rows.length &&
      isContinuation(rows[j - 1].text, rows[j].isWrapped, cols)
    ) {
      offsets.push(group.length);
      group += rows[j].text;
      j++;
    }
    // Scan the joined group for URLs and map offsets back to (row, col).
    URL_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_REGEX.exec(group))) {
      const url = m[0];
      if (!isValidUrl(url)) continue;
      const startIdx = m.index;
      const endIdx = m.index + url.length - 1; // inclusive last char
      const start = mapOffset(offsets, startIdx);
      const end = mapOffset(offsets, endIdx);
      links.push({
        url,
        startRow: groupStart + start.row,
        startCol: start.col,
        endRow: groupStart + end.row,
        endCol: end.col + 1, // exclusive
      });
    }
    i = j;
  }
  return links;
}

/** Map a character offset within a joined group to its {row, col}. */
function mapOffset(
  offsets: number[],
  idx: number
): { row: number; col: number } {
  let row = 0;
  for (let r = offsets.length - 1; r >= 0; r--) {
    if (idx >= offsets[r]) {
      row = r;
      break;
    }
  }
  return { row, col: idx - offsets[row] };
}

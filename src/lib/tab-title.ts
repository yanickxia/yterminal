// Pure normalization for shell/agent-reported terminal titles (OSC 0/2) before
// they become a tab's auto display name. No React / no store so the terminal
// manager and its unit test share one implementation.

import type { Tab } from "./types";

/**
 * Default type marker shown before a tab's name when the user hasn't set a
 * custom icon: a file tab (read-only viewer) vs. a terminal tab. Purely derived
 * from the tab's type at render time — never persisted, so a user-set `icon`
 * always wins over this.
 */
export function defaultTabIcon(tab: Pick<Tab, "file">): string {
  return tab.file ? "📄" : ">_";
}

/** Longest auto title we keep; longer titles are truncated with an ellipsis. */
export const MAX_TAB_TITLE_LEN = 40;

// C0/C1 control characters. A stray BEL/ESC in a title must never reach the UI.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Normalize a raw OSC title into a tab-name candidate:
 *   - strip C0/C1 control chars (a stray BEL/ESC must never reach the UI)
 *   - collapse internal whitespace runs and trim the ends
 *   - many shells set the title to the cwd path; keep only the last segment so
 *     "/Users/me/code/yterminal" shows as "yterminal" rather than a long path
 *   - cap the length so one pane can't stretch the tab bar
 *
 * Returns "" for a title that is empty after cleaning; callers treat that as
 * "no usable title" and leave the existing name untouched.
 */
export function sanitizeTabTitle(raw: string): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  // A bare absolute/home path -> its last segment. Only when the whole title
  // looks like a single path token (no spaces): titles like "npm run dev" or
  // "vim ~/notes.md" are left alone.
  let name = cleaned;
  if (!name.includes(" ") && /[\\/]/.test(name)) {
    const seg = name.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (seg) name = seg;
  }

  if (name.length > MAX_TAB_TITLE_LEN) {
    name = name.slice(0, MAX_TAB_TITLE_LEN - 1).trimEnd() + "…";
  }
  return name;
}

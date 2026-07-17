// DECTCEM show-cursor sequence. A program can hide the cursor with `\e[?25l`
// and is expected to restore it with this. When a remote program dies abruptly
// (ssh killed by a network drop / laptop sleep) the restore byte never arrives,
// so the local xterm stays "cursor hidden" forever — even after control returns
// to the local shell. We re-assert this at safe moments to recover.
export const SHOW_CURSOR = "\x1b[?25h";

// Only re-assert cursor visibility on the normal buffer. A full-screen TUI (vim,
// less, a coding agent) runs on the alternate buffer and may hide the cursor on
// purpose; re-showing it there would fight the program. A shell prompt is always
// on the normal buffer, where a visible cursor is always correct.
export function shouldRestoreCursor(bufferType: "normal" | "alternate"): boolean {
  return bufferType === "normal";
}

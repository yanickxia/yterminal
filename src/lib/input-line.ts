// Pure reducer that reconstructs the command lines a user submits at a shell
// prompt, by accumulating the keystrokes xterm sends toward the pty. We use it
// to capture the *literal* launch token (possibly a shell alias) a user typed
// to start an agent — the running process's argv only shows the resolved
// binary, never the alias.
//
// This is deliberately minimal: it tracks printable input and the handful of
// editing keys that affect the current line. It is NOT a terminal emulator and
// makes no attempt to track cursor position mid-line, multi-line input, or
// bracketed paste internals beyond stripping the markers. Good enough to grab
// the first token of a freshly typed command, which is all the caller needs.

export interface InputLineState {
  /** the current (unsubmitted) line buffer */
  buffer: string;
}

export function makeInputLineState(): InputLineState {
  return { buffer: "" };
}

// bracketed-paste markers the shell wraps pasted text in; strip so a pasted
// command still parses. (ESC [ 200 ~ ... ESC [ 201 ~)
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Feed one chunk of user input (the string xterm passes to pty.write). Returns
 * the next state and, when the user pressed Enter, the trimmed line that was
 * submitted. Only call this for input that ORIGINATED FROM THE USER (xterm's
 * onData) — never for programmatic injection, or we'd re-capture our own
 * resume command.
 */
export function feedInput(
  state: InputLineState,
  chunk: string
): { state: InputLineState; submitted?: string } {
  let buffer = state.buffer;
  let submitted: string | undefined;

  // strip bracketed-paste markers without disturbing the payload.
  chunk = chunk.split(PASTE_START).join("").split(PASTE_END).join("");

  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    const code = chunk.charCodeAt(i);
    if (ch === "\r" || ch === "\n") {
      // submit on the first newline; the rest (rare) starts a fresh line.
      submitted = buffer.trim();
      buffer = "";
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      // DEL / BS: erase one char.
      buffer = buffer.slice(0, -1);
      continue;
    }
    if (code === 0x15) {
      // Ctrl-U: kill the whole line.
      buffer = "";
      continue;
    }
    if (code === 0x03 || code === 0x04) {
      // Ctrl-C / Ctrl-D: abandon the current line.
      buffer = "";
      continue;
    }
    if (code === 0x1b) {
      // ESC — start of an escape sequence (arrow keys, etc.). Skip a following
      // CSI/SS3 sequence so cursor movement etc. doesn't land in the buffer.
      // We don't model the cursor, so just drop the sequence bytes.
      if (chunk[i + 1] === "[" || chunk[i + 1] === "O") {
        i += 1;
        // consume until a final byte in the @–~ range.
        while (i + 1 < chunk.length) {
          const c = chunk.charCodeAt(i + 1);
          i += 1;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      }
      continue;
    }
    if (code < 0x20) {
      // other control chars: ignore.
      continue;
    }
    buffer += ch;
  }

  return { state: { buffer }, submitted };
}

/** First whitespace-delimited token of a command line. */
export function firstToken(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const m = trimmed.match(/^\S+/);
  return m ? m[0] : "";
}

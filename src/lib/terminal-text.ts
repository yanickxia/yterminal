// Pure helpers for turning a terminal's serialized buffer into clean text for
// the AI sidebar. Kept separate from terminal-manager (which owns the live
// xterm/PTY objects) so the transforms can be unit-tested without a DOM.

// Matches ANSI/VT control sequences the SerializeAddon reproduces (colors,
// cursor moves, OSC title/cwd). They're noise to an LLM, so we drop them.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// OSC: ESC ] ... (BEL | ESC \)
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Charset designators: ESC ( B, ESC ) 0, etc. — an intermediate byte from
// ( ) * + - . / followed by a single final byte.
// eslint-disable-next-line no-control-regex
const CHARSET_RE = /\x1b[()*+\-.\/][0-~]/g;
// Remaining lone escapes (e.g. ESC = / ESC > keypad-mode toggles).
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b[@-Z\\-_]?/g;
// C0 control chars except tab (\x09) and newline (\x0a), plus DEL.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strip ANSI escape sequences and other control chars (keep \n and \t). */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(CHARSET_RE, "")
    .replace(ESC_RE, "")
    .replace(CTRL_RE, "");
}

/**
 * Normalize a serialized terminal buffer into plain text suitable for an LLM
 * prompt: strip escapes, normalize CRLF, collapse blank runs, and cap to
 * `maxChars` keeping the TAIL (the most recent output is the most relevant).
 */
export function cleanTerminalText(raw: string, maxChars = 12000): string {
  const text = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
  if (text.length <= maxChars) return text;
  // keep the end; mark that we truncated the head
  return "…(truncated)…\n" + text.slice(text.length - maxChars);
}

// Pure encoder for the Enter key with modifiers, mirroring the style of
// clipboard-shortcut.ts / link-modifier.ts. Kept separate from the
// terminal-manager IO so it can be unit-tested in isolation.
//
// Claude Code (and the keybinding installed by its `/terminal-setup` command)
// uses the traditional Meta+Enter wire sequence, ESC followed by CR, for a
// literal newline. It does not currently recognize CSI-u encoded Enter keys in
// every terminal. Normalize every modified Enter to that legacy sequence so
// Shift/Option/Control/Command+Enter all provide a reliable multiline input
// path; plain Enter remains CR and submits normally.

export interface EnterKeyLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Encode what an Enter keypress should send to the pty.
 *
 * Returns `"\r"` (plain CR, i.e. submit) when no modifier is held, and the
 * Claude Code-compatible legacy Meta+Enter sequence otherwise.
 */
export function encodeEnter(e: EnterKeyLike): string {
  const modified = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;
  return modified ? "\x1b\r" : "\r";
}

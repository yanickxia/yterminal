// Pure encoder for the Enter key with modifiers, mirroring the style of
// clipboard-shortcut.ts / link-modifier.ts. Kept separate from the
// terminal-manager IO so it can be unit-tested in isolation.
//
// Background: a bare Enter submits (sends CR). A modified Enter used to be
// collapsed to ESC+CR (the Alt+Enter sequence) so TUIs like Claude Code treat
// it as "newline within input". But ESC+CR is indistinguishable from Alt+Enter,
// so a terminal multiplexer (tmux) can't bind Ctrl+Shift+Enter to its own
// action — it just sees a newline. Emitting the CSI-u ("fixterms" / kitty)
// encoding instead preserves the exact modifier combination on the wire, so
// tmux (and modern TUIs) can tell the combos apart and bind them.
//
// CSI-u form: ESC [ <codepoint> ; <modifier> u
//   codepoint for Enter/Return is 13 (CR).
//   modifier is 1 + a bitmask: Shift=1, Alt=2, Ctrl=4, Meta=8.

export interface EnterKeyLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Unicode codepoint the CSI-u sequence reports for the Enter/Return key. */
const ENTER_CODEPOINT = 13;

/**
 * Encode what an Enter keypress should send to the pty.
 *
 * Returns `"\r"` (plain CR, i.e. submit) when no modifier is held, and the
 * CSI-u sequence carrying the exact modifier bitmask otherwise. Returning a
 * distinct sequence per modifier combination lets tmux / modern TUIs bind
 * Ctrl+Shift+Enter and friends instead of seeing an ambiguous newline.
 */
export function encodeEnter(e: EnterKeyLike): string {
  const mods =
    (e.shiftKey ? 1 : 0) |
    (e.altKey ? 2 : 0) |
    (e.ctrlKey ? 4 : 0) |
    (e.metaKey ? 8 : 0);
  if (mods === 0) return "\r";
  return `\x1b[${ENTER_CODEPOINT};${mods + 1}u`;
}

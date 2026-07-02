// Pure predicate for terminal clipboard shortcuts, mirroring the style of
// link-modifier.ts. Kept separate from the terminal-manager IO so it can be
// unit-tested in isolation.
//
// The non-mac bindings are Ctrl+Shift+C / Ctrl+Shift+V — NEVER bare Ctrl+C /
// Ctrl+V, which must reach the shell as SIGINT / literal input. On macOS the
// conventional Cmd+C / Cmd+V is safe because Ctrl+C stays free for SIGINT.

export type ClipboardAction = "copy" | "paste";

/** Minimal shape of the fields we read off a KeyboardEvent. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchClipboardShortcut(
  e: KeyLike,
  isMac: boolean
): ClipboardAction | null {
  if (e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key !== "c" && key !== "v") return null;
  if (isMac) {
    // Cmd (no Ctrl); Shift is irrelevant to the binding.
    if (!e.metaKey || e.ctrlKey) return null;
  } else {
    // Ctrl+Shift, never Cmd. Bare Ctrl+C/V is left untouched.
    if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  }
  return key === "c" ? "copy" : "paste";
}

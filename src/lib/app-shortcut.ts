// Pure matcher for the app's global keyboard shortcuts, mirroring the style of
// clipboard-shortcut.ts. Kept separate from the App.tsx wiring so the whole
// binding table is unit-testable in isolation.
//
// Platform split — this is the invariant:
//   • macOS binds Cmd (⌘). Cmd+letter is free (it's not a terminal control
//     char), so xterm passes it through.
//   • Elsewhere (Linux/Windows) binds Ctrl+SHIFT. **Bare Ctrl+letter is never
//     matched** — Ctrl+W/N/T/… are terminal control chars that must reach the
//     shell (Ctrl+W = delete-word, etc.), exactly like the Ctrl+Shift+C/V
//     clipboard rule.
//
// A handful of actions have a secondary ("sub") variant. The sub chord is
// Shift on macOS (Cmd+Shift+X) and Alt on Linux (Ctrl+Shift+Alt+X) — Shift is
// already spent as the base modifier on Linux, so Alt distinguishes the sub.

export interface KeyLike {
  /** `KeyboardEvent.code`, e.g. "KeyW" / "Digit3" — layout-independent. */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type AppShortcut =
  | { action: "palette" }
  | { action: "aiSidebar" }
  | { action: "newWorkspace" }
  | { action: "newTab" }
  | { action: "search" }
  | { action: "split"; column: boolean }
  | { action: "closeCascade" }
  | { action: "closePane" }
  | { action: "switchWorkspace"; n: number }
  | { action: "switchTab"; n: number };

/**
 * Classify a keydown into an app shortcut, or null when it isn't one. Pure —
 * reads only the modifier flags and `code`, so it's layout-independent and
 * testable without a DOM. The caller (App.tsx) preventDefaults/stopPropagates
 * only when this returns non-null.
 */
export function matchAppShortcut(e: KeyLike, isMac: boolean): AppShortcut | null {
  // Gate on the base modifier set for the platform.
  if (isMac) {
    // Cmd required; Ctrl/Alt must be absent. Shift = sub-variant.
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  } else {
    // Ctrl+Shift required; Cmd absent. Alt = sub-variant.
    if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  }
  // Is the secondary chord held? Shift on mac, Alt on Linux/Windows.
  const sub = isMac ? e.shiftKey : e.altKey;

  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const n = Number(digit[1]);
    return sub ? { action: "switchTab", n } : { action: "switchWorkspace", n };
  }

  const letter = /^Key([A-Z])$/.exec(e.code);
  if (!letter) return null;
  const key = letter[1].toLowerCase();
  switch (key) {
    // No sub-variant: these must NOT fire when the sub chord is held.
    case "k":
      return sub ? null : { action: "palette" };
    case "i":
      return sub ? null : { action: "aiSidebar" };
    case "n":
      return sub ? null : { action: "newWorkspace" };
    case "t":
      return sub ? null : { action: "newTab" };
    case "f":
      return sub ? null : { action: "search" };
    // Has a sub-variant.
    case "d":
      return { action: "split", column: sub };
    case "w":
      return sub ? { action: "closePane" } : { action: "closeCascade" };
    default:
      return null;
  }
}

// context-menu-suppress: decide whether a native `contextmenu` event should be
// swallowed because it's the spurious one macOS WKWebView fires alongside a
// Ctrl-modified keydown. See terminal-manager.ts / PaneTerminal.tsx for the
// wiring and context-menu-suppress.test.ts for the cases.
//
// Background: on macOS, Ctrl is the system "secondary click" modifier, so a
// Ctrl+Enter keydown (now emitted as a CSI-u sequence, see enter-key.ts) also
// makes the webview dispatch a `contextmenu` event at the caret — popping our
// Copy/Paste menu on top of the terminal. We stamp the moment a modified Enter
// is handled and swallow a `contextmenu` arriving right after it.
//
// Using a self-expiring timestamp (rather than a sticky boolean) means that if
// the spurious event never arrives on some platform, a later genuine
// right-click is NOT wrongly swallowed.

export function shouldSuppressContextMenu(
  modifiedEnterAt: number | undefined,
  now: number,
  windowMs = 100
): boolean {
  if (modifiedEnterAt === undefined) return false;
  const dt = now - modifiedEnterAt;
  return dt >= 0 && dt < windowMs;
}

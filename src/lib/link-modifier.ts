export function detectIsMac(): boolean {
  return navigator.userAgent.toLowerCase().includes("mac");
}

// `getModifierState` mirrors `metaKey`/`ctrlKey` in standard browsers, but
// Tauri's WKWebView on macOS occasionally drops `metaKey` on synthesized
// mouse events; the redundant check is a fallback for that case.
//
// `requireModifier` (default true) gates clicks behind the platform modifier
// (Cmd on macOS, Ctrl elsewhere). When false, a plain click opens the link —
// the terminal "sniffs" links directly with no helper key.
export function shouldOpenLink(
  event: MouseEvent,
  isMac: boolean,
  requireModifier = true
): boolean {
  if (!requireModifier) return true;
  if (isMac) {
    return event.metaKey || event.getModifierState("Meta");
  }
  return event.ctrlKey || event.getModifierState("Control");
}

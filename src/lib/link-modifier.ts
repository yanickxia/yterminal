export function detectIsMac(): boolean {
  return navigator.userAgent.toLowerCase().includes("mac");
}

// `getModifierState` mirrors `metaKey`/`ctrlKey` in standard browsers, but
// Tauri's WKWebView on macOS occasionally drops `metaKey` on synthesized
// mouse events; the redundant check is a fallback for that case.
export function shouldOpenLink(event: MouseEvent, isMac: boolean): boolean {
  if (isMac) {
    return event.metaKey || event.getModifierState("Meta");
  }
  return event.ctrlKey || event.getModifierState("Control");
}

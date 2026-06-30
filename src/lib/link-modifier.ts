export function detectIsMac(): boolean {
  return navigator.userAgent.toLowerCase().includes("mac");
}

export function shouldOpenLink(event: MouseEvent, isMac: boolean): boolean {
  if (isMac) {
    return event.metaKey || event.getModifierState("Meta");
  }
  return event.ctrlKey || event.getModifierState("Control");
}

// paste-suppress: decide whether a native `paste` event should be swallowed
// because it's the duplicate that webkit2gtk fires alongside our own
// shortcut-driven pasteInto(). See terminal-manager.ts for the wiring and
// paste-suppress.test.ts for the cases.
//
// A keyboard paste shortcut records the moment it ran; a native `paste` event
// arriving within `windowMs` of that moment is the duplicate and is suppressed.
// Using a self-expiring timestamp (rather than a sticky boolean) means that if
// the native event never arrives on some platform, a later unrelated paste
// (middle-click / menu) is NOT wrongly swallowed.

export function shouldSuppressNativePaste(
  pasteViaShortcutAt: number | undefined,
  now: number,
  windowMs = 500
): boolean {
  if (pasteViaShortcutAt === undefined) return false;
  const dt = now - pasteViaShortcutAt;
  return dt >= 0 && dt < windowMs;
}

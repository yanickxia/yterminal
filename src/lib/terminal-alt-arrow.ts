const cursorDirections = new Map([
  ["ArrowUp", "A"],
  ["ArrowDown", "B"],
  ["ArrowRight", "C"],
  ["ArrowLeft", "D"],
]);

/** Preserve the Alt-arrow sequences sent by xterm 5.5. */
export function encodeAltArrow(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "shiftKey" | "metaKey" | "isComposing">,
  isMac: boolean
): string | undefined {
  if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.isComposing) return;
  if (isMac) {
    if (event.key === "ArrowLeft") return "\x1bb";
    if (event.key === "ArrowRight") return "\x1bf";
    return;
  }
  const direction = cursorDirections.get(event.key);
  if (direction) return `\x1b[1;5${direction}`;
}

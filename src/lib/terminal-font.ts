export interface FontFaceSetLike {
  load(font: string, text?: string): PromiseLike<unknown>;
  readonly ready: PromiseLike<unknown>;
}

/**
 * Wait for every face xterm can request from a terminal font stack.
 *
 * The complete stack is passed to FontFaceSet so a missing preferred family
 * still loads the fallback that the canvas will actually use.
 */
export async function ensureTerminalFontLoaded(
  stack: string,
  fontSize: number,
  fontSet?: FontFaceSetLike
): Promise<void> {
  const fonts =
    fontSet ??
    (typeof document !== "undefined" && document.fonts
      ? document.fonts
      : undefined);
  if (!fonts || !stack.trim()) return;

  try {
    await Promise.all([
      fonts.load(`${fontSize}px ${stack}`),
      fonts.load(`bold ${fontSize}px ${stack}`),
      fonts.load(`italic ${fontSize}px ${stack}`),
      fonts.load(`italic bold ${fontSize}px ${stack}`),
    ]);
    await fonts.ready;
  } catch {
    // Invalid hand-edited stacks and unavailable local faces must not block UI.
  }
}

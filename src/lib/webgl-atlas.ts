export interface TextureAtlasInvalidator {
  clearTextureAtlas(): void;
}

/**
 * Clear every live renderer in one synchronous pass.
 *
 * addon-webgl shares a texture atlas between terminals with equal render
 * options, but clearTextureAtlas only clears the calling renderer's model.
 * Calling every owner in the same tick keeps their models aligned with the
 * shared texture before any requestAnimationFrame redraw can run.
 */
export function clearTextureAtlases(
  renderers: Iterable<TextureAtlasInvalidator | undefined>
): void {
  for (const renderer of renderers) {
    if (!renderer) continue;
    try {
      renderer.clearTextureAtlas();
    } catch {
      // A context-loss callback may dispose an addon during invalidation.
    }
  }
}

/**
 * The small private RenderService surface needed to neutralize xterm's
 * visibility pause after a cached terminal has been attached.
 *
 * xterm 5.5 registers IntersectionObserver with a callback shaped like
 * `entries => this._handleIntersectionChange(lastEntry)`. Disconnecting the
 * observer does not cancel a callback that WKWebView has already queued, so
 * replacing the dynamically-looked-up handler is what closes that race.
 */
export interface VisibilityPauseRenderService {
  _observerDisposable?: { clear?: () => void };
  _handleIntersectionChange?: (entry: unknown) => void;
  _isPaused?: boolean;
  _needsFullRefresh?: boolean;
}

const ignoreIntersectionChange = () => {};

/**
 * Permanently disable xterm's visibility pause for a renderer whose DOM node
 * is cached/re-parented by the application. Returns whether a repaint was
 * already pending before the renderer was resumed.
 */
export function disableVisibilityPause(
  renderService: VisibilityPauseRenderService | undefined
): boolean {
  if (!renderService) return false;
  const needsRefresh = Boolean(
    renderService._isPaused || renderService._needsFullRefresh
  );
  renderService._observerDisposable?.clear?.();
  if (
    typeof renderService._handleIntersectionChange === "function" &&
    renderService._handleIntersectionChange !== ignoreIntersectionChange
  ) {
    renderService._handleIntersectionChange = ignoreIntersectionChange;
  }
  renderService._isPaused = false;
  return needsRefresh;
}

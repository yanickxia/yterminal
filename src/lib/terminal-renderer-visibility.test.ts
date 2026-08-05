import { describe, expect, it, vi } from "vitest";
import {
  disableVisibilityPause,
  type VisibilityPauseRenderService,
} from "./terminal-renderer-visibility";

describe("disableVisibilityPause", () => {
  it("disconnects the observer, resumes rendering, and reports a pending repaint", () => {
    const clear = vi.fn();
    const service: VisibilityPauseRenderService = {
      _observerDisposable: { clear },
      _isPaused: true,
      _needsFullRefresh: false,
      _handleIntersectionChange: () => {},
    };

    expect(disableVisibilityPause(service)).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(service._isPaused).toBe(false);
  });

  it("ignores an IntersectionObserver callback queued before disconnect", () => {
    const service: VisibilityPauseRenderService = {
      _isPaused: false,
      _handleIntersectionChange(entry) {
        service._isPaused = !(entry as { isIntersecting: boolean }).isIntersecting;
      },
    };
    // This mirrors xterm 5.5's observer closure: it looks the private handler
    // up when the already-queued callback eventually runs.
    const queuedObserverCallback = (entry: unknown) =>
      service._handleIntersectionChange?.(entry);

    disableVisibilityPause(service);
    queuedObserverCallback({ isIntersecting: false });

    expect(service._isPaused).toBe(false);
  });

  it("is safe before RenderService exists", () => {
    expect(disableVisibilityPause(undefined)).toBe(false);
  });
});

interface DisposableAddon {
  dispose(): void;
}

interface XtermDisposalCore {
  _isDisposed?: boolean;
  _store?: { _isDisposed?: boolean };
}

/**
 * addon-webgl 0.19 restores the DOM renderer during dispose, but checks
 * core._store._isDisposed (the newer xterm lifecycle shape) first. xterm 5.5
 * keeps _isDisposed directly on core. Without this bridge, context loss
 * removes the canvas and then throws before installing the DOM renderer.
 *
 * Install BEFORE loadAddon so xterm's AddonManager wraps this disposer too.
 * Expose the legacy flag only during disposal, including terminal teardown;
 * newer cores retain their actual store. Re-audit on either dependency upgrade.
 */
export function installWebglDisposalCompatibility(
  terminal: object,
  addon: DisposableAddon
): void {
  const core = (terminal as { _core?: XtermDisposalCore })._core;
  if (!core || "_store" in core || typeof core._isDisposed !== "boolean") return;

  const dispose = addon.dispose;
  addon.dispose = function () {
    // A reentrant disposer or newer compatibility layer may already supply it.
    const needsBridge = !("_store" in core);
    if (needsBridge) core._store = core;
    try {
      dispose.call(this);
    } finally {
      if (needsBridge) delete core._store;
    }
  };
}

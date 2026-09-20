import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installWebglDisposalCompatibility } from "./webgl-disposal";

describe("addon-webgl disposal compatibility", () => {
  it("lets the addon restore a renderer with the installed xterm core", () => {
    const term = new Terminal();
    const core = (term as any)._core;
    const restoreRenderer = vi.fn();
    const addon = {
      dispose() {
        // The exact guard used by addon-webgl 0.19's renderer-restoration callback.
        if (!core._store._isDisposed) restoreRenderer();
      },
    };
    expect(() => addon.dispose()).toThrow(TypeError);
    installWebglDisposalCompatibility(term, addon);
    addon.dispose();
    expect(restoreRenderer).toHaveBeenCalledOnce();
    expect("_store" in core).toBe(false);
    term.dispose();
  });

  it("skips renderer recreation when xterm itself is being disposed", () => {
    const term = new Terminal();
    const core = (term as any)._core;
    const restoreRenderer = vi.fn();
    const addon = {
      activate() {},
      dispose() {
        if (!core._store._isDisposed) restoreRenderer();
      },
    };
    installWebglDisposalCompatibility(term, addon);
    term.loadAddon(addon);
    expect(() => term.dispose()).not.toThrow();
    expect(restoreRenderer).not.toHaveBeenCalled();
    expect("_store" in core).toBe(false);
  });

  it("preserves the receiver and removes the bridge even if disposal fails", () => {
    const core = { _isDisposed: false };
    const addon = {
      dispose() {
        expect(this).toBe(addon);
        throw new Error("unrelated disposal failure");
      },
    };
    installWebglDisposalCompatibility({ _core: core }, addon);
    expect(() => addon.dispose()).toThrow("unrelated disposal failure");
    expect("_store" in core).toBe(false);
  });

  it("leaves modern and unknown lifecycle shapes untouched", () => {
    for (const core of [{ _store: { _isDisposed: false } }, {}]) {
      const dispose = vi.fn();
      const addon = { dispose };
      installWebglDisposalCompatibility({ _core: core }, addon);
      expect(addon.dispose).toBe(dispose);
    }
  });
});

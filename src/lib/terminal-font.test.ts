import { describe, expect, it, vi } from "vitest";
import {
  ensureTerminalFontLoaded,
  type FontFaceSetLike,
} from "./terminal-font";

describe("ensureTerminalFontLoaded", () => {
  it("loads every xterm face from the complete fallback stack", async () => {
    const load = vi.fn((_font: string) => Promise.resolve([]));
    const fonts: FontFaceSetLike = { load, ready: Promise.resolve() };
    const stack = '"Missing Font", Menlo, monospace';

    await ensureTerminalFontLoaded(stack, 15, fonts);

    expect(load.mock.calls.map(([font]) => font)).toEqual([
      `15px ${stack}`,
      `bold 15px ${stack}`,
      `italic 15px ${stack}`,
      `italic bold 15px ${stack}`,
    ]);
  });

  it("waits for FontFaceSet.ready after individual loads", async () => {
    let releaseReady = () => {};
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const fonts: FontFaceSetLike = {
      load: () => Promise.resolve([]),
      ready,
    };
    let settled = false;

    const pending = ensureTerminalFontLoaded("Menlo, monospace", 14, fonts).then(
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseReady();
    await pending;
    expect(settled).toBe(true);
  });

  it("does not reject when a local face cannot be loaded", async () => {
    const fonts: FontFaceSetLike = {
      load: () => Promise.reject(new Error("bad font")),
      ready: Promise.resolve(),
    };

    await expect(
      ensureTerminalFontLoaded("broken-font", 14, fonts)
    ).resolves.toBeUndefined();
  });
});

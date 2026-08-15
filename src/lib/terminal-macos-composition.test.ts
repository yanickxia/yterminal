import { describe, expect, it, vi } from "vitest";
import { patchLegacyContinuousComposition } from "./terminal-macos-composition";

function makeHelper(value: string, start: number, end: number) {
  const sent: Array<{ data: string; wasUserInput?: boolean }> = [];
  const remove = vi.fn();
  const immediate = vi.fn();
  const helper = {
    _textarea: { value },
    _compositionView: { classList: { remove } },
    _coreService: {
      triggerDataEvent(data: string, wasUserInput?: boolean) {
        sent.push({ data, wasUserInput });
      },
    },
    _isComposing: true,
    _isSendingComposition: false,
    _compositionPosition: { start, end },
    _dataAlreadySent: "",
    _finalizeComposition: immediate,
  };
  return { helper, sent, remove, immediate };
}

describe("patchLegacyContinuousComposition", () => {
  it("ends the old commit where a newly-started composition begins", () => {
    const pending: Array<() => void> = [];
    // The stale end includes q, the first preedit key of the next composition.
    const { helper, sent } = makeHelper("狠狠q", 0, 3);
    patchLegacyContinuousComposition(helper, (callback) =>
      pending.push(callback)
    );

    helper._finalizeComposition(true);
    // macOS starts the next composition before xterm's zero-delay send runs.
    helper._isComposing = true;
    helper._compositionPosition.start = 2;
    pending[0]();

    expect(sent).toEqual([{ data: "狠狠", wasUserInput: true }]);
  });

  it("sends the whole committed value when no new composition starts", () => {
    const pending: Array<() => void> = [];
    const { helper, sent, remove } = makeHelper("你好", 0, 2);
    patchLegacyContinuousComposition(helper, (callback) =>
      pending.push(callback)
    );

    helper._finalizeComposition(true);
    pending[0]();

    expect(remove).toHaveBeenCalledWith("active");
    expect(sent).toEqual([{ data: "你好", wasUserInput: true }]);
  });

  it("leaves immediate finalization under xterm's original implementation", () => {
    const { helper, immediate } = makeHelper("你", 0, 1);
    patchLegacyContinuousComposition(helper);

    helper._finalizeComposition(false);

    expect(immediate).toHaveBeenCalledOnce();
    expect(immediate).toHaveBeenCalledWith(false);
  });

  it("restores the original helper method during cleanup", () => {
    const pending: Array<() => void> = [];
    const { helper, immediate, sent } = makeHelper("你", 0, 1);
    const cleanup = patchLegacyContinuousComposition(helper, (callback) =>
      pending.push(callback)
    );
    expect(helper._finalizeComposition).not.toBe(immediate);
    helper._finalizeComposition(true);

    cleanup();
    pending[0]();

    expect(helper._finalizeComposition).toBe(immediate);
    expect(sent).toEqual([]);
  });
});

// terminal-macos-composition: backport xterm.js' continuous-IME fix to the
// pinned 5.5 runtime.
//
// Some macOS Chinese IMEs use one key event to commit the current candidate
// and immediately begin the next composition. xterm 5.5 snapshots both the
// old start and end offsets before its delayed composition send; when the next
// composition starts before that timer runs, the stale end can include its
// first preedit character. The key then appears to be swallowed and must be
// pressed again.
//
// Upstream fixed this by ending the old commit at the NEW composition's start
// offset. We reproduce that one delayed branch here instead of upgrading xterm
// and its private addon-webgl compatibility layers together. Immediate
// finalization is delegated unchanged to xterm.

type Schedule = (callback: () => void) => unknown;

interface LegacyCompositionHelper {
  _textarea: { value: string };
  _compositionView: { classList: { remove(name: string): void } };
  _coreService: {
    triggerDataEvent(data: string, wasUserInput?: boolean): void;
  };
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _compositionPosition: { start: number; end: number };
  _dataAlreadySent: string;
  _finalizeComposition(waitForPropagation: boolean): void;
}

interface TerminalWithCompositionHelper {
  _core?: { _compositionHelper?: LegacyCompositionHelper };
}

function isLegacyCompositionHelper(
  value: LegacyCompositionHelper | undefined
): value is LegacyCompositionHelper {
  return Boolean(
    value &&
      typeof value._finalizeComposition === "function" &&
      typeof value._textarea?.value === "string" &&
      typeof value._compositionView?.classList?.remove === "function" &&
      typeof value._coreService?.triggerDataEvent === "function" &&
      typeof value._compositionPosition?.start === "number" &&
      typeof value._compositionPosition?.end === "number" &&
      typeof value._dataAlreadySent === "string"
  );
}

/**
 * Patch an xterm 5.5 CompositionHelper in place. Exported separately so the
 * event-ordering regression can be tested without constructing a DOM terminal.
 */
export function patchLegacyContinuousComposition(
  helper: LegacyCompositionHelper | undefined,
  schedule: Schedule = (callback) => setTimeout(callback, 0)
): () => void {
  if (!isLegacyCompositionHelper(helper)) return () => {};

  const original = helper._finalizeComposition;
  let active = true;
  const patched = function (
    this: LegacyCompositionHelper,
    waitForPropagation: boolean
  ): void {
    // xterm's synchronous path is also used to cancel a pending delayed send.
    // Keep it byte-for-byte under xterm's ownership.
    if (!waitForPropagation) {
      original.call(this, false);
      return;
    }

    this._compositionView.classList.remove("active");
    this._isComposing = false;

    // A new compositionstart may mutate the live offsets before this callback.
    const currentCompositionPosition = {
      start: this._compositionPosition.start,
      end: this._compositionPosition.end,
    };

    this._isSendingComposition = true;
    schedule(() => {
      if (!active || !this._isSendingComposition) return;
      this._isSendingComposition = false;

      currentCompositionPosition.start += this._dataAlreadySent.length;
      const input = this._isComposing
        ? this._textarea.value.substring(
            currentCompositionPosition.start,
            this._compositionPosition.start
          )
        : this._textarea.value.substring(currentCompositionPosition.start);

      if (input.length > 0) {
        this._coreService.triggerDataEvent(input, true);
      }
    });
  };

  helper._finalizeComposition = patched;
  return () => {
    active = false;
    // Do not clobber another compatibility layer installed after ours.
    if (helper._finalizeComposition === patched) {
      helper._finalizeComposition = original;
    }
  };
}

/** Install the backport after `term.open()`, when xterm creates its helper. */
export function installMacosContinuousCompositionFix(term: object): () => void {
  const helper = (term as TerminalWithCompositionHelper)._core
    ?._compositionHelper;
  return patchLegacyContinuousComposition(helper);
}

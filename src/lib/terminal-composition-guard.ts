// terminal-composition-guard: neutralize orphan `compositionend` events on
// Linux (webkit2gtk).
//
// WebKitGTK + ibus/fcitx commit CJK/accented text WITHOUT ever firing
// `compositionstart` — the commit arrives as `keydown(229)` → `input`
// (inputType `insertFromComposition`) → a lone `compositionend`. xterm's
// CompositionHelper assumes balanced start/end pairs, so with no start its
// composition-start offset stays pinned at 0 and every orphan end re-sends the
// hidden textarea's ENTIRE accumulated value (only cleared on Enter/Ctrl+C).
// Typing `你好` therefore snowballs into `你好你你好好…` (see the user report).
//
// The fix (validated in coollabsio/jean#411): a Linux-only capture-phase guard
// on an ancestor of xterm's textarea that runs BEFORE xterm's own bubble
// listeners. It restores the textarea to its pre-commit value on `input` (so
// xterm's diff timer sees oldValue === newValue and no branch fires), delivers
// the committed text exactly once itself, and swallows the orphan
// `compositionend`. When `beforeinput.data` is missing, the commit is recovered
// from the textarea mutation. macOS/Windows keep xterm's native balanced flow.
//
// The time-ordering state machine lives in `makeCompositionGuard` as a pure
// reducer (targets compared by identity, values as plain strings — no DOM), so
// it's unit-testable in the node env. `attachOrphanCompositionEndGuard` is the
// thin DOM/IO wrapper that wires real events to it.

/** Opaque identity token — the real event target, compared by reference only. */
type TargetId = object;

interface PendingRestore {
  target: TargetId;
  value: string;
  /**
   * Committed text reported by `beforeinput`. `undefined` means WebKit did
   * not provide `InputEvent.data`, so derive it from the post-mutation value.
   * `null` means restore only: xterm already delivered a plain keyboard key.
   */
  deliver: string | null | undefined;
}

/** What the caller should do after an `input` event. */
export interface InputDecision {
  /** if set, assign this back to `target.value` */
  restoreValue?: string;
  /** if set, deliver this committed text to the pty exactly once */
  deliver?: string;
}

/** What the caller should do after a `compositionend` event. */
export interface CompositionEndDecision {
  /** if true, stopPropagation so xterm's CompositionHelper never sees it */
  swallow: boolean;
}

/**
 * Pure state machine for the guard. All inputs are primitives / identity
 * tokens so it runs without a DOM. The DOM wrapper below feeds it real events.
 */
export function makeCompositionGuard() {
  let compositionTarget: TargetId | null = null;
  let lastKeydownKeyCode = -1;
  let pending: PendingRestore | null = null;

  return {
    keydown(keyCode: number): void {
      lastKeydownKeyCode = keyCode;
      // A fresh key before the matching `input` means the snapshot is stale.
      pending = null;
    },

    compositionStart(target: TargetId): void {
      compositionTarget = target;
      pending = null;
    },

    reset(): void {
      compositionTarget = null;
      lastKeydownKeyCode = -1;
      pending = null;
    },

    /**
     * Snapshot the pre-mutation value so `input` can restore it. Two cases we
     * take over; everything else is left to xterm.
     */
    beforeInput(
      target: TargetId,
      inputType: string,
      data: string | null,
      oldValue: string
    ): void {
      if (
        inputType === "insertFromComposition" &&
        target !== compositionTarget
      ) {
        // Orphan commit (no matching start): we must deliver it ourselves.
        pending = {
          target,
          value: oldValue,
          deliver: data && data.length > 0 ? data : undefined,
        };
      } else if (
        inputType === "insertText" &&
        compositionTarget === null &&
        lastKeydownKeyCode !== 229
      ) {
        // Plain-key echo of a character xterm's _keyDown already delivered:
        // restore to drain the textarea, but do NOT re-deliver.
        pending = { target, value: oldValue, deliver: null };
      }
    },

    input(target: TargetId, newValue = ""): InputDecision {
      if (!pending || pending.target !== target) return {};
      const { value, deliver } = pending;
      pending = null;
      const decision: InputDecision = { restoreValue: value };
      // Restore whole value rather than trimming a suffix: the UA mutation may
      // replace a char or rewrite an NBSP, so a suffix diff is unreliable.
      const committed = deliver === undefined
        ? insertedText(value, newValue)
        : deliver;
      if (committed) decision.deliver = committed;
      return decision;
    },

    compositionEnd(target: TargetId | null): CompositionEndDecision {
      // Balanced only when this end matches the start we recorded. Anything
      // else is the webkit orphan → swallow so xterm doesn't re-send.
      const balanced =
        compositionTarget !== null && target === compositionTarget;
      compositionTarget = null;
      return { swallow: !balanced };
    },
  };
}

/** Return the inserted/replaced portion of a textarea mutation. */
export function insertedText(oldValue: string, newValue: string): string {
  let start = 0;
  while (
    start < oldValue.length &&
    start < newValue.length &&
    oldValue[start] === newValue[start]
  ) {
    start++;
  }
  let oldEnd = oldValue.length;
  let newEnd = newValue.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldValue[oldEnd - 1] === newValue[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  return newValue.slice(start, newEnd);
}

export type CompositionGuard = ReturnType<typeof makeCompositionGuard>;

/**
 * Attach the guard to `root` (an ancestor of xterm's textarea) in the capture
 * phase, so it runs before xterm's bubble-phase listeners. `deliverOrphanData`
 * receives committed text that the guard took responsibility for (write it to
 * the pty). Returns a cleanup function that removes every listener.
 */
export function attachOrphanCompositionEndGuard(
  root: HTMLElement,
  deliverOrphanData: (data: string) => void
): () => void {
  const g = makeCompositionGuard();

  const onKeyDown = (e: KeyboardEvent) => g.keydown(e.keyCode);
  const onCompositionStart = (e: Event) => {
    if (e.target) g.compositionStart(e.target);
  };
  const onBeforeInput = (e: InputEvent) => {
    const target = e.target as HTMLTextAreaElement | null;
    if (!target) return;
    g.beforeInput(target, e.inputType, e.data, target.value);
  };
  const onInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement | null;
    if (!target) return;
    const decision = g.input(target, target.value);
    if (typeof decision.restoreValue === "string") {
      target.value = decision.restoreValue;
    }
    if (decision.deliver) deliverOrphanData(decision.deliver);
  };
  const onCompositionEnd = (e: Event) => {
    if (g.compositionEnd(e.target ?? null).swallow) {
      e.stopPropagation();
    }
  };
  // A cached terminal may have been detached while an IME composition was in
  // progress. Reset when its textarea becomes active again, before the next
  // native composition event, without swallowing a late compositionend during
  // the blur itself.
  const onFocus = () => g.reset();

  root.addEventListener("keydown", onKeyDown as EventListener, true);
  root.addEventListener(
    "compositionstart",
    onCompositionStart as EventListener,
    true
  );
  root.addEventListener("beforeinput", onBeforeInput as EventListener, true);
  root.addEventListener("input", onInput as EventListener, true);
  root.addEventListener(
    "compositionend",
    onCompositionEnd as EventListener,
    true
  );
  root.addEventListener("focus", onFocus, true);

  return () => {
    root.removeEventListener("keydown", onKeyDown as EventListener, true);
    root.removeEventListener(
      "compositionstart",
      onCompositionStart as EventListener,
      true
    );
    root.removeEventListener(
      "beforeinput",
      onBeforeInput as EventListener,
      true
    );
    root.removeEventListener("input", onInput as EventListener, true);
    root.removeEventListener(
      "compositionend",
      onCompositionEnd as EventListener,
      true
    );
    root.removeEventListener("focus", onFocus, true);
  };
}

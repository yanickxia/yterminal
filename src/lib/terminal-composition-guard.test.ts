// Tests for the orphan-composition guard state machine.
//
// The pure reducer carries no DOM dependency (targets are compared by identity
// only, values are plain strings), so these run in the default node env — no
// jsdom needed, matching the pure/IO split used across the codebase.

import { describe, it, expect } from "vitest";
import { makeCompositionGuard } from "./terminal-composition-guard";

const T = { id: "textarea" }; // opaque event target; only identity matters
const OTHER = { id: "other" };

describe("makeCompositionGuard — orphan compositionend (webkit2gtk + IME)", () => {
  it("delivers committed CJK once and restores the textarea", () => {
    const g = makeCompositionGuard();
    // WebKitGTK never fires compositionstart; the commit arrives as a 229
    // keydown, an insertFromComposition input, then an orphan compositionend.
    g.keydown(229);
    g.beforeInput(T, "insertFromComposition", "你好", ""); // snapshot old value ""
    const inputDecision = g.input(T);
    expect(inputDecision.restoreValue).toBe("");
    expect(inputDecision.deliver).toBe("你好");
    // The orphan end targets an element we never saw a start for → swallow it,
    // so xterm's CompositionHelper never re-sends the accumulated textarea.
    expect(g.compositionEnd(T).swallow).toBe(true);
  });

  it("does not accumulate across successive orphan commits", () => {
    const g = makeCompositionGuard();
    // Because each input restores the textarea to its pre-commit value, the
    // snapshot the next round sees never grows — the source of the duplication.
    g.keydown(229);
    g.beforeInput(T, "insertFromComposition", "你", "");
    expect(g.input(T)).toEqual({ restoreValue: "", deliver: "你" });
    g.compositionEnd(T);

    g.keydown(229);
    g.beforeInput(T, "insertFromComposition", "好", ""); // still "" — restored
    expect(g.input(T)).toEqual({ restoreValue: "", deliver: "好" });
    g.compositionEnd(T);
  });
});

describe("makeCompositionGuard — balanced composition (macOS/Windows/normal)", () => {
  it("stays out of the way when compositionstart fired", () => {
    const g = makeCompositionGuard();
    g.compositionStart(T);
    // in-progress preedit input belongs to xterm; we neither restore nor deliver
    g.beforeInput(T, "insertFromComposition", "你", "");
    expect(g.input(T)).toEqual({});
    // matched end → let xterm handle it
    expect(g.compositionEnd(T).swallow).toBe(false);
  });
});

describe("makeCompositionGuard — plain keyboard input", () => {
  it("restores the echo of an already-handled key without re-delivering", () => {
    const g = makeCompositionGuard();
    // xterm's _keyDown already sent 'A' via triggerDataEvent; webkit still
    // echoes it into the textarea as insertText. Restore to drain it, but do
    // NOT deliver again (would double the character).
    g.keydown(65); // 'A', not 229
    g.beforeInput(T, "insertText", "A", "");
    const d = g.input(T);
    expect(d.restoreValue).toBe("");
    expect(d.deliver).toBeUndefined();
  });

  it("ignores an input with no matching beforeInput snapshot", () => {
    const g = makeCompositionGuard();
    expect(g.input(T)).toEqual({});
  });

  it("clears a stale pending restore on the next keydown", () => {
    const g = makeCompositionGuard();
    g.beforeInput(T, "insertText", "A", "");
    g.keydown(66); // a fresh key arrives before input fired — drop the snapshot
    expect(g.input(T)).toEqual({});
  });

  it("does not swallow a compositionend on a mismatched target", () => {
    const g = makeCompositionGuard();
    g.compositionStart(T);
    // end targets a different element → treat as orphan for that element
    expect(g.compositionEnd(OTHER).swallow).toBe(true);
  });
});

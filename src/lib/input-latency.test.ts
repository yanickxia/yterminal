import { describe, expect, it } from "vitest";
import { formatLatencySummary, makeInputLatencyTracker } from "./input-latency";

describe("input latency tracker", () => {
  it("summarizes a completed input/output/parse/render sample", () => {
    const tracker = makeInputLatencyTracker({ batchSize: 1, timeoutMs: 100 });

    expect(tracker.start(10)).toBe(true);
    tracker.markOutput(14);
    tracker.markParsed(16);

    expect(tracker.markRendered(20)).toEqual({
      count: 1,
      inputToOutput: { p50: 4, p95: 4, max: 4 },
      outputToParsed: { p50: 2, p95: 2, max: 2 },
      inputToRender: { p50: 10, p95: 10, max: 10 },
    });
  });

  it("does not replace a live sample but replaces an expired sample", () => {
    const tracker = makeInputLatencyTracker({ batchSize: 2, timeoutMs: 100 });

    expect(tracker.start(10)).toBe(true);
    expect(tracker.start(50)).toBe(false);
    expect(tracker.start(111)).toBe(true);
  });

  it("reports nearest-rank percentiles and clears a completed batch", () => {
    const tracker = makeInputLatencyTracker({ batchSize: 3, timeoutMs: 100 });
    let summary = null;

    for (const [start, output, parsed, render] of [
      [0, 1, 2, 3],
      [10, 14, 16, 20],
      [30, 39, 43, 50],
    ]) {
      tracker.start(start);
      tracker.markOutput(output);
      tracker.markParsed(parsed);
      summary = tracker.markRendered(render);
    }

    expect(summary?.inputToOutput).toEqual({ p50: 4, p95: 9, max: 9 });
    expect(summary?.outputToParsed).toEqual({ p50: 2, p95: 4, max: 4 });
    expect(summary?.inputToRender).toEqual({ p50: 10, p95: 20, max: 20 });
    expect(formatLatencySummary(summary!)).not.toMatch(/content=|key=/i);
    expect(tracker.start(60)).toBe(true);
  });

  it("ignores render events until PTY output arrives and resets pending work", () => {
    const tracker = makeInputLatencyTracker({ batchSize: 1, timeoutMs: 100 });

    tracker.start(0);
    expect(tracker.markRendered(2)).toBeNull();
    tracker.reset();
    tracker.markOutput(3);
    tracker.markParsed(4);

    expect(tracker.markRendered(5)).toBeNull();
  });

  it("drops a pending sample when output arrives after its timeout", () => {
    const tracker = makeInputLatencyTracker({ batchSize: 1, timeoutMs: 100 });

    tracker.start(0);
    tracker.markOutput(101);
    tracker.markParsed(102);

    expect(tracker.markRendered(103)).toBeNull();
    expect(tracker.start(104)).toBe(true);
  });
});

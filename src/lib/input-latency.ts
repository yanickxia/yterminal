export interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
}

export interface LatencySummary {
  count: number;
  inputToOutput: LatencyStats;
  outputToParsed: LatencyStats;
  inputToRender: LatencyStats;
}

interface PendingSample {
  inputAt: number;
  outputAt?: number;
  parsedAt?: number;
}

interface LatencySample {
  inputToOutput: number;
  outputToParsed: number;
  inputToRender: number;
}

export interface InputLatencyTracker {
  start(now: number): boolean;
  markOutput(now: number): void;
  markParsed(now: number): void;
  markRendered(now: number): LatencySummary | null;
  reset(): void;
}

function summarize(values: number[]): LatencyStats {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
  };
}

export function makeInputLatencyTracker(
  options: { batchSize?: number; timeoutMs?: number } = {}
): InputLatencyTracker {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 100));
  const timeoutMs = Math.max(1, options.timeoutMs ?? 250);
  let pending: PendingSample | undefined;
  let samples: LatencySample[] = [];

  return {
    start(now) {
      if (pending && now - pending.inputAt <= timeoutMs) return false;
      pending = { inputAt: now };
      return true;
    },

    markOutput(now) {
      if (pending && pending.outputAt === undefined) pending.outputAt = now;
    },

    markParsed(now) {
      if (
        pending &&
        pending.outputAt !== undefined &&
        pending.parsedAt === undefined
      ) {
        pending.parsedAt = now;
      }
    },

    markRendered(now) {
      if (
        !pending ||
        pending.outputAt === undefined ||
        pending.parsedAt === undefined
      ) {
        return null;
      }
      samples.push({
        inputToOutput: pending.outputAt - pending.inputAt,
        outputToParsed: pending.parsedAt - pending.outputAt,
        inputToRender: now - pending.inputAt,
      });
      pending = undefined;
      if (samples.length < batchSize) return null;

      const completed = samples;
      samples = [];
      return {
        count: completed.length,
        inputToOutput: summarize(completed.map((s) => s.inputToOutput)),
        outputToParsed: summarize(completed.map((s) => s.outputToParsed)),
        inputToRender: summarize(completed.map((s) => s.inputToRender)),
      };
    },

    reset() {
      pending = undefined;
      samples = [];
    },
  };
}

export function formatLatencySummary(summary: LatencySummary): string {
  const formatStats = (stats: LatencyStats) =>
    `p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms`;
  return [
    `samples=${summary.count}`,
    `input_to_output(${formatStats(summary.inputToOutput)})`,
    `output_to_parsed(${formatStats(summary.outputToParsed)})`,
    `input_to_render(${formatStats(summary.inputToRender)})`,
  ].join(" ");
}

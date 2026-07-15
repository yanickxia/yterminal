# Terminal Input Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce ordinary terminal key-to-render latency by removing per-key blocking-pool dispatch and avoidable hot-path work, with aggregate measurements and regression coverage.

**Architecture:** Keep the existing xterm and `pty_read` paths. Give every Rust PTY session a bounded async write sender backed by a dedicated blocking writer thread, replace per-chunk activity timer churn with a deadline timer, and collect privacy-safe latency aggregates in TypeScript. Measure the existing viewport workaround before deciding whether its per-write hook can be removed.

**Tech Stack:** Tauri 2, Rust, `portable-pty`, Tokio MPSC, React 18, TypeScript, xterm.js 5.5, Vitest.

## Global Constraints

- Blocking PTY syscalls must never run on Tauri's async worker pool.
- `src-tauri/src/pty.rs` and `src/lib/pty.ts` change together.
- No predicted local echo and no suppression of shell/TUI output.
- Keep terminal sessions cached and re-parented on tab switches.
- Preserve WebGL rendering and DOM fallback.
- Preserve Linux orphan-composition, paste de-duplication, tmux mouse bridge, scrollback, and close-flush behavior.
- Do not change the `pty_read` long-poll protocol in this phase.
- Latency telemetry records durations and counts only, never terminal or input content.

---

### Task 1: Pure Input Latency Aggregator

**Files:**
- Create: `src/lib/input-latency.ts`
- Create: `src/lib/input-latency.test.ts`

**Interfaces:**
- Produces: `makeInputLatencyTracker(options?)` with `start`, `markOutput`, `markParsed`, `markRendered`, and `reset` methods.
- Produces: `LatencySummary` containing `count`, plus p50/p95/max for `inputToOutput`, `outputToParsed`, and `inputToRender`.
- Produces: `formatLatencySummary(summary)` for one aggregate DEBUG log line.

- [ ] **Step 1: Write failing tracker tests**

Cover one complete sample, refusal to overwrite an in-flight sample, expired-sample replacement, percentile ordering, automatic batch reset, and content-free formatting.

```ts
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
    for (const [start, output, parsed, render] of [
      [0, 1, 2, 3],
      [10, 14, 16, 20],
      [30, 39, 43, 50],
    ]) {
      tracker.start(start);
      tracker.markOutput(output);
      tracker.markParsed(parsed);
      const summary = tracker.markRendered(render);
      if (render === 50) {
        expect(summary?.inputToRender).toEqual({ p50: 10, p95: 20, max: 20 });
        expect(formatLatencySummary(summary!)).not.toMatch(/content=|key=/i);
      }
    }
    expect(tracker.start(60)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/lib/input-latency.test.ts`

Expected: FAIL because `src/lib/input-latency.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure tracker**

Use one pending sample, a bounded batch array, nearest-rank percentile `ceil(percent * length) - 1`, and no timers. Timeouts are checked only by `start(now)` so the tracker creates no background work.

```ts
export interface LatencyStats { p50: number; p95: number; max: number }
export interface LatencySummary {
  count: number;
  inputToOutput: LatencyStats;
  outputToParsed: LatencyStats;
  inputToRender: LatencyStats;
}

export function makeInputLatencyTracker(
  options: { batchSize?: number; timeoutMs?: number } = {}
) {
  // Hold at most one pending sample and emit only complete batches.
}

export function formatLatencySummary(summary: LatencySummary): string {
  const f = (s: LatencyStats) => `p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms max=${s.max.toFixed(1)}ms`;
  return `samples=${summary.count} input_to_output(${f(summary.inputToOutput)}) output_to_parsed(${f(summary.outputToParsed)}) input_to_render(${f(summary.inputToRender)})`;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/lib/input-latency.test.ts`

Expected: all tests in the file pass.

- [ ] **Step 5: Commit the tracker**

```bash
git add src/lib/input-latency.ts src/lib/input-latency.test.ts
git commit -m "perf: add terminal input latency aggregation"
```

### Task 2: Deadline-Based Activity Timer

**Files:**
- Modify: `src/stores/activity-store.ts`
- Create: `src/stores/activity-store.test.ts`

**Interfaces:**
- Produces: `activityIdleDelay(now, lastActivityAt, idleMs?) => number | null`; `null` means the pane is now idle.
- Preserves: `markActivity(paneId)` and `clearActivity(paneId)` public APIs.

- [ ] **Step 1: Write failing deadline tests**

```ts
import { describe, expect, it } from "vitest";
import { ACTIVITY_IDLE_MS, activityIdleDelay } from "./activity-store";

describe("activityIdleDelay", () => {
  it("returns remaining time before the pane is idle", () => {
    expect(activityIdleDelay(1_200, 1_000)).toBe(ACTIVITY_IDLE_MS - 200);
  });

  it("returns null at and after the idle deadline", () => {
    expect(activityIdleDelay(1_800, 1_000)).toBeNull();
    expect(activityIdleDelay(2_000, 1_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/stores/activity-store.test.ts`

Expected: FAIL because `activityIdleDelay` is not exported.

- [ ] **Step 3: Implement a single timer per pane**

Store `{ lastActivityAt, timer }` per pane. `markActivity` updates the timestamp in-place when a timer exists. The timer callback calls `activityIdleDelay(Date.now(), state.lastActivityAt)` and either marks inactive or schedules itself for the remaining duration.

```ts
export function activityIdleDelay(
  now: number,
  lastActivityAt: number,
  idleMs = ACTIVITY_IDLE_MS
): number | null {
  const remaining = idleMs - (now - lastActivityAt);
  return remaining > 0 ? remaining : null;
}
```

- [ ] **Step 4: Run focused and related tests**

Run: `npx vitest run src/stores/activity-store.test.ts src/lib/workspace-agents.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the activity optimization**

```bash
git add src/stores/activity-store.ts src/stores/activity-store.test.ts
git commit -m "perf: avoid per-chunk activity timer churn"
```

### Task 3: Dedicated PTY Writer Thread

**Files:**
- Modify: `src-tauri/src/pty.rs`
- Modify: `src/lib/pty.ts`

**Interfaces:**
- Replaces `Session.writer` with `writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>`.
- Produces internal `writer_loop<W: Write>(pid, writer, rx) -> Result<(), String>` used by the production thread and Rust tests.
- Preserves all frontend `IPty` methods and Tauri command names.

- [ ] **Step 1: Add failing Rust tests for the writer loop**

Add a `#[cfg(test)]` module in `pty.rs` with a shared in-memory writer and a writer that returns an error. Verify ordered bytes, receiver-close exit, and error exit.

```rust
#[test]
fn writer_loop_preserves_message_order_and_exits_when_closed() {
    let output = Arc::new(std::sync::Mutex::new(Vec::new()));
    let writer = SharedWriter(output.clone());
    let (tx, rx) = mpsc::channel(4);
    tx.blocking_send(b"ab".to_vec()).unwrap();
    tx.blocking_send(b"cd".to_vec()).unwrap();
    drop(tx);
    assert!(writer_loop(7, writer, rx).is_ok());
    assert_eq!(&*output.lock().unwrap(), b"abcd");
}

#[test]
fn writer_loop_stops_on_write_error() {
    let (tx, rx) = mpsc::channel(1);
    tx.blocking_send(b"x".to_vec()).unwrap();
    drop(tx);
    assert!(writer_loop(8, FailingWriter, rx).is_err());
}
```

- [ ] **Step 2: Run the Rust test and verify RED**

Run: `cargo test pty::tests::writer_loop -- --nocapture` from `src-tauri/`.

Expected: FAIL because `writer_loop` does not exist.

- [ ] **Step 3: Implement the writer queue**

Add `WRITE_CHANNEL_CAP`, create the channel and named writer thread during `pty_spawn`, move the writer into the thread, and save the sender on `Session`. `pty_write` awaits only `writer_tx.send(data.into_bytes())` and reports a closed queue as an error. Remove successful per-write DEBUG logging; keep slow enqueue WARN and error logs.

```rust
fn writer_loop<W: std::io::Write>(
    pid: u32,
    mut writer: W,
    mut rx: mpsc::Receiver<Vec<u8>>,
) -> Result<(), String> {
    while let Some(data) = rx.blocking_recv() {
        writer.write_all(&data).map_err(|e| {
            format!("pty writer pid={pid}: {e}")
        })?;
    }
    Ok(())
}
```

In `src/lib/pty.ts`, delete the successful `logger.trace` write message. Keep RTT measurement so writes slower than `SLOW_MS` still emit WARN.

- [ ] **Step 4: Run Rust unit tests and check**

Run: `cargo test pty::tests -- --nocapture` and `cargo check` from `src-tauri/`.

Expected: tests pass and `cargo check` exits 0.

- [ ] **Step 5: Commit both PTY layers**

```bash
git add src-tauri/src/pty.rs src/lib/pty.ts
git commit -m "perf: queue pty writes on dedicated workers"
```

### Task 4: Integrate Latency Metrics and Remove Hot TRACE Logs

**Files:**
- Modify: `src/lib/terminal-manager.ts`
- Modify: `src/lib/pty.ts`
- Modify: `src-tauri/src/pty.rs`

**Interfaces:**
- Consumes `makeInputLatencyTracker`, `formatLatencySummary`, and `getVerbose`.
- Keeps all public terminal-manager APIs unchanged.

- [ ] **Step 1: Add a failing integration-oriented tracker test**

Extend `input-latency.test.ts` to verify render-before-output is ignored and parse/render calls after `reset()` do nothing. This specifies the ordering required by terminal-manager before wiring it.

```ts
it("ignores render events until PTY output arrives and resets pending work", () => {
  const tracker = makeInputLatencyTracker({ batchSize: 1, timeoutMs: 100 });
  tracker.start(0);
  expect(tracker.markRendered(2)).toBeNull();
  tracker.reset();
  tracker.markOutput(3);
  tracker.markParsed(4);
  expect(tracker.markRendered(5)).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/lib/input-latency.test.ts`

Expected: the new ordering assertion fails until the tracker handles the case.

- [ ] **Step 3: Complete tracker ordering behavior and wire terminal-manager**

Create one tracker per `Session`. When verbose is enabled, call `start(performance.now())` immediately inside `term.onData`; mark output before `term.write`; pass a write callback that marks parsed; subscribe to `term.onRender` and emit one aggregate DEBUG message when a batch completes.

Remove these hot-path messages:

- frontend input TRACE in `terminal-manager.ts`;
- frontend successful read TRACE in `pty.ts`;
- Rust successful read TRACE in `pty.rs`.

Keep the 200-read heartbeat and all slow/error messages.

- [ ] **Step 4: Run TypeScript tests and build**

Run: `npx vitest run src/lib/input-latency.test.ts src/lib/input-line.test.ts` and `npm run build`.

Expected: tests and production build pass.

- [ ] **Step 5: Commit telemetry integration**

```bash
git add src/lib/input-latency.ts src/lib/input-latency.test.ts src/lib/terminal-manager.ts src/lib/pty.ts src-tauri/src/pty.rs
git commit -m "perf: aggregate terminal latency off the hot log path"
```

### Task 5: Measure and Validate the Viewport Hook

**Files:**
- Modify conditionally: `src/lib/terminal-manager.ts`
- Document results: `docs/superpowers/specs/2026-07-15-terminal-input-latency-design.md`

**Interfaces:**
- No new public interface.
- Keeps explicit `syncXtermViewport` calls in attach, fit, wheel, and restore paths.

- [ ] **Step 1: Build and collect a baseline with the existing hook**

Run `npm run tauri:dev`, enable Settings -> Advanced -> Verbose debug logging, and use a fresh `cat` session. Enter at least 100 characters and record the aggregate p50/p95/max line for `input_to_render`. Also exercise zsh, tmux/vim, IME, paste, scrollback, and tab re-parenting.

- [ ] **Step 2: Remove only the per-write viewport listener**

Delete:

```ts
term.onWriteParsed(() => {
  if (s) syncXtermViewport(s);
});
```

Do not remove explicit synchronization elsewhere.

- [ ] **Step 3: Rebuild, repeat the same sample, and inspect scrolling**

Use the same viewport size and workload. Keep the deletion only if input latency improves repeatably or avoids measurable work and all scrolling checks pass. Restore the listener if any documented scroll behavior regresses.

- [ ] **Step 4: Record measured before/after evidence in the design document**

Add a dated `## 实测结果` section with environment, build type, sample count, before and after p50/p95/max, and whether the viewport listener remained removed.

- [ ] **Step 5: Commit the verified viewport decision**

```bash
git add src/lib/terminal-manager.ts docs/superpowers/specs/2026-07-15-terminal-input-latency-design.md
git commit -m "perf: avoid redundant xterm viewport work"
```

### Task 6: Full Verification and Completion Audit

**Files:**
- Verify all files changed by Tasks 1-5.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Run all frontend tests**

Run: `npm test`

Expected: all Vitest files and tests pass with zero failures.

- [ ] **Step 2: Run frontend type-check and production build**

Run: `npx tsc --noEmit` and `npm run build`.

Expected: both commands exit 0.

- [ ] **Step 3: Run all Rust tests and checks**

Run: `cargo test` and `cargo check` from `src-tauri/`.

Expected: all tests pass and both commands exit 0.

- [ ] **Step 4: Inspect the final diff and hot paths**

Run `git diff HEAD~5 --check`, inspect every changed hunk, and search for remaining per-key/per-read TRACE logs and direct blocking PTY calls inside async commands.

- [ ] **Step 5: Run the GUI acceptance matrix once more**

Verify zsh typing, `cat`, tmux/vim, coding-agent TUI, CJK IME, paste, high output, scrollback, tab/workspace switching, pane close, and application close.

- [ ] **Step 6: Complete only with current evidence**

Compare the final worktree against every goal and invariant in the design spec. Do not claim the latency objective from unit tests alone; include the recorded runtime metrics and state any WebKit frame floor visible in the measurements.

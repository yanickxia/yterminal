// First-party bridge to the native pty commands in src-tauri/src/pty.rs.
// Replaces the upstream `tauri-pty` npm package — same `spawn()` shape so
// `terminal-manager` doesn't need to know the difference, but the underlying
// pid is the real OS child pid (queryable by `process_cwd`) instead of an
// internal session counter.

import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";

/** A round-trip to a pty command slower than this is logged at WARN. */
const SLOW_MS = 250;

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface IPty {
  pid: number | undefined;
  cols: number;
  rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: Uint8Array) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
}

class Emitter<T> {
  private listeners: Array<(value: T) => void> = [];
  fire(value: T) {
    for (const fn of this.listeners.slice()) fn(value);
  }
  add(cb: (value: T) => void) {
    this.listeners.push(cb);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(cb);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }
}

class Pty implements IPty {
  pid: number | undefined;
  cols: number;
  rows: number;
  private dataEmitter = new Emitter<Uint8Array>();
  private exitEmitter = new Emitter<{ exitCode: number }>();
  private ready: Promise<void>;
  private exited = false;

  constructor(file: string, args: string[], opt: SpawnOptions) {
    this.cols = opt.cols ?? 80;
    this.rows = opt.rows ?? 24;
    logger.info(
      "pty",
      `spawn requested file=${file} args=${JSON.stringify(args)} cols=${this.cols} rows=${this.rows} cwd=${opt.cwd ?? "<default>"}`
    );
    const t0 = performance.now();
    this.ready = invoke<number>("pty_spawn", {
      file,
      args,
      cols: this.cols,
      rows: this.rows,
      cwd: opt.cwd ?? null,
      env: opt.env ?? {},
    }).then((pid) => {
      this.pid = pid;
      logger.info(
        "pty",
        `spawned pid=${pid} in ${Math.round(performance.now() - t0)}ms`
      );
      this.readLoop();
      this.waitForExit();
    });
  }

  write(data: string) {
    this.ready.then(() => {
      const t0 = performance.now();
      invoke("pty_write", { pid: this.pid, data })
        .then(() => {
          const ms = performance.now() - t0;
          // This is the keystroke path. If typing "doesn't register", the
          // write round-trip is where the delay shows up — log slow ones loudly.
          if (ms >= SLOW_MS) {
            logger.warn(
              "pty",
              `write SLOW pid=${this.pid} bytes=${data.length} rtt=${Math.round(ms)}ms`
            );
          }
        })
        .catch((e) => {
          logger.error("pty", `write error pid=${this.pid}: ${String(e)}`);
        });
    });
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.ready.then(() =>
      invoke("pty_resize", { pid: this.pid, cols, rows })
        .then(() =>
          logger.debug("pty", `resize pid=${this.pid} cols=${cols} rows=${rows}`)
        )
        .catch((e) => {
          logger.error("pty", `resize error pid=${this.pid}: ${String(e)}`);
        })
    );
  }

  kill() {
    this.ready.then(() =>
      invoke("pty_kill", { pid: this.pid })
        .then(() => logger.info("pty", `kill pid=${this.pid}`))
        .catch((e) => {
          // killing an already-exited child is fine; swallow
          if (typeof e === "string" && e.includes("Unavailable")) return;
          logger.error("pty", `kill error pid=${this.pid}: ${String(e)}`);
        })
    );
  }

  onData(cb: (data: Uint8Array) => void) {
    return this.dataEmitter.add(cb);
  }

  onExit(cb: (e: { exitCode: number }) => void) {
    return this.exitEmitter.add(cb);
  }

  // Long-poll loop: each pty_read blocks in Rust until the pty has data, then
  // resolves with a Uint8Array. EOF is reported as the literal string "EOF" in
  // the rejection — that's how tauri-plugin-pty signaled it and how the
  // exitstatus path discovers the child's gone.
  private async readLoop() {
    await this.ready;
    let reads = 0;
    let bytes = 0;
    try {
      for (;;) {
        const t0 = performance.now();
        const data = await invoke<ArrayBuffer | Uint8Array>("pty_read", {
          pid: this.pid,
        });
        const waited = performance.now() - t0;
        // Tauri's ipc::Response::new(buf) deserializes to a Uint8Array on
        // recent versions; older paths produce ArrayBuffer. Normalize.
        const bytesArr =
          data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        reads++;
        bytes += bytesArr.length;
        // A read that resolved after a long wait is normal (idle shell). We log
        // a periodic heartbeat instead of every read to avoid flooding, plus a
        // TRACE per read for full detail when verbose.
        logger.trace(
          "pty",
          `read pid=${this.pid} bytes=${bytesArr.length} waited=${Math.round(waited)}ms`
        );
        if (reads % 200 === 0) {
          logger.debug(
            "pty",
            `read heartbeat pid=${this.pid} reads=${reads} totalBytes=${bytes}`
          );
        }
        this.dataEmitter.fire(bytesArr);
      }
    } catch (e) {
      if (typeof e === "string" && e.includes("EOF")) {
        logger.info(
          "pty",
          `read loop EOF pid=${this.pid} after reads=${reads} totalBytes=${bytes}`
        );
        return;
      }
      logger.error("pty", `read loop error pid=${this.pid}: ${String(e)}`);
    }
  }

  private async waitForExit() {
    if (this.exited) return;
    try {
      const exitCode = await invoke<number>("pty_exitstatus", {
        pid: this.pid,
      });
      this.exited = true;
      logger.info("pty", `exit pid=${this.pid} code=${exitCode}`);
      this.exitEmitter.fire({ exitCode });
    } catch (e) {
      logger.error("pty", `exitstatus error pid=${this.pid}: ${String(e)}`);
    }
  }
}

export function spawn(
  file: string,
  args: string[] | string | undefined,
  opt: SpawnOptions = {},
): IPty {
  const argList = typeof args === "string" ? [args] : (args ?? []);
  return new Pty(file, argList, opt);
}

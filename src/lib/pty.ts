// First-party bridge to the native pty commands in src-tauri/src/pty.rs.
// Replaces the upstream `tauri-pty` npm package — same `spawn()` shape so
// `terminal-manager` doesn't need to know the difference, but the underlying
// pid is the real OS child pid (queryable by `process_cwd`) instead of an
// internal session counter.

import { invoke } from "@tauri-apps/api/core";

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
    this.ready = invoke<number>("pty_spawn", {
      file,
      args,
      cols: this.cols,
      rows: this.rows,
      cwd: opt.cwd ?? null,
      env: opt.env ?? {},
    }).then((pid) => {
      this.pid = pid;
      this.readLoop();
      this.waitForExit();
    });
  }

  write(data: string) {
    this.ready.then(() =>
      invoke("pty_write", { pid: this.pid, data }).catch((e) => {
        console.error("pty write error:", e);
      }),
    );
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.ready.then(() =>
      invoke("pty_resize", { pid: this.pid, cols, rows }).catch((e) => {
        console.error("pty resize error:", e);
      }),
    );
  }

  kill() {
    this.ready.then(() =>
      invoke("pty_kill", { pid: this.pid }).catch((e) => {
        // killing an already-exited child is fine; swallow
        if (typeof e === "string" && e.includes("Unavailable")) return;
        console.error("pty kill error:", e);
      }),
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
    try {
      for (;;) {
        const data = await invoke<ArrayBuffer | Uint8Array>("pty_read", {
          pid: this.pid,
        });
        // Tauri's ipc::Response::new(buf) deserializes to a Uint8Array on
        // recent versions; older paths produce ArrayBuffer. Normalize.
        const bytes =
          data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        this.dataEmitter.fire(bytes);
      }
    } catch (e) {
      if (typeof e === "string" && e.includes("EOF")) return;
      console.error("pty read error:", e);
    }
  }

  private async waitForExit() {
    if (this.exited) return;
    try {
      const exitCode = await invoke<number>("pty_exitstatus", {
        pid: this.pid,
      });
      this.exited = true;
      this.exitEmitter.fire({ exitCode });
    } catch (e) {
      console.error("pty exitstatus error:", e);
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

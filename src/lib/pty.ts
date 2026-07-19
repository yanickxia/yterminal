// PTY endpoint backed by the per-user yterminal-agent. The agent, rather than
// the Tauri GUI, owns the OS PTY so closing/reopening the window can attach to
// the same shell. Local and SSH hosts share the HostTransport protocol.

import {
  HostRequestError,
  localHost,
  type AgentEvent,
  type HostTransport,
} from "./host-transport";
import { logger } from "./logger";
import {
  flushWorkspaceOperations,
  subscribeHostTransport,
  transportForWorkspace,
} from "./workspace-sync";
import { acceptOutputSequence } from "./remote-sequence";

const SLOW_MS = 250;
const CHECKPOINT_CHUNK = 256 * 1024;

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  workspaceId?: string;
  paneId?: string;
  hostId?: string;
  sessionId?: string;
}

export interface IPty {
  pid: number | undefined;
  sessionId: string | undefined;
  cols: number;
  rows: number;
  readonly readOnly: boolean;
  readonly controlConnectionId: string | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  takeControl(): Promise<number>;
  kill(): void;
  detach(): void;
  checkpoint(data: string): void;
  flushCheckpoint(): Promise<void>;
  waitForParserIdle(timeoutMs?: number): Promise<void>;
  isParserIdle(): boolean;
  acknowledgeData(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  onReset(cb: () => void): { dispose(): void };
  onRemoteResize(cb: (size: { cols: number; rows: number }) => void): {
    dispose(): void;
  };
  onReadOnlyChange(cb: (readOnly: boolean) => void): { dispose(): void };
  onFreshSpawn(cb: () => void): { dispose(): void };
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
  get empty() {
    return this.listeners.length === 0;
  }
}

class AgentPty implements IPty {
  pid: number | undefined;
  sessionId: string | undefined;
  cols: number;
  rows: number;
  readOnly = false;
  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly exitEmitter = new Emitter<{ exitCode: number }>();
  private readonly resetEmitter = new Emitter<void>();
  private readonly resizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private readonly readOnlyEmitter = new Emitter<boolean>();
  private readonly freshSpawnEmitter = new Emitter<void>();
  private readonly pendingData: Uint8Array[] = [];
  private readonly parseEnds = new Map<Uint8Array, number>();
  private readonly parseIdleWaiters: Array<() => void> = [];
  private ready: Promise<void>;
  private host: HostTransport | undefined;
  private leaseEpoch = 0;
  private nextSeq = 0;
  private parsedSeq = 0;
  private resetPending = false;
  private recovering = false;
  private exitCode: number | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeControl: (() => void) | undefined;
  private unsubscribeTransport: (() => void) | undefined;
  private checkpointQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposeAction: "none" | "detach" | "kill" = "none";
  private freshSpawned = false;
  private readonly workspaceId: string;

  constructor(file: string, args: string[], opt: SpawnOptions) {
    const initialCols = opt.cols ?? 80;
    const initialRows = opt.rows ?? 24;
    const workspaceId = opt.workspaceId ?? "local-default";
    this.workspaceId = workspaceId;
    const paneId = opt.paneId ?? newPaneId();
    const hostId = opt.hostId ?? "local";
    this.readOnly = hostId !== "local";
    this.cols = initialCols;
    this.rows = initialRows;
    logger.info(
      "pty",
      `agent spawn requested pane=${paneId} cols=${this.cols} rows=${this.rows}`
    );
    const startedAt = performance.now();
    const connect = async (host: HostTransport, resuming: boolean) => {
      if (this.disposed) return;
      if (host === this.host && this.sessionId) return;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.unsubscribeControl?.();
      this.unsubscribeControl = undefined;
      this.host = host;
      this.unsubscribeControl = host.subscribeControl(workspaceId, (epoch) => {
        if (epoch === null) {
          // `hostId === "local"` only means this GUI reaches the agent through
          // its local socket; it does NOT mean this GUI must remain the
          // controller. A remote GUI may have deliberately forced a takeover.
          // Automatically forcing another acquire here made the host GUI steal
          // the lease straight back, so takeover only worked while that GUI
          // was closed. Stay read-only until this user explicitly takes control
          // (or a fresh GUI connection performs its initial acquire below).
          this.readOnly = true;
          this.readOnlyEmitter.fire(this.readOnly);
          return;
        }
        this.leaseEpoch = epoch;
        this.readOnly = false;
        this.readOnlyEmitter.fire(false);
      });
      // A hot-reloaded WebView may leave an older backend connection holding
      // the local lease. The local GUI is the same user/device, so force the
      // takeover; remote UI uses an explicit confirmation path later.
      // Structural operations must reach the owner first: a brand-new
      // workspace does not exist yet when its optimistic first pane mounts,
      // and a new split/tab must exist before the session can bind to it.
      await flushWorkspaceOperations(workspaceId);
      if (this.disposed) return;
      try {
        this.leaseEpoch = await host.ensureControl(
          workspaceId,
          hostId === "local"
        );
      } catch (error) {
        if (hostId === "local") throw error;
        this.readOnly = true;
        this.readOnlyEmitter.fire(true);
        if (error instanceof HostRequestError && error.code === "control_held") {
          logger.info(
            "pty",
            `remote workspace attached read-only workspace=${workspaceId}: ${error.message}`
          );
        } else {
          logger.warn(
            "pty",
            `remote workspace opened read-only workspace=${workspaceId}: ${String(error)}`
          );
        }
      }
      if (this.disposed) return;

      const candidateSessionId = this.sessionId ?? opt.sessionId;
      if (candidateSessionId) {
        try {
          if (resuming) await this.waitForParserIdle();
          await this.attach(
            host,
            candidateSessionId,
            initialCols,
            initialRows,
            resuming ? this.parsedSeq : null
          );
          await this.refreshSessionPid(host, candidateSessionId);
          if (this.disposed) return;
          logger.info(
            "pty",
            `agent reattached session=${this.sessionId} in ${Math.round(performance.now() - startedAt)}ms`
          );
          return;
        } catch (error) {
          this.clearSessionSubscription();
          this.sessionId = undefined;
          if (this.readOnly) throw error;
          logger.warn(
            "pty",
            `stored session unavailable pane=${paneId}; spawning a replacement: ${String(error)}`
          );
        }
      }
      if (this.readOnly) {
        throw new Error(`remote pane has no attachable session: ${paneId}`);
      }
      const response = await host.request({
        method: "spawn_session",
        params: {
          workspace_id: workspaceId,
          pane_id: paneId,
          lease_epoch: this.leaseEpoch,
          file: hostId === "local" ? file : "",
          args,
          cols: initialCols,
          rows: initialRows,
          cwd: opt.cwd ?? null,
          env: hostId === "local" ? (opt.env ?? {}) : safeRemoteEnv(opt.env),
        },
      });
      if (response.kind !== "session_spawned") {
        throw new Error(`unexpected spawn response: ${response.kind}`);
      }
      this.sessionId = response.data.session_id;
      this.pid = response.data.pid ?? undefined;
      if (this.disposed) {
        if (this.disposeAction === "kill") {
          await host
            .request({
              method: "kill_session",
              params: {
                session_id: this.sessionId,
                lease_epoch: this.leaseEpoch,
              },
            })
            .catch(() => {});
        } else if (this.disposeAction === "detach") {
          await host
            .request({
              method: "detach_session",
              params: { session_id: this.sessionId },
            })
            .catch(() => {});
        }
        return;
      }
      // A replacement session owns a fresh sequence space even though we keep
      // the old rendered snapshot above its new prompt. Reset protocol
      // accounting so the first checkpoint is valid for the new session; that
      // checkpoint will then fold the preserved snapshot into its ANSI state.
      this.nextSeq = 0;
      this.parsedSeq = 0;
      this.parseEnds.clear();
      this.resolveParserIdle();
      // This xterm may intentionally contain the legacy pre-agent snapshot.
      // A brand-new session starts at sequence zero, so preserve that buffer
      // and append the new session's replay. Existing sessions use `null`
      // above and receive an authoritative reset/checkpoint instead.
      await this.attach(host, this.sessionId, initialCols, initialRows, 0);
      this.freshSpawned = true;
      this.freshSpawnEmitter.fire(undefined);
      logger.info(
        "pty",
        `agent attached session=${this.sessionId} pid=${this.pid ?? "?"} in ${Math.round(performance.now() - startedAt)}ms`
      );
    };

    this.ready = (async () => {
      const host =
        transportForWorkspace(workspaceId) ??
        (hostId === "local" ? await localHost() : undefined);
      if (!host) throw new Error(`workspace host is offline: ${hostId}`);
      await connect(host, false);
    })().catch((error) => {
      logger.error("pty", `agent spawn failed pane=${paneId}: ${String(error)}`);
    });

    this.unsubscribeTransport = subscribeHostTransport(hostId, (host) => {
      if (this.disposed) return;
      if (!host) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.unsubscribeControl?.();
        this.unsubscribeControl = undefined;
        this.host = undefined;
        if (hostId !== "local") {
          this.readOnly = true;
          this.readOnlyEmitter.fire(true);
        }
        return;
      }
      if (host === this.host) return;
      this.ready = connect(host, true).catch((error) => {
        logger.warn(
          "pty",
          `agent reattach failed pane=${paneId}: ${String(error)}`
        );
      });
    });
  }

  get controlConnectionId(): string | undefined {
    return this.host?.connectionId;
  }

  write(data: string) {
    if (this.disposed) return;
    void this.ready.then(async () => {
      if (this.disposed || !this.host || !this.sessionId || this.readOnly) return;
      const startedAt = performance.now();
      await this.host.notify({
        method: "input",
        params: {
          session_id: this.sessionId,
          lease_epoch: this.leaseEpoch,
          bytes: Array.from(new TextEncoder().encode(data)),
        },
      });
      const elapsed = performance.now() - startedAt;
      if (elapsed >= SLOW_MS) {
        logger.warn(
          "pty",
          `agent write SLOW session=${this.sessionId} bytes=${data.length} enqueue=${Math.round(elapsed)}ms`
        );
      }
    }).catch((error) => logger.error("pty", `agent write failed: ${String(error)}`));
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    logger.info("term", `DEBUG local resize session=${this.sessionId} cols=${cols} rows=${rows}`);
    this.cols = cols;
    this.rows = rows;
    void this.ready
      .then(async () => {
        if (this.disposed || !this.host || !this.sessionId || this.readOnly) return;
        await this.host.notify({
          method: "resize",
          params: {
            session_id: this.sessionId,
            lease_epoch: this.leaseEpoch,
            cols,
            rows,
          },
        });
      })
      .catch((error) => logger.error("pty", `agent resize failed: ${String(error)}`));
  }

  async takeControl(): Promise<number> {
    await this.ready;
    if (this.disposed || !this.host) return this.leaseEpoch;
    const nextEpoch = await this.host.ensureControl(this.workspaceId, true);
    if (this.disposed) return nextEpoch;
    this.leaseEpoch = nextEpoch;
    this.readOnly = false;
    this.readOnlyEmitter.fire(false);
    logger.info(
      "pty",
      `take control acquired workspace=${this.workspaceId} lease=${nextEpoch}`
    );
    return nextEpoch;
  }

  kill() {
    if (this.disposed) return;
    this.disposeAction = "kill";
    this.disposed = true;
    this.clearSubscriptions();
    void this.ready
      .then(async () => {
        if (!this.host || !this.sessionId) return;
        await this.host.request({
          method: "kill_session",
          params: {
            session_id: this.sessionId,
            lease_epoch: this.leaseEpoch,
          },
        });
      })
      .catch((error) => logger.error("pty", `agent kill failed: ${String(error)}`));
  }

  detach() {
    if (this.disposed) return;
    this.disposeAction = "detach";
    this.disposed = true;
    this.clearSubscriptions();
    void this.ready
      .then(async () => {
        if (!this.host || !this.sessionId) return;
        await this.host.request({
          method: "detach_session",
          params: { session_id: this.sessionId },
        });
      })
      .catch((error) => logger.debug("pty", `agent detach failed: ${String(error)}`));
  }

  checkpoint(data: string): void {
    if (this.disposed) return;
    // The serialized xterm must include every byte represented by parsedSeq.
    // Callers normally await waitForParserIdle(); keep this guard as a final
    // defense against a replay/output callback racing the snapshot.
    if (this.parseEnds.size !== 0) return;
    const ansi = new TextEncoder().encode(data);
    const throughSeq = this.parsedSeq;
    this.checkpointQueue = this.checkpointQueue
      .then(async () => {
        await this.ready;
        if (this.disposed || !this.host || !this.sessionId || this.readOnly) return;
        await this.host.request({
          method: "checkpoint_begin",
          params: {
            session_id: this.sessionId,
            lease_epoch: this.leaseEpoch,
            through_seq: throughSeq,
            total_bytes: ansi.length,
          },
        });
        for (let offset = 0; offset < ansi.length; offset += CHECKPOINT_CHUNK) {
          await this.host.request({
            method: "checkpoint_chunk",
            params: {
              session_id: this.sessionId,
              bytes: Array.from(ansi.subarray(offset, offset + CHECKPOINT_CHUNK)),
            },
          });
        }
        await this.host.request({
          method: "checkpoint_end",
          params: { session_id: this.sessionId },
        });
      })
      .catch((error) => logger.warn("pty", `checkpoint failed: ${String(error)}`));
  }

  flushCheckpoint(): Promise<void> {
    return this.checkpointQueue;
  }

  acknowledgeData(data: Uint8Array): void {
    const end = this.parseEnds.get(data);
    if (end === undefined) return;
    this.parseEnds.delete(data);
    this.parsedSeq = Math.max(this.parsedSeq, end);
    this.resolveParserIdle();
  }

  onData(cb: (data: Uint8Array) => void) {
    const disposable = this.dataEmitter.add(cb);
    while (this.pendingData.length > 0) cb(this.pendingData.shift()!);
    return disposable;
  }

  onExit(cb: (e: { exitCode: number }) => void) {
    const disposable = this.exitEmitter.add(cb);
    if (this.exitCode !== undefined) cb({ exitCode: this.exitCode });
    return disposable;
  }

  onReset(cb: () => void) {
    const disposable = this.resetEmitter.add(cb);
    if (this.resetPending) {
      this.resetPending = false;
      cb();
    }
    return disposable;
  }

  onRemoteResize(cb: (size: { cols: number; rows: number }) => void) {
    return this.resizeEmitter.add(cb);
  }

  onReadOnlyChange(cb: (readOnly: boolean) => void) {
    const disposable = this.readOnlyEmitter.add(cb);
    cb(this.readOnly);
    return disposable;
  }

  onFreshSpawn(cb: () => void) {
    const disposable = this.freshSpawnEmitter.add(cb);
    if (this.freshSpawned) cb();
    return disposable;
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.event) {
      case "replay_begin":
        this.nextSeq = event.data.base_seq;
        if (event.data.reset) {
          this.parsedSeq = event.data.base_seq;
          this.parseEnds.clear();
          this.resolveParserIdle();
          if (this.resetEmitter.empty) this.resetPending = true;
          else this.resetEmitter.fire(undefined);
        }
        break;
      case "checkpoint_chunk": {
        const data = toBytes(event.data.bytes);
        // A checkpoint represents the screen through `base_seq`, but it is
        // safe to resume from that sequence only after every ANSI chunk has
        // actually passed through xterm's parser. Tracking every chunk keeps
        // waitForParserIdle() closed until the whole snapshot is applied.
        this.parseEnds.set(data, this.nextSeq);
        this.emitData(data);
        break;
      }
      case "output": {
        const result = acceptOutputSequence(
          this.nextSeq,
          event.data.start_seq,
          toBytes(event.data.bytes)
        );
        if (result.kind === "duplicate") return;
        if (result.kind === "gap") {
          logger.warn(
            "pty",
            `output gap session=${this.sessionId} expected=${result.expected} got=${result.actual}`
          );
          void this.recoverFromGap().catch((error) =>
            logger.warn("pty", `output recovery failed: ${String(error)}`)
          );
          return;
        }
        this.nextSeq = result.end;
        this.parseEnds.set(result.data, result.end);
        this.emitData(result.data);
        break;
      }
      case "replay_end":
        this.nextSeq = event.data.next_seq;
        break;
      case "size_changed": {
        const { cols, rows } = event.data;
        logger.info("term", `DEBUG size_changed session=${this.sessionId} cols=${cols} rows=${rows}`);
        if (!this.readOnly) {
          // The controller's xterm DOM is the size authority. Re-applying the
          // agent's broadcast here can race a local fit() and bounce the terminal
          // between the previous PTY size and the current container size.
          if (cols !== this.cols || rows !== this.rows) {
            logger.debug(
              "pty",
              `ignored controller size_changed session=${this.sessionId} remote=${cols}x${rows} local=${this.cols}x${this.rows}`
            );
            this.resize(this.cols, this.rows);
          }
          break;
        }
        this.cols = cols;
        this.rows = rows;
        this.resizeEmitter.fire({ cols: this.cols, rows: this.rows });
        break;
      }
      case "exited":
        this.exitCode = event.data.exit_code;
        this.exitEmitter.fire({ exitCode: event.data.exit_code });
        break;
      default:
        break;
    }
  }

  private emitData(data: Uint8Array): void {
    if (this.dataEmitter.empty) this.pendingData.push(data);
    else this.dataEmitter.fire(data);
  }

  private async recoverFromGap(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.ready;
      if (this.disposed || !this.host || !this.sessionId) return;
      // Stop delivering the old live stream, then wait until every byte that
      // was already queued into xterm has actually parsed. Reattaching from a
      // merely-received sequence would replay those bytes twice.
      this.clearSessionSubscription();
      await this.waitForParserIdle();
      if (this.disposed || !this.host || !this.sessionId) return;
      await this.attach(
        this.host,
        this.sessionId,
        this.cols,
        this.rows,
        this.parsedSeq
      );
    } finally {
      this.recovering = false;
    }
  }

  private async attach(
    host: HostTransport,
    sessionId: string,
    cols: number,
    rows: number,
    afterSeq: number | null = null
  ): Promise<void> {
    if (this.disposed) return;
    this.sessionId = sessionId;
    this.unsubscribe = host.subscribeSession(sessionId, (event) =>
      this.handleEvent(event)
    );
    await host.request({
      method: "attach_session",
      params: {
        session_id: sessionId,
        after_seq: afterSeq,
        cols,
        rows,
      },
    });
    if (this.disposed) this.clearSessionSubscription();
  }

  private async refreshSessionPid(
    host: HostTransport,
    sessionId: string
  ): Promise<void> {
    try {
      const response = await host.request({ method: "list_sessions" });
      if (response.kind !== "sessions") return;
      const session = response.data.sessions.find(
        (candidate) => candidate.sessionId === sessionId
      );
      this.pid = session?.pid ?? undefined;
    } catch (error) {
      logger.warn("pty", `session metadata refresh failed: ${String(error)}`);
    }
  }

  private clearSessionSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  waitForParserIdle(timeoutMs?: number): Promise<void> {
    if (this.parseEnds.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      this.parseIdleWaiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const index = this.parseIdleWaiters.indexOf(waiter);
          if (index >= 0) this.parseIdleWaiters.splice(index, 1);
          resolve();
        }, timeoutMs);
      }
    });
  }

  isParserIdle(): boolean {
    return this.parseEnds.size === 0;
  }

  private resolveParserIdle(): void {
    if (this.parseEnds.size !== 0) return;
    for (const resolve of this.parseIdleWaiters.splice(0)) resolve();
  }

  private clearSubscriptions(): void {
    this.clearSessionSubscription();
    this.unsubscribeControl?.();
    this.unsubscribeControl = undefined;
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
  }
}

function toBytes(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function newPaneId(): string {
  try {
    return `pane-${crypto.randomUUID()}`;
  } catch {
    return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function safeRemoteEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  if (!env) return {};
  const allowed = new Set(["TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "LC_ALL"]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key))
  );
}

export function spawn(
  file: string,
  args: string[] | string | undefined,
  opt: SpawnOptions = {}
): IPty {
  const argList = typeof args === "string" ? [args] : (args ?? []);
  return new AgentPty(file, argList, opt);
}

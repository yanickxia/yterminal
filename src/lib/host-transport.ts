import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  WorkspaceDocument,
  WorkspaceOperation,
} from "./workspace-protocol";

export interface AgentHello {
  selectedProtocol: number;
  agentVersion: string;
  deviceId: string;
  hostname: string;
  os: string;
  arch: string;
  capabilities: string[];
}

export interface RemoteProcessInfo {
  pid: number;
  ppid: number;
  argv: string[];
}

export interface RemoteGitFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

export interface RemoteGitStatus {
  isRepo: boolean;
  branch: string;
  root: string;
  files: RemoteGitFile[];
}

export interface RemoteSessionInfo {
  sessionId: string;
  paneId: string;
  workspaceId: string;
  state: "running" | "exited" | "lost";
  pid: number | null;
  cwd: string | null;
  cols: number;
  rows: number;
  headSeq: number;
  exitCode: number | null;
}

export type HostRequest =
  | { method: "ping" }
  | { method: "agent_status" }
  | { method: "set_draining"; params: { draining: boolean } }
  | { method: "shutdown_agent" }
  | { method: "list_workspaces" }
  | { method: "get_workspace"; params: { workspace_id: string } }
  | {
      method: "import_workspaces";
      params: { workspaces: WorkspaceDocument[] };
    }
  | {
      method: "create_workspace";
      params: { workspace: WorkspaceDocument };
    }
  | {
      method: "apply_workspace_op";
      params: {
        workspace_id: string;
        base_revision: number;
        lease_epoch: number;
        operation: WorkspaceOperation;
      };
    }
  | {
      method: "delete_workspace";
      params: { workspace_id: string; lease_epoch: number };
    }
  | { method: "get_cwd"; params: { session_id: string } }
  | { method: "home_dir" }
  | { method: "process_tree"; params: { session_id: string } }
  | {
      method: "resolve_agent_session";
      params: { kind: string; cwd: string; pid: number };
    }
  | { method: "git_status"; params: { dir: string } }
  | { method: "git_diff"; params: { dir: string; path: string } }
  | { method: "path_is_file"; params: { path: string } }
  | {
      method: "read_text_file";
      params: { path: string; offset: number; max_bytes: number };
    }
  | { method: "list_sessions" }
  | {
      method: "spawn_session";
      params: {
        workspace_id: string;
        pane_id: string;
        lease_epoch: number;
        file: string;
        args: string[];
        cols: number;
        rows: number;
        cwd: string | null;
        env: Record<string, string>;
      };
    }
  | {
      method: "attach_session";
      params: {
        session_id: string;
        after_seq: number | null;
        cols: number;
        rows: number;
      };
    }
  | { method: "detach_session"; params: { session_id: string } }
  | {
      method: "input";
      params: { session_id: string; lease_epoch: number; bytes: number[] };
    }
  | {
      method: "resize";
      params: {
        session_id: string;
        lease_epoch: number;
        cols: number;
        rows: number;
      };
    }
  | {
      method: "kill_session";
      params: { session_id: string; lease_epoch: number };
    }
  | {
      method: "acquire_control";
      params: { workspace_id: string; force: boolean };
    }
  | {
      method: "release_control";
      params: { workspace_id: string; lease_epoch: number };
    }
  | {
      method: "control_heartbeat";
      params: { workspace_id: string; lease_epoch: number };
    }
  | {
      method: "checkpoint_begin";
      params: {
        session_id: string;
        lease_epoch: number;
        through_seq: number;
        total_bytes: number;
      };
    }
  | {
      method: "checkpoint_chunk";
      params: { session_id: string; bytes: number[] };
    }
  | { method: "checkpoint_end"; params: { session_id: string } };

export type HostResponse =
  | { kind: "pong" }
  | { kind: "ack" }
  | {
      kind: "agent_status";
      data: {
        draining: boolean;
        running_sessions: number;
        database_bytes: number;
        journal_bytes: number;
        checkpoint_bytes: number;
        dropped_journal_chunks: number;
      };
    }
  | { kind: "workspaces"; data: { workspaces: WorkspaceDocument[] } }
  | { kind: "workspace"; data: { workspace: WorkspaceDocument } }
  | { kind: "cwd"; data: { cwd: string | null } }
  | { kind: "home_directory"; data: { path: string | null } }
  | { kind: "processes"; data: { processes: RemoteProcessInfo[] } }
  | { kind: "agent_session"; data: { session_id: string | null } }
  | { kind: "git_status"; data: { status: RemoteGitStatus } }
  | { kind: "text"; data: { text: string } }
  | { kind: "boolean"; data: { value: boolean } }
  | {
      kind: "file_chunk";
      data: {
        bytes: number[] | Uint8Array;
        total_bytes: number;
        eof: boolean;
      };
    }
  | {
      kind: "session_spawned";
      data: { session_id: string; pid: number | null };
    }
  | { kind: "sessions"; data: { sessions: RemoteSessionInfo[] } }
  | {
      kind: "control_acquired";
      data: { workspace_id: string; lease_epoch: number };
    };

export type AgentEvent =
  | {
      event: "workspace_changed";
      data: { workspace: WorkspaceDocument };
    }
  | { event: "workspace_removed"; data: { workspace_id: string } }
  | {
      event: "replay_begin";
      data: {
        session_id: string;
        reset: boolean;
        base_seq: number;
        head_seq: number;
      };
    }
  | {
      event: "checkpoint_chunk";
      data: { session_id: string; bytes: number[] | Uint8Array };
    }
  | {
      event: "output";
      data: {
        session_id: string;
        start_seq: number;
        bytes: number[] | Uint8Array;
      };
    }
  | {
      event: "replay_end";
      data: { session_id: string; next_seq: number };
    }
  | {
      event: "size_changed";
      data: { session_id: string; cols: number; rows: number };
    }
  | {
      event: "exited";
      data: { session_id: string; exit_code: number };
    }
  | {
      event: "control_changed";
      data: {
        workspace_id: string;
        controller_client_id: string | null;
        lease_epoch: number;
      };
    }
  | { event: "warning"; data: { code: string; message: string } };

type HostEvent =
  | { type: "agent"; payload: AgentEvent }
  | { type: "diagnostic"; payload: { message: string } }
  | { type: "disconnected"; payload: { message: string } };

export interface HostConnectOptions {
  kind: "local" | "ssh";
  name?: string;
  sshTarget?: string;
}

export class HostRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "HostRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface HostConnectionInfo {
  connectionId: string;
  hello: AgentHello;
}

type SessionListener = (event: AgentEvent) => void;
type StatusListener = (online: boolean, message?: string) => void;
type WorkspaceListener = (event: AgentEvent) => void;
type ControlListener = (leaseEpoch: number | null) => void;

export class HostTransport {
  readonly connectionId: string;
  readonly hello: AgentHello;
  private readonly channel: Channel<HostEvent>;
  private readonly sessionListeners = new Map<string, Set<SessionListener>>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly workspaceListeners = new Set<WorkspaceListener>();
  private readonly controlListeners = new Map<string, Set<ControlListener>>();
  private readonly leases = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private online = true;
  private notifyQueue: Promise<void> = Promise.resolve();

  private constructor(
    info: HostConnectionInfo,
    channel: Channel<HostEvent>
  ) {
    this.connectionId = info.connectionId;
    this.hello = info.hello;
    this.channel = channel;
    this.heartbeat = setInterval(() => {
      for (const [workspaceId, leaseEpoch] of this.leases) {
        void this.request({
          method: "control_heartbeat",
          params: { workspace_id: workspaceId, lease_epoch: leaseEpoch },
        }).catch((error) => {
          if (
            error instanceof HostRequestError &&
            [
              "stale_control_lease",
              "control_expired",
              "control_required",
            ].includes(error.code)
          ) {
            this.clearLease(workspaceId);
          }
        });
      }
    }, 5_000);
  }

  static async connect(options: HostConnectOptions): Promise<HostTransport> {
    const channel = new Channel<HostEvent>();
    let transport: HostTransport | undefined;
    // The Rust side may finish the handshake and report a disconnect before
    // `invoke(host_connect)` resolves. Buffer those early events instead of
    // silently losing them and leaving a dead connection marked online.
    const earlyEvents: HostEvent[] = [];
    channel.onmessage = (event) => {
      if (transport) transport.handleEvent(event);
      else earlyEvents.push(event);
    };
    const info = await invoke<HostConnectionInfo>("host_connect", {
      options: {
        kind: options.kind,
        name: options.name ?? "yterminal",
        sshTarget: options.sshTarget ?? null,
      },
      onEvent: channel,
    });
    transport = new HostTransport(info, channel);
    for (const event of earlyEvents) transport.handleEvent(event);
    return transport;
  }

  async request(request: HostRequest): Promise<HostResponse> {
    try {
      return await invoke<HostResponse>("host_request", {
        connectionId: this.connectionId,
        request,
      });
    } catch (error) {
      throw normalizeHostError(error);
    }
  }

  async notify(request: HostRequest): Promise<void> {
    const next = this.notifyQueue.then(() =>
      invoke<void>("host_notify", {
        connectionId: this.connectionId,
        request,
      })
    );
    this.notifyQueue = next.catch(() => {
      /* keep a failed send from poisoning later reconnect-era notifications */
    });
    return next;
  }

  async ensureControl(workspaceId: string, force = false): Promise<number> {
    const current = this.leases.get(workspaceId);
    if (current !== undefined && !force) return current;
    const response = await this.request({
      method: "acquire_control",
      params: { workspace_id: workspaceId, force },
    });
    if (response.kind !== "control_acquired") {
      throw new Error(`unexpected control response: ${response.kind}`);
    }
    this.leases.set(workspaceId, response.data.lease_epoch);
    for (const listener of this.controlListeners.get(workspaceId) ?? []) {
      listener(response.data.lease_epoch);
    }
    return response.data.lease_epoch;
  }

  subscribeSession(sessionId: string, listener: SessionListener): () => void {
    let listeners = this.sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.online);
    return () => this.statusListeners.delete(listener);
  }

  subscribeWorkspaces(listener: WorkspaceListener): () => void {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
  }

  subscribeControl(workspaceId: string, listener: ControlListener): () => void {
    let listeners = this.controlListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.controlListeners.set(workspaceId, listeners);
    }
    listeners.add(listener);
    const current = this.leases.get(workspaceId);
    if (current !== undefined) listener(current);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.controlListeners.delete(workspaceId);
    };
  }

  async disconnect(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    // Drop future Rust channel deliveries while retaining the Channel object
    // for the lifetime of the connection above.
    this.channel.onmessage = () => {};
    await invoke("host_disconnect", { connectionId: this.connectionId });
    this.setOnline(false, "disconnected");
  }

  private handleEvent(event: HostEvent): void {
    if (event.type === "disconnected") {
      this.setOnline(false, event.payload.message);
      return;
    }
    if (event.type === "diagnostic") {
      console.warn("SSH/agent diagnostic", event.payload.message);
      return;
    }
    const body = event.payload;
    if (
      body.event === "workspace_changed" ||
      body.event === "workspace_removed"
    ) {
      for (const listener of this.workspaceListeners) listener(body);
      return;
    }
    if (body.event === "control_changed") {
      const current = this.leases.get(body.data.workspace_id);
      if (
        current !== undefined &&
        (body.data.controller_client_id === null ||
          current !== body.data.lease_epoch)
      ) {
        this.clearLease(body.data.workspace_id);
      }
      return;
    }
    if (body.event === "warning") {
      console.warn(`agent ${body.data.code}: ${body.data.message}`);
      if (body.data.code === "slow_client_detached") {
        this.setOnline(false, body.data.message);
      }
      return;
    }
    const sessionId = body.data.session_id;
    for (const listener of this.sessionListeners.get(sessionId) ?? []) {
      listener(body);
    }
  }

  private setOnline(online: boolean, message?: string): void {
    if (this.online === online && !message) return;
    this.online = online;
    for (const listener of this.statusListeners) listener(online, message);
  }

  private clearLease(workspaceId: string): void {
    if (!this.leases.delete(workspaceId)) return;
    for (const listener of this.controlListeners.get(workspaceId) ?? []) {
      listener(null);
    }
  }
}

function normalizeHostError(error: unknown): HostRequestError {
  if (typeof error === "string" && error.trim().startsWith("{")) {
    try {
      return normalizeHostError(JSON.parse(error));
    } catch {
      /* fall through to the plain string */
    }
  }
  if (error && typeof error === "object") {
    const value = error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    if (typeof value.code === "string") {
      return new HostRequestError(
        value.code,
        typeof value.message === "string" ? value.message : value.code,
        value.retryable === true
      );
    }
  }
  return new HostRequestError("host_request_failed", String(error));
}

let localHostPromise: Promise<HostTransport> | undefined;
let localHostTransport: HostTransport | undefined;

export function localHost(): Promise<HostTransport> {
  if (!localHostPromise) {
    localHostPromise = HostTransport.connect({
      kind: "local",
      name: "Local GUI",
    })
      .then((transport) => {
        localHostTransport = transport;
        return transport;
      })
      .catch((error) => {
        localHostPromise = undefined;
        localHostTransport = undefined;
        throw error;
      });
  }
  return localHostPromise;
}

export function resetLocalHost(disconnected?: HostTransport): void {
  if (disconnected && localHostTransport !== disconnected) return;
  localHostPromise = undefined;
  localHostTransport = undefined;
}

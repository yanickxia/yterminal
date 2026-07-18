import {
  HostRequestError,
  HostTransport,
  localHost,
  resetLocalHost,
} from "./host-transport";
import { logger } from "./logger";
import {
  toWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceOperation,
} from "./workspace-protocol";
import type { Workspace } from "./types";

interface ProjectionSink {
  replaceHost(hostId: string, workspaces: WorkspaceDocument[]): void;
  upsert(hostId: string, workspace: WorkspaceDocument): void;
  remove(hostId: string, workspaceId: string): void;
}

let sink: ProjectionSink | undefined;
const LOCAL_HOST_ID = "local";
const hosts = new Map<string, HostTransport>();
const deviceHosts = new Map<string, string>();
const hostTransportListeners = new Map<
  string,
  Set<(transport: HostTransport | undefined) => void>
>();
const owners = new Map<string, string>();
let startPromise: Promise<void> | undefined;
const revisions = new Map<string, number>();
const documents = new Map<string, WorkspaceDocument>();
const queues = new Map<string, Promise<void>>();
// Agent-side runtime updates (OSC cwd/title/status) may arrive while a local
// structural operation is still optimistic. Remember the newest document,
// but do not project its pre-operation tree until that workspace queue drains.
const deferredProjectionHosts = new Map<string, string>();
let localReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let localReconnectAttempt = 0;

export function configureWorkspaceProjection(next: ProjectionSink): void {
  sink = next;
}

export function startWorkspaceSync(initial: Workspace[]): Promise<void> {
  if (startPromise) return startPromise;
  // Seed ownership for cached remote documents before SSH reconnects. This
  // keeps offline file/Git/process operations from ever falling back to the
  // local machine merely because the remote transport is not online yet.
  for (const workspace of initial) {
    const hostId = workspace.hostId ?? LOCAL_HOST_ID;
    owners.set(workspace.id, hostId);
    documents.set(revisionKey(hostId, workspace.id), toWorkspaceDocument(workspace));
  }
  startPromise = (async () => {
    const host = await localHost();
    hosts.set(LOCAL_HOST_ID, host);
    deviceHosts.set(host.hello.deviceId, LOCAL_HOST_ID);
    publishHostTransport(LOCAL_HOST_ID, host);
    subscribeHost(LOCAL_HOST_ID, host);
    const localInitial = initial.filter(
      (workspace) => (workspace.hostId ?? LOCAL_HOST_ID) === LOCAL_HOST_ID
    );
    const response = await host.request({
      method: "import_workspaces",
      params: { workspaces: localInitial.map(toWorkspaceDocument) },
    });
    if (response.kind !== "workspaces") {
      throw new Error(`unexpected workspace import response: ${response.kind}`);
    }
    for (const workspace of response.data.workspaces) {
      remember(LOCAL_HOST_ID, workspace);
    }
    sink?.replaceHost(LOCAL_HOST_ID, response.data.workspaces);
    try {
      localStorage.setItem("yterminal-workspaces.agent-migrated", "1");
    } catch {
      /* localStorage unavailable; the agent database is still authoritative */
    }
    logger.info(
      "workspace",
      `agent authority ready workspaces=${response.data.workspaces.length}`
    );
  })().catch((error) => {
    startPromise = undefined;
    logger.error("workspace", `agent sync failed: ${String(error)}`);
    throw error;
  });
  return startPromise;
}

export function queueCreateWorkspace(workspace: Workspace): void {
  // Startup migration imports the complete local snapshot after seeding; any
  // mutation before start is already represented in that snapshot.
  if (!startPromise) return;
  enqueue(workspace.id, async () => {
    const hostId = workspace.hostId ?? LOCAL_HOST_ID;
    owners.set(workspace.id, hostId);
    try {
      const connection = await requireHost(hostId);
      const response = await connection.request({
        method: "create_workspace",
        params: { workspace: toWorkspaceDocument(workspace) },
      });
      if (response.kind !== "workspace") {
        throw new Error(`unexpected create response: ${response.kind}`);
      }
      if (remember(hostId, response.data.workspace)) {
        sink?.upsert(hostId, response.data.workspace);
      }
    } catch (error) {
      owners.delete(workspace.id);
      sink?.remove(hostId, workspace.id);
      throw error;
    }
  });
}

export function queueWorkspaceOperation(
  workspaceId: string,
  operation: WorkspaceOperation
): void {
  if (!startPromise) return;
  enqueue(workspaceId, async () => {
    const hostId = owners.get(workspaceId) ?? LOCAL_HOST_ID;
    try {
      const connection = await requireHost(hostId);
      let revision = revisions.get(revisionKey(hostId, workspaceId));
      if (revision === undefined)
        revision = await refreshWorkspace(hostId, connection, workspaceId);
      const leaseEpoch = await connection.ensureControl(
        workspaceId,
        hostId === LOCAL_HOST_ID
      );
      const response = await connection.request({
        method: "apply_workspace_op",
        params: {
          workspace_id: workspaceId,
          base_revision: revision,
          lease_epoch: leaseEpoch,
          operation,
        },
      });
      acceptWorkspaceResponse(hostId, response);
    } catch (error) {
      if (
        !(error instanceof HostRequestError) ||
        error.code !== "workspace_revision_conflict"
      ) {
        rollbackWorkspace(hostId, workspaceId);
        throw error;
      }
      // A remote/controller event won the race. Refresh the authoritative
      // document and retry this typed operation exactly once.
      try {
        const connection = await requireHost(hostId);
        const revision = await refreshWorkspace(hostId, connection, workspaceId);
        const leaseEpoch = await connection.ensureControl(
          workspaceId,
          hostId === LOCAL_HOST_ID
        );
        const response = await connection.request({
          method: "apply_workspace_op",
          params: {
            workspace_id: workspaceId,
            base_revision: revision,
            lease_epoch: leaseEpoch,
            operation,
          },
        });
        acceptWorkspaceResponse(hostId, response);
      } catch (retryError) {
        rollbackWorkspace(hostId, workspaceId);
        throw retryError;
      }
    }
  });
}

export function queueDeleteWorkspace(workspaceId: string): void {
  if (!startPromise) return;
  enqueue(workspaceId, async () => {
    const hostId = owners.get(workspaceId) ?? LOCAL_HOST_ID;
    try {
      const connection = await requireHost(hostId);
      const leaseEpoch = await connection.ensureControl(
        workspaceId,
        hostId === LOCAL_HOST_ID
      );
      await connection.request({
        method: "delete_workspace",
        params: { workspace_id: workspaceId, lease_epoch: leaseEpoch },
      });
      revisions.delete(revisionKey(hostId, workspaceId));
      documents.delete(revisionKey(hostId, workspaceId));
      owners.delete(workspaceId);
      sink?.remove(hostId, workspaceId);
    } catch (error) {
      rollbackWorkspace(hostId, workspaceId);
      throw error;
    }
  });
}

function enqueue(workspaceId: string, task: () => Promise<void>): void {
  const previous = queues.get(workspaceId) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* a failed predecessor must not permanently poison this workspace */
    })
    .then(task)
    .catch((error) => {
      logger.error(
        "workspace",
        `agent mutation failed workspace=${workspaceId}: ${String(error)}`
      );
    });
  queues.set(workspaceId, next);
  void next.finally(() => {
    if (queues.get(workspaceId) !== next) return;
    queues.delete(workspaceId);
    const hostId = deferredProjectionHosts.get(workspaceId);
    if (!hostId) return;
    deferredProjectionHosts.delete(workspaceId);
    const document = documents.get(revisionKey(hostId, workspaceId));
    if (document) sink?.upsert(hostId, document);
  });
}

async function requireHost(hostId: string): Promise<HostTransport> {
  if (startPromise) await startPromise;
  const host = hosts.get(hostId);
  if (!host) throw new Error(`host is not connected: ${hostId}`);
  return host;
}

async function refreshWorkspace(
  hostId: string,
  connection: HostTransport,
  workspaceId: string
): Promise<number> {
  const response = await connection.request({
    method: "get_workspace",
    params: { workspace_id: workspaceId },
  });
  if (response.kind !== "workspace") {
    throw new Error(`unexpected get response: ${response.kind}`);
  }
  if (remember(hostId, response.data.workspace)) {
    sink?.upsert(hostId, response.data.workspace);
  }
  return response.data.workspace.revision;
}

function acceptWorkspaceResponse(
  hostId: string,
  response: Awaited<ReturnType<HostTransport["request"]>>
): void {
  if (response.kind !== "workspace") {
    throw new Error(`unexpected mutation response: ${response.kind}`);
  }
  if (remember(hostId, response.data.workspace)) {
    sink?.upsert(hostId, response.data.workspace);
  }
}

export async function connectRemoteWorkspaceHost(
  hostId: string,
  name: string,
  sshTarget: string
): Promise<HostTransport> {
  const existing = hosts.get(hostId);
  if (existing) return existing;
  const connection = await HostTransport.connect({
    kind: "ssh",
    name,
    sshTarget,
  });
  const duplicateHost = deviceHosts.get(connection.hello.deviceId);
  if (duplicateHost && duplicateHost !== hostId) {
    await connection.disconnect();
    throw new Error(
      `This device is already connected as ${duplicateHost} (device ${connection.hello.deviceId}).`
    );
  }
  hosts.set(hostId, connection);
  deviceHosts.set(connection.hello.deviceId, hostId);
  publishHostTransport(hostId, connection);
  subscribeHost(hostId, connection);
  try {
    const response = await connection.request({ method: "list_workspaces" });
    if (response.kind !== "workspaces") {
      throw new Error(`unexpected remote workspace response: ${response.kind}`);
    }
    for (const workspace of response.data.workspaces) remember(hostId, workspace);
    sink?.replaceHost(hostId, response.data.workspaces);
    return connection;
  } catch (error) {
    hosts.delete(hostId);
    if (deviceHosts.get(connection.hello.deviceId) === hostId) {
      deviceHosts.delete(connection.hello.deviceId);
    }
    publishHostTransport(hostId, undefined);
    await connection.disconnect().catch(() => {});
    throw error;
  }
}

export async function disconnectRemoteWorkspaceHost(hostId: string): Promise<void> {
  const connection = hosts.get(hostId);
  if (!connection || hostId === LOCAL_HOST_ID) return;
  hosts.delete(hostId);
  if (deviceHosts.get(connection.hello.deviceId) === hostId) {
    deviceHosts.delete(connection.hello.deviceId);
  }
  publishHostTransport(hostId, undefined);
  await connection.disconnect();
}

export async function disconnectAllWorkspaceHosts(): Promise<void> {
  const entries = Array.from(hosts.entries());
  hosts.clear();
  deviceHosts.clear();
  for (const [hostId] of entries) publishHostTransport(hostId, undefined);
  resetLocalHost();
  await Promise.all(entries.map(([, connection]) => connection.disconnect().catch(() => {})));
}

export async function forgetRemoteWorkspaceHost(hostId: string): Promise<void> {
  await disconnectRemoteWorkspaceHost(hostId);
  const workspaceIds = Array.from(owners.entries())
    .filter(([, owner]) => owner === hostId)
    .map(([workspaceId]) => workspaceId);
  for (const workspaceId of workspaceIds) {
    deferredProjectionHosts.delete(workspaceId);
    owners.delete(workspaceId);
    revisions.delete(revisionKey(hostId, workspaceId));
    documents.delete(revisionKey(hostId, workspaceId));
    sink?.remove(hostId, workspaceId);
  }
}

export function transportForWorkspace(workspaceId: string): HostTransport | undefined {
  return hosts.get(owners.get(workspaceId) ?? LOCAL_HOST_ID);
}

export function hostIdForWorkspace(workspaceId: string): string {
  return owners.get(workspaceId) ?? LOCAL_HOST_ID;
}

export function isRemoteWorkspace(workspaceId: string): boolean {
  return hostIdForWorkspace(workspaceId) !== LOCAL_HOST_ID;
}

/** Wait until optimistic structural mutations for this workspace reach its agent. */
export async function flushWorkspaceOperations(workspaceId: string): Promise<void> {
  await (queues.get(workspaceId) ?? Promise.resolve());
}

/** Observe future connection replacements for one host profile. */
export function subscribeHostTransport(
  hostId: string,
  listener: (transport: HostTransport | undefined) => void
): () => void {
  let listeners = hostTransportListeners.get(hostId);
  if (!listeners) {
    listeners = new Set();
    hostTransportListeners.set(hostId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) hostTransportListeners.delete(hostId);
  };
}

export async function takeWorkspaceControl(workspaceId: string): Promise<number> {
  const hostId = owners.get(workspaceId) ?? LOCAL_HOST_ID;
  const connection = await requireHost(hostId);
  return connection.ensureControl(workspaceId, true);
}

function subscribeHost(hostId: string, connection: HostTransport): void {
  connection.subscribeWorkspaces((event) => {
    if (event.event === "workspace_changed") {
      if (!remember(hostId, event.data.workspace)) return;
      if (queues.has(event.data.workspace.id)) {
        deferredProjectionHosts.set(event.data.workspace.id, hostId);
      } else {
        sink?.upsert(hostId, event.data.workspace);
      }
    } else if (event.event === "workspace_removed") {
      deferredProjectionHosts.delete(event.data.workspace_id);
      revisions.delete(revisionKey(hostId, event.data.workspace_id));
      documents.delete(revisionKey(hostId, event.data.workspace_id));
      owners.delete(event.data.workspace_id);
      sink?.remove(hostId, event.data.workspace_id);
    }
  });
  if (hostId === LOCAL_HOST_ID) {
    connection.subscribeStatus((online, message) => {
      if (online || hosts.get(LOCAL_HOST_ID) !== connection) return;
      logger.warn("workspace", `local agent disconnected: ${message ?? "closed"}`);
      hosts.delete(LOCAL_HOST_ID);
      if (deviceHosts.get(connection.hello.deviceId) === LOCAL_HOST_ID) {
        deviceHosts.delete(connection.hello.deviceId);
      }
      publishHostTransport(LOCAL_HOST_ID, undefined);
      resetLocalHost(connection);
      scheduleLocalReconnect();
    });
  }
}

function scheduleLocalReconnect(): void {
  if (localReconnectTimer) return;
  const delay = [1_000, 2_000, 5_000, 10_000, 30_000][
    Math.min(localReconnectAttempt, 4)
  ];
  localReconnectAttempt += 1;
  localReconnectTimer = setTimeout(() => {
    localReconnectTimer = undefined;
    void reconnectLocalHost();
  }, delay);
}

async function reconnectLocalHost(): Promise<void> {
  let connection: HostTransport | undefined;
  try {
    connection = await localHost();
    hosts.set(LOCAL_HOST_ID, connection);
    deviceHosts.set(connection.hello.deviceId, LOCAL_HOST_ID);
    publishHostTransport(LOCAL_HOST_ID, connection);
    subscribeHost(LOCAL_HOST_ID, connection);
    const response = await connection.request({ method: "list_workspaces" });
    if (response.kind !== "workspaces") {
      throw new Error(`unexpected local workspace response: ${response.kind}`);
    }
    for (const workspace of response.data.workspaces) {
      remember(LOCAL_HOST_ID, workspace);
    }
    sink?.replaceHost(LOCAL_HOST_ID, response.data.workspaces);
    localReconnectAttempt = 0;
    logger.info("workspace", "local agent reconnected");
  } catch (error) {
    await connection?.disconnect().catch(() => {});
    hosts.delete(LOCAL_HOST_ID);
    publishHostTransport(LOCAL_HOST_ID, undefined);
    resetLocalHost();
    logger.warn("workspace", `local agent reconnect failed: ${String(error)}`);
    scheduleLocalReconnect();
  }
}

function remember(hostId: string, workspace: WorkspaceDocument): boolean {
  const key = revisionKey(hostId, workspace.id);
  const currentRevision = revisions.get(key);
  // Request responses and daemon-side OSC updates are produced by different
  // async tasks. Their broadcasts can cross even though SQLite revisions are
  // monotonic, so never let an older document regress the projection.
  if (currentRevision !== undefined && workspace.revision < currentRevision) {
    return false;
  }
  owners.set(workspace.id, hostId);
  revisions.set(key, workspace.revision);
  documents.set(key, workspace);
  return true;
}

function rollbackWorkspace(hostId: string, workspaceId: string): void {
  const document = documents.get(revisionKey(hostId, workspaceId));
  if (document) sink?.upsert(hostId, document);
}

function revisionKey(hostId: string, workspaceId: string): string {
  return `${hostId}:${workspaceId}`;
}

function publishHostTransport(
  hostId: string,
  transport: HostTransport | undefined
): void {
  for (const listener of hostTransportListeners.get(hostId) ?? []) {
    listener(transport);
  }
}

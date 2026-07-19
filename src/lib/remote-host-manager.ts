import { useHostStore, type SshHostProfile } from "../stores/host-store";
import {
  connectRemoteWorkspaceHost,
  disconnectRemoteWorkspaceHost,
  forgetRemoteWorkspaceHost,
} from "./workspace-sync";
import { logger } from "./logger";

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();
const paused = new Set<string>();
const forgotten = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

export function startConfiguredRemoteHosts(): void {
  for (const profile of useHostStore.getState().profiles) {
    paused.delete(profile.id);
    forgotten.delete(profile.id);
    void connectProfile(profile);
  }
}

export function connectProfile(profile: SshHostProfile): Promise<void> {
  const existing = inFlight.get(profile.id);
  if (existing) return existing;
  const pending = connectProfileInner(profile).finally(() => {
    if (inFlight.get(profile.id) === pending) inFlight.delete(profile.id);
  });
  inFlight.set(profile.id, pending);
  return pending;
}

async function connectProfileInner(profile: SshHostProfile): Promise<void> {
  if (paused.has(profile.id)) return;
  if (!profile.sshTarget.trim()) {
    useHostStore.getState().setRuntime(profile.id, {
      status: "error",
      message: "SSH target is empty",
    });
    return;
  }
  clearRetry(profile.id);
  useHostStore.getState().setRuntime(profile.id, { status: "connecting" });
  try {
    const transport = await connectRemoteWorkspaceHost(
      profile.id,
      profile.name,
      profile.sshTarget
    );
    if (paused.has(profile.id)) {
      if (forgotten.has(profile.id)) {
        await forgetRemoteWorkspaceHost(profile.id);
      } else {
        await disconnectRemoteWorkspaceHost(profile.id);
      }
      return;
    }
    retryAttempts.delete(profile.id);
    useHostStore.getState().setRuntime(profile.id, {
      status: "online",
      deviceId: transport.hello.deviceId,
      hostname: transport.hello.hostname,
      os: transport.hello.os,
      agentVersion: transport.hello.agentVersion,
    });
    transport.subscribeStatus((online, message) => {
      if (online) return;
      useHostStore.getState().setRuntime(profile.id, {
        status: "offline",
        message,
      });
      void disconnectRemoteWorkspaceHost(profile.id).finally(() => {
        if (!paused.has(profile.id)) scheduleRetry(profile.id);
      });
    });
  } catch (error) {
    if (paused.has(profile.id)) return;
    const message = String(error);
    logger.warn(
      "remote",
      `SSH host connection failed id=${profile.id}: ${message}`
    );
    useHostStore.getState().setRuntime(profile.id, {
      status: "error",
      message,
    });
    if (isPermanentConnectionError(message)) paused.add(profile.id);
    if (!paused.has(profile.id)) scheduleRetry(profile.id);
  }
}

function isPermanentConnectionError(message: string): boolean {
  const value = message.toLowerCase();
  return [
    "already connected as",
    "permission denied",
    "host key verification failed",
    "remote host identification has changed",
    "offending key",
    "yterminal-agent: not found",
    "no such file or directory",
    "incompatible protocol",
    "ssh target is empty",
    "ssh target must not",
  ].some((marker) => value.includes(marker));
}

export async function removeRemoteHost(profileId: string): Promise<void> {
  paused.add(profileId);
  forgotten.add(profileId);
  clearRetry(profileId);
  await forgetRemoteWorkspaceHost(profileId);
  useHostStore.getState().removeHost(profileId);
}

export async function reconnectRemoteHost(profileId: string): Promise<void> {
  paused.delete(profileId);
  forgotten.delete(profileId);
  clearRetry(profileId);
  await disconnectRemoteWorkspaceHost(profileId);
  const profile = useHostStore
    .getState()
    .profiles.find((item) => item.id === profileId);
  if (profile) await connectProfile(profile);
}

export async function pauseRemoteHost(profileId: string): Promise<void> {
  paused.add(profileId);
  clearRetry(profileId);
  await disconnectRemoteWorkspaceHost(profileId);
  useHostStore.getState().setRuntime(profileId, {
    status: "offline",
    message: "Disconnected by user; remote processes are still running.",
  });
}

function scheduleRetry(profileId: string): void {
  if (paused.has(profileId)) return;
  if (retryTimers.has(profileId)) return;
  const attempt = (retryAttempts.get(profileId) ?? 0) + 1;
  retryAttempts.set(profileId, attempt);
  const delay = [1_000, 2_000, 5_000, 10_000, 30_000][
    Math.min(attempt - 1, 4)
  ];
  const timer = setTimeout(() => {
    retryTimers.delete(profileId);
    const profile = useHostStore
      .getState()
      .profiles.find((item) => item.id === profileId);
    if (profile) void connectProfile(profile);
  }, delay);
  retryTimers.set(profileId, timer);
}

function clearRetry(profileId: string): void {
  const timer = retryTimers.get(profileId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(profileId);
}

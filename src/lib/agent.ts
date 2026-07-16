// First-party bridge to the agent-introspection commands in
// src-tauri/src/main.rs. Thin wrappers over `invoke`, mirroring the shape of
// pty.ts / opener.ts so the IPC surface stays centralized and mockable in
// vitest. No logic here — classification and resume-command building live in
// the pure agent-detect.ts.

import { invoke } from "@tauri-apps/api/core";
import type { AgentKind } from "./types";
import type { ProcInfo } from "./agent-detect";
import {
  isRemoteWorkspace,
  transportForWorkspace,
} from "./workspace-sync";

/** Descendant process tree of a pane's shell pid (excludes the shell itself). */
export async function paneProcessTree(
  pid: number,
  workspaceId?: string,
  sessionId?: string
): Promise<ProcInfo[]> {
  if (workspaceId && sessionId) {
    try {
      const response = await transportForWorkspace(workspaceId)?.request({
        method: "process_tree",
        params: { session_id: sessionId },
      });
      if (response?.kind === "processes") return response.data.processes;
    } catch {
      if (isRemoteWorkspace(workspaceId)) return [];
    }
  }
  if (workspaceId && isRemoteWorkspace(workspaceId)) return [];
  try {
    return await invoke<ProcInfo[]>("pane_process_tree", { pid });
  } catch {
    return [];
  }
}

/**
 * Resolve the current on-disk session id for an agent in a given cwd. `pid` is
 * the detected agent process so the backend can pin the exact session file it
 * has open (multiple agents sharing one cwd each resolve to their own id);
 * pass 0 when unknown.
 */
export async function agentSessionId(
  kind: AgentKind,
  cwd: string,
  pid: number,
  workspaceId?: string
): Promise<string | null> {
  if (workspaceId) {
    try {
      const response = await transportForWorkspace(workspaceId)?.request({
        method: "resolve_agent_session",
        params: { kind, cwd, pid },
      });
      if (response?.kind === "agent_session") {
        const id = response.data.session_id;
        return id && id.trim() ? id : null;
      }
    } catch {
      if (isRemoteWorkspace(workspaceId)) return null;
    }
  }
  if (workspaceId && isRemoteWorkspace(workspaceId)) return null;
  try {
    const id = await invoke<string | null>("agent_session_id", {
      kind,
      cwd,
      pid,
    });
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}

/**
 * Read environment variables for a process by pid. Used to capture the env
 * config (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, etc.) the user's launcher
 * alias set on a coding-agent process, so we can replay it on resume without
 * knowing the alias name.
 */
export async function processEnv(
  pid: number,
  workspaceId?: string
): Promise<Record<string, string>> {
  // Environment values may contain API tokens. They are intentionally never
  // exposed by the SSH agent protocol; a remote client receives only the
  // public agent kind/command/session summary stored in the workspace.
  if (workspaceId && isRemoteWorkspace(workspaceId)) return {};
  try {
    const pairs = await invoke<Array<[string, string]>>("process_env", { pid });
    const env: Record<string, string> = {};
    for (const [k, v] of pairs) env[k] = v;
    return env;
  } catch {
    return {};
  }
}

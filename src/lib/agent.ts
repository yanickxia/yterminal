// First-party bridge to the agent-introspection commands in
// src-tauri/src/main.rs. Thin wrappers over `invoke`, mirroring the shape of
// pty.ts / opener.ts so the IPC surface stays centralized and mockable in
// vitest. No logic here — classification and resume-command building live in
// the pure agent-detect.ts.

import { invoke } from "@tauri-apps/api/core";
import type { AgentKind } from "./types";
import type { ProcInfo } from "./agent-detect";

/** Descendant process tree of a pane's shell pid (excludes the shell itself). */
export async function paneProcessTree(pid: number): Promise<ProcInfo[]> {
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
  pid: number
): Promise<string | null> {
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
export async function processEnv(pid: number): Promise<Record<string, string>> {
  try {
    const pairs = await invoke<Array<[string, string]>>("process_env", { pid });
    const env: Record<string, string> = {};
    for (const [k, v] of pairs) env[k] = v;
    return env;
  } catch {
    return {};
  }
}

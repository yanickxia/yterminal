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

/** Resolve the current on-disk session id for an agent in a given cwd. */
export async function agentSessionId(
  kind: AgentKind,
  cwd: string
): Promise<string | null> {
  try {
    const id = await invoke<string | null>("agent_session_id", { kind, cwd });
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}

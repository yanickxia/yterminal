// First-party bridge to the `install_claude_hooks` command in
// src-tauri/src/main.rs. Thin wrapper over `invoke`, mirroring git.ts so the
// IPC surface stays centralized and mockable in vitest.
//
// The command merges (or removes) our agent-status hooks into
// ~/.claude/settings.json. Those hooks emit an OSC 777 `notify;yt-agent;<state>`
// sequence through Claude Code's PTY on each lifecycle event; yterminal parses
// it per-pane (see agent-hook-osc.ts + the OSC 777 handler in terminal-manager)
// to drive the exact agent run-state instead of guessing from PTY activity.

import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";

/**
 * Install (enable=true) or remove (enable=false) the yterminal agent-status
 * hooks in ~/.claude/settings.json. Idempotent and preserves the user's own
 * hooks. Never throws — a failure is logged and swallowed so a boot-time call
 * can't take down the app.
 */
export async function installClaudeHooks(enable: boolean): Promise<void> {
  try {
    await invoke("install_claude_hooks", { enable });
  } catch (e) {
    logger.warn("agent-hooks", `install_claude_hooks failed: ${String(e)}`);
  }
}

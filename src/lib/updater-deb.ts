// First-party bridge to the deb self-update commands in src-tauri/src/main.rs.
// Thin wrappers over `invoke`, mirroring git.ts so the IPC surface stays
// centralized and mockable in vitest.
//
// Why this exists: the Tauri updater only replaces an AppImage on Linux. A
// deb-installed app must download + verify + `pkexec dpkg -i` its own .deb —
// these commands are that path. See updater-store.ts for the state machine.

import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";

/** Which install flavor is running. Drives which updater path the store takes. */
export type InstallKind = "appimage" | "deb" | "rpm" | "other";

export interface DebUpdateResult {
  /** true = pkexec ran dpkg to completion; caller prompts a restart. */
  installed: boolean;
  /** where the verified .deb landed (for manual install when pkexec absent). */
  downloadedPath: string;
}

/** Ask the backend which install flavor is running. Falls back to "other". */
export async function installKind(): Promise<InstallKind> {
  try {
    return (await invoke<InstallKind>("install_kind")) ?? "other";
  } catch (e) {
    logger.warn("updater", `install_kind failed: ${String(e)}`);
    return "other";
  }
}

/**
 * Download the .deb at `url`, verify its minisign `signature`, and install it
 * via pkexec. Rejects (without installing) on a bad signature. Propagates
 * errors so the store can surface them in the update dialog.
 */
export async function installDebUpdate(
  url: string,
  signature: string
): Promise<DebUpdateResult> {
  return invoke<DebUpdateResult>("install_deb_update", { url, signature });
}

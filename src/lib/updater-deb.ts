// First-party bridge to the deb self-update commands in src-tauri/src/main.rs.
// Thin wrappers over `invoke`, mirroring git.ts so the IPC surface stays
// centralized and mockable in vitest.
//
// Why this exists: the Tauri updater only replaces an AppImage on Linux. A
// deb-installed app must download + verify + `pkexec dpkg -i` its own .deb —
// these commands are that path. See updater-store.ts for the state machine.

import { invoke, Channel } from "@tauri-apps/api/core";
import { logger } from "./logger";

/** Which install flavor is running. Drives which updater path the store takes. */
export type InstallKind = "appimage" | "deb" | "rpm" | "other";

export interface DebUpdateResult {
  /** true = pkexec ran dpkg to completion; caller prompts a restart. */
  installed: boolean;
  /** where the verified .deb landed (for manual install when pkexec absent). */
  downloadedPath: string;
}

/** Download-progress event streamed from Rust while the .deb downloads. Shape
 *  mirrors `DebProgressEvent` in main.rs: internally tagged on `event`
 *  (lower-cased), fields flattened alongside the tag. */
export type DebProgressEvent =
  | { event: "started"; contentLength: number | null }
  | { event: "progress"; chunkLength: number }
  | { event: "finished" };

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
 * errors so the store can surface them in the update dialog. `onProgress`, when
 * given, receives download-progress events so the UI can render a progress bar.
 */
export async function installDebUpdate(
  url: string,
  signature: string,
  onProgress?: (e: DebProgressEvent) => void
): Promise<DebUpdateResult> {
  const channel = new Channel<DebProgressEvent>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<DebUpdateResult>("install_deb_update", {
    url,
    signature,
    onProgress: channel,
  });
}

/**
 * Fetch the updater manifest (latest.json) server-side via reqwest and return
 * its raw body text. The WebView can't fetch it directly: GitHub's
 * `releases/latest/download/latest.json` 302-redirects to a different-origin
 * CDN, and the CORS check on `tauri://localhost` blocks that redirect. reqwest
 * follows it fine, so the deb update path routes the fetch through Rust.
 */
export async function fetchLatestJson(url: string): Promise<string> {
  return invoke<string>("fetch_latest_json", { url });
}

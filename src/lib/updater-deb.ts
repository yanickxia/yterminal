// First-party bridge to the deb self-update commands in src-tauri/src/main.rs.
// Thin wrappers over `invoke`, mirroring git.ts so the IPC surface stays
// centralized and mockable in vitest.
//
// Why this exists: the Tauri updater only replaces an AppImage on Linux. A
// deb-installed app must download + verify its own .deb, then run `pkexec
// dpkg -i` only after user confirmation. These commands are that split path.

import { invoke, Channel } from "@tauri-apps/api/core";
import { logger } from "./logger";

/** Which install flavor is running. Drives which updater path the store takes. */
export type InstallKind = "appimage" | "deb" | "rpm" | "other";

export interface DebDownloadResult {
  /** Path of the downloaded package after signature verification. */
  downloadedPath: string;
}

export interface DebInstallResult {
  /** true = pkexec ran dpkg to completion. */
  installed: boolean;
  /** Where the verified .deb remains (for manual install when pkexec is absent). */
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
 * Download the .deb and verify its minisign signature without installing it.
 * This is safe to run silently in the background; pkexec is deferred until the
 * user explicitly chooses Install and restart.
 */
export async function downloadDebUpdate(
  url: string,
  signature: string,
  options: { githubMirror?: string; httpProxy?: string } = {},
  onProgress?: (e: DebProgressEvent) => void
): Promise<DebDownloadResult> {
  const channel = new Channel<DebProgressEvent>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<DebDownloadResult>("download_deb_update", {
    url,
    signature,
    githubMirror: options.githubMirror?.trim() || undefined,
    httpProxy: options.httpProxy?.trim() || undefined,
    onProgress: channel,
  });
}

/** Install the previously verified package via pkexec. */
export async function installDebUpdate(
  downloadedPath: string,
  signature: string
): Promise<DebInstallResult> {
  return invoke<DebInstallResult>("install_deb_update", {
    downloadedPath,
    signature,
  });
}

/**
 * Fetch the updater manifest (latest.json) server-side via reqwest and return
 * its raw body text. The WebView can't fetch it directly: GitHub's
 * `releases/latest/download/latest.json` 302-redirects to a different-origin
 * CDN, and the CORS check on `tauri://localhost` blocks that redirect. reqwest
 * follows it fine, so the deb update path routes the fetch through Rust.
 */
export async function fetchLatestJson(
  url: string,
  options: { githubMirror?: string; httpProxy?: string } = {}
): Promise<string> {
  return invoke<string>("fetch_latest_json", {
    url,
    githubMirror: options.githubMirror?.trim() || undefined,
    httpProxy: options.httpProxy?.trim() || undefined,
  });
}

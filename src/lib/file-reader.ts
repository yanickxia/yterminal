// First-party bridge to the read-only file-viewing commands in
// src-tauri/src/main.rs. Thin wrappers over `invoke`, mirroring opener.ts /
// agent.ts so the IPC surface stays centralized and mockable in vitest. All
// routing logic lives in the pure file-link-classify.ts.

import { invoke } from "@tauri-apps/api/core";

/** Decoded contents of a text file, as returned by `read_text_file`. */
export interface FileContents {
  text: string;
  bytes: number;
}

/** True when `path` exists and is a regular file. */
export async function pathIsFile(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_is_file", { path });
  } catch {
    return false;
  }
}

/**
 * Read a text file for the built-in viewer. Rejects (rather than returning
 * partial data) when the file is missing, too large, or binary — the caller
 * then falls back to an external OS open.
 */
export async function readTextFile(path: string): Promise<FileContents> {
  return invoke<FileContents>("read_text_file", { path });
}

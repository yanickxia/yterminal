// First-party bridge to the read-only file-viewing commands in
// src-tauri/src/main.rs. Thin wrappers over `invoke`, mirroring opener.ts /
// agent.ts so the IPC surface stays centralized and mockable in vitest. All
// routing logic lives in the pure file-link-classify.ts.

import { invoke } from "@tauri-apps/api/core";
import {
  isRemoteWorkspace,
  transportForWorkspace,
} from "./workspace-sync";

/** Decoded contents of a text file, as returned by `read_text_file`. */
export interface FileContents {
  text: string;
  bytes: number;
}

const REMOTE_FILE_CHUNK_BYTES = 256 * 1024;

/** True when `path` exists and is a regular file. */
export async function pathIsFile(
  path: string,
  workspaceId?: string
): Promise<boolean> {
  if (workspaceId) {
    try {
      const response = await transportForWorkspace(workspaceId)?.request({
        method: "path_is_file",
        params: { path },
      });
      if (response?.kind === "boolean") return response.data.value;
    } catch {
      if (isRemoteWorkspace(workspaceId)) return false;
    }
  }
  if (workspaceId && isRemoteWorkspace(workspaceId)) return false;
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
export async function readTextFile(
  path: string,
  workspaceId?: string
): Promise<FileContents> {
  if (workspaceId) {
    try {
      const transport = transportForWorkspace(workspaceId);
      if (transport) {
        const decoder = new TextDecoder();
        let text = "";
        let offset = 0;
        let totalBytes = 0;
        for (;;) {
          const response = await transport.request({
            method: "read_text_file",
            params: {
              path,
              offset,
              max_bytes: REMOTE_FILE_CHUNK_BYTES,
            },
          });
          if (response.kind !== "file_chunk") {
            throw new Error(`unexpected file response: ${response.kind}`);
          }
          const bytes =
            response.data.bytes instanceof Uint8Array
              ? response.data.bytes
              : new Uint8Array(response.data.bytes);
          totalBytes = response.data.total_bytes;
          text += decoder.decode(bytes, { stream: !response.data.eof });
          offset += bytes.length;
          if (response.data.eof) return { text, bytes: totalBytes };
          if (bytes.length === 0) throw new Error("remote file read made no progress");
        }
      }
    } catch (error) {
      if (isRemoteWorkspace(workspaceId)) throw error;
    }
  }
  if (workspaceId && isRemoteWorkspace(workspaceId)) {
    throw new Error("remote host is offline");
  }
  return invoke<FileContents>("read_text_file", { path });
}

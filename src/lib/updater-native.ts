// Runtime-configurable updater check. The stock JS plugin accepts an HTTP
// proxy but its endpoint is fixed in tauri.conf.json. Our Rust command builds
// the same updater resource with a user-selected GitHub mirror, then this
// wrapper returns the stock Update class so download/install remain first-party.

import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";

export const LATEST_JSON_URL =
  "https://github.com/yanickxia/yterminal/releases/latest/download/latest.json";

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

export interface UpdaterNetworkOptions {
  githubMirror?: string;
  httpProxy?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function checkUpdate(
  options: UpdaterNetworkOptions = {}
): Promise<Update | null> {
  const metadata = await invoke<UpdateMetadata | null>("check_update", {
    endpoint: LATEST_JSON_URL,
    githubMirror: nonEmpty(options.githubMirror),
    httpProxy: nonEmpty(options.httpProxy),
  });
  return metadata ? new Update(metadata) : null;
}


// First-party bridge to the read-only `git_status` command in
// src-tauri/src/main.rs. Thin wrapper over `invoke`, mirroring file-reader.ts
// so the IPC surface stays centralized and mockable in vitest.

import { invoke } from "@tauri-apps/api/core";

/** One changed file in a repo's working tree, as returned by `git_status`. */
export interface GitFile {
  /** Path relative to the repo root (the new path for renames). */
  path: string;
  /** Two-char porcelain XY status code (e.g. " M", "A ", "??", "R "). */
  status: string;
  insertions: number;
  deletions: number;
}

/** Git state for a directory. `isRepo` false => not inside a work tree. */
export interface GitStatus {
  isRepo: boolean;
  branch: string;
  root: string;
  files: GitFile[];
}

const EMPTY: GitStatus = { isRepo: false, branch: "", root: "", files: [] };

/**
 * Inspect `dir` as a git worktree, returning the current branch and changed
 * files. Never throws — a non-repo (or a git error) resolves to an empty,
 * non-repo status so the sidebar can render "not a repo" without try/catch at
 * the call site.
 */
export async function gitStatus(dir: string): Promise<GitStatus> {
  try {
    return await invoke<GitStatus>("git_status", { dir });
  } catch {
    return EMPTY;
  }
}

/**
 * Coarse change class for a porcelain XY code, used to pick a label/color.
 * Untracked ("??") is "added"; a delete in either column is "deleted"; a rename
 * is "renamed"; anything else with a set column is "modified".
 */
export function changeKind(
  status: string
): "added" | "modified" | "deleted" | "renamed" | "untracked" {
  if (status === "??") return "untracked";
  const [x, y] = [status[0] ?? " ", status[1] ?? " "];
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

/** Split a repo-relative path into `{ name, dir }` for two-line display. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  if (i === -1) return { name: path, dir: "" };
  return { name: path.slice(i + 1), dir: path.slice(0, i) };
}

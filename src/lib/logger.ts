// Frontend debug logger for yterminal.
//
// Mirrors the Rust-side logger (src-tauri/src/logger.rs): same level/source/
// message shape and the same ISO-8601 UTC timestamp format, so when the user
// exports logs the backend can merge both timelines into one chronological
// file. Every entry is also forwarded to the Rust `log_event` command, which
// appends it to the on-disk log — that's what makes the export complete even
// for events that happen purely in the webview (keystrokes, focus changes,
// xterm writes).
//
// Privacy: we log sizes, ids, durations and control metadata — never terminal
// content or user keystrokes themselves.

import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

const RING_CAPACITY = 5000;
const ring: string[] = [];

// verbose gates DEBUG/TRACE. Default ON until the user opts out (the hang is
// rare; we want maximum detail captured by default).
let verbose = true;

export function setVerbose(on: boolean) {
  verbose = on;
}
export function getVerbose(): boolean {
  return verbose;
}

/** ISO-8601 UTC with millisecond precision — matches the Rust formatter. */
function ts(): string {
  return new Date().toISOString(); // e.g. 2026-06-29T15:25:31.123Z
}

function pushRing(line: string) {
  ring.push(line);
  if (ring.length > RING_CAPACITY) ring.shift();
}

/**
 * Core log call. Builds the line, keeps it in the in-memory ring, echoes to the
 * devtools console, and forwards to the Rust backend so it lands in the shared
 * on-disk log. The backend forward is fire-and-forget: a logging failure must
 * never throw into the caller's path.
 */
export function log(level: LogLevel, source: string, message: string) {
  if (!verbose && (level === "DEBUG" || level === "TRACE")) return;
  const line = `${ts()} [${level}] [${source}] ${message}`;
  pushRing(line);
  // console mirror for live dev
  const c =
    level === "ERROR"
      ? console.error
      : level === "WARN"
      ? console.warn
      : console.log;
  c(line);
  // forward to the backend file (best effort; swallow if not in Tauri)
  invoke("log_event", { level, source, message }).catch(() => {
    /* non-Tauri or backend busy — the ring still has it */
  });
}

export const logger = {
  error: (source: string, message: string) => log("ERROR", source, message),
  warn: (source: string, message: string) => log("WARN", source, message),
  info: (source: string, message: string) => log("INFO", source, message),
  debug: (source: string, message: string) => log("DEBUG", source, message),
  trace: (source: string, message: string) => log("TRACE", source, message),
};

/** The in-memory tail, newest last. Used as a fallback if export needs it. */
export function ringSnapshot(): string[] {
  return ring.slice();
}

/**
 * Sync verbose with the backend and write an export file. Returns the absolute
 * path of the written export, or throws with a message the UI can show.
 */
export async function exportLogs(): Promise<string> {
  // make sure the backend's verbose flag matches the UI before exporting
  try {
    await invoke("set_log_verbose", { verbose });
  } catch {
    /* ignore */
  }
  return invoke<string>("export_logs");
}

/** Absolute path of the directory holding logs/exports (for display). */
export async function logDirPath(): Promise<string> {
  try {
    return await invoke<string>("log_dir_path");
  } catch {
    return "";
  }
}

/** Clear both the in-memory ring and the on-disk log. */
export async function clearLogs(): Promise<void> {
  ring.length = 0;
  try {
    await invoke("clear_logs");
  } catch {
    /* ignore */
  }
}

/**
 * Pull the current verbose flag from the backend (source of truth) and mirror
 * it locally. Call once at startup.
 */
export async function syncVerboseFromBackend(): Promise<void> {
  try {
    const v = await invoke<boolean>("get_log_verbose");
    verbose = v;
  } catch {
    /* keep the local default */
  }
}

let installed = false;
/**
 * Install global handlers that capture uncaught errors and unhandled promise
 * rejections into the log. These are exactly the kind of failures that can
 * leave the app in a wedged state without any visible message.
 */
export function installGlobalErrorLogging() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    logger.error(
      "window",
      `uncaught error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    let reason = "";
    try {
      reason =
        e.reason instanceof Error
          ? `${e.reason.name}: ${e.reason.message}`
          : String(e.reason);
    } catch {
      reason = "<unstringifiable reason>";
    }
    logger.error("window", `unhandled rejection: ${reason}`);
  });
  // Visibility/focus transitions help correlate "hang started after I switched
  // away" reports against the PTY timeline.
  document.addEventListener("visibilitychange", () => {
    logger.debug("window", `visibility=${document.visibilityState}`);
  });
}

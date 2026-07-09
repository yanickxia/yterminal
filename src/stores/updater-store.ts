// updater-store: state machine for the auto-update flow.
//
// States:
//   idle → checking → { up-to-date | available | error }
//   available → downloading → { ready | error }
//   ready → installing → (process relaunches, never returns)
//
// Only `lastCheckedAt` is persisted. Everything else is per-session.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  installKind,
  installDebUpdate,
  fetchLatestJson,
  type InstallKind,
} from "../lib/updater-deb";
import { logger } from "../lib/logger";

/** Updater manifest endpoint (mirrors plugins.updater.endpoints in the conf).
 *  Fetched server-side (Rust reqwest) — see fetchLatestJson — because the
 *  WebView's CORS check blocks GitHub's cross-origin 302 redirect. */
const LATEST_JSON_URL =
  "https://github.com/yanickxia/yterminal/releases/latest/download/latest.json";

export type UpdaterState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateManifest {
  version: string;
  notes: string | null;
  date: string | null;
}

interface UpdaterStore {
  state: UpdaterState;
  manifest: UpdateManifest | null;
  /** bytes downloaded / total, both null until the plugin reports them */
  progress: { downloaded: number; total: number | null } | null;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  /** install flavor, resolved lazily on first check; null until then. */
  installKind: InstallKind | null;
  /** deb path when pkexec was unavailable and the user must install by hand. */
  debManualPath: string | null;

  check: () => Promise<void>;
  startDownload: () => Promise<void>;
  relaunch: () => Promise<void>;
  dismiss: () => void;
}

// The check() call returns an `Update` instance that holds an opaque
// IPC handle; we keep it in module scope so startDownload() can use the
// same instance the plugin already validated. (It's not serializable,
// so it can't live in the persisted Zustand state.)
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;

export const useUpdaterStore = create<UpdaterStore>()(
  persist(
    (set, get) => ({
      state: "idle",
      manifest: null,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
      installKind: null,
      debManualPath: null,

      check: async () => {
        if (get().state === "checking" || get().state === "downloading") return;
        set({ state: "checking", errorMessage: null });
        // Resolve the install flavor once (cheap; cached after first success).
        if (get().installKind === null) {
          set({ installKind: await installKind() });
        }
        try {
          const update = await check();
          set({ lastCheckedAt: Date.now() });
          if (!update) {
            pendingUpdate = null;
            set({ state: "up-to-date", manifest: null });
            return;
          }
          pendingUpdate = update;
          set({
            state: "available",
            manifest: {
              version: update.version,
              notes: update.body ?? null,
              date: update.date ?? null,
            },
          });
        } catch (e: any) {
          pendingUpdate = null;
          set({
            state: "error",
            errorMessage: e?.message ?? String(e),
          });
        }
      },

      startDownload: async () => {
        if (get().state !== "available") return;

        // deb install: the Tauri updater can't replace a .deb, so download +
        // verify + pkexec install our own signed .deb read from latest.json.
        if (get().installKind === "deb") {
          set({ state: "downloading", progress: null, debManualPath: null });
          try {
            const body = await fetchLatestJson(LATEST_JSON_URL);
            const manifest = JSON.parse(body);
            const deb = manifest?.["linux-deb"];
            if (!deb?.url || !deb?.signature) {
              throw new Error(
                "This release has no signed .deb for in-app update. Install the new .deb from the Releases page."
              );
            }
            const result = await installDebUpdate(deb.url, deb.signature);
            if (result.installed) {
              set({ state: "ready" });
            } else {
              // pkexec unavailable: verified .deb left on disk for manual install.
              set({ state: "ready", debManualPath: result.downloadedPath });
            }
          } catch (e: any) {
            logger.warn("updater", `deb update failed: ${String(e)}`);
            set({ state: "error", errorMessage: e?.message ?? String(e) });
          }
          return;
        }

        if (!pendingUpdate) return;
        set({ state: "downloading", progress: { downloaded: 0, total: null } });
        try {
          let downloaded = 0;
          let total: number | null = null;
          await pendingUpdate.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
              set({ progress: { downloaded: 0, total } });
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              set({ progress: { downloaded, total } });
            } else if (event.event === "Finished") {
              set({ state: "ready" });
            }
          });
        } catch (e: any) {
          set({
            state: "error",
            errorMessage: e?.message ?? String(e),
          });
        }
      },

      relaunch: async () => {
        if (get().state !== "ready") return;
        set({ state: "installing" });
        try {
          await relaunch();
        } catch (e: any) {
          set({
            state: "error",
            errorMessage: e?.message ?? String(e),
          });
        }
      },

      dismiss: () => {
        // Keep state === 'available' so Settings can re-open the modal.
        // Only the modal-open flag is owned by the dialog component.
      },
    }),
    {
      name: "yterminal-updater",
      // only the timestamp deserves persistence; everything else is transient
      partialize: (s) => ({ lastCheckedAt: s.lastCheckedAt }),
    }
  )
);

/** Test-only helper. Resets store state AND the module-scope handle. */
export function __resetUpdaterForTests(): void {
  pendingUpdate = null;
  useUpdaterStore.setState({
    state: "idle",
    manifest: null,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    installKind: null,
    debManualPath: null,
  });
}

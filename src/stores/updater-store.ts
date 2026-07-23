// updater-store: state machine for background-capable updates.
//
// States:
//   idle → checking → { up-to-date | available | error }
//   available → downloading → { ready | error }
//   ready → installing → (process relaunches, never returns)
//
// Download and installation are intentionally separate. The update dialog can
// close as soon as a download starts; once verified bytes are ready, the app
// prompts for the user-confirmed install/restart step.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { arch as osArch } from "@tauri-apps/plugin-os";
import {
  installKind,
  downloadDebUpdate,
  installDebUpdate,
  fetchLatestJson,
  type InstallKind,
} from "../lib/updater-deb";
import {
  checkUpdate,
  LATEST_JSON_URL,
  type UpdaterNetworkOptions,
} from "../lib/updater-native";
import { useSettingsStore } from "./settings-store";
import { logger } from "../lib/logger";

function debEntryForHost(manifest: any): { url?: string; signature?: string } | null {
  const arch = osArch();
  if (arch === "aarch64") return manifest?.["linux-deb-aarch64"] ?? null;
  if (arch === "x86_64") {
    return manifest?.["linux-deb-x86_64"] ?? manifest?.["linux-deb"] ?? null;
  }
  return manifest?.[`linux-deb-${arch}`] ?? null;
}

function networkOptions(): UpdaterNetworkOptions {
  const settings = useSettingsStore.getState();
  return {
    githubMirror: settings.githubMirror,
    httpProxy: settings.updateHttpProxy,
  };
}

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

export interface CheckUpdateOptions {
  /** Honor the auto-download setting without showing the available dialog. */
  autoDownload?: boolean;
}

interface UpdaterStore {
  state: UpdaterState;
  manifest: UpdateManifest | null;
  /** bytes downloaded / total, both null until the downloader reports them */
  progress: { downloaded: number; total: number | null } | null;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  /** true while an automatic/manual download should stay out of the foreground */
  backgroundDownload: boolean;
  /** install flavor, resolved lazily on first check; null until then. */
  installKind: InstallKind | null;
  /** verified deb path, retained until the user confirms install. */
  debDownloadedPath: string | null;
  /** signature rechecked immediately before the downloaded deb is elevated. */
  debSignature: string | null;
  /** deb path shown when pkexec is unavailable and manual install is required. */
  debManualPath: string | null;

  check: (options?: CheckUpdateOptions) => Promise<void>;
  startDownload: () => Promise<void>;
  relaunch: () => Promise<void>;
  dismiss: () => void;
}

// The plugin Update holds opaque resource handles and downloaded bytes, so it
// must remain module-local rather than entering persisted Zustand state.
let pendingUpdate: Update | null = null;

export const useUpdaterStore = create<UpdaterStore>()(
  persist(
    (set, get) => ({
      state: "idle",
      manifest: null,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
      backgroundDownload: false,
      installKind: null,
      debDownloadedPath: null,
      debSignature: null,
      debManualPath: null,

      check: async (options = {}) => {
        if (["checking", "downloading", "ready", "installing"].includes(get().state)) {
          return;
        }
        set({
          state: "checking",
          errorMessage: null,
          progress: null,
          backgroundDownload: false,
          debDownloadedPath: null,
          debSignature: null,
          debManualPath: null,
        });
        if (get().installKind === null) {
          set({ installKind: await installKind() });
        }
        try {
          if (pendingUpdate) {
            await pendingUpdate.close().catch(() => undefined);
            pendingUpdate = null;
          }
          const update = await checkUpdate(networkOptions());
          set({ lastCheckedAt: Date.now() });
          if (!update) {
            set({ state: "up-to-date", manifest: null });
            return;
          }
          pendingUpdate = update;
          const shouldAutoDownload =
            options.autoDownload === true &&
            useSettingsStore.getState().autoDownloadUpdates;
          set({
            state: "available",
            backgroundDownload: shouldAutoDownload,
            manifest: {
              version: update.version,
              notes: update.body ?? null,
              date: update.date ?? null,
            },
          });
          if (shouldAutoDownload) await get().startDownload();
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
        if (get().installKind === "rpm") {
          set({
            state: "error",
            errorMessage:
              "In-app update isn't available for the .rpm build. Use your package manager or download the latest .rpm from Releases.",
          });
          return;
        }

        set({
          state: "downloading",
          backgroundDownload: true,
          progress: { downloaded: 0, total: null },
          errorMessage: null,
          debDownloadedPath: null,
          debSignature: null,
          debManualPath: null,
        });

        try {
          // Tauri cannot replace a package-manager-owned .deb. Download and
          // verify it here, but defer pkexec/dpkg until Install and restart.
          if (get().installKind === "deb") {
            const network = networkOptions();
            const body = await fetchLatestJson(LATEST_JSON_URL, network);
            const manifest = JSON.parse(body);
            const deb = debEntryForHost(manifest);
            if (!deb?.url || !deb?.signature) {
              throw new Error(
                "This release has no signed .deb for this architecture. Install the new .deb from the Releases page."
              );
            }
            let downloaded = 0;
            let total: number | null = null;
            const result = await downloadDebUpdate(
              deb.url,
              deb.signature,
              network,
              (event) => {
                if (event.event === "started") {
                  total = event.contentLength;
                  set({ progress: { downloaded: 0, total } });
                } else if (event.event === "progress") {
                  downloaded += event.chunkLength;
                  set({ progress: { downloaded, total } });
                }
              }
            );
            set({
              state: "ready",
              progress: total === null ? { downloaded, total } : { downloaded: total, total },
              debDownloadedPath: result.downloadedPath,
              debSignature: deb.signature,
            });
            return;
          }

          if (!pendingUpdate) throw new Error("Update handle expired. Check again.");
          let downloaded = 0;
          let total: number | null = null;
          await pendingUpdate.download((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
              set({ progress: { downloaded: 0, total } });
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              set({ progress: { downloaded, total } });
            }
          });
          // download() verifies the signature before it resolves. Do not mark
          // ready from the earlier Finished event.
          set({
            state: "ready",
            progress: total === null ? { downloaded, total } : { downloaded: total, total },
          });
        } catch (e: any) {
          logger.warn("updater", `update download failed: ${String(e)}`);
          set({ state: "error", errorMessage: e?.message ?? String(e) });
        }
      },

      relaunch: async () => {
        if (get().state !== "ready" || get().debManualPath) return;
        set({ state: "installing", errorMessage: null });
        try {
          if (get().installKind === "deb") {
            const downloadedPath = get().debDownloadedPath;
            const signature = get().debSignature;
            if (!downloadedPath || !signature) {
              throw new Error("Downloaded .deb is missing. Check again.");
            }
            const result = await installDebUpdate(downloadedPath, signature);
            if (!result.installed) {
              set({
                state: "ready",
                debManualPath: result.downloadedPath,
              });
              return;
            }
          } else {
            if (!pendingUpdate) throw new Error("Downloaded update is no longer available.");
            await pendingUpdate.install();
          }
          await relaunch();
        } catch (e: any) {
          set({ state: "error", errorMessage: e?.message ?? String(e) });
        }
      },

      dismiss: () => {
        // Dialog visibility is UI-local. Keep the update/download state alive.
      },
    }),
    {
      name: "yterminal-updater",
      partialize: (state) => ({ lastCheckedAt: state.lastCheckedAt }),
    }
  )
);

/** Test-only helper. Resets store state AND the module-scope resource handle. */
export function __resetUpdaterForTests(): void {
  pendingUpdate = null;
  useUpdaterStore.setState({
    state: "idle",
    manifest: null,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    backgroundDownload: false,
    installKind: null,
    debDownloadedPath: null,
    debSignature: null,
    debManualPath: null,
  });
}

# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app auto-update for yterminal that pulls new versions from GitHub Releases via the official `tauri-plugin-updater`, prompts the user, and installs after consent.

**Architecture:** Three layers — (1) Tauri Rust backend registers `tauri-plugin-updater` + `tauri-plugin-process`; (2) a Zustand store + `<UpdateDialog>` modal + Settings tab drive the UX; (3) the existing `release.yml` is extended to sign artifacts and publish a `latest.json` manifest as a release asset.

**Tech Stack:** Tauri 2, `@tauri-apps/plugin-updater` v2, `@tauri-apps/plugin-process` v2, Zustand, vitest, Node `gh` CLI in CI.

**Reference spec:** `docs/superpowers/specs/2026-06-29-auto-update-design.md` — read this first; every decision below is anchored there.

---

## Chunk 1: Tauri backend + config

### Task 1: Generate ed25519 signing keypair (HUMAN-IN-LOOP)

This task requires the maintainer to run a command and copy values into a config file + a GitHub Secret. An agent CAN run the CLI command, but the maintainer must manually add the GitHub Secret before any release is cut.

**Files:**
- Modify: `src-tauri/tauri.conf.json` (add `plugins.updater.pubkey`)
- Create: `~/.tauri/yterminal.key` (NEVER commit; lives only on maintainer's machine)
- GitHub repo secret: `TAURI_SIGNING_PRIVATE_KEY` (manually configured in repo settings)

- [ ] **Step 1: Generate keypair**

  ```bash
  mkdir -p ~/.tauri
  npx @tauri-apps/cli signer generate -w ~/.tauri/yterminal.key --no-password
  ```

  Expected: prints `Public key: dW50cnVzdGVkIGNvbW1lbnQ6...` (base64-encoded) and writes the private key file. Capture the **public key** string.

  Note: `--no-password` keeps it scriptable. If you'd rather set a passphrase, omit the flag and remember to add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to GitHub Secrets too.

- [ ] **Step 2: Add the GitHub Secret**

  This is manual. Go to `https://github.com/yanickxia/yterminal/settings/secrets/actions` → New repository secret:
  - Name: `TAURI_SIGNING_PRIVATE_KEY`
  - Value: full contents of `~/.tauri/yterminal.key`

  (No agent action — record completion as a checked box only after the maintainer confirms.)

- [ ] **Step 3: Commit (the public key — see Task 5 — references it)**

  No commit yet at this task; the pubkey will be wired in during Task 5.

---

### Task 2: Add Rust crate dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the two updater-related crates**

  Append under `[dependencies]` in `src-tauri/Cargo.toml`:

  ```toml
  tauri-plugin-updater = "2"
  tauri-plugin-process = "2"
  ```

- [ ] **Step 2: Verify it compiles**

  Run: `cargo check --manifest-path src-tauri/Cargo.toml`
  Expected: succeeds (may emit warnings about unused; ignore for now — the plugins are registered in Task 3).

- [ ] **Step 3: Commit**

  ```bash
  git add src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -m "deps: add tauri-plugin-updater and tauri-plugin-process"
  ```

---

### Task 3: Register the plugins in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs` (the existing `tauri::Builder::default()` chain near the bottom of the file)

- [ ] **Step 1: Add two `.plugin(...)` lines next to the existing ones**

  In the `fn main()` builder chain, the current code is:

  ```rust
  tauri::Builder::default()
      .plugin(tauri_plugin_os::init())
      .plugin(tauri_plugin_pty::init())
      .invoke_handler(tauri::generate_handler![ ... ])
  ```

  Change to:

  ```rust
  tauri::Builder::default()
      .plugin(tauri_plugin_os::init())
      .plugin(tauri_plugin_pty::init())
      .plugin(tauri_plugin_updater::Builder::new().build())
      .plugin(tauri_plugin_process::init())
      .invoke_handler(tauri::generate_handler![ ... ])
  ```

  Order matters only for plugins with init-time deps; updater/process have none.

- [ ] **Step 2: Build to verify**

  Run: `cargo build --manifest-path src-tauri/Cargo.toml`
  Expected: succeeds.

- [ ] **Step 3: Commit**

  ```bash
  git add src-tauri/src/main.rs
  git commit -m "feat(tauri): register updater and process plugins"
  ```

---

### Task 4: Grant the plugin permissions

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Append `"updater:default"` and `"process:default"` to the `permissions` array**

  Current:

  ```json
  "permissions": [
    "core:default",
    "os:default",
    "pty:default"
  ]
  ```

  Change to:

  ```json
  "permissions": [
    "core:default",
    "os:default",
    "pty:default",
    "updater:default",
    "process:default"
  ]
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src-tauri/capabilities/default.json
  git commit -m "feat(tauri): allow updater and process IPC from the renderer"
  ```

---

### Task 5: Wire the updater plugin config in `tauri.conf.json`

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add a top-level `plugins.updater` block**

  Insert a new `"plugins"` key as a peer of `"app"` and `"bundle"` (it does not exist yet). Use the **public key from Task 1, Step 1** as the `pubkey` value:

  ```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/yanickxia/yterminal/releases/latest/download/latest.json"
      ],
      "pubkey": "<paste the base64 public key from Task 1>"
    }
  }
  ```

  Do NOT add `"createUpdaterArtifacts": "v1Compatible"` — we want the v2 default (raw `.exe` on Windows, not `.nsis.zip`).

- [ ] **Step 2: Verify the config still parses**

  Run: `npx @tauri-apps/cli info`
  Expected: prints environment info without errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src-tauri/tauri.conf.json
  git commit -m "feat(tauri): configure updater endpoint and signing pubkey"
  ```

---

## Chunk 2: Frontend store, dialog, settings UI

### Task 6: Add npm dependencies and vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install runtime + test deps**

  ```bash
  npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
  npm install --save-dev vitest @vitest/ui
  ```

- [ ] **Step 2: Add a `test` script to `package.json`**

  Under `"scripts"`, add:

  ```json
  "test": "vitest run",
  "test:watch": "vitest"
  ```

- [ ] **Step 3: Create a minimal `vitest.config.ts` at repo root**

  ```ts
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    },
  });
  ```

- [ ] **Step 4: Smoke-test vitest**

  Run: `npm test`
  Expected: "No test files found" (a clean exit; we add tests next). If it errors with anything else, fix the config before continuing.

- [ ] **Step 5: Commit**

  ```bash
  git add package.json package-lock.json vitest.config.ts
  git commit -m "deps: add @tauri-apps/plugin-updater, plugin-process, vitest"
  ```

---

### Task 7: Updater store — state machine (TDD)

**Files:**
- Create: `src/stores/updater-store.ts`
- Create: `src/stores/updater-store.test.ts`

- [ ] **Step 1: Write failing test for `idle → checking → up-to-date`**

  Create `src/stores/updater-store.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  // Mock the Tauri plugin BEFORE importing the store.
  vi.mock("@tauri-apps/plugin-updater", () => ({
    check: vi.fn(),
  }));
  vi.mock("@tauri-apps/plugin-process", () => ({
    relaunch: vi.fn(),
  }));

  import { check } from "@tauri-apps/plugin-updater";
  import { useUpdaterStore } from "./updater-store";

  beforeEach(() => {
    vi.clearAllMocks();
    // reset store between tests
    useUpdaterStore.setState({
      state: "idle",
      manifest: null,
      progress: null,
      errorMessage: null,
      lastCheckedAt: null,
    });
  });

  describe("updater-store", () => {
    it("transitions idle → checking → up-to-date when no update is available", async () => {
      (check as any).mockResolvedValue(null); // plugin returns null when up-to-date
      const p = useUpdaterStore.getState().check();
      expect(useUpdaterStore.getState().state).toBe("checking");
      await p;
      expect(useUpdaterStore.getState().state).toBe("up-to-date");
      expect(useUpdaterStore.getState().lastCheckedAt).not.toBeNull();
    });
  });
  ```

- [ ] **Step 2: Run the test, confirm it fails**

  Run: `npm test`
  Expected: FAIL — `Cannot find module './updater-store'`.

- [ ] **Step 3: Implement the minimal store**

  Create `src/stores/updater-store.ts`:

  ```ts
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

    check: () => Promise<void>;
    startDownload: () => Promise<void>;
    relaunch: () => Promise<void>;
    dismiss: () => void;
  }

  // The check() call returns an `Update` object whose contentHandle is opaque;
  // we keep it on the side so startDownload() can use the same instance the
  // plugin already validated.
  let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;

  export const useUpdaterStore = create<UpdaterStore>()(
    persist(
      (set, get) => ({
        state: "idle",
        manifest: null,
        progress: null,
        errorMessage: null,
        lastCheckedAt: null,

        check: async () => {
          if (get().state === "checking" || get().state === "downloading") return;
          set({ state: "checking", errorMessage: null });
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
          if (get().state !== "available" || !pendingUpdate) return;
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
  ```

- [ ] **Step 4: Run the test, confirm it passes**

  Run: `npm test`
  Expected: PASS, 1 test.

- [ ] **Step 5: Add coverage for the remaining transitions**

  Append to `src/stores/updater-store.test.ts`:

  ```ts
  it("transitions idle → checking → available when an update is offered", async () => {
    (check as any).mockResolvedValue({
      version: "0.4.0",
      body: "release notes",
      date: "2026-06-29T07:30:00Z",
      downloadAndInstall: vi.fn(),
    });
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("available");
    expect(useUpdaterStore.getState().manifest?.version).toBe("0.4.0");
  });

  it("captures error message when check() throws", async () => {
    (check as any).mockRejectedValue(new Error("boom"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("error");
    expect(useUpdaterStore.getState().errorMessage).toBe("boom");
  });

  it("check() while already checking is a no-op", async () => {
    (check as any).mockImplementation(
      () => new Promise(() => { /* never resolve */ })
    );
    useUpdaterStore.getState().check(); // first call
    expect(useUpdaterStore.getState().state).toBe("checking");
    await useUpdaterStore.getState().check(); // second call should bail
    expect((check as any).mock.calls.length).toBe(1);
  });

  it("startDownload from idle is a no-op", async () => {
    await useUpdaterStore.getState().startDownload();
    expect(useUpdaterStore.getState().state).toBe("idle");
  });

  it("relaunch from idle is a no-op", async () => {
    const { relaunch: rel } = await import("@tauri-apps/plugin-process");
    await useUpdaterStore.getState().relaunch();
    expect((rel as any).mock.calls.length).toBe(0);
  });
  ```

- [ ] **Step 6: Run the tests, all pass**

  Run: `npm test`
  Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

  ```bash
  git add src/stores/updater-store.ts src/stores/updater-store.test.ts
  git commit -m "feat(updater): zustand store with state machine + tests"
  ```

---

### Task 8: Auto-check on launch

**Files:**
- Create: `src/lib/updater-auto-check.ts`
- Modify: `src/App.tsx` (call into the new module from the existing init `useEffect`)

- [ ] **Step 1: Create the helper module**

  Create `src/lib/updater-auto-check.ts`:

  ```ts
  // Schedule a single update check ~5s after launch. Failures are swallowed
  // (logged); the user is not notified at launch — Settings shows the error
  // for users who care.
  import { useUpdaterStore } from "../stores/updater-store";

  export function scheduleAutoCheck(): void {
    setTimeout(() => {
      useUpdaterStore
        .getState()
        .check()
        .catch((e) => console.warn("[updater] auto-check failed:", e));
    }, 5000);
  }
  ```

- [ ] **Step 2: Wire it into `App.tsx`**

  In `src/App.tsx`, add an import next to the others at the top:

  ```ts
  import { scheduleAutoCheck } from "./lib/updater-auto-check";
  ```

  Inside the existing `useEffect(() => { ... }, [])` body in `App.tsx`, after `setReady(true);` (around the line that already calls `detectSystemFonts().then(...)`), add:

  ```ts
  scheduleAutoCheck();
  ```

  This runs only once after the shell is initialized, so the auto-check never races with shell init.

- [ ] **Step 3: Smoke test the dev build**

  Run: `npm run tauri dev`
  Expected: app launches, shell appears, no console errors. After ~5 seconds you should see the updater do its work in the devtools console (it will hit the network; if `latest.json` doesn't exist yet — it won't until first signed release — the store flips to `error`, which is fine).
  Stop the dev server with Ctrl-C.

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/updater-auto-check.ts src/App.tsx
  git commit -m "feat(updater): launch-time check 5s after window mounts"
  ```

---

### Task 9: `<UpdateDialog>` component

**Files:**
- Create: `src/components/UpdateDialog.tsx`
- Modify: `src/styles.css` (only if needed — reuse `modal`/`modal-backdrop` from `SettingsPanel`)

- [ ] **Step 1: Create the component**

  Create `src/components/UpdateDialog.tsx`:

  ```tsx
  import { useUpdaterStore } from "../stores/updater-store";

  /**
   * Modal driven by `useUpdaterStore`. Visible whenever state is one of
   * { available, downloading, ready, error-after-available }. The "Later"
   * button hides this dialog locally but leaves store state alone, so the
   * Settings panel can re-open it.
   */
  export function UpdateDialog({
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  }) {
    const state = useUpdaterStore((s) => s.state);
    const manifest = useUpdaterStore((s) => s.manifest);
    const progress = useUpdaterStore((s) => s.progress);
    const errorMessage = useUpdaterStore((s) => s.errorMessage);
    const startDownload = useUpdaterStore((s) => s.startDownload);
    const doRelaunch = useUpdaterStore((s) => s.relaunch);
    const recheck = useUpdaterStore((s) => s.check);

    if (!open) return null;
    if (state !== "available" && state !== "downloading"
        && state !== "ready" && state !== "error") return null;

    return (
      <div className="modal-backdrop" onMouseDown={onClose}>
        <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>
              {state === "ready"
                ? "Update ready to install"
                : state === "error"
                ? "Update failed"
                : `Update available${manifest ? ` — v${manifest.version}` : ""}`}
            </span>
            <button className="icon-btn" title="Close" onClick={onClose}>
              ×
            </button>
          </div>

          <div className="modal-body">
            {state === "available" && manifest && (
              <>
                <p>A new version of yterminal is ready to download.</p>
                {manifest.notes && (
                  <pre
                    style={{
                      maxHeight: 240,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      fontSize: 12,
                    }}
                  >
                    {manifest.notes}
                  </pre>
                )}
                <div className="modal-footer">
                  <button onClick={onClose}>Later</button>
                  <button onClick={() => startDownload()}>Update now</button>
                </div>
              </>
            )}

            {state === "downloading" && (
              <>
                <p>Downloading…</p>
                <progress
                  value={progress?.downloaded ?? 0}
                  max={progress?.total ?? undefined}
                  style={{ width: "100%" }}
                />
                <p style={{ fontSize: 12, opacity: 0.7 }}>
                  {progress?.total
                    ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                    : `${formatBytes(progress?.downloaded ?? 0)}`}
                </p>
              </>
            )}

            {state === "ready" && (
              <>
                <p>Download complete. Restart yterminal to apply the update.</p>
                <div className="modal-footer">
                  <button onClick={onClose}>Restart later</button>
                  <button onClick={() => doRelaunch()}>Restart now</button>
                </div>
              </>
            )}

            {state === "error" && (
              <>
                <p>{errorMessage ?? "Unknown error."}</p>
                <div className="modal-footer">
                  <button onClick={onClose}>Close</button>
                  <button onClick={() => recheck()}>Retry</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  ```

  Re-use existing `.modal-backdrop`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.icon-btn` classes from `SettingsPanel`. If a class name doesn't exist, prefer adding minimal CSS to `src/styles.css` over inventing new component-local styles.

- [ ] **Step 2: Smoke-test typecheck**

  Run: `npm run build`
  Expected: TS compiles cleanly. (Don't worry about Vite output — we only care that types check.)

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/UpdateDialog.tsx
  git commit -m "feat(updater): UpdateDialog component"
  ```

---

### Task 10: Settings tab "Update"

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Add `update` to the `TabId` union and `TABS` array**

  At the top of `SettingsPanel.tsx`:

  ```ts
  type TabId = "appearance" | "terminal" | "update";

  const TABS: { id: TabId; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "terminal", label: "Terminal" },
    { id: "update", label: "Update" },
  ];
  ```

- [ ] **Step 2: Add a new tab body block**

  Find the existing `{tab === "terminal" && ( ... )}` block. Immediately AFTER it (still inside the `<div className="modal-body">`), add:

  ```tsx
  {tab === "update" && (
    <UpdateTab />
  )}
  ```

  Then, at the bottom of the file (or above `SettingsPanel`), define:

  ```tsx
  import { useUpdaterStore } from "../stores/updater-store";
  // (add this to the existing imports at the top)
  ```

  And add the component definition:

  ```tsx
  function UpdateTab() {
    const state = useUpdaterStore((s) => s.state);
    const manifest = useUpdaterStore((s) => s.manifest);
    const errorMessage = useUpdaterStore((s) => s.errorMessage);
    const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
    const recheck = useUpdaterStore((s) => s.check);

    const currentVersion = (window as any).__APP_VERSION__ ?? "dev";
    return (
      <div className="field">
        <label className="field-label">Current version</label>
        <div>{currentVersion}</div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => recheck()} disabled={state === "checking"}>
            {state === "checking"
              ? "Checking…"
              : state === "available" && manifest
              ? `View update v${manifest.version}`
              : state === "error"
              ? "Retry"
              : "Check for updates"}
          </button>
          {lastCheckedAt && (
            <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
              Last checked: {new Date(lastCheckedAt).toLocaleString()}
            </span>
          )}
        </div>
        {state === "error" && errorMessage && (
          <div style={{ marginTop: 8, color: "var(--err, #c66)" }}>
            {errorMessage}
          </div>
        )}
        {state === "up-to-date" && (
          <div style={{ marginTop: 8, opacity: 0.7 }}>You're up to date.</div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 3: Inject `__APP_VERSION__` from Vite**

  Modify `vite.config.ts` to expose the app version at build time. Add a `define` block:

  ```ts
  import { defineConfig } from "vite";
  import react from "@vitejs/plugin-react";
  import pkg from "./package.json" with { type: "json" };

  export default defineConfig({
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    // ...preserve any existing options
  });
  ```

  And add a small TS declaration so the `(window as any)` cast above isn't needed in the long run. Replace `(window as any).__APP_VERSION__ ?? "dev"` with `__APP_VERSION__`, and add to `src/vite-env.d.ts` (create it if missing):

  ```ts
  declare const __APP_VERSION__: string;
  ```

- [ ] **Step 4: Build + manual test**

  Run: `npm run tauri dev`
  Open Settings → click the new "Update" tab. The current version should match `package.json`. Click "Check for updates" — even if the network request fails (no `latest.json` published yet), the UI should not crash.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/SettingsPanel.tsx vite.config.ts src/vite-env.d.ts
  git commit -m "feat(updater): Settings 'Update' tab with manual check button"
  ```

---

### Task 11: Mount `<UpdateDialog>` in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add a local `updateDialogOpen` flag**

  In `App.tsx`, near the other `useState` calls (line ~30 in the current file), add:

  ```ts
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  ```

- [ ] **Step 2: Auto-open the dialog when the store enters `available`**

  Near the existing `useEffect`s, add:

  ```ts
  // Subscribe to store; show dialog when an update becomes available.
  useEffect(() => {
    return useUpdaterStore.subscribe((s, prev) => {
      if (s.state === "available" && prev.state !== "available") {
        setUpdateDialogOpen(true);
      }
    });
  }, []);
  ```

  Add the import next to the other store imports:

  ```ts
  import { useUpdaterStore } from "./stores/updater-store";
  import { UpdateDialog } from "./components/UpdateDialog";
  ```

- [ ] **Step 3: Render the dialog OUTSIDE the `!ready` gate**

  Find the `</div>` that closes the outer `<div className="app">` (last line of the JSX, around line 226). Just BEFORE that closing div, *outside* the `{!ready ? ... : ...}` ternary and outside the `{paletteOpen && ...}` block, add:

  ```tsx
  <UpdateDialog
    open={updateDialogOpen}
    onClose={() => setUpdateDialogOpen(false)}
  />
  ```

  This guarantees the dialog can render before the shell is ready (e.g. if the auto-check fires earlier than expected, or if a future change moves the auto-check before `setReady(true)`).

- [ ] **Step 4: Smoke test**

  Run: `npm run tauri dev`
  Confirm the app still renders normally and no console error fires. Stop with Ctrl-C.

- [ ] **Step 5: Commit**

  ```bash
  git add src/App.tsx
  git commit -m "feat(updater): mount UpdateDialog and auto-open on availability"
  ```

---

## Chunk 3: Release CI

### Task 12: `scripts/generate-latest-json.mjs` (TDD)

**Files:**
- Create: `scripts/generate-latest-json.mjs`
- Create: `scripts/generate-latest-json.test.mjs`

The script is small enough to test as a pure function; the side-effecting bits (`gh release view`, `fetch` for `.sig` contents) are passed in as injected dependencies so the test can stub them.

- [ ] **Step 1: Write the failing test**

  Create `scripts/generate-latest-json.test.mjs`:

  ```js
  import { describe, it, expect } from "vitest";
  import { buildManifest } from "./generate-latest-json.mjs";

  const fixtureRelease = {
    tagName: "v0.4.0",
    publishedAt: "2026-06-29T07:30:00Z",
    body: "release notes here",
    assets: [
      {
        name: "yterminal_universal.app.tar.gz",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_universal.app.tar.gz",
      },
      {
        name: "yterminal_universal.app.tar.gz.sig",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_universal.app.tar.gz.sig",
      },
      {
        name: "yterminal_0.4.0_x64-setup.exe",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_x64-setup.exe",
      },
      {
        name: "yterminal_0.4.0_x64-setup.exe.sig",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_x64-setup.exe.sig",
      },
      {
        name: "yterminal_0.4.0_amd64.AppImage",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.AppImage",
      },
      {
        name: "yterminal_0.4.0_amd64.AppImage.sig",
        url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.AppImage.sig",
      },
    ],
  };

  // map of "filename" → "fake .sig content"
  const fakeSigs = {
    "yterminal_universal.app.tar.gz.sig": "DARWIN_SIG",
    "yterminal_0.4.0_x64-setup.exe.sig": "WINDOWS_SIG",
    "yterminal_0.4.0_amd64.AppImage.sig": "LINUX_SIG",
  };

  const fetchSig = async (asset) => fakeSigs[asset.name];

  describe("buildManifest", () => {
    it("produces correct manifest shape for all platforms", async () => {
      const manifest = await buildManifest(fixtureRelease, fetchSig);
      expect(manifest.version).toBe("0.4.0");
      expect(manifest.notes).toBe("release notes here");
      expect(manifest.pub_date).toBe("2026-06-29T07:30:00Z");
      expect(manifest.platforms["darwin-universal"].signature).toBe("DARWIN_SIG");
      expect(manifest.platforms["darwin-x86_64"].signature).toBe("DARWIN_SIG");
      expect(manifest.platforms["darwin-aarch64"].signature).toBe("DARWIN_SIG");
      expect(manifest.platforms["windows-x86_64"].url).toMatch(/x64-setup\.exe$/);
      expect(manifest.platforms["linux-x86_64"].url).toMatch(/\.AppImage$/);
    });

    it("throws when a platform asset is missing", async () => {
      const broken = {
        ...fixtureRelease,
        assets: fixtureRelease.assets.filter(
          (a) => !a.name.includes("AppImage")
        ),
      };
      await expect(buildManifest(broken, fetchSig)).rejects.toThrow(/AppImage/);
    });

    it("throws when a sibling .sig is missing", async () => {
      const broken = {
        ...fixtureRelease,
        assets: fixtureRelease.assets.filter(
          (a) => a.name !== "yterminal_universal.app.tar.gz.sig"
        ),
      };
      await expect(buildManifest(broken, fetchSig)).rejects.toThrow(/\.sig/);
    });
  });
  ```

- [ ] **Step 2: Run the test, confirm it fails**

  Run: `npm test`
  Expected: FAIL — module not found.

- [ ] **Step 3: Implement `generate-latest-json.mjs`**

  Create `scripts/generate-latest-json.mjs`:

  ```js
  #!/usr/bin/env node
  // Build latest.json for the Tauri updater from a GitHub release's assets.
  //
  // Usage (in CI):
  //   TAG=v0.4.0 node scripts/generate-latest-json.mjs > latest.json
  //
  // The pure logic lives in `buildManifest` so it's unit-testable without
  // shelling out to gh / fetching the network.
  import { execFileSync } from "node:child_process";
  import { writeFileSync } from "node:fs";

  /**
   * Find a single asset by name predicate. Throws if 0 or 2+ match.
   */
  function findAsset(release, predicate, label) {
    const matches = release.assets.filter(predicate);
    if (matches.length === 0) {
      throw new Error(`No release asset matched ${label}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple release assets matched ${label}: ${matches
          .map((m) => m.name)
          .join(", ")}`
      );
    }
    return matches[0];
  }

  /**
   * Build the latest.json manifest. `fetchSig(asset)` resolves the asset's
   * `.sig` content as a string. Pure (no I/O of its own); delegates to
   * `fetchSig`.
   */
  export async function buildManifest(release, fetchSig) {
    const version = release.tagName.replace(/^v/, "");

    const darwinBundle = findAsset(
      release,
      (a) => a.name.endsWith(".app.tar.gz") && a.name.includes("universal"),
      "darwin universal .app.tar.gz"
    );
    const darwinSig = findAsset(
      release,
      (a) => a.name === darwinBundle.name + ".sig",
      "darwin .sig"
    );
    const darwinSigContent = await fetchSig(darwinSig);

    const windowsBundle = findAsset(
      release,
      (a) => a.name.endsWith("-setup.exe"),
      "windows -setup.exe"
    );
    const windowsSig = findAsset(
      release,
      (a) => a.name === windowsBundle.name + ".sig",
      "windows .sig"
    );
    const windowsSigContent = await fetchSig(windowsSig);

    const linuxBundle = findAsset(
      release,
      (a) => a.name.endsWith(".AppImage"),
      "linux .AppImage"
    );
    const linuxSig = findAsset(
      release,
      (a) => a.name === linuxBundle.name + ".sig",
      "linux .sig"
    );
    const linuxSigContent = await fetchSig(linuxSig);

    const darwinPlatform = {
      signature: darwinSigContent,
      url: darwinBundle.url,
    };

    return {
      version,
      notes: release.body ?? "",
      pub_date: release.publishedAt,
      platforms: {
        "darwin-universal": darwinPlatform,
        "darwin-x86_64": darwinPlatform,
        "darwin-aarch64": darwinPlatform,
        "windows-x86_64": {
          signature: windowsSigContent,
          url: windowsBundle.url,
        },
        "linux-x86_64": {
          signature: linuxSigContent,
          url: linuxBundle.url,
        },
      },
    };
  }

  // ----- main -----
  if (import.meta.url === `file://${process.argv[1]}`) {
    const tag = process.env.TAG;
    if (!tag) {
      console.error("TAG env var is required (e.g. v0.4.0)");
      process.exit(1);
    }
    const json = execFileSync("gh", [
      "release",
      "view",
      tag,
      "--json",
      "tagName,publishedAt,body,assets",
    ], { encoding: "utf-8" });
    const release = JSON.parse(json);

    const fetchSig = async (asset) => {
      const res = await fetch(asset.url, {
        redirect: "follow",
        headers: { Accept: "application/octet-stream" },
      });
      if (!res.ok) {
        throw new Error(`fetch ${asset.name}: HTTP ${res.status}`);
      }
      return (await res.text()).trim();
    };

    const manifest = await buildManifest(release, fetchSig);
    writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
    console.error(`Wrote latest.json for ${tag}`);
  }
  ```

- [ ] **Step 4: Run the test, all pass**

  Run: `npm test`
  Expected: PASS, all tests (including the 5 store tests + 3 manifest tests).

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/generate-latest-json.mjs scripts/generate-latest-json.test.mjs
  git commit -m "feat(release): generate-latest-json.mjs + tests"
  ```

---

### Task 13: Sign artifacts in `release.yml` + fail-fast guard

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the fail-fast guard step BEFORE the build step**

  In the existing `build` job's `steps:` list, immediately before the `- name: Build and release` step that uses `tauri-apps/tauri-action@v0`, insert:

  ```yaml
  - name: Verify signing key is configured
    shell: bash
    env:
      KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    run: |
      if [ -z "$KEY" ]; then
        echo "::error::TAURI_SIGNING_PRIVATE_KEY secret is not set. Generate a key with 'npx @tauri-apps/cli signer generate' and add it as a repo secret. See docs/superpowers/specs/2026-06-29-auto-update-design.md."
        exit 1
      fi
  ```

- [ ] **Step 2: Extend the existing `tauri-action` step's `env:` block**

  Currently:

  ```yaml
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ```

  Extend to:

  ```yaml
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  ```

- [ ] **Step 3: Lint the workflow**

  Run: `gh workflow view release.yml --repo yanickxia/yterminal 2>/dev/null || cat .github/workflows/release.yml`
  Verify the YAML structure looks right (correct indentation; both new pieces are at step / env level).

- [ ] **Step 4: Commit**

  ```bash
  git add .github/workflows/release.yml
  git commit -m "ci(release): sign updater artifacts and fail-fast on missing key"
  ```

---

### Task 14: New `publish-latest-json` job

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Append the aggregator job**

  At the END of `release.yml` (same indentation level as the existing `build:` job), append:

  ```yaml
  publish-latest-json:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Build latest.json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.ref_name }}
        run: node scripts/generate-latest-json.mjs
      - name: Upload latest.json to release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.ref_name }}
        run: gh release upload "$TAG" latest.json --clobber
  ```

  `--clobber` lets re-runs overwrite an existing `latest.json` without erroring out.

- [ ] **Step 2: Commit**

  ```bash
  git add .github/workflows/release.yml
  git commit -m "ci(release): publish latest.json after build job"
  ```

---

### Task 15: README + first-time runbook

**Files:**
- Modify: `README.md` (add a short "Auto-update" section near the bottom, above "Tech stack")

- [ ] **Step 1: Add a brief user-facing note**

  Append to `README.md`, before the "Tech stack" heading:

  ```markdown
  ## Auto-update

  yterminal checks GitHub for new releases on launch (5 seconds after the
  window opens) and via **Settings → Update → Check for updates**. When a
  new version is available, you'll see a dialog with the release notes
  and an "Update now" button. Updates are signed with ed25519 and verified
  before install — a tampered or mismatched download is refused.

  Linux users: the in-app updater works for the **AppImage** flavor only;
  `.deb` / `.rpm` users continue to install via the system package
  manager.
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add README.md
  git commit -m "docs: document the in-app auto-update flow"
  ```

---

### Task 16: End-to-end manual acceptance (one-shot, after Task 15)

This is a single checklist task — no further code changes.

- [ ] **Step 1: Confirm GitHub Secret is in place**

  Visit `https://github.com/yanickxia/yterminal/settings/secrets/actions`. `TAURI_SIGNING_PRIVATE_KEY` must be present. (And `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you set a passphrase in Task 1.)

- [ ] **Step 2: Cut a test release**

  ```bash
  scripts/bump-version.sh 0.4.0 --push
  ```

  Watch the run on GitHub Actions:
  - All three platform builds should produce `.sig` files alongside artifacts.
  - The `publish-latest-json` job should run and upload `latest.json`.

- [ ] **Step 3: Verify the resulting release**

  ```bash
  gh release view v0.4.0 --repo yanickxia/yterminal --json assets | grep -E "(\.sig|latest\.json)"
  ```

  Expected: matches for `latest.json` and at least three `.sig` files.

- [ ] **Step 4: Run an older build against the new release**

  Install the v0.3.0 build from the `dist/` directory (or download from the v0.3.0 release). Launch it. After 5 seconds the dialog should appear pointing at v0.4.0.

- [ ] **Step 5: Walk through the whole flow on macOS**

  - Click "Update now" → progress bar advances → "Restart now" enabled.
  - Click "Restart now" → app quits, relaunches as v0.4.0.
  - Open Settings → Update → confirm "You're up to date" after re-check.

- [ ] **Step 6 (optional, recommended): repeat on Windows + Linux AppImage**

  Same flow on the other two platforms.

- [ ] **Step 7: Commit nothing (this task is verification only).**

---

## Done

If every box is ticked, the feature ships in v0.4.0. Future releases need zero extra work — `scripts/bump-version.sh <ver> --push` triggers everything end to end.

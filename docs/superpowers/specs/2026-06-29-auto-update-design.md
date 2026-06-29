# Auto-Update via GitHub Releases — Design

**Status:** Draft
**Date:** 2026-06-29
**Owner:** yanickxia
**Target version:** 0.4.0

## Goal

Let yterminal check for, download, verify, and install new versions
released to `https://github.com/yanickxia/yterminal/releases`, without
the user having to visit the release page or run an installer manually.

## Non-goals

- Delta / binary-diff updates. Tauri's updater downloads the full
  packaged bundle each time; that is acceptable for this app's size
  and release cadence.
- "Skip this version" / "remind me in 24h" persistence. Re-prompting
  on next launch is acceptable for a single-developer project; the
  state cost isn't worth it.
- Channels (stable / beta / nightly). Single channel only.
- In-app rollback to a previous version.
- Auto-update for `.deb` / `.rpm` Linux packages — those distros have
  their own package managers; only `AppImage` flows through the
  in-app updater.

## Decisions (confirmed during brainstorming)

| Decision | Choice |
|---|---|
| Mechanism | `tauri-plugin-updater` (official Tauri 2 plugin) |
| Check timing | Auto on launch (delayed) **and** manual button in Settings |
| Install flow | Prompt user; download + install + relaunch only after explicit consent |
| Signing key | Generated locally, public key committed to `tauri.conf.json`, private key uploaded as GitHub Actions secret |
| Update manifest endpoint | `latest.json` published as a release asset, fetched via the permanent redirect `https://github.com/yanickxia/yterminal/releases/latest/download/latest.json` |

## Architecture

```
launch (+5s) ┐                ┌──────────────┐
settings btn ┴── updater ── ► │ latest.json  │  (release asset)
                              └──────┬───────┘
                                     ▼
                        compare current.version vs latest.version
                                     │
                                ┌────┴────┐
                                ▼         ▼
                            no-op      modal: version + release notes
                                            ├─ "Later"  → keep state, surface in Settings
                                            └─ "Update" → download → verify ed25519
                                                              → install → relaunch
```

Endpoint design uses GitHub's permanent
`/releases/latest/download/<asset>` redirect, so no GitHub Pages,
S3 bucket, or custom backend is needed.

## Components

### 1. Rust side (`src-tauri/`)

**`Cargo.toml`** — add:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # for relaunch() after install
```

**`src/main.rs`** — register both plugins in the existing builder
chain (add next to `tauri_plugin_os::init()` and `tauri_plugin_pty::init()`):

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

No custom Rust commands. Both plugins expose JS APIs the frontend
calls directly.

**`capabilities/default.json`** — append `"updater:default"` *and*
`"process:default"` to the `permissions` array. Without
`process:default` the `relaunch()` call from the "Restart now"
button will fail at runtime.

### 2. Tauri config (`src-tauri/tauri.conf.json`)

Add a `plugins.updater` block:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/yanickxia/yterminal/releases/latest/download/latest.json"
    ],
    "pubkey": "<base64 of generated public key>"
  }
}
```

Bundler targets, current state and changes needed:

- **macOS** — current build produces `yterminal_universal.app.tar.gz`
  + `.sig` from `--target universal-apple-darwin`. The Tauri 2
  updater consumes that directly. No changes.
- **Windows** — current build produces `*-setup.exe` (NSIS) and
  `*_x64_en-US.msi`. Tauri 2's updater consumes the **raw `.exe`**
  directly (this is the v2 default; the v1-style `.nsis.zip` is
  only emitted when `bundle.createUpdaterArtifacts: "v1Compatible"`
  is set, which we do **not** want). `latest.json` will therefore
  reference `*_x64-setup.exe`. No bundler change needed.
- **Linux** — current build produces `.AppImage`, `.deb`, `.rpm`.
  The updater consumes `.AppImage` in place. `.deb` / `.rpm`
  continue to be produced for manual installs but are not
  referenced from `latest.json`. No bundler change needed.

The existing `bundle.targets: "all"` setting in `tauri.conf.json`
already produces every artifact above, verified against the v0.3.0
release assets.

### 3. Frontend (`src/stores/updater-store.ts` + `src/components/`)

The store goes in `src/stores/` alongside the existing
`settings-store.ts` and `workspace-store.ts` — same place, same
naming convention.

**`src/stores/updater-store.ts`** — Zustand slice. Only
`lastCheckedAt` is persisted (matches the persisted slice pattern
already used by `settings-store`); everything else is transient
session state.

State machine:

```
idle ──► checking ──► up-to-date
              │
              └─► available ──► downloading ──► ready ──► installing ──► (relaunch)
              │                       │              │
              └─► error               └─► error      └─► error
```

Actions:
- `check()` — calls `@tauri-apps/plugin-updater`'s `check()`, on
  success transitions to `up-to-date` or `available` with the
  manifest payload. Calling `check()` while already `checking` is
  a no-op.
- `startDownload()` — only valid from `available`; calls
  `update.downloadAndInstall(onEvent)`, threads progress events
  into the store. No-op from any other state.
- `relaunch()` — calls `@tauri-apps/plugin-process`'s `relaunch()`
  once state is `ready`.
- `dismiss()` — closes the modal but keeps the `available` payload
  so Settings can re-open it.
- `lastCheckedAt: number | null` — timestamp surfaced in Settings.

Every action is `try / catch`; errors set `state = 'error'` with a
human message and never throw past the store boundary.

**`src/lib/updater-auto-check.ts`** — thin module exposing
`scheduleAutoCheck()`. `App.tsx` calls it once after mount:
`setTimeout(() => useUpdaterStore.getState().check(), 5000)`.
Failure is swallowed (logged via `console.warn`); the user is
*not* shown a toast on launch-time failure.

**`src/components/UpdateDialog.tsx`** — modal rendered against the
store state. Mounted in `App.tsx` at the top level next to the
existing `WorkspacePalette` / search overlay, **outside** any
"workspace ready" gate so an updater error surfaces even if the
rest of the app is degraded.

Render modes:

- `available` — version, release notes (rendered as plain `<pre>`;
  the codebase has no markdown renderer and we are not adding one),
  `[Later] [Update now]`.
- `downloading` — progress bar with bytes / total. "Cancel" is not
  offered — Tauri's `downloadAndInstall` doesn't expose
  cancellation.
- `ready` — "Download finished. Restart to apply." `[Restart now]`.
- `error` — error message + `[Retry]` (re-runs whichever step
  failed).

**Settings panel** — append a new section to the existing
`SettingsPanel` component (which already shows theme / font):

```
Update
  Current version: 0.3.0
  [Check for updates]   Last checked: 2026-06-29 15:42
```

When `state === 'available'` the button label flips to
`[View update v0.4.0]` and re-opens the modal. When
`state === 'error'` the button label is `[Retry]` and the error
message is shown next to it.

### 4. Release CI (`.github/workflows/release.yml`)

The current workflow is a single `build` job with a 3-platform
matrix that calls `tauri-apps/tauri-action@v0`. Two changes:

**(a) Sign artifacts** — extend the existing `env:` block on the
`tauri-action` step (currently only sets `GITHUB_TOKEN`) so each
build runs with the signing key in scope:

```yaml
- name: Build and release
  uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  with:
    ...
```

When `TAURI_SIGNING_PRIVATE_KEY` is set, `tauri build` automatically
signs each updater-eligible artifact and writes a sibling `.sig`
file that `tauri-action` then uploads to the draft release.

**(b) Fail-fast guard** — add one short step *before* the build
step in the same job, so a missing secret aborts immediately rather
than producing an unsigned release:

```yaml
- name: Verify signing key is configured
  shell: bash
  env:
    KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  run: |
    if [ -z "$KEY" ]; then
      echo "::error::TAURI_SIGNING_PRIVATE_KEY secret is not set." \
           "Generate a key with 'npx @tauri-apps/cli signer generate'" \
           "and add it as a repo secret. See docs/superpowers/specs/" \
           "2026-06-29-auto-update-design.md."
      exit 1
    fi
```

**(c) New `publish-latest-json` job** — runs once after the matrix
build completes, on Ubuntu, and uploads `latest.json` to the same
draft release:

```yaml
publish-latest-json:
  needs: [build]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
    - run: node scripts/generate-latest-json.mjs
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        TAG: ${{ github.ref_name }}
    - run: gh release upload "$TAG" latest.json --clobber
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The existing build job already publishes the release as a draft;
this aggregator runs against the draft and adds `latest.json` to
its assets. The maintainer publishes the draft manually as today.

### 5. `scripts/generate-latest-json.mjs` (new)

Node script (no extra npm deps; uses `gh` CLI via `child_process`).

Inputs:
- `TAG` env (e.g. `v0.4.0`)
- `gh release view` to enumerate the release's assets

Logic:
1. `version` = `TAG.slice(1)` (drop the `v` prefix)
2. `notes` = release body (from `gh release view --json body`)
3. `pub_date` = release `publishedAt`
4. For each platform key, find the matching asset and its sibling
   `.sig`:
   - `darwin-x86_64`, `darwin-aarch64`, `darwin-universal` → all
     three keys point at the same single universal artifact
     (`yterminal_universal.app.tar.gz` + its `.sig`). The build
     matrix only produces one universal bundle, and the Tauri
     updater accepts the same URL under multiple darwin keys.
   - `windows-x86_64` → `*_x64-setup.exe` (raw NSIS installer,
     v2 default; **not** `.nsis.zip`)
   - `linux-x86_64` → `*_amd64.AppImage`
5. Download each `.sig` (it's small text), embed contents into the
   manifest's `signature` field.
6. Write `./latest.json`.

Schema:

```json
{
  "version": "0.4.0",
  "notes": "...release body...",
  "pub_date": "2026-06-29T07:30:00Z",
  "platforms": {
    "darwin-universal": {
      "signature": "<contents of yterminal_universal.app.tar.gz.sig>",
      "url": "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_universal.app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "<same as darwin-universal>",
      "url": "<same as darwin-universal>"
    },
    "darwin-x86_64": {
      "signature": "<same as darwin-universal>",
      "url": "<same as darwin-universal>"
    },
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_x64-setup.exe"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.AppImage"
    }
  }
}
```

**Fail-fast:** if any platform's expected asset or its `.sig` is
missing, the script exits non-zero. Better to fail the release than
to publish a manifest the updater will reject silently.

## Data flow / sequence (happy path)

```
User launches v0.3.0
  ▼ +5s
store.check()
  ▼
plugin-updater HTTP GET latest.json
  ▼
plugin verifies signature on response (no — signature is per-bundle, not on JSON)
  ▼
plugin parses JSON, picks current platform key
  ▼
0.4.0 > 0.3.0  →  store.state = 'available'
  ▼
<UpdateDialog> opens
  ▼ user clicks "Update now"
store.startDownload()
  ▼
plugin downloads .app.tar.gz / .exe / .AppImage with progress events
  ▼
plugin verifies ed25519 signature in .sig vs pubkey in tauri.conf.json
  ▼ ok
plugin replaces installed bundle in place (macOS: app bundle; Windows: nsis;
  Linux: AppImage self-replace)
  ▼
store.state = 'ready'
  ▼ user clicks "Restart now"
plugin-process relaunch()
  ▼
new version starts; check on launch finds 0.4.0 == 0.4.0 → no-op
```

## Error handling

Single invariant: **updater failures never block the main app
flow.** All failures collapse to `state = 'error'` with a
user-readable message; the modal remains dismissible; the next
launch reattempts the auto-check normally.

| Scenario | User-visible result |
|---|---|
| Offline / network unreachable | Auto-check: silent (console.warn). Settings: "无法连接，检查网络" + Retry. |
| `latest.json` 404 / JSON parse error | "更新源暂不可用" + Retry. |
| Current platform key missing from `latest.json` | Same as no update available; auto-check silent, Settings shows "已是最新". |
| Signature verification fails on download | Modal switches to error state: "下载内容校验失败，请稍后重试" + Retry. |
| Download interrupted | Modal error + Retry. |
| Version in manifest ≤ current | `state = 'up-to-date'`. |

## Testing

### Unit tests

- `scripts/generate-latest-json.mjs` — vitest with fixture
  `gh release view` JSON and fake `.sig` files. Cover:
  - happy path: produces correct shape for all three platforms
  - missing `.sig` → exits non-zero
  - missing platform-specific bundle → exits non-zero
  - malformed `TAG` env → exits non-zero
- `src/updater/store.ts` — vitest with `@tauri-apps/plugin-updater`
  mocked. Cover every state transition listed in the diagram, plus:
  - `check()` while already `checking` is a no-op
  - `startDownload()` from a state other than `available` is a no-op
  - error in `check()` produces `state = 'error'` with the error
    message preserved

### Manual acceptance

1. Locally edit `package.json` / `Cargo.toml` / `tauri.conf.json`
   to `0.0.1`, `tauri dev` → on launch (after 5s) the modal should
   appear with the real `latest.json` content.
2. Click "Later" → modal closes, Settings button shows "View update
   v0.x.y", clicking re-opens modal.
3. Click "Check for updates" twice in a row in Settings → second
   click also works (no stuck `checking` state).
4. Edit `tauri.conf.json` `endpoints` to a non-existent domain →
   launch should not crash; Settings should show the error state.
5. Cut a real `0.3.1` patch release through the new pipeline; on
   a `0.3.0` install, run through the full check → download →
   install → relaunch flow on macOS, Windows, and Linux.

## Rollback

- A bad `latest.json` cannot be edited in place after release, but
  publishing any new release replaces what `releases/latest`
  resolves to. Mitigation: cut a `0.x.y+1` patch release with a
  corrected manifest.
- The signature-verification path is the safety net: a malformed
  `latest.json` can at worst point the updater at a bundle whose
  `.sig` doesn't match the public key, in which case the client
  refuses to install — bad updates cannot land on users' machines.
- Disabling auto-update entirely: remove the
  `plugins.updater.endpoints` array (or set to `[]`) and ship a
  hotfix; the plugin treats missing endpoints as "feature off".

## First-time release runbook

A one-time setup the maintainer does once before the first signed
release:

1. Generate the key pair locally:
   ```bash
   npx @tauri-apps/cli signer generate -w ~/.tauri/yterminal.key
   ```
   The CLI prints the **public key** (paste into
   `tauri.conf.json` → `plugins.updater.pubkey`) and writes the
   **private key** to `~/.tauri/yterminal.key`.
2. (Optional) Choose a passphrase for the private key. The CLI
   asks; remember it for step 4.
3. Commit `tauri.conf.json` with the public key.
4. Add GitHub repo secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` = full contents of
     `~/.tauri/yterminal.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the passphrase from
     step 2 (omit if you didn't set one)
5. Cut a fresh release via the existing
   `scripts/bump-version.sh <ver> --push` flow. CI should sign
   bundles and publish `latest.json` automatically.

After this one-time setup, subsequent releases need no extra steps.

## Open risks

- **Code-signing for macOS / Windows is unrelated to updater
  signing.** Tauri updater signing protects update *integrity*; OS
  Gatekeeper / SmartScreen warnings are a separate problem. This
  design does not address those — out of scope.
- **GitHub rate limits on `releases/latest/download/...`** —
  unauthenticated requests are rate-limited per IP. For a personal
  app this is fine; if it ever becomes a problem, swap the endpoint
  to a static `latest.json` on GitHub Pages.
- **PTY shutdown during `relaunch()`.** `tauri-plugin-pty` spawns
  child shells that need to be killed cleanly when the host process
  exits. `relaunch()` calls `app.exit()` then re-spawns, which lets
  the plugin's Drop run; in practice this works the same as the
  user pressing Cmd-Q. Worth re-confirming during manual acceptance
  on each platform.
- **Scrollback survival across in-place upgrade.** The SQLite
  database lives at `$XDG_DATA_HOME/yterminal/scrollback.db` (or the
  Windows / macOS equivalent), *outside* the application bundle, so
  an in-place app replacement leaves it untouched. Autosave runs
  on a 15s tick under WAL, so worst case the user loses 15s of
  buffer at the moment they hit "Restart now".
- **Linux `.AppImage` self-replace requires write access.** If the
  user installed the AppImage to a system location like
  `/opt/yterminal`, the running process won't be able to overwrite
  it and the updater will error out. We can't fix this from inside
  the app — the user has to either re-launch from a writable
  location or fall back to the manual `.deb` / `.rpm` download.

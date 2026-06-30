# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run tauri:dev      # full GUI dev (needs platform webview libs — see README)
npm run dev            # Vite-only frontend (no Tauri shell, no PTY)
npm run build          # tsc --noEmit + Vite production bundle
npx tsc --noEmit       # type-check only
npm test               # vitest run (one shot)
npm run test:watch     # vitest watch
npx vitest run path/to/file.test.ts        # single test file
npx vitest run -t "name"                   # filter by test name
```

Rust side (in `src-tauri/`):

```bash
cargo check            # type-check Rust without building the GUI
cargo build            # debug build
```

CI (`.github/workflows/ci.yml`) only runs `tsc --noEmit` and `npm run build` on push/PR — full multi-platform bundles are built only on `v*` tag pushes via `release.yml`.

### Releasing

`scripts/bump-version.sh <ver>` rewrites the version in **three** manifests that must stay in sync: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Add `--tag` to commit + tag, `--push` to also push (which triggers the release workflow). Never bump the version in only one file by hand.

## Architecture

Tauri 2 desktop app: Rust backend in `src-tauri/`, React 18 + TypeScript frontend in `src/`. The split is opinionated — almost all logic is in TS; Rust hosts only what the WebView can't do (PTY, font enumeration, SQLite, process cwd lookup, JSON config file).

### State model: Workspace → Tab → PaneTree → PaneLeaf

```
Workspace[]                       <- src/stores/workspace-store.ts (Zustand, localStorage-persisted)
  └── Tab[]                       <- same store
        └── PaneTree (recursive)  <- src/lib/pane-tree.ts (pure split/remove/resize/collectLeaves)
              └── PaneLeaf        <- live xterm + PTY, owned by src/lib/terminal-manager.ts
```

`workspace-store.ts` is the single source of truth for structure and the only thing persisted to localStorage. `pane-tree.ts` contains **pure** transforms — no IO, no side effects — so the store stays serializable.

### Terminal caching (critical design)

`terminal-manager.ts` keeps xterm.js `Terminal` + PTY instances in an in-memory `Map` keyed by paneId. Switching tabs / panes **re-parents the cached DOM node** rather than destroying and recreating the terminal. This is what makes scrollback and shell state survive tab switches. Consequences when editing this file:

- Never tear down a session on tab/pane *switch* — only on explicit close (`disposeSession`) or shell exit.
- `term.open()` requires its parent to be in the DOM; sessions track an `opened` flag and defer `open()` until the first `attachSession`.
- App-wide re-renders must not pass fresh callback identities into `PaneTerminal` — App.tsx wraps `onFocusPane`/`onExitPane`/`onResizePane` in `useCallback` for exactly this reason.

### PTY layer is in-tree, not `tauri-plugin-pty`

`src-tauri/src/pty.rs` calls `portable-pty` directly and exposes `pty_spawn` / `pty_read` / `pty_write` / `pty_resize` / `pty_kill` / `pty_exitstatus` as top-level Tauri commands. The frontend wraps these in `src/lib/pty.ts` (note: NOT the `tauri-pty` npm package). The reason this layer was rewritten: the upstream plugin returned an internal session counter as `pty.pid` instead of the real OS pid, which broke `process_cwd(pid)` (lsof on macOS / `/proc/<pid>/cwd` on Linux). Cwd lookup is what powers "new tab inherits the active shell's cwd" and "restart in the directory I left off".

If you need to change PTY behavior, edit `src-tauri/src/pty.rs` and `src/lib/pty.ts` together. Don't reintroduce the plugin.

### Persistence — three separate stores

| What | Where | Why separate |
|---|---|---|
| Workspace/tab/pane structure | `localStorage` (Zustand persist) | Small, synchronous, JSON-shaped |
| Per-pane scrollback snapshots | SQLite at `$XDG_DATA_HOME/yterminal/scrollback.db` (Windows: `%APPDATA%\yterminal\scrollback.db`) | Unbounded; localStorage's ~5MB origin quota was the cliff |
| Appearance (theme/font/size) | JSON at `~/.config/yterminal/config.json` | User-editable, syncable across machines, re-read on window focus |

Scrollback flow: `App.tsx` calls `preloadScrollbacks()` once at startup to bulk-fetch from SQLite into an in-memory map; `loadScrollback(paneId)` is then synchronous (the React lifecycle that consumes it isn't async-friendly). A 15s autosave tick writes via `scrollback_save`. Startup GC: `scrollback_prune(liveIds)` drops snapshots for panes no longer in the workspace store.

Appearance flow: `loadConfigFromDisk()` runs at startup and on `window` `focus` event — so editing the JSON file by hand (or syncing it via git/Dropbox) updates the running app live. Settings panel writes back via `write_config`.

### Theming

`src/lib/themes.ts` owns the palette → xterm theme + CSS-variable mapping. `applyAppearance()` re-themes every cached terminal in place AND updates the CSS vars on the document — both must be kept in sync; do not change one path without the other.

### Link handling

`terminal-manager.ts` loads `@xterm/addon-web-links` on every new `Terminal`. The click handler delegates to:

- `src/lib/link-modifier.ts` — pure predicate `shouldOpenLink(event, isMac)`; `isMac` is detected once at module load via `navigator.userAgent` (matches the existing UA-based platform check used by `pickShell`). Belt-and-suspenders: the predicate also calls `event.getModifierState(...)` because Tauri's WKWebView on macOS occasionally drops `metaKey`.
- `src/lib/opener.ts` — thin wrapper over `@tauri-apps/plugin-opener` `openUrl`, mirroring the `src/lib/pty.ts` shape so the IPC surface is centralized and mockable in vitest.

The Tauri capability `opener:allow-open-url` in `src-tauri/capabilities/default.json` is scoped to `http://*` and `https://*`. **Keep this lock-down when adding new schemes** — widening the scope (to `file://`, `mailto:`, etc.) is a security decision, not a cleanup task.

### Updater

In-app auto-update via `tauri-plugin-updater` (ed25519-signed). Auto-check fires 5s after launch via `scheduleAutoCheck()` and reads from a GitHub release `latest.json` (regenerated by `scripts/generate-latest-json.mjs` during release). Linux: AppImage flavor only — `.deb`/`.rpm` users use the system package manager.

## Conventions

- **Keep this file in sync.** When architecture, commands, persistence layout, or invariants change, update CLAUDE.md in the same change. A stale CLAUDE.md is worse than none — it actively misleads future sessions.
- **No comments explaining what code does.** The codebase already follows this; existing comments are reserved for *why* (a constraint, a workaround, a non-obvious invariant — e.g. the `useCallback` block in `App.tsx`, the `pty.rs` header). Match that style — don't add narration.
- TypeScript is strict; `npx tsc --noEmit` must pass before any PR.
- Tests live next to the file they cover (`*.test.ts`/`*.test.tsx` in `src/`, `*.test.mjs` in `scripts/`). Vitest runs in `node` environment by default — DOM tests need an explicit jsdom setup.
- Prefer editing existing files over adding new ones; the source layout in `README.md` is canonical.

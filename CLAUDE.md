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

### HTML5 drag-and-drop requires `dragDropEnabled: false`

`src-tauri/tauri.conf.json` sets `app.windows[0].dragDropEnabled = false`. Tauri's default is `true`, which makes wry/WKWebView capture OS-level drag events at the native layer and **swallow the WebView's `drop` event** — the symptom is "drag visual feedback works (`dragstart`/`dragover` fire) but the list never reorders". This affects tab and workspace reorder in `TabBar.tsx` / `WorkspaceSidebar.tsx`. Don't re-enable it without rewriting both reorder paths against Tauri's native drag events.

### PTY layer is in-tree, not `tauri-plugin-pty`

`src-tauri/src/pty.rs` calls `portable-pty` directly and exposes `pty_spawn` / `pty_read` / `pty_write` / `pty_resize` / `pty_kill` / `pty_exitstatus` as top-level Tauri commands. The frontend wraps these in `src/lib/pty.ts` (note: NOT the `tauri-pty` npm package). The reason this layer was rewritten: the upstream plugin returned an internal session counter as `pty.pid` instead of the real OS pid, which broke `process_cwd(pid)` (lsof on macOS / `/proc/<pid>/cwd` on Linux). Cwd lookup is what powers "new tab inherits the active shell's cwd" and "restart in the directory I left off".

Blocking syscalls (`reader.read`, `child.wait`, `writer.write_all`) MUST stay off the async worker pool. Each live session has two long-running tasks in flight from the JS side (`readLoop` and `waitForExit`); if either parks an async worker via a sync syscall, ~8 sessions exhaust the default 16-worker tokio runtime on a 16-core Mac and the next shell's first read never schedules (its tab renders blank forever). The current shape:

- Reader: `pty_spawn` starts a dedicated OS thread per session that loops `read()` and pushes chunks into a `tokio::sync::mpsc` channel; `pty_read` only `recv().await`s — never blocks a worker.
- `pty_exitstatus` and `pty_write` run their sync calls inside `tauri::async_runtime::spawn_blocking`, dispatching to tokio's blocking-thread pool.
- The reader thread self-terminates when the channel's receiver is dropped (session removed) or when `read()` returns EOF.

Do not re-introduce a direct sync call inside any `#[tauri::command] async fn` here.

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

- `src/lib/link-modifier.ts` — pure predicate `shouldOpenLink(event, isMac, requireModifier=true)`; `isMac` is detected once at module load via `navigator.userAgent` (matches the existing UA-based platform check used by `pickShell`). Belt-and-suspenders: the predicate also calls `event.getModifierState(...)` because Tauri's WKWebView on macOS occasionally drops `metaKey`. `requireModifier` is fed from the `requireModifierForLinks` setting (Settings → Terminal, default true): when false the predicate short-circuits to `true` so a plain click opens links/file paths with no helper key. Both the WebLinksAddon handler and the file-path `LinkProvider` in `terminal-manager.ts` read `useSettingsStore.getState().requireModifierForLinks` at click time, so toggling the setting takes effect live without re-creating terminals.
- `src/lib/opener.ts` — thin wrapper over `@tauri-apps/plugin-opener` (`openUrl` for web links, `openPath` for OS-opening local files), mirroring the `src/lib/pty.ts` shape so the IPC surface is centralized and mockable in vitest.

The Tauri capability `opener:allow-open-url` in `src-tauri/capabilities/default.json` is scoped to `http://*` and `https://*`. **Keep this lock-down when adding new schemes** — widening the scope (to `file://`, `mailto:`, etc.) is a security decision, not a cleanup task. `opener:allow-open-path` is also granted so recognized non-text files (images, binaries) can be handed to the OS default app.

### File links + built-in viewer

Path-like tokens in terminal output are clickable (same Cmd/Ctrl+click gate as web links), opening recognized text/code/markdown in a read-only built-in viewer **rendered inside its own tab** and handing anything else to the OS. Four concerns, kept separate (pure logic / IO split mirrors the rest of the codebase):

- **Classification (pure)** — `src/lib/file-link-classify.ts`: `findPathSpans(line)` scans a line of terminal text for path-like tokens (trims wrapping quotes/punctuation, keeps a `:line:col` suffix); `looksLikePath`, `classifyViewable` (ext → highlight.js language via `VIEW_EXT_LANGUAGE`, markdown flagged in `MARKDOWN_EXTS`, bare names like `Dockerfile`/`.bashrc` in `VIEWABLE_BASENAMES`), `classifyFilePath` (→ `view` | `os-open`), and `resolvePath` (expands `~`, joins against cwd, collapses `.`/`..`, strips `:line:col`). Fully unit-tested in `file-link-classify.test.ts`.
- **Backend read (Rust, SYNC)** — `src-tauri/src/main.rs`: `path_is_file(path)` and `read_text_file(path)`. The reader rejects (rather than returning partial data) when the file is missing, larger than `MAX_VIEWER_BYTES` (2 MiB), or binary (NUL-byte sniff over the first 8 KB), decoding lossily so a few stray bytes still open. Wrapped by `src/lib/file-reader.ts`.
- **Routing (IO)** — `src/lib/file-link.ts` `handleClickedToken(token, cwd, home?)`: web URL → `openUrl`; otherwise resolve + `path_is_file` probe, then a viewable type opens a file tab in the active workspace (`useWorkspaceStore.openFileTab`), a non-viewable file is `openPath`-ed, and a non-existent/dir token is ignored. `terminal-manager.ts` registers an xterm `LinkProvider` that maps `findPathSpans` results to clickable ranges and calls this on activate, resolving against the pane's live `shellCwd` and a lazily-cached `homeDir()`.
- **Viewer (read-only UI, in a tab)** — a viewable file opens as a dedicated **tab** rather than a modal. The durable descriptor lives on `Tab.file` (`{path, language, markdown}`, persisted with the workspace at store version 5); the workspace store's `openFileTab(workspaceId, file)` creates the tab (reusing an existing tab for the same path) and the tab keeps an inert placeholder `root` leaf so all tree-walking code (cwd/agent snapshots, `collectLeafIds`, session disposal) treats it uniformly without ever mounting a shell. `App.tsx` renders `<FileViewer tabId file>` in the terminal area when `activeTab.file` is set, otherwise the `<PaneRenderer>`. The file *text* is not persisted (it can be large): `src/stores/viewer-store.ts` (transient zustand, keyed by tab id) lazily `load`s it from disk on first render and `drop`s it when the tab closes. `TabBar` close paths and the Cmd/Ctrl+W shortcut skip session disposal for file tabs and drop the cached content; split/search controls are hidden/no-op for them. `src/lib/file-render.ts` does the rendering: Markdown via `marked` → `DOMPurify.sanitize` (the source is an arbitrary on-disk file, so it must never inject active content), source via `highlight.js` (escaped/structural output, safe to inject). A "Raw" toggle shows unrendered text. hljs token colors live in `styles.css` (`.file-viewer-*` / `.hljs-*`), no separate theme stylesheet shipped.

### AI sidebar

A collapsible right-hand panel that lets the user ask an LLM about their terminal, optionally attaching the focused pane's serialized output as context. Toggled via Cmd/Ctrl+I, the ✦ button in the WorkspaceSidebar header/rail, or the store's `toggleOpen`. Kept modular so streaming/more providers (P2) and an agent that drives the terminal (P3) slot in without reshaping the surface. Concerns split the usual pure-logic / IO / UI way:

- **HTTP proxy (Rust)** — the WebView can't call LLM endpoints directly (CORS + it would expose the key in page context), so `ai_chat` in `src-tauri/src/main.rs` is a thin OpenAI-compatible proxy: it POSTs `{model, messages, stream:false}` to `<baseUrl>/chat/completions` with `Authorization: Bearer <key>` and returns `choices[0].message.content`, surfacing non-2xx bodies as `Err` snippets. Uses `reqwest` 0.12 with `rustls-tls` (not native-tls) to keep the build self-contained — no system OpenSSL.
- **Context capture (pure + manager)** — `src/lib/terminal-text.ts` (pure, unit-tested in `terminal-text.test.ts`): `stripAnsi` drops CSI/OSC/charset/C0 noise; `cleanTerminalText(raw, maxChars=12000)` normalizes newlines, collapses blank runs, and keeps the **tail** (most recent output) with a `…(truncated)…` marker when over cap. `terminal-manager.ts` exposes `getSessionText(paneId, maxChars)` which serializes the pane's `SerializeAddon` buffer through that cleaner. Capture is opt-in per message via the "Attach terminal context" checkbox.
- **Provider config** — `settings-store.ts` holds `aiProviders: AiProvider[]` (`{id, name, baseUrl, model, apiKey}`) + `activeAiProviderId`, with add/update/remove/setActive actions and the `activeAiProvider()` helper. **`apiKey` is localStorage-only — deliberately NOT written to the syncable JSON config** (same secret-handling stance as agent-resume env). Persist schema bumped to `version: 4`. Edited in Settings → AI (`AiTab` in `SettingsPanel.tsx`).
- **Transcript + wire (transient store)** — `src/stores/ai-store.ts` (not persisted; scoped to the running session like the terminal itself) holds `turns`, `sending`, `open`, and `send(prompt, context?)`. `send` optimistically appends a user turn + a pending assistant turn, builds wire messages `[system prompt] (+ optional context as a fenced system message) + prior non-pending/non-error turns`, calls `aiChat` (`src/lib/ai.ts`, the IPC wrapper over `ai_chat`), then fills or errors the assistant turn.
- **UI** — `src/components/AiSidebar.tsx` renders as a sibling in `.app` when `ai-store.open`; assistant replies render through the shared `renderMarkdown` (marked → DOMPurify) used by the file viewer, so model output is sanitized before injection. `App.tsx` refits the active tab's panes when the sidebar toggles (it changes terminal width). Styles are the `.ai-sidebar*` / `.ai-msg*` / `.ai-provider-*` rules in `styles.css`.

### Agent session resume

When a tab is restored on launch, a coding agent that was running in a pane (`claude` / `codex` / `opencode`) is resumed automatically. Four concerns, kept separate:

- **Detection** — `agent.ts` (`paneProcessTree`) wraps SYNC Rust commands in `src-tauri/src/main.rs`: `pane_process_tree(pid)` walks the OS process tree under a pane's shell pid (Linux `/proc`, macOS `ps`), and `agent_session_id(kind, cwd)` resolves the agent's newest on-disk session id (Claude: `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`; Codex: `$CODEX_HOME`/`~/.codex/sessions/**/rollout-*-<uuid>.jsonl`; OpenCode: `$OPENCODE_DATA_DIR`/`~/.local/share/opencode/**/ses_*`). `agent-detect.ts` is the pure classifier — argv-wide (so node-wrapper launches like `node .../claude-code/cli.js` still match), deepest-descendant wins.
- **Alias capture** — the running process argv only shows the resolved binary, never the alias the user typed. `input-line.ts` is a pure reducer fed from `term.onData` (user keystrokes only) that reconstructs each submitted command line; the session keeps a small `recentSubmits` history of first-tokens. At snapshot time we scan it newest-first for a token whose basename contains the detected kind name (`tokenMatchesKind`) — TUI-inside Enter submissions ("hello", "fix bug") won't contain `claude`/`codex`/`opencode` and are skipped, while a real launcher like `claude-by-kimi-...` matches. The first hit is cached in `typedCommands` so subsequent ticks are stable. Best-effort only: aliases the user invoked via ↑ history or shell autocompletion produce no keystrokes for the reducer; those cases fall back to env replay (next bullet).
- **Env capture** — for wrapper aliases that mainly export env vars (typical for "use claude with custom endpoint / model" setups), the alias name is often unrecoverable. `process_env(pid)` (Linux `/proc/<pid>/environ`, macOS `ps eww`) reads the agent process's environment; `filterAgentEnv` keeps only whitelisted prefixes (`ANTHROPIC_` / `CLAUDE_` / `CODEX_` / `OPENAI_` / `OPENCODE_`). The captured map lives on `PaneAgent.env` and `buildResumeCommand` prepends it as `KEY='value' ... <cmd> --resume <id>`, sorted for determinism. Note: captured values may include `*_AUTH_TOKEN` / `*_API_KEY`-style secrets — they're persisted to localStorage at the same security level as the user's shell-rc.
- **Persistence + resume** — `snapshotAllAgents()` in `terminal-manager.ts` runs on the same 15s tick (and on close) as `snapshotAllCwds()`, plus an extra debounced 1s tick scheduled after each shell submission to catch a freshly launched agent before TUI Enter pollution pushes its launch token out of `recentSubmits`. Per live pane it detects the agent, resolves the session id, captures relevant env vars, and writes a `PaneAgent {kind, command, sessionId, env?}` onto the `PaneLeaf` (or clears it when no agent runs). On next launch, `getOrCreateSession` reads the persisted `agent`, builds the resume command (`buildResumeCommand`: claude `--resume`, codex `resume`, opencode `--session`), and injects it once the shell is ready — on the first OSC 7 prompt, or a 1.5s timeout fallback for bare shells. Injection writes straight to the pty (bypassing the `onData` reducer so we don't re-capture our own command) and is guarded by a `resumeInjected` flag so it fires exactly once.

Invariants: never inject into a pane that wasn't restored-from-persist with an `agent`; never log terminal content from the input-line reducer. The persist schema bumped to `version: 4` for the additive optional `PaneAgent.env` (migrate is a pass-through; v3 bumped earlier for `PaneLeaf.agent`).

### Updater

In-app auto-update via `tauri-plugin-updater` (ed25519-signed). Auto-check fires 5s after launch via `scheduleAutoCheck()` and reads from a GitHub release `latest.json` (regenerated by `scripts/generate-latest-json.mjs` during release). Linux: AppImage flavor only — `.deb`/`.rpm` users use the system package manager.

## Conventions

- **Keep this file in sync.** When architecture, commands, persistence layout, or invariants change, update CLAUDE.md in the same change. A stale CLAUDE.md is worse than none — it actively misleads future sessions.
- **No comments explaining what code does.** The codebase already follows this; existing comments are reserved for *why* (a constraint, a workaround, a non-obvious invariant — e.g. the `useCallback` block in `App.tsx`, the `pty.rs` header). Match that style — don't add narration.
- TypeScript is strict; `npx tsc --noEmit` must pass before any PR.
- Tests live next to the file they cover (`*.test.ts`/`*.test.tsx` in `src/`, `*.test.mjs` in `scripts/`). Vitest runs in `node` environment by default — DOM tests need an explicit jsdom setup.
- Prefer editing existing files over adding new ones; the source layout in `README.md` is canonical.

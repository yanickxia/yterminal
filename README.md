# yterminal

A workspace-first terminal emulator, built from scratch (not a fork) on the
same battle-tested stack as termul / maiTerm.

It organizes shells in three levels — a **workspace sidebar**, **tabs** inside
each workspace, and a recursive **split-pane tree** inside each tab — with
persistent scrollback, switchable themes, configurable fonts, and
drag-and-drop reordering.

## Features

- **Workspaces → Tabs → Split panes** — a three-level model; each leaf pane is
  its own live shell.
- **Split panes** — split any pane horizontally or vertically, nest freely,
  resize with draggable dividers, focus follows click.
- **Persistent scrollback** — every pane's buffer is snapshotted (colors
  intact) via `@xterm/addon-serialize` and replayed on the next launch.
- **In-terminal search** — `Cmd/Ctrl + F` opens a search box that highlights
  matches in the focused pane's scrollback, with next/previous stepping.
- **Themes (skins)** — 5 built-in: Tokyo Night, Dracula, Solarized Dark,
  Gruvbox Dark, One Light. Applied live to both the terminal and the app chrome.
- **Fonts** — pick a monospace family and size; the picker offers built-in
  presets plus every monospace font installed on your system (enumerated
  natively via font-kit). Applied live without re-spawning shells.
- **Drag-and-drop reorder** — reorder tabs within a workspace and workspaces in
  the sidebar.
- **Instance caching** — terminals are cached, not destroyed, on tab/pane
  switch, so scrollback and shell state survive.
- **SSH remote workspaces** — attach to every workspace, tab, split and live PTY
  on another macOS/Linux machine through one persistent system OpenSSH channel.
  Closing either GUI or losing the network does not stop the remote work.

## Remote workspaces over SSH

On every machine that should own remotely accessible work, open **Settings →
Remote** and click **Enable Remote Workspaces**. This installs
`~/.local/bin/yterminal-agent` plus a per-user systemd service (Linux) or
LaunchAgent (macOS). No root permission and no listening TCP port are needed.

On the client machine, add an SSH target in the same panel. The target is an
alias or `user@host` accepted by your existing `ssh` command. Authentication,
host-key verification, `ProxyJump`, agent forwarding and key selection remain
entirely in `~/.ssh/config`/OpenSSH; yterminal stores no password or private key.

Remote workspaces then appear under their device in the sidebar. One client
controls a workspace at a time; other clients attach read-only and can use
**Take Control**. **Disconnect** only detaches the GUI. **Terminate** is the
explicit operation that ends a remote shell/workspace.

The agent keeps the PTY, workspace document, output journal and renderer
checkpoints under the remote OS user. Reconnect resumes from a byte sequence,
so scrollback and full-screen TUIs continue without intentionally respawning a
shell. Git status, cwd/process detection and the text file viewer execute on the
workspace's owner host rather than accidentally reading the client machine.

### Agent CLI diagnostics

The installed agent also exposes health and end-to-end checks:

```bash
yterminal-agent doctor
yterminal-agent smoke --json
yterminal-agent verify --json
yterminal-agent control-hold WORKSPACE_ID --force --timeout 30000
yterminal-agent hot-restart --json
```

`verify` uses isolated temporary workspaces to exercise controller takeover,
all typed workspace mutations, PTY attach/input/resize/kill, checkpoint and
incremental replay, per-pane scrollback inheritance across a restart, plus
cwd/process/Git/file services. It cleans its temporary workspaces and sessions
even when a check fails. Pass `--socket PATH` to test an isolated daemon.
`control-hold` keeps one client-scoped lease alive with heartbeats; the shorter
`control` command only probes acquisition and releases the lease when the
command exits. Run `yterminal-agent help verify` for details.

`hot-restart` upgrades the agent **without closing your workspaces**. It
restarts the managed daemon even while shells are live (unlike `shutdown`, which
is gated on zero sessions). The shell processes do restart, but every pane
inherits its predecessor's checkpointed scrollback, so a reconnecting client
replays the prior screen; the GUI reconnects and re-spawns automatically and
coding agents resume. Run it on the daemon's machine (or over SSH for a remote
host); it manages the installed service, so it cannot target a custom `--socket`
daemon.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + D` | Split the focused pane to the right |
| `Cmd/Ctrl + Shift + D` | Split the focused pane downward |
| `Cmd/Ctrl + F` | Search the focused pane's scrollback (Enter / Shift+Enter to step, Esc to close) |
| `Cmd/Ctrl + Shift + W` | Close the focused pane |
| `Cmd/Ctrl + W` | Close the current tab |
| Any modifier + `Enter` | Insert a newline in Claude Code and compatible TUIs |
| Double-click a tab / workspace | Rename it |

## Configuration

Appearance, terminal, and updater settings are mirrored to a plain JSON file,
so you can version it, sync it across machines, or edit it by hand:

| OS | Path |
|---|---|
| macOS / Linux | `~/.config/yterminal/config.json` (honors `$XDG_CONFIG_HOME`) |
| Windows | `%APPDATA%\yterminal\config.json` |

```json
{
  "version": 2,
  "appearance": {
    "theme": "tokyo-night",
    "font": "jetbrains-mono",
    "fontSize": 14
  },
  "updates": {
    "autoDownload": false,
    "githubMirror": "",
    "httpProxy": ""
  }
}
```

- `theme` — one of: `tokyo-night`, `dracula`, `solarized-dark`, `gruvbox-dark`,
  `one-light`.
- `font` — a built-in preset id (`jetbrains-mono`, `menlo`, `cascadia`,
  `fira-code`, `sf-mono`) **or the exact name of any monospace font installed on
  your system** (e.g. `IBM Plex Mono`, `Hack`). The Settings font picker lists
  built-in presets plus the monospace fonts detected on this machine; unknown
  names fall back to a generic monospace.
- `fontSize` — integer px, clamped to `8`–`28`.

Changes made in the in-app **Settings** panel are written back to this file.
Conversely, when you sync the file in (git pull, Dropbox, a hand edit) the app
re-reads it and applies the changes the next time its window regains
focus. Unknown or invalid values fall back to defaults, so a malformed file
never breaks the app. The Settings panel shows the exact file path.

## Auto-update

yterminal checks GitHub for new releases on launch (5 seconds after the
window opens) and via **Settings → Update → Check for updates**. Downloads run
in the background; once a signed update has been downloaded and verified,
yterminal prompts you to restart and apply it. Enable silent automatic
downloads from the same page if you only want to see the final restart prompt.

The Update settings also accept a GitHub mirror (a URL prefix or a template
containing `{url}`) and an updater-only HTTP(S) proxy such as
`http://127.0.0.1:7890`. Both the manifest and release asset use the selected
route. A tampered or mismatched download is refused.

Linux **AppImage** and **.deb** builds can update in-app. A .deb is downloaded
and verified silently, then asks for administrator approval only after you
choose Install and restart. `.rpm` users continue to update via the system
package manager.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Backend | Rust (`portable-pty` in a per-user `yterminal-agent`) |
| Frontend | React 18 + TypeScript + Vite |
| State | Zustand (persisted) |
| Terminal | xterm.js + agent CBOR protocol (+ `addon-fit`, `addon-serialize`) |

## Architecture

```
Host → Workspace (sidebar)         <- agent SQLite authority + client cache
  └── Tab[] (per workspace)        <- workspace-store.ts
        └── PaneTree (recursive)   <- pane-tree.ts (split / remove / resize)
              └── PaneLeaf == agent session UUID <- xterm + local/SSH transport
```

### Source layout

| Path | Responsibility |
|---|---|
| `src/stores/workspace-store.ts` | Client projection/view state for agent-owned workspaces |
| `src-tauri/src/agent/` | PTY ownership, workspace authority, journal/checkpoints and Unix-socket server |
| `src/lib/host-transport.ts` | Shared local/SSH request, event, lease and reconnect transport |
| `src/stores/settings-store.ts` | Appearance settings (theme / font / size), persisted separately |
| `src/lib/terminal-manager.ts` | Owns live xterm.js + PTY instances; cache, attach/detach, fit, persist, live re-theme |
| `src/lib/pane-tree.ts` | Pure split-tree transforms (split, remove, resize, collect leaves) |
| `src/lib/scrollback.ts` | Local SQLite checkpoint/cache compatibility layer |
| `src/lib/themes.ts` | Built-in skins + font presets; palette → xterm theme + CSS vars |
| `src/components/` | `WorkspaceSidebar`, `TabBar`, `PaneRenderer`, `PaneTerminal`, `SettingsPanel` |

Terminals are **cached, not destroyed**, on tab/pane switch, so scrollback
survives. PTYs are spawned lazily the first time a pane becomes visible.

## Develop

```bash
npm install
npm run tauri:dev
```

Requires Node 18+ and Rust (stable).

Useful checks without launching the GUI:

```bash
npm run build        # type-check + bundle the frontend
npx tsc --noEmit     # type-check only
```

### Platform prerequisites

- **macOS**: Xcode Command Line Tools (`xcode-select --install`). No extra system libs needed.
- **Windows**: MSVC Build Tools + WebView2 (preinstalled on Win10/11).
- **Linux**: WebKitGTK 4.1 + GTK3, e.g. on Debian/Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
  ```

> The frontend (`npm run dev`, `npm run build`) and `cargo check` for non-GUI
> logic work anywhere. The full GUI (`tauri:dev`) needs the platform webview
> libs above — a headless server without GTK cannot launch the window.

## Releases

Release builds are produced automatically by GitHub Actions
(`.github/workflows/release.yml`). To cut a release, use the helper script — it
sets the version in all three manifests (`package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`) at once, then commits,
tags, and pushes:

```bash
scripts/bump-version.sh 0.2.0 --push   # bump + commit + tag v0.2.0 + push
```

Or do it in steps:

```bash
scripts/bump-version.sh 0.2.0          # just rewrite the manifests
scripts/bump-version.sh 0.2.0 --tag    # rewrite + commit + tag (no push)
```

Doing it by hand instead:

```bash
# bump the version in package.json, src-tauri/tauri.conf.json,
# and src-tauri/Cargo.toml so they match, then:
git tag v0.2.0
git push origin v0.2.0
```

Pushing a `v*` tag triggers the workflow, which builds native bundles on macOS
(Apple Silicon + Intel), Windows, and Linux, then publishes them to a GitHub
Release as a **draft**. Review the draft and hit publish. The workflow can also
be started manually from the Actions tab via `workflow_dispatch`.

Artifacts per platform:

| Platform | Bundles |
|---|---|
| macOS | `.dmg`, `.app` (universal — arm64 + x86_64) |
| Windows | `.msi`, NSIS `.exe` |
| Linux | `.AppImage`, `.deb` |

### Installing on macOS (unsigned)

The macOS bundles are **not yet code-signed or notarized**, so on first launch
Gatekeeper will block them with *"yterminal is damaged and can't be opened"* or
*"cannot be opened because the developer cannot be verified"*. The app is fine —
it just hasn't gone through Apple's signing/notarization yet. Use one of the
workarounds below.

1. Open the `.dmg` and drag **yterminal** into `/Applications`.
2. Clear the quarantine flag macOS puts on downloaded apps, then launch normally:

   ```bash
   xattr -dr com.apple.quarantine /Applications/yterminal.app
   ```

Without using the terminal: try to open the app once (it gets blocked), then go
to **System Settings → Privacy & Security**, scroll to the *Security* section,
and click **Open Anyway**. Right-clicking the app and choosing **Open** also
works on most macOS versions.

> Proper signing + notarization is on the roadmap; until then these steps are
> the intended way to run the macOS build.

## Roadmap

- [x] Workspace sidebar + tabs (MVP)
- [x] Split panes (recursive pane tree, draggable dividers, focus + shortcuts)
- [x] Persist scrollback — per-pane buffer snapshots via `@xterm/addon-serialize`
      into `localStorage`, replayed on launch (autosave + flush on close)
- [x] Settings / themes — appearance panel: 5 built-in skins, font family + size,
      applied live to all open terminals and the app chrome
- [x] Drag-and-drop reorder — tabs within a workspace and workspaces in the
      sidebar, via native HTML5 DnD
- [x] CI — automated multi-platform release builds via GitHub Actions
- [x] Scale scrollback to a Rust + SQLite store (unbounded history)
- [x] SSH remote workspace attach with daemon-owned persistent PTYs

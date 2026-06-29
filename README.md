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

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + D` | Split the focused pane to the right |
| `Cmd/Ctrl + Shift + D` | Split the focused pane downward |
| `Cmd/Ctrl + F` | Search the focused pane's scrollback (Enter / Shift+Enter to step, Esc to close) |
| `Cmd/Ctrl + Shift + W` | Close the focused pane |
| `Cmd/Ctrl + W` | Close the current tab |
| Double-click a tab / workspace | Rename it |

## Configuration

Appearance settings are mirrored to a plain JSON file, so you can version it,
sync it across machines, or edit it by hand:

| OS | Path |
|---|---|
| macOS / Linux | `~/.config/yterminal/config.json` (honors `$XDG_CONFIG_HOME`) |
| Windows | `%APPDATA%\yterminal\config.json` |

```json
{
  "version": 1,
  "appearance": {
    "theme": "tokyo-night",
    "font": "jetbrains-mono",
    "fontSize": 14
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
re-reads it and applies the new appearance the next time its window regains
focus. Unknown or invalid values fall back to defaults, so a malformed file
never breaks the app. The Settings panel shows the exact file path.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Backend | Rust (`tauri-plugin-pty` for PTY) |
| Frontend | React 18 + TypeScript + Vite |
| State | Zustand (persisted) |
| Terminal | xterm.js + `tauri-pty` (+ `addon-fit`, `addon-serialize`) |

## Architecture

```
Workspace (sidebar)                <- workspace-store.ts (Zustand, persisted)
  └── Tab[] (per workspace)        <- workspace-store.ts
        └── PaneTree (recursive)   <- pane-tree.ts (split / remove / resize)
              └── PaneLeaf == live shell  <- terminal-manager.ts (xterm + pty)
```

### Source layout

| Path | Responsibility |
|---|---|
| `src/stores/workspace-store.ts` | Workspace + tab + pane tree, all CRUD & reorder, persisted to `localStorage` |
| `src/stores/settings-store.ts` | Appearance settings (theme / font / size), persisted separately |
| `src/lib/terminal-manager.ts` | Owns live xterm.js + PTY instances; cache, attach/detach, fit, persist, live re-theme |
| `src/lib/pane-tree.ts` | Pure split-tree transforms (split, remove, resize, collect leaves) |
| `src/lib/scrollback.ts` | Per-pane buffer snapshots in `localStorage` (save / load / clear / prune) |
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
- [ ] SSH sessions

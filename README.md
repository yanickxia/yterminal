# yterminal

A workspace-first terminal emulator. Two-level model: a **workspace sidebar**, and **multiple tabs inside each workspace** — each tab is its own shell session.

Built from scratch (not a fork) using the same battle-tested stack as termul/maiTerm.

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Backend | Rust (`tauri-plugin-pty` for PTY) |
| Frontend | React 18 + TypeScript + Vite |
| State | Zustand (persisted) |
| Terminal | xterm.js + `tauri-pty` |

## Architecture

```
Workspace (sidebar)         <- workspace-store.ts (Zustand, persisted)
  └── Tab[] (per workspace) <- workspace-store.ts
        └── live shell      <- terminal-manager.ts (xterm + pty, instance cache)
```

- `src/stores/workspace-store.ts` — the workspace+tab tree, all CRUD, persisted to localStorage.
- `src/lib/terminal-manager.ts` — owns live xterm.js + PTY instances. Terminals are **cached, not destroyed**, on tab switch, so scrollback survives. PTYs are spawned lazily on first view.
- `src/components/` — `WorkspaceSidebar`, `TabBar`, `TerminalView`.

## Develop

```bash
npm install
npm run tauri:dev
```

Requires Node 18+ and Rust (stable).

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

## Roadmap

- [x] Workspace sidebar + tabs (MVP)
- [ ] Split panes (insert a Pane layer between Workspace and Tab)
- [ ] Persist scrollback (SQLite via Rust)
- [ ] SSH sessions
- [ ] Drag-and-drop reorder
- [ ] Settings / themes
```

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

## Roadmap

- [x] Workspace sidebar + tabs (MVP)
- [ ] Split panes (insert a Pane layer between Workspace and Tab)
- [ ] Persist scrollback (SQLite via Rust)
- [ ] SSH sessions
- [ ] Drag-and-drop reorder
- [ ] Settings / themes
```

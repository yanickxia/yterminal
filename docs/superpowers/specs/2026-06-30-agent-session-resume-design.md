# Agent Session Resume on Tab Restore — Design Spec

**Date:** 2026-06-30
**Status:** Draft v1
**Scope:** When a tab is restored on app relaunch, if a coding agent (Claude Code / Codex / OpenCode) was running in a pane, automatically respawn that agent and resume its prior session by session id, preserving the original launch command (including shell aliases).

## Goal

yterminal already restores tab/pane structure and scrollback on relaunch, and respawns the login shell in the saved cwd. But a coding agent that was running inside a pane is gone — the user lands at a fresh shell prompt. We want:

1. **Detect** which agent (if any) was live in a pane when the app was last running, and capture its on-disk **session id** so the agent can be resumed.
2. **Remember the launch command as typed**, so an alias (`cc`, `cx`, …) the user invoked is replayed verbatim rather than a canonical binary path.
3. On restore, **respawn the agent with the resume flags + session id**, run from the pane's saved cwd so the agent's cwd↔session binding holds.

Non-goals (deferred):

- Resuming non-agent long-running TUIs (vim, tmux, btop). Only the three named agents.
- Restoring in-flight agent UI state beyond what the agent's own `--resume` reconstructs.
- A settings toggle / per-agent enable. Always-on, best-effort, silent on failure.
- Windows process-tree introspection (no `/proc`); the feature degrades to "no agent detected" there, same as `process_cwd`.

## Agent matrix (verified semantics)

| Agent | Resume command template | Session store | Id format | "Current" id heuristic |
|---|---|---|---|---|
| Claude Code | `<cmd> --resume <id>` | `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl` | v4 UUID (file stem; prefer `sessionId` field inside) | newest-mtime `*.jsonl` in the **cwd's** project dir |
| Codex | `<cmd> resume <id>` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (honors `$CODEX_HOME`) | UUID trailing the rollout filename | newest-mtime `rollout-*.jsonl`, parse trailing UUID |
| OpenCode | `<cmd> --session <id>` | `~/.local/share/opencode/.../storage/session/...` (honors `$OPENCODE_DATA_DIR`) | `ses_<ULID>` | newest-mtime session json (ULID is time-sortable) |

`<cmd>` is the literal command the user typed (could be an alias). Claude's id binds to the original cwd, so resume is always launched from the pane's saved cwd; the others are cwd-tolerant but we still launch from the saved cwd for consistency.

## Architecture

Three concerns, kept separate so the testable logic stays pure:

### 1. Detection — does a pane have a live agent, and what is it?

The login shell's child process tree is the source of truth. Add a Rust command:

```
pane_process_tree(pid: u32) -> Vec<ProcInfo>   // ProcInfo { pid, ppid, comm, argv: Vec<String> }
```

- **Linux:** walk `/proc`, read `/proc/<pid>/stat` (ppid) and `/proc/<pid>/cmdline` (NUL-split argv); collect every descendant of `pid`.
- **macOS:** `ps -axo pid=,ppid=,command=` once, parse, build the descendant set. (`ps` is universally present; avoids a libproc/unsafe dep, same rationale as the `lsof` choice in `process_cwd`.)
- **Windows / other:** return empty (feature inert).

A **pure** TS classifier `detectAgent(tree, shellPid)` (in `src/lib/agent-detect.ts`) matches each descendant's argv against agent signatures. Matching is argv-based, not comm-based, so a node-wrapper (`node …/cli.js`) or an alias that expands to a different binary is still recognized:

- Claude: argv contains a token whose basename is `claude`, OR an arg path ending in `claude-code/cli.js` / `@anthropic-ai/claude-code`.
- Codex: basename `codex` (and not the `codex resume` we ourselves injected — irrelevant at detect time).
- OpenCode: basename `opencode`.

Returns `{ agent: "claude"|"codex"|"opencode", pid } | null` (deepest/most-recent match wins).

### 2. Alias capture — what did the user type to launch it?

xterm doesn't expose shell history, and the running process's argv shows the *resolved* binary, not the alias. So we capture the user's submitted command line at the terminal layer.

A pure reducer `src/lib/input-line.ts`:

```
feedInput(state, chunk) -> { state, submittedLine?: string }
```

It accumulates printable keystrokes the user sends toward the pty, handles CR (submit → emit the trimmed line, reset), and basic editing (BS/DEL, Ctrl-U, Ctrl-C reset). `terminal-manager` keeps one reducer per pane fed from the existing `term.onData` hook. On each submitted line, if its first token matches a known agent launcher (by the same classifier's name table, including common aliases the user has used before in this session), we stash it as the pane's `pendingAgentCommand`. When detection later confirms an agent is live, we pair the detected agent with the most-recent matching typed command to recover the alias.

This is best-effort: if capture missed (agent launched before this version, or via a script), we fall back to the canonical binary name (`claude`/`codex`/`opencode`).

### 3. Persistence + resume

Extend `PaneLeaf` (in `src/lib/types.ts`) with an optional field:

```ts
agent?: {
  kind: "claude" | "codex" | "opencode";
  command: string;     // literal launch token, e.g. "cc" or "claude"
  sessionId: string;   // resolved at snapshot time
}
```

This rides the existing Zustand `localStorage` persist (it's small and JSON-shaped — fits the workspace-store layer). A store action `setPaneAgent(ws, tab, pane, agent | undefined)` writes/clears it, mirroring `updatePaneCwd`.

**Snapshot path:** the existing 15s autosave tick (and `onCloseRequested`) already calls `snapshotAllCwds()`. Add `snapshotAllAgents()` alongside: for each live session, call `pane_process_tree(pid)` → `detectAgent`; if an agent is live, call a Rust command `agent_session_id(kind, cwd)` to resolve the current session id, pair with the captured command, and write it into the store. If no agent is live, clear any stale `agent` on that leaf.

```
agent_session_id(kind: String, cwd: String) -> Option<String>
```

implements the per-agent disk heuristics in the matrix above.

**Restore path:** `getOrCreateSession` already spawns the shell in the saved cwd and replays scrollback. After wiring the shell, if `leaf.agent` is set, build the resume command via a pure `buildResumeCommand(agent)` (in `agent-detect.ts`) and **type it into the shell** once the shell is ready. We inject on the first OSC 7 prompt (the shell signals readiness), with a fixed-timeout fallback if no OSC 7 arrives (bare shells). Injection = `pty.write(cmd + "\r")`. Running through the shell (rather than spawning the binary directly) is what lets an alias resolve.

`buildResumeCommand`:
- claude → `${command} --resume ${sessionId}`
- codex → `${command} resume ${sessionId}`
- opencode → `${command} --session ${sessionId}`

Session id is shell-quoted defensively (ids are `[A-Za-z0-9_-]`, but quote anyway).

## Files touched

- `src/lib/types.ts` — add `PaneLeaf.agent`.
- `src/lib/agent-detect.ts` (new) — pure: `detectAgent`, `classifyCommandToken`, `buildResumeCommand`, agent signature table. + tests.
- `src/lib/input-line.ts` (new) — pure submitted-line reducer. + tests.
- `src/lib/pty.ts` — expose `panePid`/typed input nothing new; reuse `write`.
- `src/lib/terminal-manager.ts` — per-pane input reducer; `snapshotAllAgents`; resume injection in `getOrCreateSession`/`attachSession`; capture launch commands.
- `src/lib/agent.ts` (new) — thin invoke wrappers `paneProcessTree`, `agentSessionId` (mockable, mirrors `pty.ts`/`opener.ts`).
- `src/stores/workspace-store.ts` — `setPaneAgent` action + persist (bump version to 3, migrate is a no-op add).
- `src-tauri/src/main.rs` — `pane_process_tree`, `agent_session_id` commands + handler registration.
- `CLAUDE.md` — document the new restore behavior + the two new commands.

## Invariants / risks

- **Never inject into a pane that wasn't restored-from-persist.** Resume injection only fires when `leaf.agent` was loaded from storage at startup, never for live splits/new tabs — otherwise switching tabs could re-type the command. Guard: a per-pane `resumeInjected` flag set on first spawn.
- **Detection must not misclassify the resume command we inject** as fresh user intent (would loop). The input reducer ignores writes that didn't originate from `term.onData` (our injection uses `pty.write` directly, bypassing the reducer).
- **No terminal content is logged** (consistent with `logger.rs` policy) — argv from `pane_process_tree` could contain secrets, so the snapshot path logs only the agent kind + a redacted id length, never argv.
- Blocking syscalls stay off the async pool: `pane_process_tree` and `agent_session_id` are filesystem/`ps` reads; expose them as **sync** `#[tauri::command]` (run on Tauri's sync command pool, same as `process_cwd`).

# Agent hot-restart (巧升级) design

Date: 2026-07-19
Branch: feat/ssh-remote-workspaces

## Problem

Upgrading the `yterminal-agent` daemon today forces the user to close every
workspace first. Two paths exist and both are unsatisfactory:

- `shutdown` (protocol) requires `drain on` **and zero live sessions** — so it
  is blocked whenever any shell is running. This is the gate the user hits.
- `restart` (systemd/launchd) has no gate but SIGTERMs the daemon. Every PTY is
  a direct child of the daemon, so the shells die. A respawned session gets a
  **new session id with an empty journal**, so on any fresh attach (CLI, a
  reopened GUI, a remote reconnect) the pane's scrollback is gone.

A GUI that stays open happens to preserve its xterm buffer across reconnect
(the `AgentPty`/`Terminal` JS objects survive; the replacement session attaches
with `after_seq=0, reset:false` and appends the new shell **below** the retained
buffer). But that is incidental and does not cover reopened or remote clients.

## Goal (chosen route: "巧升级")

Allow the daemon to restart **with live sessions present**, and make the
respawned session replay the **prior pane's persisted scrollback** so every
client — local, reopened, remote, and the CLI verifier — sees history restored.
Shell processes DO restart (unified restart, no active-task detection); the
workspace/tab/pane structure and scrollback survive; agents (claude/codex)
auto-resume through the existing resume path.

Non-goals: keeping live shell PIDs alive across upgrade (FD handoff /
exec-in-place — rejected: no cross-platform `PR_SET_CHILD_SUBREAPER`, macOS
cannot transfer child reaping). GUI button (deferred; CLI first).

## Key facts established from the code

- `sessions` rows carry `pane_id`; `output_chunks` (journal) and `checkpoints`
  are persisted continuously — every output append mirrors to SQLite
  (`repository.rs` journal writer), so the persisted journal is always current
  even under an abrupt SIGTERM. No final flush is required.
- On startup `AgentRepository::open` marks previously-`running` sessions
  `'lost'` but retains their rows, journal, and checkpoints.
- `replay_plan` (session_manager.rs): an attach with `after_seq=None` and a
  checkpoint whose `through_seq >= journal_start` replays `reset:true` +
  checkpoint ANSI + journal tail. This is exactly what a fresh reconnect/CLI
  attach does, so seeding a checkpoint on the respawned session is sufficient to
  surface inherited scrollback with no client cooperation.
- Journal reads/writes are serialized on one writer thread via `JournalOp`; any
  new read that must observe pending checkpoint writes has to go through that
  same channel.

## Design

### 1. Repository: inherit-checkpoint read (pure SQL, ordered on the writer)

Add `JournalOp::LoadPaneInheritance { workspace_id, pane_id, exclude_session_id,
reply }` and a public async `load_pane_inheritance(workspace_id, pane_id,
exclude_session_id) -> Option<PaneInheritance>` where
`PaneInheritance { through_seq: u64, ansi: Vec<u8> }`.

Writer logic: pick the most recent session for `(workspace_id, pane_id)` that is
**not** `exclude_session_id` and has a checkpoint row, ordered by
`sessions.updated_at DESC`, and return its `checkpoints.through_seq` + `ansi`.
Returns `None` when the pane has no prior checkpoint. Runs on the journal writer
thread so it is ordered after any queued checkpoint write.

### 2. session_manager: seed the respawned session

In `spawn`, immediately after building the live `ManagedSession` (before
returning), call `load_pane_inheritance(workspace_id, pane_id, new_id)`. If a
checkpoint is found:

- set `data.checkpoint = Some(Checkpoint { through_seq: BASE, ansi })`
- set `data.head_seq = BASE`

where `BASE` is the inherited `through_seq` (kept as-is). The live PTY output
then sequences starting at `BASE`, so an `after_seq=None` attach yields
`reset:true` + inherited ANSI + subsequent live output — the prior screen with
the new shell's prompt appended, exactly matching the GUI-preserved-buffer case.

Seeding is best-effort: a read error logs and leaves the session un-seeded
(fresh empty scrollback) rather than failing the spawn.

Idempotency interaction: `spawn` treats `(workspace,pane)` with a still-`Running`
session as attach-to-existing (returns early). Inheritance only runs on a
genuinely new spawn, so a reopened GUI attaching to a live session is unaffected.

### 3. CLI: `hot-restart` command

`yterminal-agent hot-restart [--timeout MS] [--json] [--socket PATH]`

1. Probe the daemon (`Ping`) so we fail fast if it is not running.
2. Snapshot the pre-restart session set (`ListSessions`) for reporting.
3. `service::restart()` (systemctl/launchctl restart) — no zero-session gate.
4. `wait_until_running` then re-`Ping`; report `{restarted, versionBefore,
   versionAfter, sessionsBefore}`.

`hot-restart` is a local service operation (like `restart`): run it on the
daemon's machine, or over SSH for a remote host. It is intentionally NOT a
protocol request — the frontend/remote reconnect logic already recovers.

Help text + README updated. `--socket` custom daemons cannot be service-managed,
so `hot-restart` on a non-default socket errors with actionable guidance.

### 4. verify: prove inheritance end-to-end

Add a `hot-restart-scrollback-inheritance` check to `verify` that does NOT
require a real service restart (verify runs against isolated daemons/sockets):

1. spawn a session in a temp workspace, write a unique marker line, wait for it
   in the live output, force a checkpoint (drive CheckpointBegin/Chunk/End with
   a serialized ANSI screen containing the marker).
2. kill the session (simulating the shell dying on restart) — its row becomes
   `exited` but retains its checkpoint.
3. spawn again on the **same pane_id**; attach with `after_seq=null`.
4. assert the replay contains the marker (inherited from the prior checkpoint).

This exercises the exact inheritance seam without touching systemd, so it is
safe in `verify` and runs identically local and remote.

## Testing

- Rust unit test in `repository.rs`: `load_pane_inheritance` picks the newest
  prior checkpoint for a pane, excludes the current session, returns `None` when
  absent, and is ordered after a queued checkpoint.
- Rust unit test in `session_manager.rs` (or via the existing daemon test
  harness): a respawn on the same pane replays a prior checkpoint's bytes.
- `verify` gains the inheritance check (integration-level, runs in CI-free
  local + remote runs).
- Manual: local isolated daemon `hot-restart`, then remote `10.211.55.3`
  `hot-restart` end-to-end.

## Files touched

- `src-tauri/src/agent/repository.rs` — new op + read + unit test
- `src-tauri/src/agent/session_manager.rs` — seed on spawn
- `src-tauri/src/bin/yterminal-agent.rs` — `hot-restart` command, verify check,
  help text
- `README.md` — document `hot-restart`
- `scripts/dev-agent-remote.sh` — exercise `hot-restart` in the remote flow

## Post-implementation: latent race found by remote verification

Extending `verify` and running it repeatedly against the **busy remote service
daemon** surfaced an intermittent (~37%) failure at the pre-existing
`spawn-session-bind` check. Systematic debugging (DIAG instrumentation on the
remote daemon) caught the root cause: `SpawnSession`'s `BindSession` workspace
mutation was failing with **"database is locked"** and being **silently
swallowed** (`if let Ok(workspace) = …`), leaving the session spawned but
unbound.

Cause: `apply_workspace_operation_inner` opened a **DEFERRED** transaction
(rusqlite default) that reads (`load_workspace`) then upgrades to a write
(`UPDATE`). In WAL mode, a read→write upgrade that collides with the journal
writer's separate connection returns `SQLITE_BUSY` **without honoring
`busy_timeout`**, so the 5s timeout never applied. Only reproducible under
sustained journal writes from live sessions — hence remote-only.

Fix (two layers): the two main-connection write transactions now use
`BEGIN IMMEDIATE` (`transaction_with_behavior(TransactionBehavior::Immediate)`)
so they take the write lock up front and `busy_timeout` waits out the journal
writer's short transaction; and `SpawnSession` now **propagates** a bind failure
(killing the orphan session and returning `bind_session_failed`) instead of
silently returning an unbound session. Verified: the same remote daemon that
failed ~37% now passes 15/15 settled and 12/12 under steady concurrent
output+OSC load.


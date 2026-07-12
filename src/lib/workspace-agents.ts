// Pure roll-up from per-pane agent snapshots + attention flags + activity flags
// + hook-reported run-state to the coding agents running inside a workspace. No
// React / no store — just a tree walk so the workspace status bar, the sidebar
// rows, and their unit tests share one implementation. Mirrors attention.ts.
//
// Signals feeding this (all maintained elsewhere):
//   * PaneLeaf.agent — set by terminal-manager's snapshotAllAgents() every ~15s
//     when a coding agent (claude/codex/opencode) is detected in a pane's
//     process tree; cleared when the agent exits. Presence == "an agent runs here".
//   * the `waiting` set (attention-store) — pane ids that rang the terminal bell
//     while unfocused (an agent pausing for input / finishing / erroring).
//   * the `active` set (activity-store) — pane ids that produced PTY output in
//     the last ~800ms == "the agent is streaming output right now".
//   * the `everActive` set (activity-store) — pane produced output at least once.
//   * the hook-state map (hook-state-store) — the AUTHORITATIVE run-state a
//     Claude Code agent reports via the OSC 777 hooks we install: working / idle
//     / permission (see agent-hook-osc.ts). Present only for hook-enabled Claude
//     agents; Codex/OpenCode and missed hooks fall back to the heuristic below.
//
// An agent pane is classified in precedence order (see classify()):
//   "attention" — bell rang (`waiting`) OR hook says `permission` (blocked on you)
//   "executing" — live output right now (`active`, beats stale hook state) OR
//                 hook says `working`
//   "waiting"   — hook says `idle`, OR heuristic (everActive && !active) — the
//                 agent worked and fell silent, i.e. it's your turn. Suppressed
//                 on the focused pane (you're already looking) — same rule the
//                 bell path applies via isPaneFocused.
//   "idle"      — none of the above (freshly launched / restored, never active).

import type { AgentKind, Workspace } from "./types";
import type { AgentHookState } from "./agent-hook-osc";
import { collectLeaves } from "./pane-tree";

// Re-export so the status-bar UI can pull the agent-kind union from the same
// module it gets the summary from.
export type { AgentKind };

/** Run-state of a single agent pane. */
export type AgentRunState = "executing" | "waiting" | "idle" | "attention";

/** One coding agent detected in a workspace, with its owning tab/pane. */
export interface WorkspaceAgentEntry {
  kind: AgentKind;
  /** the launch command as the user typed it (alias-preserving). */
  command: string;
  tabId: string;
  /** display label for the owning tab (customName wins over auto name). */
  tabName: string;
  tabIcon?: string;
  /** the pane id running the agent — used to jump straight to it. */
  paneId: string;
  state: AgentRunState;
}

/** Aggregate summary for a workspace's status bar. */
export interface WorkspaceAgentSummary {
  entries: WorkspaceAgentEntry[];
  /** total agents running in the workspace. */
  total: number;
  /** how many are blocked waiting for the operator. */
  attention: number;
  /** how many are actively producing output right now. */
  executing: number;
  /** how many worked earlier and are now silent, waiting for input. */
  waiting: number;
}

/** Classify one agent pane from the ephemeral signals + any hook-reported state.
 *
 * Hook state (from a Claude Code agent's lifecycle hooks) is authoritative when
 * present, but with one override: a pane producing output *right now* (`active`)
 * is always `executing`, so a stale hook `idle`/`working` can't mask live work.
 *
 * `focusedPaneId` is the pane the user is currently looking at. The focused pane
 * is never reported as `waiting` — "it's your turn" is pointless when you're
 * already staring at it (same rule the bell path applies via `isPaneFocused`).
 * Focus does NOT suppress `executing` or `attention`; it only mutes the passive
 * waiting nag, dropping the pane to `idle`. */
function classify(
  paneId: string,
  waiting: Set<string>,
  active: Set<string>,
  everActive: Set<string>,
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): AgentRunState {
  const hook = hookState?.get(paneId);
  // Blocked on the user: an explicit bell, or a hook permission prompt.
  if (waiting.has(paneId) || hook === "permission") return "attention";
  // Live output beats any (possibly stale) hook state.
  if (active.has(paneId)) return "executing";
  if (hook === "working") return "executing";
  // "It's your turn": hook idle, or the heuristic (worked then fell silent).
  // Suppressed on the focused pane.
  const wantsWaiting =
    hook === "idle" || (hook === undefined && everActive.has(paneId));
  if (wantsWaiting && paneId !== focusedPaneId) return "waiting";
  return "idle";
}

/**
 * Roll every running agent in a workspace up into a flat, stably-ordered list
 * (workspace → tab → left-to-right pane order) plus aggregate counts. File
 * tabs are skipped (their inert leaf never runs a shell). Each agent pane is
 * classified attention > executing > idle (see module header).
 */
export function workspaceAgentSummary(
  workspace: Workspace | undefined,
  waiting: Set<string>,
  active: Set<string> = new Set(),
  everActive: Set<string> = new Set(),
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): WorkspaceAgentSummary {
  const entries: WorkspaceAgentEntry[] = [];
  if (!workspace)
    return { entries, total: 0, attention: 0, executing: 0, waiting: 0 };
  let attention = 0;
  let executing = 0;
  let waitingCount = 0;
  for (const tab of workspace.tabs) {
    if (tab.file) continue;
    for (const leaf of collectLeaves(tab.root)) {
      if (!leaf.agent) continue;
      const state = classify(
        leaf.id,
        waiting,
        active,
        everActive,
        focusedPaneId,
        hookState
      );
      if (state === "attention") attention++;
      else if (state === "executing") executing++;
      else if (state === "waiting") waitingCount++;
      entries.push({
        kind: leaf.agent.kind,
        command: leaf.agent.command,
        tabId: tab.id,
        tabName: tab.customName?.trim() || tab.name,
        tabIcon: tab.icon,
        paneId: leaf.id,
        state,
      });
    }
  }
  return {
    entries,
    total: entries.length,
    attention,
    executing,
    waiting: waitingCount,
  };
}

/**
 * Per-workspace agent status for the sidebar rows. One entry per workspace that
 * has at least one running agent, carrying the total agent count and the single
 * most-urgent state across its panes (attention > executing > idle) so a row
 * can paint one dot. Independent of which workspace is active, so every row can
 * show its own indicator at a glance (cmux-style).
 */
export interface WorkspaceAgentStatus {
  /** total agents running in the workspace. */
  total: number;
  /** the most urgent state among the workspace's agent panes. */
  state: AgentRunState;
}

/**
 * Map each workspace id to its aggregate agent status. Only workspaces with an
 * agent that is executing, waiting for input, or blocked on the bell are
 * included: an agent that has *never* produced output this session (freshly
 * launched / restored and dormant, classified `idle`) is omitted, so `.has(id)`
 * gates the dot to "an agent is working / waiting on you" rather than merely
 * "an agent exists". Workspaces whose agents are all idle are dropped entirely.
 */
export function workspacesAgentStatus(
  workspaces: Workspace[],
  waiting: Set<string>,
  active: Set<string>,
  everActive: Set<string> = new Set(),
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): Map<string, WorkspaceAgentStatus> {
  const out = new Map<string, WorkspaceAgentStatus>();
  const rank: Record<AgentRunState, number> = {
    idle: 0,
    waiting: 1,
    executing: 2,
    attention: 3,
  };
  for (const ws of workspaces) {
    let total = 0;
    let best: AgentRunState = "idle";
    for (const tab of ws.tabs) {
      if (tab.file) continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (!leaf.agent) continue;
        total++;
        const state = classify(
          leaf.id,
          waiting,
          active,
          everActive,
          focusedPaneId,
          hookState
        );
        if (rank[state] > rank[best]) best = state;
      }
    }
    // Only surface a dot when an agent is actually running (executing), waiting
    // on the user, or ringing the bell. All-idle workspaces show nothing.
    if (total > 0 && best !== "idle") out.set(ws.id, { total, state: best });
  }
  return out;
}

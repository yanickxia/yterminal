// Pure agent detection + resume-command logic. No IO, no Tauri — everything
// here is a deterministic transform over process argv and command strings, so
// it's fully unit-testable. The IO side (reading the process tree, resolving
// session ids) lives in agent.ts; the orchestration in terminal-manager.ts.

import type { AgentKind, PaneAgent } from "./types";

/** One process in a pane's descendant tree, as returned by the Rust backend. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  argv: string[];
}

/** basename of a path-or-token, stripping a trailing platform suffix. */
function basename(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  let name = slash === -1 ? token : token.slice(slash + 1);
  // strip a Windows-style executable suffix so "claude.exe" matches "claude".
  name = name.replace(/\.(exe|cmd|bat)$/i, "");
  return name;
}

/**
 * Classify a single argv (the full command line of one process) as an agent,
 * or null. Matching is intentionally argv-wide rather than argv[0]-only: these
 * CLIs are frequently launched through a node wrapper
 * (`node .../claude-code/cli.js`) or a shim, so argv[0] is `node`, not the
 * agent. We therefore look at every token.
 */
export function classifyArgv(argv: string[]): AgentKind | null {
  for (const raw of argv) {
    const base = basename(raw).toLowerCase();
    if (base === "claude") return "claude";
    if (base === "codex") return "codex";
    if (base === "opencode") return "opencode";
    // node-wrapper / installed-package path forms.
    const lower = raw.toLowerCase();
    if (
      lower.includes("@anthropic-ai/claude-code") ||
      lower.includes("claude-code/cli")
    ) {
      return "claude";
    }
    if (lower.includes("@openai/codex") || lower.includes("/codex/")) {
      return "codex";
    }
    if (lower.includes("opencode-ai") || lower.includes("/opencode/")) {
      return "opencode";
    }
  }
  return null;
}

/**
 * Classify the FIRST token of a command line the user typed. This is how we
 * recognize the launch command (possibly an alias). We only trust an exact
 * basename match here — substring matching on user input would misfire on e.g.
 * `git codex-review`. Aliases are handled by the caller pairing this with a
 * live detection; an unknown token returns null.
 */
export function classifyCommandToken(token: string): AgentKind | null {
  const base = basename(token).toLowerCase();
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "opencode") return "opencode";
  return null;
}

/**
 * Given a pane's process tree and the shell pid that roots it, return the
 * detected agent kind (and the matching process), or null. When several
 * descendants match, the deepest one wins — that's the agent the user is
 * actually interacting with (vs. a parent wrapper).
 */
export function detectAgent(
  tree: ProcInfo[]
): { kind: AgentKind; pid: number } | null {
  // depth = distance from any root in this (already shell-rooted) subtree.
  const byPid = new Map<number, ProcInfo>();
  for (const p of tree) byPid.set(p.pid, p);
  function depth(p: ProcInfo): number {
    let d = 0;
    let cur: ProcInfo | undefined = p;
    const seen = new Set<number>();
    while (cur && byPid.has(cur.ppid) && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
      d++;
    }
    return d;
  }
  let best: { kind: AgentKind; pid: number; depth: number } | null = null;
  for (const p of tree) {
    const kind = classifyArgv(p.argv);
    if (!kind) continue;
    const d = depth(p);
    if (!best || d > best.depth) best = { kind, pid: p.pid, depth: d };
  }
  return best ? { kind: best.kind, pid: best.pid } : null;
}

/** Shell-quote a token that should already be id-safe, defensively. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_.\-/]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the shell command line that resumes an agent's prior session. Run
 * through the user's shell (not spawned directly) so an alias in `command`
 * resolves naturally.
 *
 *   claude   -> `<cmd> --resume <id>`
 *   codex    -> `<cmd> resume <id>`
 *   opencode -> `<cmd> --session <id>`
 */
export function buildResumeCommand(agent: PaneAgent): string {
  const cmd = agent.command.trim() || agent.kind;
  const id = shellQuote(agent.sessionId);
  switch (agent.kind) {
    case "claude":
      return `${cmd} --resume ${id}`;
    case "codex":
      return `${cmd} resume ${id}`;
    case "opencode":
      return `${cmd} --session ${id}`;
  }
}

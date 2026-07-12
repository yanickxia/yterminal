// Pure parser for the agent-status OSC 777 payload that Claude Code emits via
// the hooks we install (see agent-hooks.ts + install_claude_hooks in main.rs).
// No IO — just a string transform so it's unit-testable; the DOM side
// (registerOscHandler) lives in terminal-manager.ts.
//
// xterm hands an OSC 777 handler the payload *between* the `]777;` introducer
// and the ST/BEL terminator. Our hooks send `notify;yt-agent;<state>`, e.g.
// `notify;yt-agent;working`. `<state>` is one of working / idle / permission
// (a live run-state we store) or `ended` (the agent session finished — the
// caller clears the pane's state and falls back to the heuristic).

/** A live agent run-state reported by a hook. `ended` is a clear signal. */
export type AgentHookState = "working" | "idle" | "permission";

/** The marker every yterminal hook payload carries, distinguishing our OSC 777
 * notifications from a real desktop notification some other program sends. */
const MARKER = "yt-agent";

/**
 * Parse an OSC 777 payload. Returns the reported run-state, the string
 * `"ended"` when the agent session finished, or null when the payload is not
 * one of ours (a genuine `notify;...` from another tool) — the caller then
 * passes the sequence through untouched.
 */
export function parseAgentHookOsc(
  data: string
): AgentHookState | "ended" | null {
  // Expected shape: notify;yt-agent;<state>
  const parts = data.split(";");
  if (parts.length < 3) return null;
  if (parts[0] !== "notify" || parts[1] !== MARKER) return null;
  const state = parts[2];
  switch (state) {
    case "working":
    case "idle":
    case "permission":
      return state;
    case "ended":
      return "ended";
    default:
      return null;
  }
}

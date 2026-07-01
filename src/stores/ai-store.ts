// ai-store: transient chat transcript for the AI sidebar. Not persisted — the
// conversation is scoped to the running session (like the terminal itself).
// Provider config lives in settings-store; this store only holds the running
// exchange + request status.
//
// Two modes:
//   • chat (default): streaming Q&A. `send` streams deltas into the pending
//     assistant turn via `aiChatStream`; a `stop()` control cancels it.
//   • agent: the model may drive the terminal. `send` runs a tool loop
//     (`aiChatTools`), and each `run_command` tool call is gated behind a
//     per-command approval before it's executed via `runCommandInPane`.

import { create } from "zustand";
import {
  aiChatStream,
  aiCancel,
  aiChatTools,
  type AiMessage,
  type AiTool,
} from "../lib/ai";
import { activeAiProvider, type AiProvider } from "../stores/settings-store";
import { runCommandInPane } from "../lib/terminal-manager";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** true while an assistant turn is awaiting/streaming the provider response */
  pending?: boolean;
  /** set on an assistant turn when the request failed */
  error?: boolean;
  /** for tool turns: the shell command that was run */
  command?: string;
  /** for tool turns: the command's exit code (null when unknown) */
  exitCode?: number | null;
}

/** A command the agent wants to run, awaiting the user's approval. */
export interface PendingApproval {
  /** transient id, unique per prompt */
  id: string;
  /** the shell command the model proposed */
  command: string;
}

interface AiState {
  turns: ChatTurn[];
  sending: boolean;
  /** whether the right sidebar is open */
  open: boolean;
  /** when true, `send` runs the terminal-driving agent loop */
  agentMode: boolean;
  /** set while a command is awaiting approval (agent mode); else null */
  pendingApproval: PendingApproval | null;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  setAgentMode: (on: boolean) => void;
  clear: () => void;
  /** cancel the in-flight streaming reply (chat mode) */
  stop: () => void;
  /** approve or deny the pending agent command */
  resolveApproval: (approved: boolean) => void;
  /**
   * Send a user message. `context`, when provided, is the captured terminal
   * text; it's prepended as a system message on the wire but shown to the user
   * as a compact chip rather than dumped into the transcript. `paneId` is the
   * active pane the agent runs commands in (agent mode only).
   */
  send: (prompt: string, context?: string, paneId?: string) => Promise<void>;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

const SYSTEM_PROMPT =
  "You are an assistant embedded in a terminal emulator. The user may attach " +
  "their terminal output as context. Be concise and practical; when you " +
  "suggest shell commands, format them in fenced code blocks.";

const AGENT_SYSTEM_PROMPT =
  "You are an agent embedded in a terminal emulator. You can run shell " +
  "commands in the user's active terminal via the `run_command` tool to " +
  "accomplish their request. Each command is shown to the user for approval " +
  "before it runs, so prefer small, safe, well-scoped commands and explain " +
  "what you're doing. Inspect state before mutating it. When the task is " +
  "complete, reply with a short summary and do not call the tool again. Be " +
  "concise.";

/** JSON-Schema tool the agent uses to run one shell command in the pane. */
const RUN_COMMAND_TOOL: AiTool = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a single shell command in the user's active terminal pane and " +
      "return its captured stdout/stderr and exit code. The command runs in " +
      "the live shell (its cwd and environment persist between calls).",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/** Max agent tool-loop iterations, so a misbehaving model can't loop forever. */
const MAX_AGENT_STEPS = 12;

// The pending-approval resolver lives outside zustand state (it's a function,
// not serializable). The agent loop awaits this promise; the UI's
// resolveApproval flips it.
let approvalResolver: ((approved: boolean) => void) | null = null;

// The in-flight streaming id, so `stop()` can cancel it. Module-level rather
// than state because only the store internals need it.
let currentStreamId: string | null = null;

export const useAiStore = create<AiState>((set, get) => ({
  turns: [],
  sending: false,
  open: false,
  agentMode: false,
  pendingApproval: null,
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setAgentMode: (on) => set({ agentMode: on }),
  clear: () => set({ turns: [] }),

  stop: () => {
    if (currentStreamId) {
      aiCancel(currentStreamId);
      currentStreamId = null;
    }
  },

  resolveApproval: (approved) => {
    const r = approvalResolver;
    approvalResolver = null;
    set({ pendingApproval: null });
    if (r) r(approved);
  },

  send: async (prompt, context, paneId) => {
    const text = prompt.trim();
    if (!text || get().sending) return;

    const provider = activeAiProvider();
    const agentMode = get().agentMode;
    const userTurn: ChatTurn = { id: newId(), role: "user", content: text };
    const assistantTurn: ChatTurn = {
      id: newId(),
      role: "assistant",
      content: "",
      pending: true,
    };
    set((s) => ({
      turns: [...s.turns, userTurn, assistantTurn],
      sending: true,
    }));

    if (!provider) {
      set((s) => ({
        sending: false,
        turns: s.turns.map((t) =>
          t.id === assistantTurn.id
            ? {
                ...t,
                pending: false,
                error: true,
                content:
                  "No AI provider configured. Open Settings → AI to add one.",
              }
            : t
        ),
      }));
      return;
    }

    // Build the wire messages from the prior transcript (excluding the two we
    // just optimistically appended) plus a system prompt and optional context.
    const priorTurns = get().turns.filter(
      (t) =>
        t.id !== assistantTurn.id &&
        !t.pending &&
        !t.error &&
        t.role !== "tool"
    );
    const systemPrompt = agentMode ? AGENT_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const wire: AiMessage[] = [{ role: "system", content: systemPrompt }];
    if (context && context.trim()) {
      wire.push({
        role: "system",
        content:
          "Current terminal context (most recent output):\n\n" +
          "```\n" +
          context.trim() +
          "\n```",
      });
    }
    for (const t of priorTurns) {
      // the just-appended user turn is included here (it's not pending)
      wire.push({ role: t.role, content: t.content });
    }

    if (agentMode) {
      await runAgentLoop(provider, wire, assistantTurn.id, paneId);
      return;
    }

    // --- chat mode: stream the reply -----------------------------------------
    await new Promise<void>((resolve) => {
      currentStreamId = aiChatStream(provider, wire, {
        onDelta: (delta) => {
          set((s) => ({
            turns: s.turns.map((t) =>
              t.id === assistantTurn.id
                ? { ...t, content: t.content + delta, pending: false }
                : t
            ),
          }));
        },
        onDone: () => {
          currentStreamId = null;
          set((s) => ({
            sending: false,
            turns: s.turns.map((t) =>
              t.id === assistantTurn.id ? { ...t, pending: false } : t
            ),
          }));
          resolve();
        },
        onError: (message) => {
          currentStreamId = null;
          set((s) => ({
            sending: false,
            turns: s.turns.map((t) =>
              t.id === assistantTurn.id
                ? {
                    ...t,
                    pending: false,
                    error: true,
                    content: t.content
                      ? t.content
                      : `Request failed: ${message}`,
                  }
                : t
            ),
          }));
          resolve();
        },
      });
    });
  },
}));

/**
 * Run the agent tool loop: repeatedly ask the model (with the `run_command`
 * tool), execute any approved commands in the pane, feed the results back as
 * `tool`-role messages, and continue until the model stops calling tools (or a
 * step cap is hit). The first assistant turn (`firstTurnId`) is reused for the
 * model's first textual reply; subsequent replies append new turns.
 */
async function runAgentLoop(
  provider: AiProvider,
  wire: AiMessage[],
  firstTurnId: string,
  paneId: string | undefined
): Promise<void> {
  const set = useAiStore.setState;
  const get = useAiStore.getState;
  // The tool loop needs the raw OpenAI message array (assistant messages may
  // carry tool_calls, and tool results are tool-role messages keyed by id).
  const messages: unknown[] = [...wire];
  let assistantTurnId: string | null = firstTurnId;

  const failFirst = (msg: string) => {
    set((s) => ({
      sending: false,
      turns: s.turns.map((t) =>
        t.id === firstTurnId
          ? { ...t, pending: false, error: true, content: msg }
          : t
      ),
    }));
  };

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const assistant = await aiChatTools(provider, messages, [
        RUN_COMMAND_TOOL,
      ]);
      messages.push(assistant);

      const content = assistant.content ?? "";
      const calls = assistant.tool_calls ?? [];

      // Show the model's textual reply, if any.
      if (content.trim()) {
        if (assistantTurnId) {
          const id = assistantTurnId;
          set((s) => ({
            turns: s.turns.map((t) =>
              t.id === id ? { ...t, pending: false, content } : t
            ),
          }));
        } else {
          const turn: ChatTurn = {
            id: newId(),
            role: "assistant",
            content,
          };
          set((s) => ({ turns: [...s.turns, turn] }));
        }
      } else if (assistantTurnId && calls.length === 0) {
        // No content and no tool calls: clear the empty pending turn.
        const id = assistantTurnId;
        set((s) => ({
          turns: s.turns.map((t) =>
            t.id === id ? { ...t, pending: false } : t
          ),
        }));
      }
      assistantTurnId = null;

      if (calls.length === 0) break; // done — model produced a final answer

      // Execute each requested command (gated by approval).
      for (const call of calls) {
        if (call.function.name !== "run_command") {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Unknown tool: ${call.function.name}`,
          });
          continue;
        }

        let command = "";
        try {
          command = String(JSON.parse(call.function.arguments).command ?? "");
        } catch {
          command = "";
        }
        if (!command.trim()) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "Error: empty or unparseable command.",
          });
          continue;
        }

        // Gate on user approval.
        const approved = await requestApproval(command);
        if (!approved) {
          const denyTurn: ChatTurn = {
            id: newId(),
            role: "tool",
            content: "Command denied by user.",
            command,
            exitCode: null,
          };
          set((s) => ({ turns: [...s.turns, denyTurn] }));
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "The user denied running this command.",
          });
          continue;
        }

        if (!paneId) {
          const noPane = "No active terminal pane to run the command in.";
          const turn: ChatTurn = {
            id: newId(),
            role: "tool",
            content: noPane,
            command,
            exitCode: null,
          };
          set((s) => ({ turns: [...s.turns, turn] }));
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: noPane,
          });
          continue;
        }

        const result = await runCommandInPane(paneId, command);
        const shown =
          (result.output || "(no output)") +
          (result.timedOut ? "\n[timed out]" : "");
        const turn: ChatTurn = {
          id: newId(),
          role: "tool",
          content: shown,
          command,
          exitCode: result.exitCode,
        };
        set((s) => ({ turns: [...s.turns, turn] }));

        const toolText =
          `exit_code: ${result.exitCode ?? "unknown"}` +
          (result.timedOut ? " (timed out)" : "") +
          `\noutput:\n${result.output || "(no output)"}`;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolText,
        });
      }
    }
    set(() => ({ sending: false }));
  } catch (e) {
    if (get().turns.some((t) => t.id === firstTurnId && t.pending)) {
      failFirst(`Request failed: ${String(e)}`);
    } else {
      const turn: ChatTurn = {
        id: newId(),
        role: "assistant",
        content: `Request failed: ${String(e)}`,
        error: true,
      };
      set((s) => ({ sending: false, turns: [...s.turns, turn] }));
    }
  }
}

/**
 * Publish a pending command for approval and resolve once the user decides.
 * The resolver is stashed module-side; the store's `resolveApproval` flips it.
 */
function requestApproval(command: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    approvalResolver = resolve;
    useAiStore.setState(() => ({
      pendingApproval: { id: newId(), command },
    }));
  });
}

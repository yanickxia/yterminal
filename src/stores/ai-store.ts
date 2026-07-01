// ai-store: transient chat transcript for the AI sidebar. Not persisted — the
// conversation is scoped to the running session (like the terminal itself).
// Provider config lives in settings-store; this store only holds the running
// exchange + request status.

import { create } from "zustand";
import { aiChat, type AiMessage } from "../lib/ai";
import { activeAiProvider } from "../stores/settings-store";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** true while an assistant turn is awaiting the provider response */
  pending?: boolean;
  /** set on an assistant turn when the request failed */
  error?: boolean;
}

interface AiState {
  turns: ChatTurn[];
  sending: boolean;
  /** whether the right sidebar is open */
  open: boolean;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  clear: () => void;
  /**
   * Send a user message. `context`, when provided, is the captured terminal
   * text; it's prepended as a system message on the wire but shown to the user
   * as a compact chip rather than dumped into the transcript.
   */
  send: (prompt: string, context?: string) => Promise<void>;
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

export const useAiStore = create<AiState>((set, get) => ({
  turns: [],
  sending: false,
  open: false,
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  clear: () => set({ turns: [] }),

  send: async (prompt, context) => {
    const text = prompt.trim();
    if (!text || get().sending) return;

    const provider = activeAiProvider();
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
      (t) => t.id !== assistantTurn.id && !t.pending && !t.error
    );
    const wire: AiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
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

    try {
      const reply = await aiChat(provider, wire);
      set((s) => ({
        sending: false,
        turns: s.turns.map((t) =>
          t.id === assistantTurn.id
            ? { ...t, pending: false, content: reply }
            : t
        ),
      }));
    } catch (e) {
      set((s) => ({
        sending: false,
        turns: s.turns.map((t) =>
          t.id === assistantTurn.id
            ? {
                ...t,
                pending: false,
                error: true,
                content: `Request failed: ${String(e)}`,
              }
            : t
        ),
      }));
    }
  },
}));

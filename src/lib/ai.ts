// Thin wrapper over the Rust `ai_chat*` commands, mirroring the pty.ts /
// opener.ts shape so the IPC surface is centralized and mockable in vitest. The
// WebView can't call third-party LLM endpoints directly (CORS + we don't want
// the key in page script), so all traffic goes through the Rust proxy.

import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import type { AiProvider } from "../stores/settings-store";

export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiMessage {
  role: AiRole;
  content: string;
}

/**
 * Send a chat completion through the Rust proxy and resolve the assistant's
 * reply text. Rejects with a stringified error (bad key, unknown model, network
 * failure, non-2xx provider response) that the caller can show inline.
 */
export async function aiChat(
  provider: AiProvider,
  messages: AiMessage[]
): Promise<string> {
  return invoke<string>("ai_chat", {
    req: {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages,
    },
  });
}

// --- streaming (P2) ---------------------------------------------------------

/** One event pushed from the Rust streaming command; mirrors `AiStreamEvent`. */
export type AiStreamEvent =
  | { event: "delta"; text: string }
  | { event: "done" }
  | { event: "error"; message: string };

export interface AiStreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Stream a chat completion. Deltas arrive via the Rust->JS Channel and are
 * dispatched to `handlers`; exactly one terminal event (`done` or `error`)
 * fires. Returns the `streamId` so the caller can `aiCancel(streamId)`.
 */
export function aiChatStream(
  provider: AiProvider,
  messages: AiMessage[],
  handlers: AiStreamHandlers
): string {
  const streamId = newStreamId();
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = (msg) => {
    if (msg.event === "delta") handlers.onDelta(msg.text);
    else if (msg.event === "done") handlers.onDone();
    else if (msg.event === "error") handlers.onError(msg.message);
  };
  // Fire-and-forget: the promise resolves when the stream ends, but progress is
  // delivered through the channel. A rejection (rare — the command swallows
  // provider errors into an `error` event) is surfaced as an error event too.
  invoke("ai_chat_stream", {
    req: {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages,
      streamId,
    },
    onEvent: channel,
  }).catch((e) => handlers.onError(String(e)));
  return streamId;
}

/** Cancel an in-flight stream. Safe to call after it already finished. */
export function aiCancel(streamId: string): void {
  void invoke("ai_chat_cancel", { streamId }).catch(() => {
    /* unknown id / already gone — ignore */
  });
}

function newStreamId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// --- tool calling (P3) ------------------------------------------------------

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface AiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A tool call requested by the model in an assistant message. */
export interface AiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The raw assistant message returned by `ai_chat_tools`. */
export interface AiAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: AiToolCall[];
}

/**
 * One tool-enabled round trip. `messages` is passed through verbatim (it may
 * contain prior `tool_calls` / `tool`-role entries), and the raw assistant
 * message is returned so the caller can branch on `content` vs `tool_calls`.
 */
export async function aiChatTools(
  provider: AiProvider,
  messages: unknown[],
  tools: AiTool[]
): Promise<AiAssistantMessage> {
  return invoke<AiAssistantMessage>("ai_chat_tools", {
    req: {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages,
      tools,
    },
  });
}

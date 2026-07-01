// Thin wrapper over the Rust `ai_chat` command, mirroring the pty.ts / opener.ts
// shape so the IPC surface is centralized and mockable in vitest. The WebView
// can't call third-party LLM endpoints directly (CORS + we don't want the key
// in page script), so all traffic goes through the Rust proxy.

import { invoke } from "@tauri-apps/api/core";
import type { AiProvider } from "../stores/settings-store";

export type AiRole = "system" | "user" | "assistant";

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

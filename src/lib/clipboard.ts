import {
  readText as pluginReadText,
  writeText as pluginWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

// Thin wrapper over the Tauri clipboard plugin, mirroring src/lib/opener.ts so
// the IPC surface is centralized and mockable in vitest. We deliberately use
// the native plugin rather than navigator.clipboard: the latter is unreliable
// in webkit2gtk's non-secure context (the original Linux copy bug).

export async function clipboardWrite(text: string): Promise<void> {
  await pluginWriteText(text);
}

export async function clipboardRead(): Promise<string> {
  return pluginReadText();
}

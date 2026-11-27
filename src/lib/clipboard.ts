import { invoke } from "@tauri-apps/api/core";
import { isWeb } from "./platform";

// The Rust bridge serializes macOS clipboard access with WebKit on the main
// thread. navigator.clipboard remains unreliable in webkit2gtk's non-secure
// context, so all platforms keep using the native clipboard backend.

export async function clipboardWrite(text: string): Promise<void> {
  if (isWeb) return navigator.clipboard.writeText(text);
  await invoke<void>("clipboard_write_text", { text });
}

export async function clipboardRead(): Promise<string> {
  if (isWeb) return navigator.clipboard.readText();
  return invoke<string>("clipboard_read_text");
}

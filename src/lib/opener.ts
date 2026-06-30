import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";

export async function openUrl(uri: string): Promise<void> {
  await pluginOpenUrl(uri);
}

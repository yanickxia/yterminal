import { openUrl as pluginOpenUrl, openPath as pluginOpenPath } from "@tauri-apps/plugin-opener";

export async function openUrl(uri: string): Promise<void> {
  await pluginOpenUrl(uri);
}

/** Hand a local filesystem path to the OS default application. */
export async function openPath(path: string): Promise<void> {
  await pluginOpenPath(path);
}

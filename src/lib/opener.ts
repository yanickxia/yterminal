import { openUrl as pluginOpenUrl, openPath as pluginOpenPath } from "@tauri-apps/plugin-opener";
import { isWeb } from "./platform";

export async function openUrl(uri: string): Promise<void> {
  if (isWeb) {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) links are supported");
    }
    window.open(url.href, "_blank", "noopener,noreferrer");
    return;
  }
  await pluginOpenUrl(uri);
}

/** Hand a local filesystem path to the OS default application. */
export async function openPath(path: string): Promise<void> {
  await pluginOpenPath(path);
}

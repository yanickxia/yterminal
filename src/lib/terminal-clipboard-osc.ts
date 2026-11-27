import type { IParser } from "@xterm/xterm";

function decodeClipboardText(data: string): string | undefined {
  const separator = data.indexOf(";");
  if (separator === -1 || !/^[cpqs0-7]*$/.test(data.slice(0, separator))) return;

  const payload = data.slice(separator + 1);
  // Queries and empty/invalid copies must leave the local clipboard alone.
  if (!payload || payload === "?") return;
  try {
    const bytes = Uint8Array.from(atob(payload), (byte) => byte.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Handle terminal-initiated text copies through the app's clipboard bridge. */
export function registerClipboardOsc(
  parser: IParser,
  canCopy: () => boolean,
  writeText: (text: string) => Promise<void>,
  onError: (error: unknown) => void
) {
  return parser.registerOscHandler(52, (data) => {
    if (!canCopy()) return true;
    const text = decodeClipboardText(data);
    if (!text) return true;
    return writeText(text).catch(onError).then(() => true);
  });
}

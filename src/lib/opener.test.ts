import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";
import { openUrl } from "./opener";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openUrl", () => {
  it("forwards the uri to @tauri-apps/plugin-opener openUrl", async () => {
    await openUrl("https://example.com/path?q=1");
    expect(pluginOpenUrl).toHaveBeenCalledTimes(1);
    expect(pluginOpenUrl).toHaveBeenCalledWith("https://example.com/path?q=1");
  });

  it("propagates plugin rejection so callers can log it", async () => {
    (pluginOpenUrl as any).mockRejectedValueOnce(new Error("scope denied"));
    await expect(openUrl("file:///etc/passwd")).rejects.toThrow("scope denied");
  });
});

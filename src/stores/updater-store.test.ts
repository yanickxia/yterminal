import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/updater-native", () => ({
  LATEST_JSON_URL:
    "https://github.com/yanickxia/yterminal/releases/latest/download/latest.json",
  checkUpdate: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  arch: vi.fn().mockReturnValue("x86_64"),
}));
vi.mock("../lib/updater-deb", () => ({
  installKind: vi.fn().mockResolvedValue("other"),
  downloadDebUpdate: vi.fn(),
  installDebUpdate: vi.fn(),
  fetchLatestJson: vi.fn(),
}));

import { relaunch } from "@tauri-apps/plugin-process";
import { arch } from "@tauri-apps/plugin-os";
import { checkUpdate } from "../lib/updater-native";
import {
  installKind,
  downloadDebUpdate,
  installDebUpdate,
  fetchLatestJson,
} from "../lib/updater-deb";
import { useSettingsStore } from "./settings-store";
import { useUpdaterStore, __resetUpdaterForTests } from "./updater-store";

function fakeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.4.0",
    body: "release notes",
    date: "2026-06-29T07:30:00Z",
    close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (arch as any).mockReturnValue("x86_64");
  (installKind as any).mockResolvedValue("other");
  useSettingsStore.setState({
    autoDownloadUpdates: false,
    githubMirror: "",
    updateHttpProxy: "",
  });
  __resetUpdaterForTests();
});

describe("updater-store", () => {
  it("transitions idle → checking → up-to-date when no update is available", async () => {
    (checkUpdate as any).mockResolvedValue(null);
    const pending = useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("checking");
    await pending;
    expect(useUpdaterStore.getState().state).toBe("up-to-date");
    expect(useUpdaterStore.getState().lastCheckedAt).not.toBeNull();
  });

  it("transitions idle → checking → available when an update is offered", async () => {
    (checkUpdate as any).mockResolvedValue(fakeUpdate());
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("available");
    expect(useUpdaterStore.getState().manifest?.version).toBe("0.4.0");
    expect(useUpdaterStore.getState().backgroundDownload).toBe(false);
  });

  it("passes the configured mirror and proxy to update checks", async () => {
    useSettingsStore.setState({
      githubMirror: "https://mirror.example",
      updateHttpProxy: "http://127.0.0.1:7890",
    });
    (checkUpdate as any).mockResolvedValue(null);
    await useUpdaterStore.getState().check();
    expect(checkUpdate).toHaveBeenCalledWith({
      githubMirror: "https://mirror.example",
      httpProxy: "http://127.0.0.1:7890",
    });
  });

  it("captures an update-check error", async () => {
    (checkUpdate as any).mockRejectedValue(new Error("boom"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("error");
    expect(useUpdaterStore.getState().errorMessage).toBe("boom");
  });

  it("check() while already checking is a no-op", async () => {
    (checkUpdate as any).mockImplementation(
      () => new Promise(() => { /* never resolve */ })
    );
    void useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("checking");
    await useUpdaterStore.getState().check();
    expect((checkUpdate as any).mock.calls.length).toBe(1);
  });

  it("downloads first and installs only after restart confirmation", async () => {
    const update = fakeUpdate();
    (checkUpdate as any).mockResolvedValue(update);
    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().startDownload();

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().state).toBe("ready");

    await useUpdaterStore.getState().relaunch();
    expect(update.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("auto-downloads silently only when the setting is enabled", async () => {
    useSettingsStore.setState({ autoDownloadUpdates: true });
    const update = fakeUpdate();
    (checkUpdate as any).mockResolvedValue(update);

    await useUpdaterStore.getState().check({ autoDownload: true });

    expect(update.download).toHaveBeenCalledOnce();
    expect(useUpdaterStore.getState().state).toBe("ready");
    expect(useUpdaterStore.getState().backgroundDownload).toBe(true);
  });

  it("does not auto-download when the setting is disabled", async () => {
    const update = fakeUpdate();
    (checkUpdate as any).mockResolvedValue(update);
    await useUpdaterStore.getState().check({ autoDownload: true });
    expect(update.download).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().state).toBe("available");
  });

  it("deb download is silent and defers pkexec until restart confirmation", async () => {
    (installKind as any).mockResolvedValue("deb");
    (checkUpdate as any).mockResolvedValue(fakeUpdate());
    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({
        "linux-deb-x86_64": { url: "https://x/y-amd64.deb", signature: "SIG" },
      })
    );
    (downloadDebUpdate as any).mockResolvedValue({
      downloadedPath: "/tmp/yterminal-update.deb",
    });
    (installDebUpdate as any).mockResolvedValue({
      installed: true,
      downloadedPath: "/tmp/yterminal-update.deb",
    });

    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().startDownload();

    expect(downloadDebUpdate).toHaveBeenCalledWith(
      "https://x/y-amd64.deb",
      "SIG",
      { githubMirror: "", httpProxy: "" },
      expect.any(Function)
    );
    expect(installDebUpdate).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().state).toBe("ready");
    expect(useUpdaterStore.getState().debDownloadedPath).toBe(
      "/tmp/yterminal-update.deb"
    );

    await useUpdaterStore.getState().relaunch();
    expect(installDebUpdate).toHaveBeenCalledWith(
      "/tmp/yterminal-update.deb",
      "SIG"
    );
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("deb install without pkexec keeps a manual-install path", async () => {
    (installKind as any).mockResolvedValue("deb");
    (checkUpdate as any).mockResolvedValue(fakeUpdate());
    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({
        "linux-deb-x86_64": { url: "https://x/y.deb", signature: "SIG" },
      })
    );
    (downloadDebUpdate as any).mockResolvedValue({
      downloadedPath: "/tmp/yterminal-update.deb",
    });
    (installDebUpdate as any).mockResolvedValue({
      installed: false,
      downloadedPath: "/tmp/yterminal-update.deb",
    });

    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().startDownload();
    await useUpdaterStore.getState().relaunch();

    expect(useUpdaterStore.getState().state).toBe("ready");
    expect(useUpdaterStore.getState().debManualPath).toBe(
      "/tmp/yterminal-update.deb"
    );
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("selects the aarch64 deb on Linux ARM", async () => {
    (arch as any).mockReturnValue("aarch64");
    (installKind as any).mockResolvedValue("deb");
    (checkUpdate as any).mockResolvedValue(fakeUpdate());
    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({
        "linux-deb": { url: "https://x/y-amd64.deb", signature: "SIG_X64" },
        "linux-deb-aarch64": { url: "https://x/y-arm64.deb", signature: "SIG_ARM" },
      })
    );
    (downloadDebUpdate as any).mockResolvedValue({
      downloadedPath: "/tmp/yterminal-update.deb",
    });

    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().startDownload();
    expect(downloadDebUpdate).toHaveBeenCalledWith(
      "https://x/y-arm64.deb",
      "SIG_ARM",
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("reports a missing architecture-specific deb", async () => {
    (installKind as any).mockResolvedValue("deb");
    (checkUpdate as any).mockResolvedValue(fakeUpdate());
    (fetchLatestJson as any).mockResolvedValue(JSON.stringify({ platforms: {} }));
    await useUpdaterStore.getState().check();
    await useUpdaterStore.getState().startDownload();
    expect(useUpdaterStore.getState().state).toBe("error");
    expect(downloadDebUpdate).not.toHaveBeenCalled();
  });
});

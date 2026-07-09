import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri plugin BEFORE importing the store.
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));
vi.mock("../lib/updater-deb", () => ({
  installKind: vi.fn().mockResolvedValue("other"),
  installDebUpdate: vi.fn(),
  fetchLatestJson: vi.fn(),
}));

import { check } from "@tauri-apps/plugin-updater";
import {
  installKind,
  installDebUpdate,
  fetchLatestJson,
} from "../lib/updater-deb";
import { useUpdaterStore, __resetUpdaterForTests } from "./updater-store";

beforeEach(() => {
  vi.clearAllMocks();
  (installKind as any).mockResolvedValue("other");
  // reset both store state AND the module-scope pendingUpdate handle
  __resetUpdaterForTests();
});

describe("updater-store", () => {
  it("transitions idle → checking → up-to-date when no update is available", async () => {
    (check as any).mockResolvedValue(null); // plugin returns null when up-to-date
    const p = useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("checking");
    await p;
    expect(useUpdaterStore.getState().state).toBe("up-to-date");
    expect(useUpdaterStore.getState().lastCheckedAt).not.toBeNull();
  });

  it("transitions idle → checking → available when an update is offered", async () => {
    (check as any).mockResolvedValue({
      version: "0.4.0",
      body: "release notes",
      date: "2026-06-29T07:30:00Z",
      downloadAndInstall: vi.fn(),
    });
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("available");
    expect(useUpdaterStore.getState().manifest?.version).toBe("0.4.0");
  });

  it("captures error message when check() throws", async () => {
    (check as any).mockRejectedValue(new Error("boom"));
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().state).toBe("error");
    expect(useUpdaterStore.getState().errorMessage).toBe("boom");
  });

  it("check() while already checking is a no-op", async () => {
    (check as any).mockImplementation(
      () => new Promise(() => { /* never resolve */ })
    );
    useUpdaterStore.getState().check(); // first call
    expect(useUpdaterStore.getState().state).toBe("checking");
    await useUpdaterStore.getState().check(); // second call should bail
    expect((check as any).mock.calls.length).toBe(1);
  });

  it("startDownload from idle is a no-op", async () => {
    await useUpdaterStore.getState().startDownload();
    expect(useUpdaterStore.getState().state).toBe("idle");
  });

  it("relaunch from idle is a no-op", async () => {
    const { relaunch: rel } = await import("@tauri-apps/plugin-process");
    await useUpdaterStore.getState().relaunch();
    expect((rel as any).mock.calls.length).toBe(0);
  });

  it("resolves installKind on check", async () => {
    (installKind as any).mockResolvedValue("deb");
    (check as any).mockResolvedValue(null);
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().installKind).toBe("deb");
  });

  it("deb startDownload: fetches latest.json, installs, → ready", async () => {
    (installKind as any).mockResolvedValue("deb");
    (check as any).mockResolvedValue({
      version: "0.4.0",
      body: "notes",
      date: null,
      downloadAndInstall: vi.fn(),
    });
    await useUpdaterStore.getState().check();
    expect(useUpdaterStore.getState().installKind).toBe("deb");

    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({
        "linux-deb": { url: "https://x/y.deb", signature: "SIG" },
      })
    );
    (installDebUpdate as any).mockResolvedValue({
      installed: true,
      downloadedPath: "/tmp/y.deb",
    });

    await useUpdaterStore.getState().startDownload();
    expect(installDebUpdate).toHaveBeenCalledWith("https://x/y.deb", "SIG");
    expect(useUpdaterStore.getState().state).toBe("ready");
    expect(useUpdaterStore.getState().debManualPath).toBeNull();
  });

  it("deb startDownload: no pkexec → ready with manual path", async () => {
    (installKind as any).mockResolvedValue("deb");
    (check as any).mockResolvedValue({
      version: "0.4.0",
      body: "notes",
      date: null,
      downloadAndInstall: vi.fn(),
    });
    await useUpdaterStore.getState().check();

    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({
        "linux-deb": { url: "https://x/y.deb", signature: "SIG" },
      })
    );
    (installDebUpdate as any).mockResolvedValue({
      installed: false,
      downloadedPath: "/tmp/y.deb",
    });

    await useUpdaterStore.getState().startDownload();
    expect(useUpdaterStore.getState().state).toBe("ready");
    expect(useUpdaterStore.getState().debManualPath).toBe("/tmp/y.deb");
  });

  it("deb startDownload: manifest without linux-deb → error", async () => {
    (installKind as any).mockResolvedValue("deb");
    (check as any).mockResolvedValue({
      version: "0.4.0",
      body: "notes",
      date: null,
      downloadAndInstall: vi.fn(),
    });
    await useUpdaterStore.getState().check();

    (fetchLatestJson as any).mockResolvedValue(
      JSON.stringify({ platforms: {} })
    );

    await useUpdaterStore.getState().startDownload();
    expect(useUpdaterStore.getState().state).toBe("error");
    expect(installDebUpdate).not.toHaveBeenCalled();
  });
});

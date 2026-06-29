import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri plugin BEFORE importing the store.
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

import { check } from "@tauri-apps/plugin-updater";
import { useUpdaterStore, __resetUpdaterForTests } from "./updater-store";

beforeEach(() => {
  vi.clearAllMocks();
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
});

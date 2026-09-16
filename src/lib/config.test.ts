import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_VERSION,
  applyConfigToStore,
  configFromStore,
  parseConfig,
} from "./config";
import {
  DEFAULT_AUTO_DOWNLOAD_UPDATES,
  DEFAULT_GITHUB_MIRROR,
  DEFAULT_UPDATE_HTTP_PROXY,
  useSettingsStore,
} from "../stores/settings-store";

beforeEach(() => {
  useSettingsStore.setState({
    takeControlOnEnter: true,
    autoDownloadUpdates: DEFAULT_AUTO_DOWNLOAD_UPDATES,
    githubMirror: DEFAULT_GITHUB_MIRROR,
    updateHttpProxy: DEFAULT_UPDATE_HTTP_PROXY,
  });
});

describe("Enter takeover config", () => {
  it.each([undefined, null, "false", 0])("defaults missing/invalid values to on: %j", (value) => {
    const parsed = parseConfig(JSON.stringify({ terminal: { takeControlOnEnter: value } }));
    expect(parsed?.terminal.takeControlOnEnter).toBe(true);
  });

  it.each([true, false])("round-trips the explicit setting: %s", (value) => {
    const parsed = parseConfig(JSON.stringify({ terminal: { takeControlOnEnter: value } }));
    applyConfigToStore(parsed!);
    expect(useSettingsStore.getState().takeControlOnEnter).toBe(value);
    expect(configFromStore().terminal.takeControlOnEnter).toBe(value);
  });
});

describe("updater config", () => {
  it("backfills updater defaults for a pre-v2 config", () => {
    const parsed = parseConfig(JSON.stringify({ version: 1 }));
    expect(parsed?.updates).toEqual({
      autoDownload: false,
      githubMirror: "",
      httpProxy: "",
    });
  });

  it("parses and applies background-download network settings", () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        updates: {
          autoDownload: true,
          githubMirror: "https://mirror.example",
          httpProxy: "http://127.0.0.1:7890",
        },
      })
    );
    expect(parsed).not.toBeNull();
    applyConfigToStore(parsed!);
    expect(useSettingsStore.getState()).toMatchObject({
      autoDownloadUpdates: true,
      githubMirror: "https://mirror.example",
      updateHttpProxy: "http://127.0.0.1:7890",
    });
  });

  it("serializes updater settings into the syncable config", () => {
    useSettingsStore.setState({
      autoDownloadUpdates: true,
      githubMirror: "https://mirror.example/{url}",
      updateHttpProxy: "http://proxy.example:8080",
    });
    expect(configFromStore()).toMatchObject({
      version: CONFIG_VERSION,
      updates: {
        autoDownload: true,
        githubMirror: "https://mirror.example/{url}",
        httpProxy: "http://proxy.example:8080",
      },
    });
  });
});

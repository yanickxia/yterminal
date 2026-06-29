#!/usr/bin/env node
// Build latest.json for the Tauri updater from a GitHub release's assets.
//
// Usage (in CI):
//   TAG=v0.4.0 node scripts/generate-latest-json.mjs > latest.json
//
// The pure logic lives in `buildManifest` so it's unit-testable without
// shelling out to gh / fetching the network.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * Find a single asset by name predicate. Throws if 0 or 2+ match.
 */
function findAsset(release, predicate, label) {
  const matches = release.assets.filter(predicate);
  if (matches.length === 0) {
    throw new Error(`No release asset matched ${label}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple release assets matched ${label}: ${matches
        .map((m) => m.name)
        .join(", ")}`
    );
  }
  return matches[0];
}

/**
 * Build the latest.json manifest. `fetchSig(asset)` resolves the asset's
 * `.sig` content as a string. Pure (no I/O of its own); delegates to
 * `fetchSig`.
 */
export async function buildManifest(release, fetchSig) {
  const version = release.tagName.replace(/^v/, "");

  const darwinBundle = findAsset(
    release,
    (a) => a.name.endsWith(".app.tar.gz") && a.name.includes("universal"),
    "darwin universal .app.tar.gz"
  );
  const darwinSig = findAsset(
    release,
    (a) => a.name === darwinBundle.name + ".sig",
    "darwin .sig"
  );
  const darwinSigContent = await fetchSig(darwinSig);

  const windowsBundle = findAsset(
    release,
    (a) => a.name.endsWith("-setup.exe"),
    "windows -setup.exe"
  );
  const windowsSig = findAsset(
    release,
    (a) => a.name === windowsBundle.name + ".sig",
    "windows .sig"
  );
  const windowsSigContent = await fetchSig(windowsSig);

  const linuxBundle = findAsset(
    release,
    (a) => a.name.endsWith(".AppImage"),
    "linux .AppImage"
  );
  const linuxSig = findAsset(
    release,
    (a) => a.name === linuxBundle.name + ".sig",
    "linux .sig"
  );
  const linuxSigContent = await fetchSig(linuxSig);

  const darwinPlatform = {
    signature: darwinSigContent,
    url: darwinBundle.url,
  };

  return {
    version,
    notes: release.body ?? "",
    pub_date: release.publishedAt,
    platforms: {
      "darwin-universal": darwinPlatform,
      "darwin-x86_64": darwinPlatform,
      "darwin-aarch64": darwinPlatform,
      "windows-x86_64": {
        signature: windowsSigContent,
        url: windowsBundle.url,
      },
      "linux-x86_64": {
        signature: linuxSigContent,
        url: linuxBundle.url,
      },
    },
  };
}

// ----- main -----
if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = process.env.TAG;
  if (!tag) {
    console.error("TAG env var is required (e.g. v0.4.0)");
    process.exit(1);
  }
  const json = execFileSync("gh", [
    "release",
    "view",
    tag,
    "--json",
    "tagName,publishedAt,body,assets",
  ], { encoding: "utf-8" });
  const release = JSON.parse(json);

  const fetchSig = async (asset) => {
    const res = await fetch(asset.url, {
      redirect: "follow",
      headers: { Accept: "application/octet-stream" },
    });
    if (!res.ok) {
      throw new Error(`fetch ${asset.name}: HTTP ${res.status}`);
    }
    return (await res.text()).trim();
  };

  const manifest = await buildManifest(release, fetchSig);
  writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
  console.error(`Wrote latest.json for ${tag}`);
}

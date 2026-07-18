import { describe, it, expect } from "vitest";
import { buildManifest } from "./generate-latest-json.mjs";

const fixtureRelease = {
  tagName: "v0.4.0",
  publishedAt: "2026-06-29T07:30:00Z",
  body: "release notes here",
  assets: [
    {
      name: "yterminal_universal.app.tar.gz",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_universal.app.tar.gz",
    },
    {
      name: "yterminal_universal.app.tar.gz.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_universal.app.tar.gz.sig",
    },
    {
      name: "yterminal_0.4.0_x64-setup.exe",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_x64-setup.exe",
    },
    {
      name: "yterminal_0.4.0_x64-setup.exe.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_x64-setup.exe.sig",
    },
    {
      name: "yterminal_0.4.0_amd64.AppImage",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.AppImage",
    },
    {
      name: "yterminal_0.4.0_amd64.AppImage.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.AppImage.sig",
    },
    {
      name: "yterminal_0.4.0_arm64.AppImage",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_arm64.AppImage",
    },
    {
      name: "yterminal_0.4.0_arm64.AppImage.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_arm64.AppImage.sig",
    },
    {
      name: "yterminal_0.4.0_amd64.deb",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.deb",
    },
    {
      name: "yterminal_0.4.0_amd64.deb.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_amd64.deb.sig",
    },
    {
      name: "yterminal_0.4.0_arm64.deb",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_arm64.deb",
    },
    {
      name: "yterminal_0.4.0_arm64.deb.sig",
      url: "https://github.com/yanickxia/yterminal/releases/download/v0.4.0/yterminal_0.4.0_arm64.deb.sig",
    },
  ],
};

// map of "filename" → "fake .sig content"
const fakeSigs = {
  "yterminal_universal.app.tar.gz.sig": "DARWIN_SIG",
  "yterminal_0.4.0_x64-setup.exe.sig": "WINDOWS_SIG",
  "yterminal_0.4.0_amd64.AppImage.sig": "LINUX_SIG",
  "yterminal_0.4.0_arm64.AppImage.sig": "LINUX_ARM_SIG",
  "yterminal_0.4.0_amd64.deb.sig": "DEB_SIG",
  "yterminal_0.4.0_arm64.deb.sig": "DEB_ARM_SIG",
};

const fetchSig = async (asset) => fakeSigs[asset.name];

describe("buildManifest", () => {
  it("produces correct manifest shape for all platforms", async () => {
    const manifest = await buildManifest(fixtureRelease, fetchSig);
    expect(manifest.version).toBe("0.4.0");
    expect(manifest.notes).toBe("release notes here");
    expect(manifest.pub_date).toBe("2026-06-29T07:30:00Z");
    expect(manifest.platforms["darwin-universal"].signature).toBe("DARWIN_SIG");
    expect(manifest.platforms["darwin-x86_64"].signature).toBe("DARWIN_SIG");
    expect(manifest.platforms["darwin-aarch64"].signature).toBe("DARWIN_SIG");
    expect(manifest.platforms["windows-x86_64"].url).toMatch(/x64-setup\.exe$/);
    expect(manifest.platforms["linux-x86_64"].signature).toBe("LINUX_SIG");
    expect(manifest.platforms["linux-x86_64"].url).toMatch(/amd64\.AppImage$/);
    expect(manifest.platforms["linux-aarch64"].signature).toBe("LINUX_ARM_SIG");
    expect(manifest.platforms["linux-aarch64"].url).toMatch(/arm64\.AppImage$/);
  });

  it("includes arch-specific linux-deb entries with their own signatures", async () => {
    const manifest = await buildManifest(fixtureRelease, fetchSig);
    expect(manifest["linux-deb"]).toBe(manifest["linux-deb-x86_64"]);
    expect(manifest["linux-deb"].signature).toBe("DEB_SIG");
    expect(manifest["linux-deb"].url).toMatch(/amd64\.deb$/);
    expect(manifest["linux-deb-x86_64"].signature).toBe("DEB_SIG");
    expect(manifest["linux-deb-aarch64"].signature).toBe("DEB_ARM_SIG");
    expect(manifest["linux-deb-aarch64"].url).toMatch(/arm64\.deb$/);
  });

  it("omits an arch-specific linux-deb entry when the .deb has no sibling .sig", async () => {
    const noDebSig = {
      ...fixtureRelease,
      assets: fixtureRelease.assets.filter(
        (a) => a.name !== "yterminal_0.4.0_amd64.deb.sig"
      ),
    };
    const manifest = await buildManifest(noDebSig, fetchSig);
    expect(manifest["linux-deb"]).toBeUndefined();
    expect(manifest["linux-deb-x86_64"]).toBeUndefined();
    expect(manifest["linux-deb-aarch64"].signature).toBe("DEB_ARM_SIG");
  });

  it("throws when a platform asset is missing", async () => {
    const broken = {
      ...fixtureRelease,
      assets: fixtureRelease.assets.filter(
        (a) => !a.name.includes("AppImage")
      ),
    };
    await expect(buildManifest(broken, fetchSig)).rejects.toThrow(/AppImage/);
  });

  it("throws when a sibling .sig is missing", async () => {
    const broken = {
      ...fixtureRelease,
      assets: fixtureRelease.assets.filter(
        (a) => a.name !== "yterminal_universal.app.tar.gz.sig"
      ),
    };
    await expect(buildManifest(broken, fetchSig)).rejects.toThrow(/\.sig/);
  });
});

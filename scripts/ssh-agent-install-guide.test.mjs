import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentReleasePage, sshAgentInstallScript, sshCheckCommand } from "../src/lib/ssh-agent-install-guide";

const version = "0.18.21";

function installFixture() {
  const dir = mkdtempSync(join(tmpdir(), "yterminal-manual-guide-"));
  const bin = join(dir, "bin");
  const remote = join(dir, "remote");
  const archive = join(dir, "agent archive.tar.gz");
  const download = join(dir, "download");
  const agent = join(remote, ".local/bin/yterminal-agent");
  mkdirSync(bin);
  mkdirSync(remote);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh
while [ "$1" != -- ]; do shift; done
shift
[ "$1" = office-nas ] || exit 1
export HOME="$TEST_REMOTE"
exec sh -c "$2"
`, { mode: 0o755 });
  writeFileSync(join(bin, "uname"), `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo aarch64 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$1" != --output ]; do shift; done
printf '%s\n' "$3" > "$TEST_DOWNLOAD"
cp "$TEST_ARCHIVE" "$2"
`, { mode: 0o755 });
  writeFileSync(join(dir, "yterminal-agent"), `#!/bin/sh
case "$1" in
  version) echo 'yterminal-agent ${version}' ;;
  ping) [ -f "$HOME/started" ] && echo pong ;;
  install) touch "$HOME/started" ;;
esac
`);
  execFileSync("tar", ["-C", dir, "-czf", archive, "yterminal-agent"]);
  const script = sshAgentInstallScript(" office-nas ", version);
  const run = (options = {}) => spawnSync("sh", {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      YTERMINAL_AGENT_ARCHIVE: "",
      YTERMINAL_AGENT_SHA256: "",
      TEST_REMOTE: remote,
      TEST_ARCHIVE: archive,
      TEST_DOWNLOAD: download,
      ...options,
    },
  });
  return { agent, archive, download, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("SSH Agent manual install guide", () => {
  it("pins the release and quotes the SSH target in copied commands", () => {
    expect(agentReleasePage(version)).toBe(
      `https://github.com/yanickxia/yterminal/releases/tag/v${version}#assets`
    );
    expect(sshCheckCommand(" -oProxyCommand=id ")).toBeUndefined();
    expect(sshAgentInstallScript("two hosts", version)).toBeUndefined();
    expect(sshCheckCommand("host'with$quote")).toBe("ssh -- 'host'\\''with$quote'");
  });

  it.skipIf(process.platform === "win32")("downloads the matching architecture without the API and reuses an installed agent", () => {
    const fixture = installFixture();
    try {
      const first = fixture.run();
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("pong");
      expect(readFileSync(fixture.download, "utf8").trim()).toBe(
        `https://github.com/yanickxia/yterminal/releases/download/v${version}/yterminal-agent_${version}_linux_aarch64.tar.gz`
      );
      rmSync(fixture.download);
      const second = fixture.run();
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("Agent already installed");
      expect(existsSync(fixture.download)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("accepts a local archive, checks the supplied digest, and avoids downloading", () => {
    const fixture = installFixture();
    try {
      const archive = { YTERMINAL_AGENT_ARCHIVE: fixture.archive };
      const bad = fixture.run({ ...archive, YTERMINAL_AGENT_SHA256: "wrong" });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("SHA-256 mismatch");
      expect(existsSync(fixture.agent)).toBe(false);
      const digest = createHash("sha256").update(readFileSync(fixture.archive)).digest("hex");
      const result = fixture.run({ ...archive, YTERMINAL_AGENT_SHA256: digest });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(existsSync(fixture.agent)).toBe(true);
      expect(existsSync(fixture.download)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

import localInstaller from "../../scripts/ssh-agent-install-local.sh?raw";
import remoteInstaller from "../../scripts/ssh-agent-install-remote.sh?raw";
import remoteProbe from "../../scripts/ssh-agent-probe.sh?raw";

const RELEASES_URL = "https://github.com/yanickxia/yterminal/releases";

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function validTarget(value: string): string | undefined {
  const target = value.trim();
  if (!target || target.startsWith("-") || /[\s\x00-\x1f\x7f-\x9f]/u.test(target)) {
    return undefined;
  }
  return target;
}

export function sshCheckCommand(value: string): string | undefined {
  const target = validTarget(value);
  return target ? `ssh -- ${shellQuote(target)}` : undefined;
}

export function agentReleasePage(version: string): string {
  return `${RELEASES_URL}/tag/v${encodeURIComponent(version)}#assets`;
}

export function sshAgentInstallScript(value: string, version: string): string | undefined {
  const target = validTarget(value);
  if (!target) return undefined;
  // The version comes from the app manifest and is also a remote shell argument.
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) return undefined;
  return [
    "sh <<'YTERMINAL_INSTALL'",
    "set -eu",
    `target=${shellQuote(target)}`,
    `version=${shellQuote(version)}`,
    `release_url=${shellQuote(RELEASES_URL)}`,
    `probe_command=${shellQuote(`sh -c ${shellQuote(remoteProbe.trim())}`)}`,
    `install_command=${shellQuote(`sh -c ${shellQuote(remoteInstaller.trim())} yterminal-bootstrap`)}`,
    "",
    localInstaller.trim(),
    "YTERMINAL_INSTALL",
    "",
  ].join("\n");
}

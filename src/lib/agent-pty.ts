import type { Terminal } from "@xterm/xterm";
import type { AgentKind, PaneLeaf } from "./types";

export type PtyAgentState = "executing" | "waiting" | "attention" | "unknown";

export interface PtyAgentObservation {
  instanceId?: string;
  state: PtyAgentState;
  source: "screen" | "title" | "unknown";
  reason: string;
}

const unknown: PtyAgentObservation = {
  state: "unknown",
  source: "unknown",
  reason: "No current agent controls or status title detected",
};

function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

export function readAgentScreen(term: Terminal): string {
  const buffer = term.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + term.rows);
  const start = Math.max(buffer.baseY, end - 40);
  const lines: string[] = [];
  for (let row = start; row < end; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n").slice(-32_000);
}

export function detectPtyAgent(
  kind: AgentKind,
  screen: string,
  title = ""
): PtyAgentObservation | null {
  const lines = screen.trimEnd().split("\n").map((line) => line.trimEnd());
  const tailLines = lines.filter((line) => line.trim()).slice(-16);
  const tail = tailLines.join("\n");
  const lower = tail.toLowerCase();
  const footer = tailLines[tailLines.length - 1] ?? "";
  const openCodeMini = kind === "opencode" &&
    tailLines.some((line) => /^\s*┃(?:\s|$)/u.test(line));
  const result = (
    state: PtyAgentState,
    source: PtyAgentObservation["source"],
    reason: string
  ): PtyAgentObservation => ({ state, source, reason });

  // Transcript overlays show historical controls; preserve the live state.
  if (
    /showing detailed transcript/i.test(tail) ||
    (/↑\/↓ to scroll/i.test(tail) && /q to quit/i.test(tail))
  ) return null;

  if (kind === "codex" && /\bAction Required\b/i.test(title)) {
    return result("attention", "title", "Codex title requests an action");
  }
  if (kind === "codex" && /\benter\/esc confirm\b/i.test(tail) && /^\s*›\s+\d+\.\s/mu.test(tail)) {
    return result("attention", "screen", "Codex confirmation menu is visible");
  }
  if (kind === "opencode" && (
    (/^\s*△ Permission required\s*$/mu.test(tail) && /esc dismiss|enter (?:confirm|submit)/i.test(tail)) ||
    (/esc dismiss/i.test(tail) && /enter (?:confirm|submit|toggle)/i.test(tail) && /↑↓ select|⇆ tab/u.test(tail))
  )) return result("attention", "screen", "OpenCode permission or question controls are visible");

  const lastDivider = lastIndex(lines, (line) => /^\s*[─━═-]{4,}/u.test(line));
  const form = (lastDivider >= 0 ? lines.slice(lastDivider + 1) : tailLines.slice(-12)).join("\n");
  const beforeDivider = lines.slice(0, lastDivider);
  const promptDivider = lastIndex(beforeDivider, (line) => /^\s*[─━═-]{4,}/u.test(line));
  const promptBody = promptDivider >= 0 ? lines.slice(promptDivider + 1, lastDivider).join("\n") : form;
  const controls = /(?:esc(?:ape)? to cancel|enter to (?:confirm|select|submit)|enter continue|\[y\/n\])/i;
  if (
    (controls.test(form) && /(?:do you want to|allow command\?|permission|trust (?:this folder|the contents)|accept|decline|yes|enter to submit)/i.test(form)) ||
    /(?:press enter to confirm or esc to cancel|enter to submit (?:answer|all))/i.test(form) ||
    (/trust this folder\?/i.test(tail) && /trust and continue|enter continue/i.test(tail))
  ) return result("attention", "screen", "Live confirmation or question controls are visible");

  const titleState = detectAgentTitle(kind, title);
  if (titleState?.state === "executing") return titleState;

  if (kind === "claude") {
    if (
      /^\s*[⏸⏵].*esc to interrupt/im.test(tail) ||
      /^\s*[*·✢✳✶✻✽]\s+\S.*…(?:\s+\([^\n]*\)|\s*$)/mu.test(tail) ||
      /^\s*[*·✢✳✶✻✽]\s+Waiting for [1-9]\d* background agents? to finish\s*$/mu.test(tail)
    ) return result("executing", "screen", "Claude live activity indicator is visible");
  } else if (kind === "codex") {
    const working = lastIndex(tailLines, (line) =>
      /^(?:[•◦]\s+)?[^\s›•◦■✗✓─].*\((?:\d+[hm]\s+)*\d+s\s*•\s*[^\n]*to interrupt\)/iu.test(line.trim())
    );
    if (
      working >= 0 &&
      !tailLines.slice(working + 1).some((line) => /^\s*[•◦■✗✓]\s/u.test(line)) &&
      !/reconnect failed/i.test(tailLines[working])
    ) return result("executing", "screen", "Codex live elapsed-time indicator is visible");
  } else if (
    (openCodeMini && /\besc interrupt\s*·.*\b(?:Build|Plan)\s+·/iu.test(footer)) ||
    /(?:^|\n)\s*(?:■|▪|esc|escape)\s+(?:stop|interrupt)\b/i.test(tail) ||
    /(?:^|\n)\s*(?:press\s+)?(?:esc|escape|ctrl\+c)\s+(?:to\s+)?interrupt\b/i.test(tail) ||
    /^\s*[■⬝]{4,}\s*$/mu.test(tail)
  ) return result("executing", "screen", "OpenCode stop control is visible");

  if (titleState) return titleState;
  if (kind === "claude" && /^\s*❯(?:\s|$)/mu.test(promptBody) && !controls.test(tail)) {
    return result("waiting", "screen", "Claude input composer is visible");
  }
  if (
    kind === "codex" && /^\s*›(?:\s|$)/mu.test(tail) &&
    !/model:\s*loading|resuming session/i.test(tail) &&
    /(?:context left|\? for shortcuts|ask codex|gpt-|codex)/i.test(tail)
  ) return result("waiting", "screen", "Codex input composer and footer are visible");
  if (kind === "opencode" && /(?:tab\s+(?:switch|agents?)|ctrl\+[a-z]\s+commands)/i.test(lower) && /(?:^|\n)\s*(?:build|plan)\b/im.test(tail)) {
    return result("waiting", "screen", "OpenCode input footer is visible");
  }
  if (openCodeMini && /^\s*(?:Build|Plan)\s+·.*\bctrl\+p menu\s*$/iu.test(footer)) {
    return result("waiting", "screen", "OpenCode mini composer and menu footer are visible");
  }
  return unknown;
}

export function detectAgentTitle(kind: AgentKind, title: string): PtyAgentObservation | null {
  if (kind === "codex" && /\bAction Required\b/i.test(title)) {
    return { state: "attention", source: "title", reason: "Codex title requests an action" };
  }
  if (
    (kind === "claude" && /^[\u2800-\u28ff◐-◓]\s/u.test(title)) ||
    (kind === "codex" && /(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u.test(title))
  ) return { state: "executing", source: "title", reason: "Agent title contains a busy indicator" };
  if (kind === "claude" && /^✳\s/u.test(title)) {
    return { state: "waiting", source: "title", reason: "Claude title reports an idle prompt" };
  }
  return null;
}

export function persistedPtyObservation(leaf: PaneLeaf): PtyAgentObservation {
  // Older daemons used runtimeStatus for hooks and have no process generation.
  if (!leaf.agent?.instanceId) return unknown;
  const state = leaf.runtimeStatus;
  if (state === "working") return { state: "executing", source: "title", reason: "Owner daemon observed a busy agent title" };
  if (state === "permission") return { state: "attention", source: "title", reason: "Owner daemon observed an action-required title" };
  if (state === "idle") return { state: "waiting", source: "title", reason: "Owner daemon observed an idle agent title" };
  return unknown;
}

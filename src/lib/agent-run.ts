// Pure helpers for the AI agent's terminal command execution (P3). The IO — a
// live `pty.onData` tap plus injection — lives in terminal-manager; the string
// transforms here (building the sentinel, parsing the exit code, scrubbing the
// echoed command line out of captured output) are kept separate so they can be
// unit-tested without a PTY.

/** A unique sentinel we print after a command so we can detect completion. */
export interface Sentinel {
  /** The literal marker token embedded in the injected command. */
  marker: string;
  /** Matches `<marker>:<exit code>` in cleaned output, capturing the code. */
  re: RegExp;
}

/** Build a fresh sentinel with a random marker (collision-proof per command). */
export function makeSentinel(
  rand: () => string = () => Math.random().toString(36).slice(2, 10)
): Sentinel {
  const marker = `__YT_DONE_${rand()}__`;
  return { marker, re: new RegExp(`${marker}:(-?\\d+)`) };
}

/**
 * The shell snippet injected after the user command: print the sentinel with
 * the command's exit status, then immediately erase the sentinel's own lines
 * from the visible terminal so the user never sees the bookkeeping "print".
 *
 * The `printf` emits `\n<marker>:<code>\n` (which our `pty.onData` tap captures
 * before the erase lands, so completion detection still works), then an ANSI
 * cursor-up + clear-to-end-of-screen (`\033[3A\r\033[0J`). Counting from the
 * fresh line the shell leaves the cursor on after submitting this line, the
 * three rows above are: the echoed sentinel command, the blank line printf
 * emitted, and the `<marker>:<code>` line — clearing them (and everything below)
 * removes the whole sentinel apparatus, leaving only the real command output
 * and the next prompt. The user's own command + its output sit above row 3 and
 * are untouched. (`printf` interprets the octal `\033` escape in bash/zsh/sh.)
 *
 * Kept as one line so it's a single prompt submission. The caller appends this
 * (with a separating newline) to the command itself. The leading space keeps it
 * out of shell history for users with `HISTCONTROL=ignorespace` / zsh
 * `HIST_IGNORE_SPACE`.
 */
export function sentinelCommand(marker: string): string {
  return ` printf '\\n${marker}:%s\\n\\033[3A\\r\\033[0J' "$?"`;
}

export interface ParsedResult {
  /** True once the sentinel has appeared in the (cleaned) output. */
  done: boolean;
  /** Parsed exit code, or null when absent/unparseable. */
  exitCode: number | null;
  /** Output captured before the sentinel, with the echoed command scrubbed. */
  output: string;
}

/**
 * Parse cleaned (ANSI-stripped) accumulated output against a sentinel. When the
 * sentinel is present, returns the exit code and the output preceding it with
 * the echoed command line removed; otherwise `done:false`.
 */
export function parseResult(
  cleaned: string,
  sentinel: Sentinel,
  command: string
): ParsedResult {
  const m = cleaned.match(sentinel.re);
  if (!m) return { done: false, exitCode: null, output: "" };
  const code = Number.parseInt(m[1], 10);
  const head = cleaned.slice(0, cleaned.indexOf(m[0]));
  return {
    done: true,
    exitCode: Number.isNaN(code) ? null : code,
    output: scrubCommandEcho(dropSentinelEcho(head, sentinel.marker), command),
  };
}

/**
 * Remove any line that carries the sentinel marker token. The shell echoes the
 * injected `printf ...<marker>...` line before running it, so that echo lands in
 * the captured output ahead of the real `<marker>:<code>` line. It contains the
 * marker verbatim (as `<marker>:%s`, which never matches the numeric regex), so
 * dropping marker-bearing lines strips the sentinel command echo without
 * touching genuine output.
 */
export function dropSentinelEcho(text: string, marker: string): string {
  if (!marker) return text;
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !line.includes(marker))
    .join("\n");
}

/**
 * Trim the leading echoed command line and collapse blank runs from captured
 * command output. The shell echoes the injected command before running it; we
 * drop the first matching line (a prompt may prefix it), then tidy whitespace.
 */
export function scrubCommandEcho(text: string, command: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const firstCmdLine = command.split("\n")[0]?.trim() ?? "";
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    if (firstCmdLine && lines[i].includes(firstCmdLine)) {
      start = i + 1;
      break;
    }
  }
  return lines
    .slice(start)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

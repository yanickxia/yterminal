# Terminal Link Click — Design Spec

**Date:** 2026-06-30
**Status:** Draft v2 (revised after spec review)
**Scope:** Add http/https link detection in terminal output and open them on cmd/ctrl + click using the system default browser.

## Goal

Users see `http://...` / `https://...` in terminal output and want to open them without copying. The current build has no link affordance at all. We will add:

1. Visual recognition (hover underline + pointer cursor) for http/https URLs in any pane.
2. Open on click with the platform-default modifier (macOS = cmd, Windows/Linux = ctrl).
3. Open via the system default browser, not inside the Tauri WebView.

Non-goals (deferred — do not add now):

- Recognizing other schemes (`file://`, `mailto:`, `ssh://`, `git@host:repo`).
- Custom matchers (Jira tickets, GitHub issue refs, etc.).
- A user-configurable modifier key in Settings.
- Right-click "Open Link" / "Copy Link" entries in the context menu.
- OSC 8 hyperlink escape sequence handling. The xterm.js core has no auto-open for OSC 8 today, and `@xterm/addon-web-links` only matches plain URLs in text. Current behavior (OSC 8 styled but not opened on click) is unchanged.

## Architecture

### Frontend integration

The xterm.js ecosystem provides `@xterm/addon-web-links`, which handles URL regex matching, hover underline, cursor switching, and event interception so a click on a link does not start a text selection. We adopt it as-is and replace only the click handler.

Integration point: `src/lib/terminal-manager.ts`, inside the function that constructs a new `Terminal` and loads its addons (currently loads `FitAddon`, `SerializeAddon`, `SearchAddon`). After the existing addons:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
import { shouldOpenLink, detectIsMac } from "./link-modifier";
import { openUrl } from "./opener";

const isMac = detectIsMac();
term.loadAddon(new WebLinksAddon((event, uri) => {
  if (shouldOpenLink(event, isMac)) {
    void openUrl(uri).catch((err) => console.warn("openUrl failed", err));
  }
}));
```

The addon's hover/underline/cursor behavior is left at default — it underlines on hover regardless of whether the modifier is held. This matches iTerm2 and VS Code's integrated terminal and avoids the reverse-discoverability problem ("the user must already know to hold cmd before they can see links exist").

### New module: `src/lib/link-modifier.ts`

Two small pure functions. `shouldOpenLink` takes `isMac` as a parameter (does not capture platform at module-load) so it is trivially testable.

```ts
export function detectIsMac(): boolean {
  return navigator.userAgent.toLowerCase().includes("mac");
}

export function shouldOpenLink(event: MouseEvent, isMac: boolean): boolean {
  if (isMac) {
    return event.metaKey || event.getModifierState("Meta");
  }
  return event.ctrlKey || event.getModifierState("Control");
}
```

Platform detection uses `navigator.userAgent` to match the project's existing convention (`terminal-manager.ts:209` already detects platform this way for shell selection). `navigator.platform` is deprecated and returns inconsistent strings on Linux WebKitGTK.

`getModifierState` is included as a belt-and-suspenders for WebView edge cases on macOS where `metaKey` is occasionally not propagated; it costs nothing and removes a class of platform-specific bug.

### New module: `src/lib/opener.ts`

Thin wrapper around the official JS helper. Existence justified by (a) centralizing the Tauri plugin import surface (mirrors `src/lib/pty.ts`), and (b) being mockable in vitest without faking `@tauri-apps/plugin-opener` directly.

```ts
import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";

export async function openUrl(uri: string): Promise<void> {
  await pluginOpenUrl(uri);
}
```

We use the official JS helper rather than raw `invoke`. The helper is the documented Tauri 2 path and removes the need to hard-code an invoke command name.

### Backend (`src-tauri/`)

- `src-tauri/Cargo.toml`: add `tauri-plugin-opener = "2"` to `[dependencies]`.
- `src-tauri/src/main.rs`: register the plugin in the Builder chain at `main.rs:381-385`, e.g. `.plugin(tauri_plugin_opener::init())`, alongside the existing `tauri_plugin_os`, `tauri_plugin_updater`, `tauri_plugin_process` calls.
- `src-tauri/capabilities/default.json`: replace the bare string `"opener:allow-open-url"` with an object form that scopes URLs to http/https globs:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "default capability for yterminal",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "os:default",
    "updater:default",
    "process:default",
    {
      "identifier": "opener:allow-open-url",
      "allow": [
        { "url": "https://*" },
        { "url": "http://*" }
      ]
    }
  ]
}
```

This is defense-in-depth: the addon's regex only matches http/https in the first place, but locking the capability prevents future widening (e.g., if someone adds a `file://` matcher later, they have to consciously edit the capability too).

### Dependencies

| Manifest | Change |
|---|---|
| `package.json` (`dependencies`) | add `@xterm/addon-web-links` (latest 0.x compatible with `@xterm/xterm` 5.5) |
| `package.json` (`dependencies`) | add `@tauri-apps/plugin-opener` (matched to plugin major) |
| `src-tauri/Cargo.toml` (`[dependencies]`) | add `tauri-plugin-opener = "2"` |

## Data flow

```
xterm output → WebLinksAddon regex match
            → user hovers      → addon paints underline + sets pointer cursor
            → user clicks      → addon invokes our handler(event, uri)
                              → shouldOpenLink(event, isMac)?
                                  no  → return
                                  yes → openUrl(uri)
                                      → @tauri-apps/plugin-opener openUrl
                                      → IPC into tauri_plugin_opener
                                      → OS hands off to default browser
```

No state is added to the Zustand store. No persistence. No new IPC channels beyond what `tauri-plugin-opener` already provides.

## Error handling

- `openUrl` rejection (e.g., capability scope denies the URL, or the OS reports no default handler) is caught and logged via `console.warn`. No user-facing toast: a click that does nothing is acceptable, and a popup for what is usually a typo'd URL is worse than silence.
- No try/catch around `term.loadAddon`. It is not a documented throw site; the constructor's only failure mode (module resolution) would have already crashed the page at import time.

## Testing

Unit tests (vitest, node env — no DOM):

- `src/lib/link-modifier.test.ts`: matrix table over `{ metaKey, ctrlKey, isMac }` × inputs → expected boolean. Pure-function table test. No global stubs needed since `isMac` is a parameter.
- `src/lib/opener.test.ts`: mock `@tauri-apps/plugin-opener` via `vi.mock`; assert `openUrl("https://example.com")` forwards to the helper with the same string.

No DOM/integration test for the addon wiring — matches the project's current testing posture (`terminal-manager.ts` has no DOM test today). Manual verification list for `npm run tauri:dev`:

- http and https URLs in shell output render with underline on hover and pointer cursor.
- cmd+click on macOS / ctrl+click on Linux+Windows opens in system default browser.
- Plain click (no modifier) does nothing, does not start selection on the link, does not eat the click for nearby characters.
- shift+click extends text selection through a link as before.
- Middle-click paste still works on Linux.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- `cargo check` in `src-tauri/` passes.

## CLAUDE.md update

Append a subsection under "Architecture" (after "Theming"):

> **Link handling.** `terminal-manager.ts` loads `@xterm/addon-web-links` on every new `Terminal`. The click handler delegates to `src/lib/link-modifier.ts` (cmd on macOS, ctrl elsewhere — detected once via `navigator.userAgent` and passed in as a parameter, so the predicate stays pure) and `src/lib/opener.ts` (thin wrapper over `@tauri-apps/plugin-opener`). The Tauri capability for `opener:allow-open-url` is scoped to `http://*` and `https://*` — keep this lock-down when adding new schemes.

## Risk register

| Risk | Mitigation |
|---|---|
| WebLinksAddon swallows shift+click or middle-click in ways that regress current xterm UX | Manual verification list covers selection + middle-click paste |
| Tauri WKWebView on macOS occasionally drops `metaKey` on mouse events | `shouldOpenLink` checks both `event.metaKey` and `event.getModifierState("Meta")` |
| `tauri-plugin-opener` permission schema changes between Tauri 2.x minor versions | Pin the crate to `"2"` (any 2.x); the `{ url: "..." }` glob schema is stable across 2.x per the v2 docs |
| Future scheme additions accidentally widen the opener scope to anything | CLAUDE.md note explicitly flags the lock-down |

## Out of scope (recorded so reviewer doesn't re-suggest)

- File-path linkification.
- "Always trust" / "ask before opening" prompts.
- Right-click menu integration.
- Configurable modifier in Settings.
- OSC 8 hyperlink escape sequences (`ESC ] 8 ; ; URL ESC \`). Behavior unchanged from today.

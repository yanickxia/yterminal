# Terminal Link Click — Design Spec

**Date:** 2026-06-30
**Status:** Draft (pending review)
**Scope:** Add http/https link detection in terminal output and open them on cmd/ctrl + click using the system default browser.

## Goal

Users see `http://...` / `https://...` in terminal output and want to open them without copying. The current build has no link affordance at all. We will add:

1. Visual recognition (hover underline + pointer cursor) for http/https URLs in any pane.
2. Open on click with the platform-default modifier (macOS = cmd, Windows/Linux = ctrl).
3. Open via the system default browser, not inside the Tauri WebView.

Non-goals (deferred to later changes — do not add now):

- Recognizing other schemes (`file://`, `mailto:`, `ssh://`, `git@host:repo`).
- Custom matchers (Jira tickets, GitHub issue refs, etc.).
- A user-configurable modifier key in Settings.
- Right-click "Open Link" / "Copy Link" entries in the context menu.

## Architecture

### Frontend integration

The xterm.js ecosystem provides `@xterm/addon-web-links`, which already handles URL regex matching, hover underline, cursor switching, and event interception so a click on a link does not start a text selection. We adopt it as-is and replace only the click handler.

Integration point: `src/lib/terminal-manager.ts`, inside the function that constructs a new `Terminal` and loads its addons (currently loads `FitAddon`, `SerializeAddon`, `SearchAddon`). After the existing addons, instantiate:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
import { shouldOpenLink } from "./link-modifier";
import { openUrl } from "./opener";

term.loadAddon(new WebLinksAddon((event, uri) => {
  if (shouldOpenLink(event)) {
    void openUrl(uri);
  }
}));
```

The addon's hover/underline/cursor behavior is left at default — it underlines on hover regardless of whether the modifier is held. This matches iTerm2 and the VS Code integrated terminal, and avoids the reverse-discoverability problem ("the user must already know to hold cmd before they can see links exist").

### New module: `src/lib/link-modifier.ts`

Pure function, no IO, easy to unit-test:

```ts
const isMac = navigator.platform.toLowerCase().includes("mac");

export function shouldOpenLink(event: MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
```

Platform detection runs once at module load. We intentionally use `navigator.platform` (sync, available everywhere) rather than Tauri's async `platform()` API to keep the click path synchronous — the WebLinksAddon handler is sync.

### New module: `src/lib/opener.ts`

Thin wrapper around `tauri-plugin-opener`'s `openUrl` invoke. Existence justified by (a) keeping the Tauri import surface centralized, mirroring `src/lib/pty.ts`, and (b) being mockable in vitest without faking `@tauri-apps/api`.

```ts
import { invoke } from "@tauri-apps/api/core";

export async function openUrl(uri: string): Promise<void> {
  await invoke("plugin:opener|open_url", { url: uri });
}
```

(Exact invoke name follows whatever `tauri-plugin-opener` exposes in its current Tauri 2 release; the JS package re-exports `openUrl` from `@tauri-apps/plugin-opener` — we'll use that helper instead of raw `invoke` if available. Implementation step verifies.)

### Backend (`src-tauri/`)

- `src-tauri/Cargo.toml`: add `tauri-plugin-opener = "2"` to `[dependencies]`.
- `src-tauri/src/main.rs`: register the plugin inside the Builder chain, alongside the existing `tauri_plugin_os::init()` / `tauri_plugin_updater::...` / `tauri_plugin_process::init()` calls.
- `src-tauri/capabilities/default.json`: append a permission entry that allows `opener:allow-open-url` **with scope restricted to `http://**` and `https://**`**. This is a defense-in-depth measure: the addon's regex only matches http/https in the first place, but locking the capability prevents accidental future widening.

Concrete capability shape (TBD by current plugin schema, the implementation step pins the exact form):

```json
{
  "identifier": "opener:allow-open-url",
  "allow": [
    { "url": "http://**" },
    { "url": "https://**" }
  ]
}
```

## Data flow

```
xterm output → WebLinksAddon regex match
            → user hovers      → addon paints underline + sets pointer cursor
            → user clicks      → addon invokes our handler(event, uri)
                              → shouldOpenLink(event)?  no → return
                                                       yes → openUrl(uri)
                                                           → invoke "plugin:opener|open_url"
                                                           → OS hands off to default browser
```

No state is added to the Zustand store. No persistence. No new IPC channels beyond the one the opener plugin already provides.

## Error handling

- `openUrl` rejection (e.g., capability scope denies the URL) is caught and logged via `console.warn` only. No user-facing toast: a click that does nothing is acceptable, and a noisy popup for what is usually a typo'd URL is worse than silence.
- Addon load failure (e.g., transient bundler issue) is also tolerated — `term.loadAddon` throws synchronously, so wrap the call in a `try`/`catch` and `console.error`. The terminal remains usable without link support.

## Testing

Unit tests (vitest, node env — no DOM):

- `src/lib/link-modifier.test.ts`: matrix of `metaKey` × `ctrlKey` × platform → expected boolean. Stub the module's platform detection by importing the function with a mocked `navigator.platform` via vi.stubGlobal.
- `src/lib/opener.test.ts`: mock `@tauri-apps/api/core` `invoke`; assert `openUrl("https://example.com")` invokes with the expected command name and `{ url }` payload.

No DOM/integration test for the addon wiring itself — matches the project's current testing posture (terminal-manager has no DOM test today). Manual verification in `npm run tauri:dev`:

- http and https links render with underline on hover.
- cmd-click (mac) / ctrl-click (win/linux) opens in system browser.
- plain click does nothing and does not break text selection.
- shift-click extends selection through a link as before.

`npx tsc --noEmit` and `npm run build` must pass.

## CLAUDE.md update

Append a short subsection under "Architecture" (after "Theming"):

> **Link handling.** `terminal-manager.ts` loads `@xterm/addon-web-links` on every new `Terminal`. The click handler delegates to `src/lib/link-modifier.ts` (cmd on macOS, ctrl elsewhere) and `src/lib/opener.ts` (thin wrapper over `tauri-plugin-opener`). The Tauri capability for `opener:allow-open-url` is scoped to `http://**` and `https://**` — keep this lock-down when adding new schemes.

## Risk register

| Risk | Mitigation |
|---|---|
| WebLinksAddon swallows shift+click or middle-click in ways that regress current xterm UX | Manual verification covers selection + middle-click paste; tests in test plan above |
| Tauri WebView (WKWebView on macOS) does not propagate `metaKey` on mouse events | Verified path during implementation; if broken, fall back to `event.getModifierState("Meta")` |
| `tauri-plugin-opener` capability schema differs slightly between Tauri 2.x patch versions | Implementation step reads `Cargo.lock`'s current Tauri patch and matches the schema for that exact version |
| Future scheme additions accidentally widen the opener scope to anything | CLAUDE.md note + tests on scope JSON file once added |

## Out of scope (recorded so reviewer doesn't re-suggest)

- File-path linkification.
- "Always trust" / "ask before opening" prompts.
- Right-click menu integration.
- Configurable modifier in Settings.
- Hyperlink escape sequences (`OSC 8`) — addon supports them but we are scoping this change to plain URL detection only. Add later if a user asks.

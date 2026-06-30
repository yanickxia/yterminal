# Terminal Link Click Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize http/https URLs in terminal output and open them in the system default browser on cmd-click (macOS) / ctrl-click (Linux + Windows).

**Architecture:** Load `@xterm/addon-web-links` on every xterm `Terminal`, replace its click handler with a modifier-gated one that delegates to `tauri-plugin-opener`'s `openUrl`. Two new tiny modules in `src/lib/` keep the predicate and the IPC call pure and testable. A Tauri capability entry locks the opener scope to http/https globs as defense-in-depth.

**Tech Stack:** TypeScript (xterm.js 5.5, React 18, Tauri 2 JS API), Rust (Tauri 2 + tauri-plugin-opener), vitest, portable-pty (unchanged).

**Spec:** `docs/superpowers/specs/2026-06-30-terminal-link-click-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add 2 JS deps |
| `src/lib/link-modifier.ts` | Create | Pure modifier-key predicate + platform detection |
| `src/lib/link-modifier.test.ts` | Create | Table tests for the predicate |
| `src/lib/opener.ts` | Create | Thin wrapper over `@tauri-apps/plugin-opener` `openUrl` |
| `src/lib/opener.test.ts` | Create | Mocked-plugin forwarding test |
| `src/lib/terminal-manager.ts` | Modify (lines 9–14, 264–269) | Load `WebLinksAddon` with our handler |
| `src-tauri/Cargo.toml` | Modify | Add `tauri-plugin-opener` crate |
| `src-tauri/src/main.rs` | Modify (lines 381–385 Builder chain) | Register opener plugin |
| `src-tauri/capabilities/default.json` | Modify | Append scoped `opener:allow-open-url` permission |
| `CLAUDE.md` | Modify (after the "Theming" subsection) | Document link handling architecture |

Each unit has one job. `link-modifier` knows nothing about Tauri. `opener` knows nothing about modifier keys or xterm. `terminal-manager` is the only place they meet. This is the boundary that lets the tests be plain pure-function checks instead of jsdom integration tests.

---

## Task 1: Add JS dependencies

**Files:**
- Modify: `package.json` (and `package-lock.json` as a side effect)

- [ ] **Step 1: Install `@xterm/addon-web-links`**

Run:
```bash
npm install @xterm/addon-web-links@^0.11.0
```

Expected: `package.json` `dependencies` gains `"@xterm/addon-web-links": "^0.11.0"`. No errors. Pin to `^0.11.0` because that's the line aligned with `@xterm/xterm` `^5.5.0` (the other `@xterm/addon-*` lines in this repo are 0.10–0.15 and target the same 5.5 core).

- [ ] **Step 2: Install `@tauri-apps/plugin-opener`**

Run:
```bash
npm install @tauri-apps/plugin-opener@^2.5.0
```

Expected: `package.json` `dependencies` gains `"@tauri-apps/plugin-opener": "^2.5.0"`. If npm resolves to a different 2.x patch, accept it — minor patch drift inside 2.x is fine. Do NOT downgrade to 1.x.

- [ ] **Step 3: Type-check baseline**

Run:
```bash
npx tsc --noEmit
```

Expected: PASS. No new files use the new packages yet, so this just confirms the installs didn't break types.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @xterm/addon-web-links and @tauri-apps/plugin-opener deps"
```

---

## Task 2: Pure modifier-key predicate (TDD)

**Files:**
- Create: `src/lib/link-modifier.ts`
- Create: `src/lib/link-modifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/link-modifier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldOpenLink } from "./link-modifier";

function mkEvent(opts: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  metaState?: boolean;
  ctrlState?: boolean;
}): MouseEvent {
  return {
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    getModifierState(key: string) {
      if (key === "Meta") return opts.metaState ?? false;
      if (key === "Control") return opts.ctrlState ?? false;
      return false;
    },
  } as unknown as MouseEvent;
}

describe("shouldOpenLink", () => {
  describe("on macOS (isMac=true)", () => {
    it("returns true when metaKey is set", () => {
      expect(shouldOpenLink(mkEvent({ metaKey: true }), true)).toBe(true);
    });
    it("returns true when getModifierState('Meta') is set", () => {
      expect(shouldOpenLink(mkEvent({ metaState: true }), true)).toBe(true);
    });
    it("returns false when only ctrlKey is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlKey: true }), true)).toBe(false);
    });
    it("returns false when no modifier is set", () => {
      expect(shouldOpenLink(mkEvent({}), true)).toBe(false);
    });
  });

  describe("on Linux/Windows (isMac=false)", () => {
    it("returns true when ctrlKey is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlKey: true }), false)).toBe(true);
    });
    it("returns true when getModifierState('Control') is set", () => {
      expect(shouldOpenLink(mkEvent({ ctrlState: true }), false)).toBe(true);
    });
    it("returns false when only metaKey is set", () => {
      expect(shouldOpenLink(mkEvent({ metaKey: true }), false)).toBe(false);
    });
    it("returns false when no modifier is set", () => {
      expect(shouldOpenLink(mkEvent({}), false)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run:
```bash
npx vitest run src/lib/link-modifier.test.ts
```

Expected: FAIL with `Failed to resolve import "./link-modifier"` (module does not exist yet). Good — confirms the test runs and is not silently passing.

- [ ] **Step 3: Implement the minimal module**

Create `src/lib/link-modifier.ts`:

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

No `detectIsMac` test is needed: it is a one-line wrapper around a global; testing it would just be testing the mock of `navigator.userAgent`. The contract that matters (the predicate) is fully tested above.

- [ ] **Step 4: Run the test, expect pass**

Run:
```bash
npx vitest run src/lib/link-modifier.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/link-modifier.ts src/lib/link-modifier.test.ts
git commit -m "feat(link-modifier): pure cmd/ctrl predicate with platform detection"
```

---

## Task 3: Opener wrapper (TDD)

**Files:**
- Create: `src/lib/opener.ts`
- Create: `src/lib/opener.test.ts`

Reference pattern for mocking Tauri plugins in this repo: `src/stores/updater-store.test.ts` (uses `vi.mock("@tauri-apps/plugin-updater", ...)`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/opener.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";
import { openUrl } from "./opener";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openUrl", () => {
  it("forwards the uri to @tauri-apps/plugin-opener openUrl", async () => {
    await openUrl("https://example.com/path?q=1");
    expect(pluginOpenUrl).toHaveBeenCalledTimes(1);
    expect(pluginOpenUrl).toHaveBeenCalledWith("https://example.com/path?q=1");
  });

  it("propagates plugin rejection so callers can log it", async () => {
    (pluginOpenUrl as any).mockRejectedValueOnce(new Error("scope denied"));
    await expect(openUrl("file:///etc/passwd")).rejects.toThrow("scope denied");
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run:
```bash
npx vitest run src/lib/opener.test.ts
```

Expected: FAIL with `Failed to resolve import "./opener"`.

- [ ] **Step 3: Implement the wrapper**

Create `src/lib/opener.ts`:

```ts
import { openUrl as pluginOpenUrl } from "@tauri-apps/plugin-opener";

export async function openUrl(uri: string): Promise<void> {
  await pluginOpenUrl(uri);
}
```

- [ ] **Step 4: Run the test, expect pass**

Run:
```bash
npx vitest run src/lib/opener.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/opener.ts src/lib/opener.test.ts
git commit -m "feat(opener): wrap @tauri-apps/plugin-opener openUrl for centralized mocking"
```

---

## Task 4: Register the Rust plugin and lock its scope

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs` (lines 381–385, the Builder chain)
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the crate**

Edit `src-tauri/Cargo.toml`. In `[dependencies]`, immediately after the line `tauri-plugin-process = "2"`, add:

```toml
tauri-plugin-opener = "2"
```

The affected window of `[dependencies]` should look like this (the rest of the section — `serde_json`, `portable-pty`, `font-kit`, `rusqlite`, and their comments — stays untouched):

```toml
tauri = { version = "2", features = [] }
tauri-plugin-os = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
# ... existing serde_json, portable-pty, font-kit, rusqlite lines unchanged ...
```

- [ ] **Step 2: Register the plugin in the Builder chain**

Edit `src-tauri/src/main.rs` at line 385. After `.plugin(tauri_plugin_process::init())`, add:

```rust
.plugin(tauri_plugin_opener::init())
```

The Builder block should become:

```rust
tauri::Builder::default()
    ...
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 3: Add the scoped capability**

Edit `src-tauri/capabilities/default.json`. The current `permissions` array is:

```json
[
  "core:default",
  "os:default",
  "updater:default",
  "process:default"
]
```

Append a scoped object so the final file is:

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

This is the entire purpose of the change: limit the IPC surface so a future code path cannot accidentally open `file://`, `javascript:`, or other schemes through this plugin.

- [ ] **Step 4: Verify Rust compiles**

Run:
```bash
cd src-tauri && cargo check && cd ..
```

Expected: PASS. May download `tauri-plugin-opener` the first time. If `cargo check` complains the schema for the capability changed, re-read the v2 docs and adjust to the exact shape; do NOT loosen the scope to fix a parse error.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/capabilities/default.json
git commit -m "feat(opener): register tauri-plugin-opener with http/https-only scope"
```

---

## Task 5: Wire `WebLinksAddon` into the terminal

**Files:**
- Modify: `src/lib/terminal-manager.ts` (imports near top, and addon loading around lines 264–269)

- [ ] **Step 1: Add the imports**

In `src/lib/terminal-manager.ts`, after the existing addon imports (current lines 10–12), add:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
import { detectIsMac, shouldOpenLink } from "./link-modifier";
import { openUrl } from "./opener";
```

- [ ] **Step 2: Cache `isMac` at module scope**

Near the top of the module — directly under the imports and before any function — add:

```ts
const isMac = detectIsMac();
```

Putting this at module scope (not per-session) is intentional: the host OS does not change across the lifetime of the app, and avoiding a per-session userAgent read keeps `createSession` allocations the same.

- [ ] **Step 3: Load the addon during session construction**

In the `createSession` function, at the existing block:

```ts
const fit = new FitAddon();
const serialize = new SerializeAddon();
const search = new SearchAddon();
term.loadAddon(fit);
term.loadAddon(serialize);
term.loadAddon(search);
```

Append immediately after the `term.loadAddon(search);` line:

```ts
term.loadAddon(
  new WebLinksAddon((event, uri) => {
    if (shouldOpenLink(event, isMac)) {
      void openUrl(uri).catch((err) => {
        console.warn("openUrl failed", err);
      });
    }
  }),
);
```

Notes:
- The addon is not stored on the `Session` struct because nothing else needs to reference it after construction. xterm disposes addons when `Terminal.dispose()` is called, which already happens in `disposeSession`.
- No try/catch around `loadAddon` — see spec rationale (no documented throw site).
- `console.warn` (not `console.error` and not a UI toast) is deliberate: failing-open silently matches user-facing expectations.

- [ ] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run:
```bash
npm test
```

Expected: PASS. The two new test files plus the existing `updater-store.test.ts` and the script test all green.

- [ ] **Step 6: Production build sanity-check**

Run:
```bash
npm run build
```

Expected: PASS. This is also what CI runs (`tsc --noEmit` + Vite build), so a green local run is the floor before pushing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/terminal-manager.ts
git commit -m "feat(terminal): wire WebLinksAddon to cmd/ctrl-click open"
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — append a new subsection after the "### Theming" block and before the "### Updater" block.

- [ ] **Step 1: Insert the subsection**

Find the "### Theming" subsection in `CLAUDE.md`. After its paragraph ends and before `### Updater`, insert:

```markdown
### Link handling

`terminal-manager.ts` loads `@xterm/addon-web-links` on every new `Terminal`. The click handler delegates to:

- `src/lib/link-modifier.ts` — pure predicate `shouldOpenLink(event, isMac)`; `isMac` is detected once at module load via `navigator.userAgent` (matches the existing UA-based platform check used by `pickShell`). Belt-and-suspenders: the predicate also calls `event.getModifierState(...)` because Tauri's WKWebView on macOS occasionally drops `metaKey`.
- `src/lib/opener.ts` — thin wrapper over `@tauri-apps/plugin-opener` `openUrl`, mirroring the `src/lib/pty.ts` shape so the IPC surface is centralized and mockable in vitest.

The Tauri capability `opener:allow-open-url` in `src-tauri/capabilities/default.json` is scoped to `http://*` and `https://*`. **Keep this lock-down when adding new schemes** — widening the scope (to `file://`, `mailto:`, etc.) is a security decision, not a cleanup task.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document link handling architecture"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full type-check**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Full test run**

```bash
npm test
```

Expected: PASS. All tests including the two new files.

- [ ] **Step 3: Full production build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Rust check**

```bash
cd src-tauri && cargo check && cd ..
```

Expected: PASS.

- [ ] **Step 5: Manual GUI smoke test**

Run:
```bash
npm run tauri:dev
```

In the running app, in any pane, `echo` or `printf` a URL into the shell and try each of:

| Action | Expected |
|---|---|
| Hover over `https://example.com` | Underline appears, cursor becomes pointer |
| Cmd-click (mac) / Ctrl-click (Linux+Win) on the URL | URL opens in the system default browser |
| Plain click on the URL (no modifier) | Nothing happens; no popup, no selection started at link position |
| Drag-select across a URL | Normal text selection works, link does not steal the drag |
| Shift-click past a URL | Selection extends through the link |
| Try `printf 'file:///etc/passwd\n'` and cmd/ctrl-click | Either nothing happens, or the opener IPC is rejected with a scope error in `console` — confirm the file is **not** opened |
| Middle-click in the terminal (Linux only, if running there) | Paste still works |

If any row fails, do not mark this step complete — fix in the appropriate prior task and re-run.

- [ ] **Step 6: No commit needed for this task** — verification only.

Use @superpowers:verification-before-completion to confirm each command in steps 1–4 actually ran and was green before declaring the plan done.

---

## Out of scope (do not implement here)

- File-path linkification, OSC 8 hyperlinks, custom matchers (Jira, GitHub refs).
- Right-click context menu "Open Link" / "Copy Link".
- Settings UI for choosing the modifier key.
- "Always trust" / confirmation dialogs.

These belong in follow-up plans if the user asks. Per the spec, do not pre-implement.

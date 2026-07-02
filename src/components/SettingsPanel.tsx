import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useSettingsStore,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_DIVIDER_WIDTH,
  MAX_DIVIDER_WIDTH,
  MIN_SCROLLBACK_LINES,
  MAX_SCROLLBACK_LINES,
  DEFAULT_SCROLLBACK_LINES,
  SCROLLBACK_UNLIMITED,
  PROVIDER_PRESETS,
  type DefaultCwdMode,
  type AiProviderKind,
} from "../stores/settings-store";
import { THEMES, FONTS, getAllFonts, registerSystemFonts } from "../lib/themes";
import { applyAppearance } from "../lib/terminal-manager";
import { saveConfigToDisk, configFilePath } from "../lib/config";
import { detectIsMac } from "../lib/link-modifier";
import { playAlertSound } from "../lib/alert-sound";
import { useUpdaterStore } from "../stores/updater-store";
import {
  exportLogs,
  clearLogs,
  logDirPath,
  setVerbose,
} from "../lib/logger";

type TabId = "appearance" | "terminal" | "ai" | "debug" | "update";

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "ai", label: "AI" },
  { id: "debug", label: "Debug" },
  { id: "update", label: "Update" },
];

/**
 * Settings modal grouped into tabs:
 *   - Appearance: theme, font, font size
 *   - Terminal: scrollback buffer + pane divider
 * All changes apply live to every open terminal via applyAppearance() and are
 * written to the on-disk JSON config so they sync across machines.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const themeId = useSettingsStore((s) => s.themeId);
  const fontId = useSettingsStore((s) => s.fontId);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const dividerWidth = useSettingsStore((s) => s.dividerWidth);
  const dividerColor = useSettingsStore((s) => s.dividerColor);
  const scrollbackLines = useSettingsStore((s) => s.scrollbackLines);
  const defaultCwdMode = useSettingsStore((s) => s.defaultCwdMode);
  const defaultCwdFixed = useSettingsStore((s) => s.defaultCwdFixed);
  const requireModifierForLinks = useSettingsStore(
    (s) => s.requireModifierForLinks
  );
  const copyOnSelect = useSettingsStore((s) => s.copyOnSelect);
  const alertSoundEnabled = useSettingsStore((s) => s.alertSoundEnabled);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setDividerWidth = useSettingsStore((s) => s.setDividerWidth);
  const setDividerColor = useSettingsStore((s) => s.setDividerColor);
  const setScrollbackLines = useSettingsStore((s) => s.setScrollbackLines);
  const setDefaultCwdMode = useSettingsStore((s) => s.setDefaultCwdMode);
  const setDefaultCwdFixed = useSettingsStore((s) => s.setDefaultCwdFixed);
  const setRequireModifierForLinks = useSettingsStore(
    (s) => s.setRequireModifierForLinks
  );
  const setCopyOnSelect = useSettingsStore((s) => s.setCopyOnSelect);
  const setAlertSoundEnabled = useSettingsStore((s) => s.setAlertSoundEnabled);

  const [tab, setTab] = useState<TabId>("appearance");
  const isMac = detectIsMac();
  const [cfgPath, setCfgPath] = useState("");
  const [fontsBump, setFontsBump] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // local string state for the scrollback number input so the user can type
  // freely (intermediate empty / out-of-range values) without the store
  // immediately clamping their input mid-edit.
  const [scrollbackDraft, setScrollbackDraft] = useState<string>(() =>
    scrollbackLines === SCROLLBACK_UNLIMITED ? "" : String(scrollbackLines)
  );
  // built-in presets vs. fonts detected on this machine. Recomputed when
  // fontsBump changes so a manual refresh re-renders the picker.
  const builtinIds = new Set(FONTS.map((f) => f.id));
  const systemFonts = (() => {
    void fontsBump;
    return getAllFonts().filter((f) => !builtinIds.has(f.id));
  })();
  // skip persisting on the initial mount (only write on actual user changes)
  const mounted = useRef(false);

  async function refreshFonts() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const families = await invoke<string[]>("refresh_fonts");
      registerSystemFonts(
        families.map((family) => ({
          id: family,
          name: family,
          stack: `"${family}", monospace`,
        }))
      );
      setFontsBump((n) => n + 1);
    } catch {
      /* command unavailable (non-Tauri) — silently no-op */
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    configFilePath().then(setCfgPath);
  }, []);

  // re-apply to live terminals and persist to the JSON file on any change
  useEffect(() => {
    applyAppearance();
    if (mounted.current) saveConfigToDisk();
    else mounted.current = true;
  }, [
    themeId,
    fontId,
    fontSize,
    dividerWidth,
    dividerColor,
    scrollbackLines,
    defaultCwdMode,
    defaultCwdFixed,
    requireModifierForLinks,
    copyOnSelect,
  ]);

  // close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function commitScrollbackDraft() {
    const n = Number(scrollbackDraft);
    if (!Number.isFinite(n)) {
      setScrollbackDraft(String(DEFAULT_SCROLLBACK_LINES));
      setScrollbackLines(DEFAULT_SCROLLBACK_LINES);
      return;
    }
    const clamped = Math.max(
      MIN_SCROLLBACK_LINES,
      Math.min(MAX_SCROLLBACK_LINES, Math.round(n))
    );
    setScrollbackDraft(String(clamped));
    setScrollbackLines(clamped);
  }

  const unlimited = scrollbackLines === SCROLLBACK_UNLIMITED;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-tabs" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Settings</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-tabbar" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={"settings-tab" + (tab === t.id ? " active" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "appearance" && (
            <>
              {/* skin / theme */}
              <div className="field">
                <label className="field-label">Theme (skin)</label>
                <div className="theme-grid">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={
                        "theme-swatch" + (t.id === themeId ? " active" : "")
                      }
                      onClick={() => setTheme(t.id)}
                      title={t.name}
                      style={{
                        background: t.palette.bgDark,
                        borderColor:
                          t.id === themeId
                            ? t.palette.accent
                            : t.palette.bgLight,
                      }}
                    >
                      <span className="theme-dots">
                        <i style={{ background: t.palette.red }} />
                        <i style={{ background: t.palette.green }} />
                        <i style={{ background: t.palette.blue }} />
                        <i style={{ background: t.palette.accent }} />
                      </span>
                      <span
                        className="theme-name"
                        style={{ color: t.palette.fg }}
                      >
                        {t.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* font family */}
              <div className="field">
                <label className="field-label" htmlFor="font-select">
                  Font
                  <button
                    type="button"
                    className="link-btn"
                    onClick={refreshFonts}
                    disabled={refreshing}
                    title="Re-scan installed system fonts"
                  >
                    {refreshing ? "scanning…" : "refresh"}
                  </button>
                </label>
                <select
                  id="font-select"
                  className="select"
                  value={fontId}
                  onChange={(e) => setFont(e.target.value)}
                >
                  <optgroup label="Built-in">
                    {FONTS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                  {systemFonts.length > 0 && (
                    <optgroup label="System fonts">
                      {systemFonts.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {/* font size */}
              <div className="field">
                <label className="field-label">Font size — {fontSize}px</label>
                <input
                  type="range"
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="range"
                />
              </div>
            </>
          )}

          {tab === "terminal" && (
            <>
              {/* scrollback */}
              <div className="field">
                <label className="field-label">Scrollback lines</label>
                <div className="scrollback-row">
                  <input
                    type="number"
                    className="select scrollback-input"
                    min={MIN_SCROLLBACK_LINES}
                    max={MAX_SCROLLBACK_LINES}
                    step={100}
                    value={unlimited ? "" : scrollbackDraft}
                    placeholder={unlimited ? "unlimited" : ""}
                    disabled={unlimited}
                    onChange={(e) => setScrollbackDraft(e.target.value)}
                    onBlur={commitScrollbackDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        commitScrollbackDraft();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={unlimited}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setScrollbackLines(SCROLLBACK_UNLIMITED);
                        } else {
                          const n =
                            Number(scrollbackDraft) || DEFAULT_SCROLLBACK_LINES;
                          setScrollbackDraft(String(n));
                          setScrollbackLines(n);
                        }
                      }}
                    />
                    Unlimited
                  </label>
                </div>
                <p className="field-hint">
                  Lines kept in each terminal's in-memory buffer. Unlimited uses
                  more RAM for long-running shells.
                </p>
              </div>

              {/* pane divider */}
              <div className="field">
                <label className="field-label">
                  Pane divider width — {dividerWidth}px
                </label>
                <input
                  type="range"
                  min={MIN_DIVIDER_WIDTH}
                  max={MAX_DIVIDER_WIDTH}
                  value={dividerWidth}
                  onChange={(e) => setDividerWidth(Number(e.target.value))}
                  className="range"
                />
              </div>

              <div className="field">
                <label className="field-label">Pane divider color</label>
                <div className="divider-color-row">
                  <input
                    type="color"
                    value={normalizeColorForInput(dividerColor)}
                    onChange={(e) => setDividerColor(e.target.value)}
                    className="color-input"
                  />
                  <input
                    type="text"
                    value={dividerColor}
                    onChange={(e) => setDividerColor(e.target.value)}
                    className="select"
                    spellCheck={false}
                  />
                </div>
              </div>

              {/* fallback working directory when no pane cwd can be inherited */}
              <div className="field">
                <label className="field-label" htmlFor="cwd-mode-select">
                  Default working directory
                </label>
                <select
                  id="cwd-mode-select"
                  className="select"
                  value={defaultCwdMode}
                  onChange={(e) =>
                    setDefaultCwdMode(e.target.value as DefaultCwdMode)
                  }
                >
                  <option value="inherit">Previous (active tab's cwd)</option>
                  <option value="home">Home (~)</option>
                  <option value="fixed">Fixed path…</option>
                </select>
                {defaultCwdMode === "fixed" && (
                  <input
                    type="text"
                    className="select"
                    style={{ marginTop: 6 }}
                    placeholder="/Users/you/projects"
                    value={defaultCwdFixed}
                    onChange={(e) => setDefaultCwdFixed(e.target.value)}
                    spellCheck={false}
                  />
                )}
                <p className="field-hint">
                  New tabs inherit the active pane in this workspace. This is
                  used only when no pane directory is available.
                </p>
              </div>

              {/* link click modifier gate */}
              <div className="field">
                <label className="field-label">Opening links</label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={requireModifierForLinks}
                    onChange={(e) =>
                      setRequireModifierForLinks(e.target.checked)
                    }
                  />
                  Require {isMac ? "Cmd" : "Ctrl"} to open links
                </label>
                <p className="field-hint">
                  When on, links and file paths in terminal output open only on{" "}
                  {isMac ? "Cmd" : "Ctrl"}+click. When off, a plain
                  click opens them.
                </p>
              </div>

              {/* copy-on-select */}
              <div className="field">
                <label className="field-label">Copying</label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={copyOnSelect}
                    onChange={(e) => setCopyOnSelect(e.target.checked)}
                  />
                  Copy on select
                </label>
                <p className="field-hint">
                  When on, selecting terminal text copies it to the clipboard
                  automatically. {isMac ? "Cmd" : "Ctrl+Shift"}+C and right-click
                  Copy work regardless.
                </p>
              </div>

              {/* attention alert sound */}
              <div className="field">
                <label className="field-label">Attention alert</label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={alertSoundEnabled}
                    onChange={(e) => setAlertSoundEnabled(e.target.checked)}
                  />
                  Play a sound when a background pane needs attention
                </label>
                <p className="field-hint">
                  A coding agent (Claude Code, OpenCode, …) rings the terminal
                  bell when it pauses for input or errors out. When on, an
                  unfocused pane doing so plays a chime; the status bar under the
                  tabs always shows which tab is waiting.{" "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => playAlertSound(true)}
                  >
                    Preview sound
                  </button>
                </p>
              </div>
            </>
          )}

          {tab === "ai" && <AiTab />}

          {tab === "update" && (
            <UpdateTab />
          )}

          {tab === "debug" && <DebugTab />}

          {/* config file location stays at the bottom regardless of tab */}
          {cfgPath && (
            <div className="field config-footer">
              <label className="field-label">Config file (JSON, syncable)</label>
              <code className="config-path">{cfgPath}</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AiTab() {
  const providers = useSettingsStore((s) => s.aiProviders);
  const activeId = useSettingsStore((s) => s.activeAiProviderId);
  const addProvider = useSettingsStore((s) => s.addAiProvider);
  const updateProvider = useSettingsStore((s) => s.updateAiProvider);
  const removeProvider = useSettingsStore((s) => s.removeAiProvider);
  const setActive = useSettingsStore((s) => s.setActiveAiProvider);

  // Switching a card's protocol: if its base URL / model were left at the old
  // kind's preset (i.e. the user never customized them), swap them to the new
  // kind's preset so the row is immediately usable. Otherwise leave the user's
  // values untouched — only the protocol flips.
  function changeKind(
    p: { id: string; kind: AiProviderKind; baseUrl: string; model: string },
    next: AiProviderKind
  ) {
    if (next === p.kind) return;
    const from = PROVIDER_PRESETS[p.kind];
    const to = PROVIDER_PRESETS[next];
    const patch: Partial<{
      kind: AiProviderKind;
      baseUrl: string;
      model: string;
    }> = { kind: next };
    if (!p.baseUrl.trim() || p.baseUrl.trim() === from.baseUrl)
      patch.baseUrl = to.baseUrl;
    if (!p.model.trim() || p.model.trim() === from.model) patch.model = to.model;
    updateProvider(p.id, patch);
  }

  return (
    <>
      <div className="field">
        <label className="field-label">AI providers</label>
        <p className="field-hint">
          Configure one or more model endpoints for the AI sidebar. Pick a
          protocol per provider — <b>OpenAI-compatible</b> (OpenAI, Azure,
          Groq, OpenRouter, local llama.cpp…) or <b>Anthropic</b> (the Claude
          Messages API). API keys are stored locally and are never written to
          the syncable JSON config.
        </p>
      </div>

      {providers.length === 0 && (
        <div className="field">
          <p className="field-hint">No providers yet. Add one below.</p>
        </div>
      )}

      {providers.map((p) => {
        const isAnthropic = p.kind === "anthropic";
        const endpoint =
          (p.baseUrl.trim().replace(/\/+$/, "") || "…") +
          (isAnthropic ? "/v1/messages" : "/chat/completions");
        return (
          <div
            key={p.id}
            className={
              "field ai-provider-card" +
              (activeId === p.id ? " active" : "")
            }
          >
            <div className="ai-provider-head">
              <label className="checkbox-label ai-provider-active">
                <input
                  type="radio"
                  name="ai-active-provider"
                  checked={activeId === p.id}
                  onChange={() => setActive(p.id)}
                />
                Active
              </label>
              <div className="ai-provider-kind">
                <select
                  className="select"
                  value={p.kind}
                  onChange={(e) =>
                    changeKind(p, e.target.value as AiProviderKind)
                  }
                  title="API protocol this provider speaks"
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </div>
              <button
                type="button"
                className="link-btn"
                onClick={() => removeProvider(p.id)}
                title="Remove this provider"
              >
                remove
              </button>
            </div>

            <div className="ai-provider-field">
              <label className="ai-field-label">Name</label>
              <input
                type="text"
                className="select"
                placeholder={isAnthropic ? "Anthropic" : "OpenAI"}
                value={p.name}
                onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                spellCheck={false}
              />
            </div>

            <div className="ai-provider-field">
              <label className="ai-field-label">Base URL</label>
              <input
                type="text"
                className="select"
                placeholder={PROVIDER_PRESETS[p.kind].baseUrl}
                value={p.baseUrl}
                onChange={(e) =>
                  updateProvider(p.id, { baseUrl: e.target.value })
                }
                spellCheck={false}
              />
              <p className="ai-field-endpoint">
                Requests go to <code>{endpoint}</code>
              </p>
            </div>

            <div className="ai-provider-field">
              <label className="ai-field-label">Model</label>
              <input
                type="text"
                className="select"
                placeholder={PROVIDER_PRESETS[p.kind].model}
                value={p.model}
                onChange={(e) =>
                  updateProvider(p.id, { model: e.target.value })
                }
                spellCheck={false}
              />
            </div>

            <div className="ai-provider-field">
              <label className="ai-field-label">
                API key {isAnthropic ? "(x-api-key)" : "(Bearer)"}
              </label>
              <input
                type="password"
                className="select"
                placeholder={isAnthropic ? "sk-ant-…" : "sk-…"}
                value={p.apiKey}
                onChange={(e) =>
                  updateProvider(p.id, { apiKey: e.target.value })
                }
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
        );
      })}

      <div className="field ai-provider-add">
        <button type="button" onClick={() => addProvider("openai")}>
          + OpenAI-compatible
        </button>
        <button type="button" onClick={() => addProvider("anthropic")}>
          + Anthropic
        </button>
      </div>
    </>
  );
}

function DebugTab() {
  const debugVerbose = useSettingsStore((s) => s.debugVerbose);
  const setDebugVerbose = useSettingsStore((s) => s.setDebugVerbose);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    logDirPath().then(setDir);
  }, []);

  async function onExport() {
    if (busy) return;
    setBusy(true);
    setStatus("Exporting…");
    try {
      const path = await exportLogs();
      setStatus(`Exported to: ${path}`);
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (busy) return;
    setBusy(true);
    try {
      await clearLogs();
      setStatus("Logs cleared.");
    } catch (e) {
      setStatus(`Clear failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleVerbose(on: boolean) {
    setDebugVerbose(on);
    // mirror into the frontend logger and the backend immediately so the new
    // level takes effect without a restart
    setVerbose(on);
    try {
      await invoke("set_log_verbose", { verbose: on });
    } catch {
      /* non-Tauri — ignore */
    }
  }

  return (
    <>
      <div className="field">
        <label className="field-label">Diagnostic logging</label>
        <p className="field-hint">
          Logs record sizes, ids, durations and control metadata to help
          diagnose hangs and dropped input. Terminal content and keystrokes are
          never recorded.
        </p>
      </div>

      <div className="field">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={debugVerbose}
            onChange={(e) => onToggleVerbose(e.target.checked)}
          />
          Verbose (capture DEBUG/TRACE detail)
        </label>
        <p className="field-hint">
          Keep on while reproducing the hang — it captures per-keystroke and
          per-read timing needed to find the stall.
        </p>
      </div>

      <div className="field">
        <label className="field-label">Logs</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onExport} disabled={busy}>
            {busy ? "Working…" : "Export logs"}
          </button>
          <button onClick={onClear} disabled={busy}>
            Clear logs
          </button>
        </div>
        {status && (
          <p className="field-hint" style={{ wordBreak: "break-all" }}>
            {status}
          </p>
        )}
      </div>

      {dir && (
        <div className="field">
          <label className="field-label">Log directory</label>
          <code className="config-path">{dir}</code>
        </div>
      )}

      <div className="field">
        <label className="field-label">Developer tools</label>
        <p className="field-hint">
          Opens the WebView devtools window. Useful for inspecting
          localStorage state when triaging persistence issues.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              invoke("open_devtools").catch((e) =>
                setStatus(`Open DevTools failed: ${String(e)}`)
              );
            }}
          >
            Open DevTools
          </button>
        </div>
      </div>
    </>
  );
}

function UpdateTab() {
  const state = useUpdaterStore((s) => s.state);
  const manifest = useUpdaterStore((s) => s.manifest);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const recheck = useUpdaterStore((s) => s.check);

  const currentVersion = __APP_VERSION__;
  return (
    <div className="field">
      <label className="field-label">Current version</label>
      <div>{currentVersion}</div>
      <div style={{ marginTop: 12 }}>
        <button onClick={() => recheck()} disabled={state === "checking"}>
          {state === "checking"
            ? "Checking…"
            : state === "available" && manifest
            ? `View update v${manifest.version}`
            : state === "error"
            ? "Retry"
            : "Check for updates"}
        </button>
        {lastCheckedAt && (
          <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
            Last checked: {new Date(lastCheckedAt).toLocaleString()}
          </span>
        )}
      </div>
      {state === "error" && errorMessage && (
        <div style={{ marginTop: 8, color: "var(--err, #c66)" }}>
          {errorMessage}
        </div>
      )}
      {state === "up-to-date" && (
        <div style={{ marginTop: 8, opacity: 0.7 }}>You're up to date.</div>
      )}
    </div>
  );
}

/** Coerce any CSS color string to a 7-char #rrggbb for <input type="color">. */
function normalizeColorForInput(c: string): string {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return "#000000";
  if (m[1].length === 3) {
    const [r, g, b] = m[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return `#${m[1].toLowerCase()}`;
}

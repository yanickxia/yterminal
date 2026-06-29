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
  type DefaultCwdMode,
} from "../stores/settings-store";
import { THEMES, FONTS, getAllFonts, registerSystemFonts } from "../lib/themes";
import { applyAppearance } from "../lib/terminal-manager";
import { saveConfigToDisk, configFilePath } from "../lib/config";
import { useUpdaterStore } from "../stores/updater-store";

type TabId = "appearance" | "terminal" | "update";

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
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
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setDividerWidth = useSettingsStore((s) => s.setDividerWidth);
  const setDividerColor = useSettingsStore((s) => s.setDividerColor);
  const setScrollbackLines = useSettingsStore((s) => s.setScrollbackLines);
  const setDefaultCwdMode = useSettingsStore((s) => s.setDefaultCwdMode);
  const setDefaultCwdFixed = useSettingsStore((s) => s.setDefaultCwdFixed);

  const [tab, setTab] = useState<TabId>("appearance");
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
            </>
          )}

          {tab === "update" && (
            <UpdateTab />
          )}

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

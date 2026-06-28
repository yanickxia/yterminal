import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  useSettingsStore,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_DIVIDER_WIDTH,
  MAX_DIVIDER_WIDTH,
} from "../stores/settings-store";
import { THEMES, FONTS, getAllFonts, registerSystemFonts } from "../lib/themes";
import { applyAppearance } from "../lib/terminal-manager";
import { saveConfigToDisk, configFilePath } from "../lib/config";

/**
 * Appearance settings modal: terminal theme (skin), font family, font size.
 * Changes apply live to every open terminal via applyAppearance() and are also
 * written to the on-disk JSON config so they can be synced across machines.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const themeId = useSettingsStore((s) => s.themeId);
  const fontId = useSettingsStore((s) => s.fontId);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const dividerWidth = useSettingsStore((s) => s.dividerWidth);
  const dividerColor = useSettingsStore((s) => s.dividerColor);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setDividerWidth = useSettingsStore((s) => s.setDividerWidth);
  const setDividerColor = useSettingsStore((s) => s.setDividerColor);

  const [cfgPath, setCfgPath] = useState("");
  const [fontsBump, setFontsBump] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
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
  }, [themeId, fontId, fontSize, dividerWidth, dividerColor]);

  // close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Appearance</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* skin / theme */}
          <div className="field">
            <label className="field-label">Theme (skin)</label>
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={"theme-swatch" + (t.id === themeId ? " active" : "")}
                  onClick={() => setTheme(t.id)}
                  title={t.name}
                  style={{
                    background: t.palette.bgDark,
                    borderColor:
                      t.id === themeId ? t.palette.accent : t.palette.bgLight,
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

          {/* config file location (sync target) */}
          {cfgPath && (
            <div className="field">
              <label className="field-label">Config file (JSON, syncable)</label>
              <code className="config-path">{cfgPath}</code>
            </div>
          )}
        </div>
      </div>
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

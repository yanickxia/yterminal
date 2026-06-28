import { useEffect, useRef, useState } from "react";
import {
  useSettingsStore,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from "../stores/settings-store";
import { THEMES, FONTS } from "../lib/themes";
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
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFont = useSettingsStore((s) => s.setFont);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  const [cfgPath, setCfgPath] = useState("");
  // skip persisting on the initial mount (only write on actual user changes)
  const mounted = useRef(false);

  useEffect(() => {
    configFilePath().then(setCfgPath);
  }, []);

  // re-apply to live terminals and persist to the JSON file on any change
  useEffect(() => {
    applyAppearance();
    if (mounted.current) saveConfigToDisk();
    else mounted.current = true;
  }, [themeId, fontId, fontSize]);

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
            </label>
            <select
              id="font-select"
              className="select"
              value={fontId}
              onChange={(e) => setFont(e.target.value)}
            >
              {FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
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

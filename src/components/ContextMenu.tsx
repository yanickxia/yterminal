import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { separator: true }
  | {
      label: string;
      onClick: () => void;
      disabled?: boolean;
      danger?: boolean;
    };

/**
 * Lightweight right-click menu. Portaled to <body> so it's never clipped by a
 * parent's overflow, and clamped to the viewport so the bottom-right of the
 * screen still gets a fully-visible menu. Dismisses on outside click or Esc.
 */
export function ContextMenu({
  items,
  x,
  y,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x,
    top: y,
  });

  // clamp into viewport AFTER first paint, when we know the menu's measured size
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const pad = 4;
    const left = Math.min(x, window.innerWidth - w - pad);
    const top = Math.min(y, window.innerHeight - h - pad);
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  }, [x, y]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onClickAway(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("keydown", onKey);
    // capture phase so we beat React's synthetic onClick on items underneath
    window.addEventListener("mousedown", onClickAway, true);
    window.addEventListener("wheel", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClickAway, true);
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const menu = (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        "separator" in it ? (
          <div key={`sep-${i}`} className="ctx-sep" />
        ) : (
          <button
            key={`${i}-${it.label}`}
            type="button"
            className={
              "ctx-item" +
              (it.disabled ? " disabled" : "") +
              (it.danger ? " danger" : "")
            }
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onClose();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  );

  return createPortal(menu, document.body);
}

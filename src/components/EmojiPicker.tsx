import { useEffect, useRef } from "react";

// A compact, dependency-free emoji picker. We don't bundle a full emoji
// database — just a curated set that's useful for labelling workspaces/tabs
// (projects, environments, status), plus a "clear" option to remove an icon.
const EMOJIS: string[] = [
  "🐚", "💻", "⚡", "🚀", "🔧", "🛠️", "🐳", "📦", "🗄️", "🧪",
  "🔬", "🐍", "🦀", "🐹", "☕", "📝", "📊", "🔥", "✨", "⭐",
  "🌱", "🌳", "🍀", "🎯", "🎨", "🧩", "🔑", "🔒", "🌐", "📡",
  "🤖", "👻", "🐛", "🩺", "💡", "📁", "🏠", "🏢", "☁️", "🌙",
  "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚪", "⚫", "❤️", "💙",
];

/**
 * Small floating emoji picker, positioned with `fixed` at the given anchor
 * point (usually the bottom-left of the trigger button) so it is never clipped
 * by scrolling ancestors like the tab bar or workspace list. Calls onPick with
 * the chosen emoji, or "" to clear.
 */
export function EmojiPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: { x: number; y: number };
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // close on outside click or Escape
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // defer so the click that opened us doesn't immediately close it
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // keep the popover inside the viewport (clamp the right/bottom edges)
  const width = 232;
  const left = Math.min(anchor.x, window.innerWidth - width - 8);
  const top = Math.min(anchor.y, window.innerHeight - 8);

  return (
    <div
      className="emoji-picker"
      ref={ref}
      style={{ left: Math.max(8, left), top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="emoji-grid">
        {EMOJIS.map((e) => (
          <button
            key={e}
            className="emoji-cell"
            onClick={() => {
              onPick(e);
              onClose();
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <button
        className="emoji-clear"
        onClick={() => {
          onPick("");
          onClose();
        }}
      >
        Clear icon
      </button>
    </div>
  );
}

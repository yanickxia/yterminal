import { useEffect, useRef } from "react";
import type { Tab } from "../lib/types";
import {
  attachSession,
  detachSession,
  fitSession,
} from "../lib/terminal-manager";

/**
 * Renders the ACTIVE tab's terminal. We mount only the active tab's cached
 * xterm DOM node into this container; switching tabs detaches the old one
 * (kept alive) and attaches the new one — preserving scrollback.
 */
export function TerminalView({ tab }: { tab: Tab }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    attachSession(tab.id, container, tab.cwd);

    const onResize = () => fitSession(tab.id);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      detachSession(tab.id);
    };
  }, [tab.id, tab.cwd]);

  return <div className="terminal-host" ref={containerRef} />;
}

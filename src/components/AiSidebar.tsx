// AiSidebar: the collapsible right-hand AI chat panel. Renders the transcript
// from ai-store, sends messages, and can attach the active terminal's serialized
// output as context. Markdown replies are rendered via the shared file-render
// helper (sanitized), matching the built-in file viewer.
//
// Two modes: chat (streaming Q&A, with a Stop control) and agent (the model may
// run shell commands in the active pane, each gated by an approval prompt).

import { useEffect, useRef, useState } from "react";
import { useAiStore } from "../stores/ai-store";
import { useSettingsStore } from "../stores/settings-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import { getSessionText } from "../lib/terminal-manager";
import { renderMarkdown } from "../lib/file-render";

/** Resolve the active tab's active pane id, or null (no shell to read). */
function activePaneId(): string | null {
  const s = useWorkspaceStore.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId);
  if (!tab || tab.file) return null;
  return tab.activePaneId ?? null;
}

export function AiSidebar() {
  const turns = useAiStore((s) => s.turns);
  const sending = useAiStore((s) => s.sending);
  const send = useAiStore((s) => s.send);
  const clear = useAiStore((s) => s.clear);
  const stop = useAiStore((s) => s.stop);
  const setOpen = useAiStore((s) => s.setOpen);
  const agentMode = useAiStore((s) => s.agentMode);
  const setAgentMode = useAiStore((s) => s.setAgentMode);
  const pendingApproval = useAiStore((s) => s.pendingApproval);
  const resolveApproval = useAiStore((s) => s.resolveApproval);
  const providerCount = useSettingsStore((s) => s.aiProviders.length);

  const [input, setInput] = useState("");
  const [attach, setAttach] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // keep the transcript pinned to the newest message
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pendingApproval]);

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    const paneId = activePaneId();
    let context: string | undefined;
    if (attach && paneId) context = getSessionText(paneId);
    void send(text, context, paneId ?? undefined);
    setInput("");
  }

  return (
    <div className="ai-sidebar">
      <div className="ai-sidebar-head">
        <span className="ai-sidebar-title">AI</span>
        <div className="ai-sidebar-head-actions">
          <label
            className="checkbox-label ai-agent-toggle"
            title="Agent mode: let the AI run terminal commands (with approval)"
          >
            <input
              type="checkbox"
              checked={agentMode}
              onChange={(e) => setAgentMode(e.target.checked)}
              disabled={sending}
            />
            Agent
          </label>
          <button
            className="link-btn"
            onClick={clear}
            disabled={turns.length === 0}
            title="Clear conversation"
          >
            clear
          </button>
          <button
            className="icon-btn"
            onClick={() => setOpen(false)}
            title="Close AI sidebar"
          >
            ×
          </button>
        </div>
      </div>

      {providerCount === 0 && (
        <div className="ai-sidebar-notice">
          No AI provider configured. Open Settings → AI to add one.
        </div>
      )}

      <div className="ai-sidebar-transcript" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="ai-sidebar-empty">
            {agentMode
              ? "Ask the agent to do something in your terminal."
              : "Ask about your terminal output, errors, or commands."}
          </div>
        ) : (
          turns.map((t) =>
            t.role === "tool" ? (
              <div key={t.id} className="ai-msg ai-msg-tool">
                <div className="ai-tool-cmd">
                  <span className="ai-tool-prompt">$</span>
                  <code>{t.command}</code>
                  {typeof t.exitCode === "number" && (
                    <span
                      className={
                        "ai-tool-exit" +
                        (t.exitCode === 0 ? "" : " ai-tool-exit-bad")
                      }
                    >
                      exit {t.exitCode}
                    </span>
                  )}
                </div>
                <pre className="ai-tool-output">{t.content}</pre>
              </div>
            ) : (
              <div
                key={t.id}
                className={
                  "ai-msg ai-msg-" + t.role + (t.error ? " ai-msg-error" : "")
                }
              >
                {t.role === "assistant" ? (
                  t.pending && !t.content ? (
                    <span className="ai-msg-pending">…</span>
                  ) : (
                    <div
                      className="ai-msg-md"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(t.content),
                      }}
                    />
                  )
                ) : (
                  <div className="ai-msg-text">{t.content}</div>
                )}
              </div>
            )
          )
        )}

        {pendingApproval && (
          <div className="ai-approval">
            <div className="ai-approval-label">
              Run this command in the terminal?
            </div>
            <pre className="ai-approval-cmd">{pendingApproval.command}</pre>
            <div className="ai-approval-actions">
              <button
                className="ai-send-btn"
                onClick={() => resolveApproval(true)}
              >
                Approve
              </button>
              <button
                className="link-btn"
                onClick={() => resolveApproval(false)}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="ai-sidebar-input">
        <label className="checkbox-label ai-attach-toggle">
          <input
            type="checkbox"
            checked={attach}
            onChange={(e) => setAttach(e.target.checked)}
          />
          Attach terminal context
        </label>
        <textarea
          className="ai-input-box"
          value={input}
          placeholder={
            agentMode
              ? "Tell the agent what to do…  (Enter to send)"
              : "Ask the AI…  (Enter to send, Shift+Enter for newline)"
          }
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {sending && !agentMode ? (
          <button className="ai-send-btn ai-stop-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            className="ai-send-btn"
            onClick={submit}
            disabled={sending || !input.trim()}
          >
            {sending ? "Working…" : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}

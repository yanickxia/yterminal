import { useUpdaterStore } from "../stores/updater-store";

/**
 * Modal driven by `useUpdaterStore`. Visible whenever state is one of
 * { available, downloading, ready, error-after-available }. The "Later"
 * button hides this dialog locally but leaves store state alone, so the
 * Settings panel can re-open it.
 */
export function UpdateDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const state = useUpdaterStore((s) => s.state);
  const manifest = useUpdaterStore((s) => s.manifest);
  const progress = useUpdaterStore((s) => s.progress);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);
  const debManualPath = useUpdaterStore((s) => s.debManualPath);
  const startDownload = useUpdaterStore((s) => s.startDownload);
  const doRelaunch = useUpdaterStore((s) => s.relaunch);
  const recheck = useUpdaterStore((s) => s.check);

  if (!open) return null;
  if (state !== "available" && state !== "downloading"
      && state !== "ready" && state !== "error") return null;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>
            {state === "ready"
              ? "Update ready to install"
              : state === "error"
              ? "Update failed"
              : `Update available${manifest ? ` — v${manifest.version}` : ""}`}
          </span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {state === "available" && manifest && (
            <>
              <p>A new version of yterminal is ready to download.</p>
              {manifest.notes && (
                <pre
                  style={{
                    maxHeight: 240,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                  }}
                >
                  {manifest.notes}
                </pre>
              )}
              <div className="modal-footer">
                <button onClick={onClose}>Later</button>
                <button onClick={() => startDownload()}>Update now</button>
              </div>
            </>
          )}

          {state === "downloading" && (
            <>
              <p>Downloading…</p>
              <progress
                value={progress?.downloaded ?? undefined}
                max={progress?.total ?? undefined}
                style={{ width: "100%" }}
              />
              <p style={{ fontSize: 12, opacity: 0.7 }}>
                {progress?.total
                  ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                  : progress
                  ? `${formatBytes(progress.downloaded)}`
                  : "Verifying signature and installing…"}
              </p>
            </>
          )}

          {state === "ready" && (
            <>
              {debManualPath ? (
                <>
                  <p>
                    Update downloaded and verified. Automatic install needs
                    <code> pkexec</code>, which isn't available here — install it
                    manually:
                  </p>
                  <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
                    sudo dpkg -i {debManualPath}
                  </pre>
                  <div className="modal-footer">
                    <button onClick={onClose}>Close</button>
                  </div>
                </>
              ) : (
                <>
                  <p>Download complete. Restart yterminal to apply the update.</p>
                  <div className="modal-footer">
                    <button onClick={onClose}>Restart later</button>
                    <button onClick={() => doRelaunch()}>Restart now</button>
                  </div>
                </>
              )}
            </>
          )}

          {state === "error" && (
            <>
              <p>{errorMessage ?? "Unknown error."}</p>
              <div className="modal-footer">
                <button onClick={onClose}>Close</button>
                <button onClick={() => recheck()}>Retry</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

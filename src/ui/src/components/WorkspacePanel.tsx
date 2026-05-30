import { useEffect, useMemo, useState } from "react";
import type {
  PermissionMode,
  ToolResultRecord,
  WorkspaceActionLog,
  WorkspaceSnapshot,
  WorkspaceStatus
} from "@shared/types";
import type { WorkspaceCommandRequest } from "@shared/ipc";

interface WorkspacePanelProps {
  open: boolean;
  status: WorkspaceStatus;
  url: string;
  snapshot: WorkspaceSnapshot | null;
  logs: WorkspaceActionLog[];
  permissionMode: PermissionMode;
  onClose: () => void;
  onRun: (request: WorkspaceCommandRequest) => Promise<ToolResultRecord>;
  onRefreshLogs: () => Promise<void>;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const [targetUrl, setTargetUrl] = useState("about:blank");
  const [selector, setSelector] = useState("body");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ToolResultRecord | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTargetUrl(props.url);
  }, [props.url]);

  const stageImage = useMemo(() => {
    if (!props.snapshot?.screenshotBase64) return null;
    return `data:image/png;base64,${props.snapshot.screenshotBase64}`;
  }, [props.snapshot]);

  if (!props.open) return null;

  const run = async (
    command: WorkspaceCommandRequest["command"],
    input: Record<string, unknown>
  ) => {
    setBusy(true);

    try {
      const response = await props.onRun({
        command,
        input,
        permissionMode: props.permissionMode
      });

      setResult(response);
      await props.onRefreshLogs();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="workspace-panel" aria-label="Workspace panel">
      <div className="workspace-topbar">
        <div className="workspace-status-line">
          <span className={`status-dot ${props.status}`} />
          <span>{props.status}</span>
          <span className="workspace-url-text">{props.url}</span>
        </div>
        <button
          className="icon-button"
          aria-label="Close workspace"
          title="Close workspace"
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="workspace-stage">
        {stageImage ? (
          <img
            className="workspace-stage-image"
            src={stageImage}
            alt={props.snapshot?.title || "Workspace preview"}
          />
        ) : (
          <div className="workspace-stage-empty" aria-label="Workspace preview">
            <span>Preview idle</span>
            <strong title={props.url}>{props.url}</strong>
          </div>
        )}
      </div>

      {props.logs.length > 0 ? (
        <details className="workspace-details">
          <summary>Action log</summary>
          <div className="action-log">
            {props.logs.map((log) => (
              <div className="log-row" key={log.id}>
                <span>{log.action}</span>
                <strong>{log.status}</strong>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <details className="workspace-details">
        <summary>Manual controls</summary>
        <div className="workspace-controls">
          <label htmlFor="workspace-url">URL</label>
          <div className="row-controls">
            <input
              id="workspace-url"
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
            />
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void run("navigate", { url: targetUrl })}
            >
              Navigate
            </button>
          </div>

          <label htmlFor="workspace-selector">Selector</label>
          <input
            id="workspace-selector"
            value={selector}
            onChange={(event) => setSelector(event.target.value)}
          />

          <label htmlFor="workspace-text">Text</label>
          <input
            id="workspace-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />

          <div className="row-controls">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void run("click", { selector })}
            >
              Click
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void run("type", { selector, text })}
            >
              Type
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void run("snapshot", { includeScreenshot: true })}
            >
              Snapshot
            </button>
          </div>
        </div>
      </details>

      {result && !result.ok ? (
        <div className="notice error">
          <strong>{result.toolName}</strong>
          <span>{result.message}</span>
        </div>
      ) : null}
    </aside>
  );
}

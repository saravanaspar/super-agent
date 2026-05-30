import { useEffect, useState, type RefObject } from "react";
import type {
  McpConnectorInstallRequest,
  McpConnectorInstallResult
} from "@shared/types";

interface McpConnectorDialogProps {
  open: boolean;
  saving: boolean;
  error: string;
  result: McpConnectorInstallResult | null;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (request: McpConnectorInstallRequest) => void;
}

const initialDraft: McpConnectorInstallRequest = {
  name: "",
  url: "",
  bearerToken: "",
  autoStart: true
};

export function McpConnectorDialog({
  open,
  saving,
  error,
  result,
  dialogRef,
  onClose,
  onSubmit,
}: McpConnectorDialogProps) {
  const [draft, setDraft] = useState<McpConnectorInstallRequest>(initialDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraft(initialDraft);
      setAdvancedOpen(false);
    }
  }, [open]);

  if (!open) return null;

  const canSubmit = Boolean(draft.name.trim() && draft.url.trim() && !saving);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="mcp-connector-dialog shadcn-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-connector-title"
        tabIndex={-1}
      >
        <div className="skill-edit-heading">
          <div>
            <h2 id="mcp-connector-title">Add custom MCP connector</h2>
            <p>Test the remote MCP server and save it only after tools can be listed.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close MCP connector"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <label className="form-field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="Figma"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>

        <label className="form-field">
          <span>Remote MCP server URL</span>
          <input
            type="url"
            value={draft.url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          />
        </label>

        <button
          className="mcp-advanced-toggle"
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          <span>{advancedOpen ? "⌄" : "›"}</span>
          Advanced settings
        </button>

        {advancedOpen ? (
          <div className="mcp-advanced-panel">
            <label className="form-field">
              <span>Bearer token</span>
              <input
                type="password"
                value={draft.bearerToken ?? ""}
                placeholder="Optional"
                onChange={(event) => setDraft((current) => ({ ...current, bearerToken: event.target.value }))}
              />
            </label>
            <label className="form-field inline-field">
              <input
                type="checkbox"
                checked={draft.autoStart !== false}
                onChange={(event) => setDraft((current) => ({ ...current, autoStart: event.target.checked }))}
              />
              <span>Auto-start this connector</span>
            </label>
          </div>
        ) : null}

        <p className="mcp-connector-note">
          Only add connectors from developers you trust. Server tools can expose external data and actions to the agent.
        </p>

        {result ? (
          <div className="mcp-validation-result">
            <span className="status-badge success">validated</span>
            <strong>{result.message}</strong>
            {result.tools.length > 0 ? (
              <ul>
                {result.tools.slice(0, 8).map((tool) => (
                  <li key={tool.name}>
                    <span>{tool.name}</span>
                    {tool.description ? <small>{tool.description}</small> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="skill-import-error">{error}</p> : null}

        <div className="skill-edit-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </button>
          {!result ? (
            <button
              className="button primary"
              type="button"
              disabled={!canSubmit}
              onClick={() => onSubmit(draft)}
            >
              {saving ? "Testing" : "Test and add"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

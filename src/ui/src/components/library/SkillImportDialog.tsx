import type { RefObject } from "react";
import type { SkillImportMode } from "@shared/types";
import type { PendingImport } from "./libraryTypes";
import { readableSize } from "./libraryUtils";

interface SkillImportDialogProps {
  pendingImport: PendingImport | null;
  importError: string | null;
  installingImport: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onInstall: (mode: SkillImportMode) => void;
}

export function SkillImportDialog({
  pendingImport,
  importError,
  installingImport,
  dialogRef,
  onClose,
  onInstall,
}: SkillImportDialogProps) {
  if (!pendingImport) return null;

  const { preview } = pendingImport;
  const duplicate = Boolean(preview.existingSkillId);
  const canReplace = preview.valid && duplicate;
  const canInstall = preview.valid;

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="skill-import-dialog shadcn-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-import-title"
        tabIndex={-1}
      >
        <div className="skill-edit-heading">
          <div>
            <p className="section-kicker">Upload validation</p>
            <h2 id="skill-import-title">Review skill package</h2>
            <p>Validation runs before install, so errors can be fixed before the skill enters the library.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close import review"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="skill-import-summary">
          <span className={preview.valid ? "status-badge success" : "status-badge partial"}>
            {preview.valid ? "valid" : "blocked"}
          </span>
          <span>{preview.filename}</span>
          <small>{readableSize(preview.packageSize)}</small>
        </div>

        {preview.skill ? (
          <dl className="skill-meta-grid extended compact-grid">
            <div>
              <dt>Name</dt>
              <dd>{preview.skill.name}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd>{preview.skill.id}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{preview.skill.fileCount}</dd>
            </div>
            <div>
              <dt>Duplicate</dt>
              <dd>{preview.existingSkillId ?? "none"}</dd>
            </div>
          </dl>
        ) : null}

        {preview.skill?.description ? (
          <div className="skill-import-description">
            <strong>Description</strong>
            <p>{preview.skill.description}</p>
          </div>
        ) : null}

        {preview.errors.length > 0 ? (
          <div className="skill-validation-section errors">
            <h3>Errors</h3>
            {preview.errors.map((issue) => (
              <div className="skill-validation-item" key={`${issue.code}-${issue.path ?? issue.message}`}>
                <strong>{issue.code}</strong>
                <p>{issue.message}</p>
                {issue.path ? <small>{issue.path}</small> : null}
              </div>
            ))}
          </div>
        ) : null}

        {preview.warnings.length > 0 ? (
          <div className="skill-validation-section warnings">
            <h3>Warnings</h3>
            {preview.warnings.map((issue) => (
              <div className="skill-validation-item" key={`${issue.code}-${issue.path ?? issue.message}`}>
                <strong>{issue.code}</strong>
                <p>{issue.message}</p>
                {issue.path ? <small>{issue.path}</small> : null}
              </div>
            ))}
          </div>
        ) : null}

        {preview.skill?.scanFindings.length ? (
          <div className="skill-validation-section warnings">
            <h3>Static scan</h3>
            {preview.skill.scanFindings.map((finding) => (
              <div className="skill-validation-item" key={`${finding.ruleId}-${finding.path ?? finding.message}`}>
                <strong>{finding.severity}: {finding.ruleId}</strong>
                <p>{finding.message}</p>
                <small>{[finding.path, finding.line ? `line ${finding.line}` : ""].filter(Boolean).join(":") || finding.ruleId}</small>
                {finding.excerpt ? <code>{finding.excerpt}</code> : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="skill-file-list-preview">
          <h3>Files</h3>
          <div>
            {preview.files.slice(0, 12).map((file) => (
              <span key={file.path}>
                {file.path}
                <small>{readableSize(file.size)}</small>
              </span>
            ))}
            {preview.files.length > 12 ? <em>+{preview.files.length - 12} more</em> : null}
          </div>
        </div>

        {importError ? <p className="skill-import-error">{importError}</p> : null}

        <div className="skill-edit-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          {canReplace ? (
            <button
              className="button secondary"
              type="button"
              disabled={installingImport}
              onClick={() => onInstall("replace")}
            >
              Replace existing
            </button>
          ) : null}
          {canInstall ? (
            <button
              className="button primary"
              type="button"
              disabled={installingImport}
              onClick={() => onInstall(duplicate ? "copy" : "replace")}
            >
              {installingImport ? "Installing" : duplicate ? "Install as copy" : "Install skill"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

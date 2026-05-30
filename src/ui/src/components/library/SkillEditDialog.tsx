import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SkillDraft } from "./libraryTypes";

interface SkillEditDialogProps {
  dialogRef: RefObject<HTMLElement | null>;
  draft: SkillDraft | null;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
  onUpdateDraft: Dispatch<SetStateAction<SkillDraft | null>>;
}

export function SkillEditDialog({
  dialogRef,
  draft,
  saving,
  onClose,
  onSave,
  onUpdateDraft,
}: SkillEditDialogProps) {
  if (!draft) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="skill-edit-dialog shadcn-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-edit-title"
        tabIndex={-1}
      >
        <div className="skill-edit-heading">
          <div>
            <h2 id="skill-edit-title">Edit skill instructions</h2>
            <p>Update extracted metadata and raw Markdown instructions.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close skill editor"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <label className="form-field">
          <span>Skill name</span>
          <input
            value={draft.name}
            onChange={(event) =>
              onUpdateDraft((current) =>
                current ? { ...current, name: event.target.value } : current
              )
            }
          />
        </label>

        <label className="form-field">
          <span>Description</span>
          <textarea
            value={draft.description}
            onChange={(event) =>
              onUpdateDraft((current) =>
                current
                  ? { ...current, description: event.target.value }
                  : current
              )
            }
            rows={3}
          />
        </label>

        <div className="skill-edit-switches">
          <label className="form-field inline-field">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                onUpdateDraft((current) =>
                  current ? { ...current, enabled: event.target.checked } : current
                )
              }
            />
            <span>Enable manual `$` selection</span>
          </label>
          <label className="form-field inline-field">
            <input
              type="checkbox"
              checked={draft.autoRouting}
              disabled={!draft.enabled}
              onChange={(event) =>
                onUpdateDraft((current) =>
                  current ? { ...current, autoRouting: event.target.checked } : current
                )
              }
            />
            <span>Enable automatic routing</span>
          </label>
        </div>

        <label className="form-field grow-field">
          <span>Instructions</span>
          <textarea
            className="skill-instructions-editor"
            value={draft.instructions}
            onChange={(event) =>
              onUpdateDraft((current) =>
                current
                  ? { ...current, instructions: event.target.value }
                  : current
              )
            }
          />
        </label>

        <div className="skill-edit-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={saving}
            onClick={onSave}
          >
            {saving ? "Saving" : "Create proposal"}
          </button>
        </div>
      </section>
    </div>
  );
}

import type { RefObject } from "react";
import type { SkillRecord } from "@shared/types";

interface SkillTrustOverrideDialogProps {
  dialogRef: RefObject<HTMLElement | null>;
  skill: SkillRecord | null;
  onCancel: () => void;
  onConfirm: (skill: SkillRecord) => void;
}

const criticalFindings = (skill: SkillRecord) =>
  skill.scanFindings.filter((finding) => finding.severity === "critical");

export function SkillTrustOverrideDialog({ dialogRef, skill, onCancel, onConfirm }: SkillTrustOverrideDialogProps) {
  if (!skill) return null;
  const findings = criticalFindings(skill);
  return (
    <section className="dialog-backdrop" role="presentation">
      <article ref={dialogRef} className="skill-dialog trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-override-title" tabIndex={-1}>
        <header className="skill-dialog-header">
          <div>
            <h2 id="trust-override-title">Review before enabling</h2>
            <p>{skill.name} was disabled because static review marked it unsafe or untrusted.</p>
          </div>
          <button className="icon-button" type="button" onClick={onCancel} aria-label="Close trust review">×</button>
        </header>
        <div className="trust-dialog-body">
          <p className="trust-dialog-reason">{skill.quarantineReason ?? "This skill requires explicit user override before it can run."}</p>
          {findings.length ? (
            <div className="trust-findings-list">
              {findings.map((finding, index) => (
                <article className="trust-finding" key={`${finding.ruleId}-${index}`}>
                  <strong>{finding.ruleId}</strong>
                  <span>{finding.path}{finding.line ? `:${finding.line}` : ""}</span>
                  <p>{finding.message}</p>
                  {finding.excerpt ? <pre>{finding.excerpt}</pre> : null}
                </article>
              ))}
            </div>
          ) : (
            <p>No exact scanner excerpt is available.</p>
          )}
          <p className="trust-dialog-warning">Enabling this skill allows manual use. Sudo remains blocked and script runs are audited.</p>
        </div>
        <footer className="skill-dialog-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button danger" type="button" onClick={() => onConfirm(skill)}>Enable anyway</button>
        </footer>
      </article>
    </section>
  );
}

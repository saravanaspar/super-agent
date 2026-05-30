import { useEffect, useRef, useState } from "react";
import type {
  SkillAuditExport,
  SkillAuditExportVerification,
  SkillCredentialReport,
  SkillCredentialSaveRequest,
  SkillRecord,
} from "@shared/types";

interface SkillProductionOpsPanelProps {
  skill: SkillRecord;
  onGetCredentials: (skillId: string) => Promise<SkillCredentialReport>;
  onSaveCredentials: (request: SkillCredentialSaveRequest) => Promise<SkillCredentialReport>;
  onExportAudit: (request?: { skillId?: string; limit?: number }) => Promise<SkillAuditExport>;
  onVerifyAudit: (payload: SkillAuditExport) => Promise<SkillAuditExportVerification>;
  onMessage: (message: string) => void;
}

const downloadJson = (filename: string, value: unknown): void => {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const emptyInputs = (report: SkillCredentialReport | null): SkillCredentialSaveRequest => ({
  skillId: report?.skillId ?? "",
  env: Object.fromEntries((report?.requiredEnv ?? []).map((item) => [item.name, ""])),
  files: Object.fromEntries((report?.requiredFiles ?? []).map((item) => [item.path, item.configuredPath ?? ""])),
});

export function SkillProductionOpsPanel({
  skill,
  onGetCredentials,
  onSaveCredentials,
  onExportAudit,
  onVerifyAudit,
  onMessage,
}: SkillProductionOpsPanelProps) {
  const [report, setReport] = useState<SkillCredentialReport | null>(null);
  const [draft, setDraft] = useState<SkillCredentialSaveRequest>(() => ({ skillId: skill.id }));
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const auditInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    setReport(null);
    setDraft({ skillId: skill.id });
    void onGetCredentials(skill.id).then((next) => {
      if (!active) return;
      setReport(next);
      setDraft(emptyInputs(next));
    }).catch((error: unknown) => {
      if (active) onMessage(error instanceof Error ? error.message : "Could not load skill credential status.");
    });
    return () => { active = false; };
  }, [onGetCredentials, onMessage, skill.id]);

  const updateEnv = (name: string, value: string): void => {
    setDraft((current) => ({ ...current, env: { ...(current.env ?? {}), [name]: value } }));
  };

  const updateFile = (path: string, value: string): void => {
    setDraft((current) => ({ ...current, files: { ...(current.files ?? {}), [path]: value } }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await onSaveCredentials({ ...draft, skillId: skill.id });
      setReport(next);
      setDraft(emptyInputs(next));
      onMessage("Skill credentials saved. Secret values remain hidden after save.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not save skill credentials.");
    } finally {
      setSaving(false);
    }
  };

  const exportAudit = async (): Promise<void> => {
    const payload = await onExportAudit({ skillId: skill.id, limit: 500 });
    downloadJson(`${skill.id}-audit-export.json`, payload);
    onMessage(`Exported ${payload.events.length} audit event(s).`);
  };

  const verifyAuditFile = async (file: File): Promise<void> => {
    setVerifying(true);
    try {
      const payload = JSON.parse(await file.text()) as SkillAuditExport;
      const result = await onVerifyAudit(payload);
      onMessage(result.ok ? `Audit export verified (${result.eventCount} events).` : `Audit export failed verification: ${result.errors.join("; ")}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Could not verify audit export.");
    } finally {
      setVerifying(false);
      if (auditInputRef.current) auditInputRef.current.value = "";
    }
  };

  const hasCredentialRequirements = Boolean(report?.requiredEnv.length || report?.requiredFiles.length);

  return (
    <section className="skill-routing-diagnostics shadcn-card subtle production-ops-panel">
      <div>
        <h3>Production controls</h3>
        <p>Configure declared secrets, export tamper-evident audit history, and verify exported audit chains.</p>
      </div>

      <div className="production-ops-grid">
        <div className="production-ops-block">
          <strong>Credentials</strong>
          {!report ? <p>Loading credential requirements.</p> : !hasCredentialRequirements ? <p>This skill declares no credential requirements.</p> : null}
          {report?.encryptionAvailable === false ? <p className="skill-import-error">Desktop encryption is unavailable, so secret values cannot be saved.</p> : null}
          {report?.requiredEnv.map((item) => (
            <label className="credential-row" key={item.name}>
              <span>{item.name}</span>
              <em>{item.source}</em>
              <input
                type="password"
                autoComplete="off"
                placeholder={item.configured ? "configured; leave blank to keep" : "paste secret value"}
                value={draft.env?.[item.name] ?? ""}
                onChange={(event) => updateEnv(item.name, event.target.value)}
              />
            </label>
          ))}
          {report?.requiredFiles.map((item) => (
            <label className="credential-row" key={item.path}>
              <span>{item.path}</span>
              <em>{item.exists ? "found" : "missing"}</em>
              <input
                type="text"
                placeholder="credential file path"
                value={draft.files?.[item.path] ?? ""}
                onChange={(event) => updateFile(item.path, event.target.value)}
              />
            </label>
          ))}
          {hasCredentialRequirements ? (
            <button className="button secondary" type="button" disabled={saving || report?.encryptionAvailable === false} onClick={() => void save()}>
              {saving ? "Saving" : "Save credentials"}
            </button>
          ) : null}
        </div>

        <div className="production-ops-block">
          <strong>Audit export</strong>
          <p>Exports include chained event hashes. Verification fails if any event or export metadata changes.</p>
          <div className="skill-edit-actions compact-actions">
            <button className="button secondary" type="button" onClick={() => void exportAudit()}>Export audit</button>
            <button className="button secondary" type="button" disabled={verifying} onClick={() => auditInputRef.current?.click()}>
              {verifying ? "Verifying" : "Verify export"}
            </button>
          </div>
          <input
            ref={auditInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void verifyAuditFile(file);
            }}
          />
        </div>
      </div>
    </section>
  );
}

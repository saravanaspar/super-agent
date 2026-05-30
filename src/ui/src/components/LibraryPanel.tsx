import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LibraryData,
  McpConnectorInstallRequest,
  McpConnectorInstallResult,
  SkillAuditExport,
  SkillAuditExportVerification,
  SkillCredentialReport,
  SkillCredentialSaveRequest,
  SkillEvalRunRecord,
  SkillExportResult,
  SkillGitHubInstallRequest,
  SkillImportMode,
  SkillImportRequest,
  SkillImportValidationResult,
  SkillPatchRequest,
  SkillProposalCreateRequest,
  SkillProposalRecord,
  SkillRecord,
  SkillRollbackSnapshot,
  SkillUpdateAllResult,
  SkillUpdateRequest,
  SkillVerificationResult
} from "@shared/types";
import { asSkillDraft, type FileViewMode, type PendingImport, type SkillDraft, type VisibleLibraryKey } from "./library/libraryTypes";
import { SkillFilesPanel } from "./library/SkillFilesPanel";
import { SkillEditDialog } from "./library/SkillEditDialog";
import { SkillImportDialog } from "./library/SkillImportDialog";
import { SkillTrustOverrideDialog } from "./library/SkillTrustOverrideDialog";
import { SkillProductionOpsPanel } from "./library/SkillProductionOpsPanel";
import { McpConnectorDialog } from "./library/McpConnectorDialog";
import { useDialogLifecycle } from "./library/useDialogLifecycle";
import {
  activeSkill,
  buildFileTree,
  collectFolderPaths,
  fileToBase64,
  formatDate,
  itemDescription,
  itemTitle,
  normalizeImportedFilename,
  readableSize,
  sectionOrder,
  skillFiles,
} from "./library/libraryUtils";
type SkillLockReason = "built-in" | "shadowed" | "read-only";

const skillLockReason = (skill: SkillRecord | null | undefined): SkillLockReason | null => {
  if (!skill) return null;
  if (skill.source === "built-in") return "built-in";
  if (skill.shadowedBy) return "shadowed";
  if (skill.writable === false) return "read-only";
  return null;
};

const skillStateLockReason = (skill: SkillRecord | null | undefined): SkillLockReason | null => {
  if (!skill) return null;
  if (skill.source === "built-in") return "built-in";
  if (skill.shadowedBy) return "shadowed";
  return null;
};

const isSkillPackageLocked = (skill: SkillRecord | null | undefined): boolean =>
  skillLockReason(skill) !== null;

const isSkillStateLocked = (skill: SkillRecord | null | undefined): boolean =>
  skillStateLockReason(skill) !== null;

const skillLockBadgeLabel = (reason: SkillLockReason): string => {
  switch (reason) {
    case "built-in":
      return "built-in locked";
    case "shadowed":
      return "shadowed";
    case "read-only":
      return "read-only root";
  }
};

const skillWriteAccessLabel = (reason: SkillLockReason | null): string => {
  if (!reason) return "Editable";
  switch (reason) {
    case "built-in":
      return "Built-in locked";
    case "shadowed":
      return "Shadowed";
    case "read-only":
      return "Read-only root";
  }
};

interface LibraryPanelProps {
  library: LibraryData;
  onUpdateSkill: (skill: SkillUpdateRequest) => Promise<SkillRecord>;
  onValidateSkillImport: (skill: SkillImportRequest) => Promise<SkillImportValidationResult>;
  onImportSkill: (skill: SkillImportRequest) => Promise<SkillRecord>;
  onExportSkill: (skillId: string) => Promise<SkillExportResult>;
  onDeleteSkill: (skillId: string) => Promise<void>;
  onCreateSkillProposal: (request: SkillProposalCreateRequest) => Promise<SkillProposalRecord>;
  onCreateSkillPatchProposal: (request: SkillPatchRequest) => Promise<SkillProposalRecord>;
  onListSkillProposals: (skillId?: string) => Promise<SkillProposalRecord[]>;
  onApplySkillProposal: (proposalId: string, acceptedPaths?: string[]) => Promise<SkillRecord>;
  onRejectSkillProposal: (proposalId: string) => Promise<SkillProposalRecord>;
  onListSkillSnapshots: (skillId: string) => Promise<SkillRollbackSnapshot[]>;
  onRestoreSkillSnapshot: (snapshotId: string) => Promise<SkillRecord>;
  onListSkillEvalRuns: (skillId: string) => Promise<SkillEvalRunRecord[]>;
  onUpdateSkillLifecycle: (skillId: string, action: "pin" | "unpin" | "archive" | "restore") => Promise<SkillRecord>;
  onInstallSkillFromGitHub: (request: SkillGitHubInstallRequest) => Promise<SkillRecord>;
  onVerifySkill: (skillId: string) => Promise<SkillVerificationResult>;
  onVerifyAllSkills: () => Promise<SkillVerificationResult[]>;
  onUpdateAllSkills: () => Promise<SkillUpdateAllResult>;
  onGetSkillCredentials: (skillId: string) => Promise<SkillCredentialReport>;
  onSaveSkillCredentials: (request: SkillCredentialSaveRequest) => Promise<SkillCredentialReport>;
  onExportSkillAuditLog: (request?: { skillId?: string; limit?: number }) => Promise<SkillAuditExport>;
  onVerifySkillAuditExport: (payload: SkillAuditExport) => Promise<SkillAuditExportVerification>;
  onCreateSkillWithChat: () => void;
  onAddMcpConnector: (request: McpConnectorInstallRequest) => Promise<McpConnectorInstallResult>;
}

export function LibraryPanel({
  library,
  onUpdateSkill,
  onValidateSkillImport,
  onImportSkill,
  onExportSkill,
  onDeleteSkill,
  onCreateSkillProposal,
  onListSkillProposals,
  onApplySkillProposal,
  onRejectSkillProposal,
  onListSkillSnapshots,
  onRestoreSkillSnapshot,
  onListSkillEvalRuns,
  onUpdateSkillLifecycle,
  onInstallSkillFromGitHub,
  onVerifySkill,
  onVerifyAllSkills,
  onUpdateAllSkills,
  onGetSkillCredentials,
  onSaveSkillCredentials,
  onExportSkillAuditLog,
  onVerifySkillAuditExport,
  onCreateSkillWithChat,
  onAddMcpConnector
}: LibraryPanelProps) {
  const [activeKey, setActiveKey] = useState<VisibleLibraryKey>("skills");
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState("SKILL.md");
  const [viewMode, setViewMode] = useState<FileViewMode>("preview");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [installingImport, setInstallingImport] = useState(false);
  const [exportingSkill, setExportingSkill] = useState(false);
  const [exportError, setExportError] = useState("");
  const [githubSkillUrl, setGithubSkillUrl] = useState("");
  const [proposals, setProposals] = useState<SkillProposalRecord[]>([]);
  const [snapshots, setSnapshots] = useState<SkillRollbackSnapshot[]>([]);
  const [evalRuns, setEvalRuns] = useState<SkillEvalRunRecord[]>([]);
  const [workflowMessage, setWorkflowMessage] = useState("");
  const [unsafeEnableSkill, setUnsafeEnableSkill] = useState<SkillRecord | null>(null);
  const [acceptedProposalPaths, setAcceptedProposalPaths] = useState<Record<string, string[]>>({});
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpError, setMcpError] = useState("");
  const [mcpResult, setMcpResult] = useState<McpConnectorInstallResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importDialogRef = useRef<HTMLElement | null>(null);
  const editDialogRef = useRef<HTMLElement | null>(null);
  const trustDialogRef = useRef<HTMLElement | null>(null);
  const mcpDialogRef = useRef<HTMLElement | null>(null);
  const workflowLoadersRef = useRef({
    onListSkillProposals,
    onListSkillSnapshots,
    onListSkillEvalRuns,
  });
  const activeSection = library[activeKey];
  const skills = library.skills.items;
  const selectedSkill = activeSkill(skills, activeSkillId);
  const selectedSkillLockReason = skillLockReason(selectedSkill);
  const selectedSkillStateLockReason = skillStateLockReason(selectedSkill);
  const selectedSkillPackageLocked = selectedSkillLockReason !== null;
  const selectedSkillStateLocked = selectedSkillStateLockReason !== null;

  const closeImportDialog = useCallback(() => setPendingImport(null), []);
  const closeEditDialog = useCallback(() => setDraft(null), []);

  useDialogLifecycle(Boolean(pendingImport), importDialogRef, closeImportDialog);
  useDialogLifecycle(Boolean(draft), editDialogRef, closeEditDialog);
  useDialogLifecycle(Boolean(unsafeEnableSkill), trustDialogRef, () => setUnsafeEnableSkill(null));
  useDialogLifecycle(mcpDialogOpen, mcpDialogRef, () => setMcpDialogOpen(false));

  useEffect(() => {
    workflowLoadersRef.current = {
      onListSkillProposals,
      onListSkillSnapshots,
      onListSkillEvalRuns,
    };
  }, [onListSkillEvalRuns, onListSkillProposals, onListSkillSnapshots]);

  useEffect(() => {
    setActiveFilePath("SKILL.md");
    setViewMode("preview");
    if (selectedSkill) {
      const tree = buildFileTree(skillFiles(selectedSkill), selectedSkill.name);
      setExpandedFolders(new Set(collectFolderPaths(tree)));
    }
  }, [selectedSkill?.id]);

  useEffect(() => {
    if (!selectedSkill) {
      setProposals([]);
      setSnapshots([]);
      setEvalRuns([]);
      return;
    }
    let active = true;
    const loaders = workflowLoadersRef.current;
    void Promise.all([
      loaders.onListSkillProposals(selectedSkill.id),
      loaders.onListSkillSnapshots(selectedSkill.id),
      loaders.onListSkillEvalRuns(selectedSkill.id),
    ]).then(([nextProposals, nextSnapshots, nextEvalRuns]) => {
      if (!active) return;
      setProposals(nextProposals);
      setSnapshots(nextSnapshots);
      setEvalRuns(nextEvalRuns);
    }).catch((error: unknown) => {
      if (active) setWorkflowMessage(error instanceof Error ? error.message : "Could not load skill workflow state.");
    });
    return () => { active = false; };
  }, [selectedSkill?.id]);

  const itemCount = useMemo(
    () =>
      sectionOrder.reduce((count, key) => count + library[key].items.length, 0),
    [library]
  );

  const installedCount = skills.filter((skill) => skill.enabled && !skill.shadowedBy).length;
  const autoRoutingCount = skills.filter(
    (skill) => skill.enabled && skill.autoRouting && !skill.shadowedBy
  ).length;

  const openSkill = (skill: SkillRecord) => {
    setActiveKey("skills");
    setActiveSkillId(skill.id);
  };

  const startEditingSkill = (skill: SkillRecord) => {
    if (isSkillPackageLocked(skill)) return;
    setDraft(asSkillDraft(skill));
  };

  const skillMarkdownForDraft = (value: SkillDraft): string => [
    "---",
    `name: ${value.name}`,
    `description: ${value.description}`,
    "---",
    value.instructions,
  ].join("\n");

  const saveDraft = async () => {
    if (!draft) return;

    setSaving(true);
    setWorkflowMessage("");
    try {
      const files = [
        { path: "SKILL.md", content: skillMarkdownForDraft(draft) },
        ...(draft.files ?? []).filter((file) => file.path !== "SKILL.md"),
      ];
      const proposal = await onCreateSkillProposal({
        skillId: draft.id,
        title: `Update ${draft.name}`,
        reason: "User edited this skill in the library.",
        source: "user",
        operation: "update",
        files,
      });
      setProposals((current) => [proposal, ...current.filter((item) => item.id !== proposal.id)]);
      setAcceptedProposalPaths((current) => ({ ...current, [proposal.id]: proposal.diff.filter((item) => item.status !== "unchanged").map((item) => item.path) }));
      setWorkflowMessage(proposal.status === "quarantined" ? "Proposal created but quarantined by review." : "Proposal created. Review the diff before applying.");
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const changedPathsForProposal = (proposal: SkillProposalRecord): string[] =>
    proposal.diff.filter((item) => item.status !== "unchanged").map((item) => item.path);

  const selectedPathsForProposal = (proposal: SkillProposalRecord): string[] =>
    acceptedProposalPaths[proposal.id] ?? changedPathsForProposal(proposal);

  const toggleProposalPath = (proposal: SkillProposalRecord, path: string): void => {
    const current = new Set(selectedPathsForProposal(proposal));
    if (current.has(path)) current.delete(path);
    else current.add(path);
    setAcceptedProposalPaths((previous) => ({ ...previous, [proposal.id]: Array.from(current).sort() }));
  };

  const applyProposal = async (proposal: SkillProposalRecord) => {
    setWorkflowMessage("");
    const saved = await onApplySkillProposal(proposal.id, selectedPathsForProposal(proposal));
    setActiveSkillId(saved.id);
    setProposals(await onListSkillProposals(saved.id));
    setSnapshots(await onListSkillSnapshots(saved.id));
  };

  const rejectProposal = async (proposal: SkillProposalRecord) => {
    const rejected = await onRejectSkillProposal(proposal.id);
    setProposals((current) => current.map((item) => item.id === rejected.id ? rejected : item));
  };

  const restoreSnapshot = async (snapshot: SkillRollbackSnapshot) => {
    const saved = await onRestoreSkillSnapshot(snapshot.id);
    setActiveSkillId(saved.id);
    setProposals(await onListSkillProposals(saved.id));
    setSnapshots(await onListSkillSnapshots(saved.id));
  };

  const installGithubSkill = async () => {
    const url = githubSkillUrl.trim();
    if (!url) return;
    setWorkflowMessage("");
    try {
      const saved = await onInstallSkillFromGitHub({ url, installMode: "replace" });
      setGithubSkillUrl("");
      setAddMenuOpen(false);
      setActiveSkillId(saved.id);
      setWorkflowMessage(`${saved.name} installed from GitHub.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : "GitHub install failed.");
    }
  };

  const verifySelectedSkill = async (skill: SkillRecord) => {
    setWorkflowMessage("");
    try {
      const result = await onVerifySkill(skill.id);
      setWorkflowMessage(`Verification ${result.status}: ${result.packageHash.slice(0, 12)}.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : "Verification failed.");
    }
  };

  const verifyAll = async () => {
    setWorkflowMessage("");
    try {
      const results = await onVerifyAllSkills();
      const failed = results.filter((result) => result.status === "failed").length;
      setAddMenuOpen(false);
      setWorkflowMessage(`Verified ${results.length} skill(s); ${failed} failed.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : "Verification failed.");
    }
  };

  const updateAll = async () => {
    setWorkflowMessage("");
    try {
      const result = await onUpdateAllSkills();
      const updates = result.checked.filter((item) => item.status === "update_available").length;
      setAddMenuOpen(false);
      setWorkflowMessage(`Checked ${result.checked.length} skill(s); ${updates} update proposal(s) available.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : "Update check failed.");
    }
  };

  const updateLifecycle = async (skill: SkillRecord, action: "pin" | "unpin" | "archive" | "restore") => {
    const saved = await onUpdateSkillLifecycle(skill.id, action);
    setActiveSkillId(saved.id);
    setWorkflowMessage(`${saved.name} lifecycle updated to ${saved.lifecycleState ?? "active"}.`);
  };

  const isUnsafeSkill = (skill: SkillRecord): boolean =>
    skill.trustLevel === "quarantined" || skill.trustLevel === "untrusted";

  const saveSkillEnabled = async (skill: SkillRecord, enabled: boolean) => {
    const saved = await onUpdateSkill({
      ...asSkillDraft(skill),
      enabled,
      autoRouting: enabled ? skill.autoRouting : false
    });
    setActiveSkillId(saved.id);
  };

  const toggleSkillEnabled = async (skill: SkillRecord) => {
    if (isSkillStateLocked(skill)) return;
    if (!skill.enabled && isUnsafeSkill(skill)) {
      setUnsafeEnableSkill(skill);
      return;
    }
    await saveSkillEnabled(skill, !skill.enabled);
  };

  const toggleAutoRouting = async (skill: SkillRecord) => {
    if (isSkillStateLocked(skill)) return;
    const saved = await onUpdateSkill({
      ...asSkillDraft(skill),
      autoRouting: !skill.autoRouting
    });
    setActiveSkillId(saved.id);
  };

  const uninstallSkill = async (skill: SkillRecord) => {
    if (isSkillPackageLocked(skill) || skill.pinned) return;
    const fileCount = skillFiles(skill).length;
    const confirmed = window.confirm(
      `Uninstall ${skill.name}?\n\nThis removes ${fileCount} file${fileCount === 1 ? "" : "s"} from the writable skill root and cannot be undone.`
    );
    if (!confirmed) return;
    await onDeleteSkill(skill.id);
    setActiveSkillId(null);
  };

  const importSkillFile = async (file: File) => {
    setImportError("");
    setImporting(true);
    try {
      const request = {
        filename: normalizeImportedFilename(file.name),
        dataBase64: await fileToBase64(file)
      };
      const preview = await onValidateSkillImport(request);
      setPendingImport({ request, preview });
      setAddMenuOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Skill validation failed.");
    } finally {
      setImporting(false);
    }
  };

  const installPendingImport = async (mode: SkillImportMode) => {
    if (!pendingImport) return;
    setInstallingImport(true);
    setImportError("");
    try {
      const saved = await onImportSkill({
        ...pendingImport.request,
        installMode: mode
      });
      setActiveKey("skills");
      setActiveSkillId(saved.id);
      setPendingImport(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Skill install failed.");
    } finally {
      setInstallingImport(false);
    }
  };

  const exportSelectedSkill = async (skill: SkillRecord) => {
    setExportError("");
    setExportingSkill(true);
    try {
      const result = await onExportSkill(skill.id);
      const bytes = Uint8Array.from(atob(result.dataBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setWorkflowMessage(`Exported manifest ${result.manifest.packageHash.slice(0, 12)} with ${result.manifest.fileCount} file(s).`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Skill export failed.");
    } finally {
      setExportingSkill(false);
    }
  };

  const addMcpConnector = async (request: McpConnectorInstallRequest) => {
    setMcpSaving(true);
    setMcpError("");
    setMcpResult(null);
    try {
      const result = await onAddMcpConnector(request);
      setMcpResult(result);
      setWorkflowMessage(result.message);
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : "MCP connector validation failed.");
    } finally {
      setMcpSaving(false);
    }
  };

  const openMcpDialog = () => {
    setMcpError("");
    setMcpResult(null);
    setMcpDialogOpen(true);
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderSkillFiles = (skill: SkillRecord) => (
    <SkillFilesPanel
      activeFilePath={activeFilePath}
      expandedFolders={expandedFolders}
      skill={skill}
      viewMode={viewMode}
      onChangeViewMode={setViewMode}
      onSelectFile={(path, mode) => {
        setActiveFilePath(path);
        setViewMode(mode);
      }}
      onToggleFolder={toggleFolder}
    />
  );

  const renderSkillDetail = () => {
    if (!selectedSkill) {
      return (
        <div className="empty-section">
          No skills installed. Add a skill to make it available in chat context.
        </div>
      );
    }

    const files = skillFiles(selectedSkill);
    const hasEvalFile = files.some((file) => file.path === "evals/evals.json");
    return (
      <article className="skill-detail-card shadcn-card">
        <div className="skill-detail-toolbar">
          <div>
            <p className="eyebrow">Skill</p>
            <h2>{selectedSkill.name}</h2>
            <p>{selectedSkill.description}</p>
          </div>
          <div className="skill-actions">
            <span
              className={
                selectedSkill.enabled
                  ? "status-badge success"
                  : "status-badge partial"
              }
            >
              {selectedSkill.enabled ? "enabled" : "disabled"}
            </span>
            {selectedSkillLockReason ? (
              <span className="status-badge locked">{skillLockBadgeLabel(selectedSkillLockReason)}</span>
            ) : null}
            <button className="button secondary" type="button" onClick={() => void verifySelectedSkill(selectedSkill)}>Verify</button>
          </div>
        </div>

        <div className="skill-control-grid">
          <div className="skill-control-card shadcn-card subtle">
            <div>
              <h3>Skill access</h3>
              <p>Controls whether this skill appears in manual `$` selection.</p>
            </div>
            <button
              className={selectedSkill.enabled ? "switch-control checked" : "switch-control"}
              type="button"
              role="switch"
              aria-checked={selectedSkill.enabled}
              disabled={selectedSkillStateLocked}
              onClick={() => void toggleSkillEnabled(selectedSkill)}
            >
              <span />
            </button>
          </div>
          <div className="skill-control-card shadcn-card subtle">
            <div>
              <h3>Auto routing</h3>
              <p>{selectedSkillStateLocked ? "Protected or shadowed skills cannot change routing." : "Allow the router to pick this skill without manual `$` selection."}</p>
            </div>
            <button
              className={selectedSkill.autoRouting ? "switch-control checked" : "switch-control"}
              type="button"
              role="switch"
              aria-checked={selectedSkill.autoRouting}
              disabled={selectedSkillStateLocked || !selectedSkill.enabled}
              onClick={() => void toggleAutoRouting(selectedSkill)}
            >
              <span />
            </button>
          </div>
        </div>

        <section className="skill-routing-diagnostics shadcn-card subtle">
          <div>
            <h3>Lifecycle</h3>
            <p>{selectedSkill.staleReason ?? (selectedSkill.lifecycleState === "archived" ? "Archived skills are recoverable and excluded from routing." : "Active skills remain available for manual use and routing.")}</p>
          </div>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{selectedSkill.lifecycleState ?? "active"}</dd>
            </div>
            <div>
              <dt>Pinned</dt>
              <dd>{selectedSkill.pinned ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Uses</dt>
              <dd>{selectedSkill.useCount ?? 0}</dd>
            </div>
          </dl>
          <div className="skill-edit-actions compact-actions">
            <button className="button secondary" type="button" disabled={selectedSkillStateLocked} onClick={() => void updateLifecycle(selectedSkill, selectedSkill.pinned ? "unpin" : "pin")}>{selectedSkill.pinned ? "Unpin" : "Pin"}</button>
            {selectedSkill.lifecycleState === "archived" ? (
              <button className="button secondary" type="button" disabled={selectedSkillStateLocked} onClick={() => void updateLifecycle(selectedSkill, "restore")}>Restore archive</button>
            ) : (
              <button className="button secondary" type="button" disabled={selectedSkillStateLocked || selectedSkill.pinned} onClick={() => void updateLifecycle(selectedSkill, "archive")}>Archive</button>
            )}
          </div>
        </section>

        <section className="skill-routing-diagnostics shadcn-card subtle">
          <div>
            <h3>Distribution</h3>
            <p>{selectedSkill.originUrl ? `Origin tracked from ${selectedSkill.originUrl}` : "No origin URL is tracked for this skill."}</p>
          </div>
          <dl>
            <div>
              <dt>Verification</dt>
              <dd>{selectedSkill.verificationStatus ?? "unverified"}</dd>
            </div>
            <div>
              <dt>Publisher</dt>
              <dd>{selectedSkill.publisher ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Verified</dt>
              <dd>{formatDate(selectedSkill.verifiedAt ?? null)}</dd>
            </div>
          </dl>
        </section>

        <dl className="skill-meta-grid extended">
          <div>
            <dt>Source</dt>
            <dd>{selectedSkill.source}</dd>
          </div>
          <div>
            <dt>Routing</dt>
            <dd>{selectedSkill.autoRouting ? "Auto + manual" : "Manual only"}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{files.length}</dd>
          </div>
          <div>
            <dt>Package</dt>
            <dd>{readableSize(selectedSkill.packageSize)}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{selectedSkill.version ?? "none"}</dd>
          </div>
          <div>
            <dt>Installed</dt>
            <dd>{formatDate(selectedSkill.installedAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDate(selectedSkill.updatedAt)}</dd>
          </div>
          <div>
            <dt>Write access</dt>
            <dd>{skillWriteAccessLabel(selectedSkillLockReason)}</dd>
          </div>
          <div>
            <dt>Root rank</dt>
            <dd>{selectedSkill.sourceRank ?? "n/a"}</dd>
          </div>
          <div>
            <dt>Root</dt>
            <dd title={selectedSkill.rootPath ?? undefined}>{selectedSkill.rootPath ?? "indexed"}</dd>
          </div>
          {selectedSkill.pluginId ? (
            <div>
              <dt>Plugin</dt>
              <dd>{selectedSkill.pluginId}</dd>
            </div>
          ) : null}
          {selectedSkill.shadowedBy ? (
            <div>
              <dt>Shadowed by</dt>
              <dd>{selectedSkill.shadowedBy}</dd>
            </div>
          ) : null}
        </dl>

        {selectedSkill.shadowReason ? (
          <section className="skill-routing-diagnostics shadcn-card subtle">
            <div>
              <h3>Precedence</h3>
              <p>{selectedSkill.shadowReason}</p>
            </div>
          </section>
        ) : null}

        <section className="skill-routing-diagnostics skill-security-report shadcn-card subtle">
          <div className="skill-security-report-header">
            <div className="skill-security-summary">
              <h3>Security report</h3>
              <p>{selectedSkill.quarantineReason ?? "Static scan did not find critical skill-risk patterns."}</p>
            </div>
            <dl className="skill-security-stats">
              <div>
                <dt>Findings</dt>
                <dd>{selectedSkill.scanFindings.length}</dd>
              </div>
              <div>
                <dt>Required tools</dt>
                <dd>{selectedSkill.dependencyMetadata.requiredBins.length || "none"}</dd>
              </div>
              <div>
                <dt>Required env</dt>
                <dd>{selectedSkill.dependencyMetadata.requiredEnv.length || "none"}</dd>
              </div>
            </dl>
          </div>
          {selectedSkill.scanFindings.length ? (
            <ul className="skill-findings-list" aria-label="Skill scan findings">
              {selectedSkill.scanFindings.map((finding) => (
                <li className={`skill-finding-item severity-${finding.severity}`} key={`${finding.ruleId}-${finding.path ?? "package"}-${finding.line ?? 0}`}>
                  <div className="skill-finding-heading">
                    <strong>{finding.message}</strong>
                    <span>{finding.severity}</span>
                  </div>
                  <span className="skill-finding-location">{[finding.path, finding.line ? `line ${finding.line}` : ""].filter(Boolean).join(":") || finding.ruleId}</span>
                  {finding.excerpt ? (
                    <pre className="skill-finding-excerpt"><code>{finding.excerpt}</code></pre>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <SkillProductionOpsPanel
          skill={selectedSkill}
          onGetCredentials={onGetSkillCredentials}
          onSaveCredentials={onSaveSkillCredentials}
          onExportAudit={onExportSkillAuditLog}
          onVerifyAudit={onVerifySkillAuditExport}
          onMessage={setWorkflowMessage}
        />

        <section className="skill-routing-diagnostics shadcn-card subtle">
          <div>
            <h3>Eval benchmark</h3>
            <p>Runs evals/evals.json, validates the assertion schema, grades supplied or static outputs, and compares against the previous run.</p>
          </div>
          <div className="skill-workflow-list">
            {!hasEvalFile ? <p>No evals/evals.json found.</p> : evalRuns.length ? evalRuns.slice(0, 3).map((run) => (
              <article className="skill-validation-item" key={run.id}>
                <strong>{run.status}: {run.score}/100</strong>
                <p>{run.passed} passed · {run.warnings} warnings · {run.failed} failed · {run.total} total</p>
                <small>{formatDate(run.finishedAt)} · {run.deltaScore === null ? "no baseline" : `delta ${run.deltaScore >= 0 ? "+" : ""}${run.deltaScore}`}</small>
              </article>
            )) : <p>No eval runs yet.</p>}
          </div>
        </section>

        <section className="skill-routing-diagnostics shadcn-card subtle">
          <div>
            <h3>Proposals and rollback</h3>
            <p>Skill edits are staged as proposals with file-level diff and review before they mutate the package.</p>
          </div>
          {workflowMessage ? <p className="skill-import-error">{workflowMessage}</p> : null}
          <div className="skill-workflow-list">
            {proposals.length ? proposals.slice(0, 5).map((proposal) => {
              const changedPaths = changedPathsForProposal(proposal);
              const acceptedPaths = new Set(selectedPathsForProposal(proposal));
              return (
                <article className="skill-validation-item" key={proposal.id}>
                  <strong>{proposal.status}: {proposal.title}</strong>
                  <p>{proposal.review.summary} Diff: {changedPaths.length} file change(s). Score: {proposal.review.score}</p>
                  {proposal.quarantineReason ? <small>{proposal.quarantineReason}</small> : null}
                  {changedPaths.length ? (
                    <div className="skill-file-diff-list">
                      {proposal.diff.filter((item) => item.status !== "unchanged").map((item) => (
                        <label className="skill-file-diff-row" key={`${proposal.id}:${item.path}`}>
                          <input
                            checked={acceptedPaths.has(item.path)}
                            disabled={proposal.status !== "pending"}
                            type="checkbox"
                            onChange={() => toggleProposalPath(proposal, item.path)}
                          />
                          <span>{item.status}</span>
                          <code>{item.path}</code>
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <div className="skill-edit-actions compact-actions">
                    <button className="button secondary" type="button" disabled={proposal.status !== "pending" || acceptedPaths.size === 0} onClick={() => void applyProposal(proposal)}>Apply selected</button>
                    <button className="button secondary" type="button" disabled={proposal.status !== "pending"} onClick={() => void rejectProposal(proposal)}>Reject all</button>
                  </div>
                </article>
              );
            }) : <p>No proposals for this skill.</p>}
          </div>
          <div className="skill-workflow-list">
            {snapshots.length ? snapshots.slice(0, 3).map((snapshot) => (
              <article className="skill-validation-item" key={snapshot.id}>
                <strong>{formatDate(snapshot.createdAt)}</strong>
                <p>{snapshot.reason}</p>
                <small>{snapshot.packageHash.slice(0, 12)} · {snapshot.files.length} files</small>
                <div className="skill-edit-actions compact-actions">
                  <button className="button secondary" type="button" onClick={() => void restoreSnapshot(snapshot)}>Restore</button>
                </div>
              </article>
            )) : null}
          </div>
        </section>

        <div className="skill-toolbar-row">
          <button
            className="button secondary"
            type="button"
            disabled={selectedSkillPackageLocked}
            onClick={() => startEditingSkill(selectedSkill)}
          >
            Edit
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={exportingSkill}
            onClick={() => void exportSelectedSkill(selectedSkill)}
          >
            {exportingSkill ? "Exporting" : "Download skill"}
          </button>
          <button
            className="button ghost-danger"
            type="button"
            disabled={selectedSkillPackageLocked}
            onClick={() => void uninstallSkill(selectedSkill)}
          >
            Uninstall
          </button>
        </div>
        {exportError ? <p className="skill-import-error">{exportError}</p> : null}

        {renderSkillFiles(selectedSkill)}
      </article>
    );
  };

  const renderMcpSection = () => (
    <div className="mcp-workbench">
      {library.mcp.items.length === 0 ? (
        <div className="empty-section">No MCP servers configured.</div>
      ) : (
        library.mcp.items.map((item, index) => {
          const record = item as Record<string, unknown>;
          const status = typeof record.status === "string" ? record.status : "unknown";
          const transport = typeof record.transport === "string" ? record.transport : "diagnostic";
          const toolCount = typeof record.toolCount === "number" ? record.toolCount : 0;
          const itemKey = typeof record.id === "string" ? record.id : `mcp-${index}`;
          return (
            <article className="mcp-card shadcn-card" key={itemKey}>
              <div>
                <h3>{itemTitle(item)}</h3>
                {itemDescription(item) ? <p>{itemDescription(item)}</p> : null}
              </div>
              <dl className="mcp-meta-grid">
                <div>
                  <dt>Status</dt>
                  <dd>{status}</dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd>{transport}</dd>
                </div>
                <div>
                  <dt>Tools</dt>
                  <dd>{toolCount}</dd>
                </div>
              </dl>
              {typeof record.lastError === "string" && record.lastError ? (
                <p className="skill-import-error">{record.lastError}</p>
              ) : null}
            </article>
          );
        })
      )}
    </div>
  );

  return (
    <main className="library-panel">
      <header className="page-header">
        <div>
          <h1>Library</h1>
          <p>{itemCount} registered local items across core agent capabilities.</p>
        </div>
      </header>

      <div className="library-layout">
        <nav className="library-nav" aria-label="Library sections">
          {sectionOrder.map((key) => {
            const section = library[key];

            return (
              <button
                key={key}
                className={
                  key === activeKey
                    ? "library-nav-item active"
                    : "library-nav-item"
                }
                onClick={() => setActiveKey(key)}
              >
                <span>{section.title}</span>
                <span>{section.items.length}</span>
              </button>
            );
          })}
        </nav>

        <section className="library-content">
          <div className="section-heading skills-section-heading">
            <div>
              <h2>{activeSection.title}</h2>
              <p>{activeSection.description}</p>
            </div>
            {activeKey === "skills" ? (
              <div className="skill-heading-actions">
                <div className="skill-stats-pill">
                  <span>{installedCount} active</span>
                  <span>{autoRoutingCount} auto</span>
                  <span>SKILL.md context</span>
                </div>
                <div className="add-skill-menu">
                  <button
                    className="button primary add-skill-trigger"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={addMenuOpen}
                    onClick={() => setAddMenuOpen((value) => !value)}
                  >
                    Add skill
                  </button>
                  {addMenuOpen ? (
                    <div className="skill-add-popover shadcn-card" role="menu">
                      <button
                        className="skill-add-option"
                        type="button"
                        role="menuitem"
                        disabled={importing}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <span>Upload skill</span>
                        <small>Import .skill, .zip, or SKILL.md with validation.</small>
                      </button>
                      <button
                        className="skill-add-option"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAddMenuOpen(false);
                          onCreateSkillWithChat();
                        }}
                      >
                        <span>Create with chat</span>
                        <small>Create and install through chat; no manual upload needed.</small>
                      </button>
                      <div className="skill-add-url-row">
                        <input
                          type="url"
                          value={githubSkillUrl}
                          placeholder="https://github.com/org/repo/tree/main/skill"
                          onChange={(event) => setGithubSkillUrl(event.target.value)}
                        />
                        <button className="button secondary" type="button" disabled={!githubSkillUrl.trim()} onClick={() => void installGithubSkill()}>Install URL</button>
                      </div>
                      <div className="skill-add-url-row">
                        <button className="button secondary" type="button" onClick={() => void verifyAll()}>Verify all</button>
                        <button className="button secondary" type="button" onClick={() => void updateAll()}>Check updates</button>
                      </div>
                      {importError ? <p className="skill-import-error">{importError}</p> : null}
                    </div>
                  ) : null}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".skill,.zip,.md,text/markdown"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importSkillFile(file);
                  }}
                />
              </div>
            ) : activeKey === "mcp" ? (
              <button className="button primary" type="button" onClick={openMcpDialog}>
                Add MCP
              </button>
            ) : (
              <span
                className={
                  activeSection.status === "complete"
                    ? "status-badge success"
                    : "status-badge partial"
                }
              >
                {activeSection.status}
              </span>
            )}
          </div>

          {activeKey === "skills" ? (
            <div className="skills-workbench">
              <aside className="skills-list shadcn-card" aria-label="Installed skills">
                {skills.map((skill) => (
                  <button
                    key={skill.id}
                    className={
                      skill.id === selectedSkill?.id
                        ? "skill-list-item active"
                        : "skill-list-item"
                    }
                    type="button"
                    onClick={() => openSkill(skill)}
                  >
                    <span>{skill.name}</span>
                    <small>{skill.description}</small>
                    <em>{skill.shadowedBy ? `shadowed by ${skill.shadowedBy}` : skill.lifecycleState === "archived" ? "archived" : skill.pinned ? "pinned" : skill.lifecycleState === "stale" ? "stale" : skill.source === "built-in" ? "built-in" : skill.autoRouting ? `${skill.source} · auto` : `${skill.source} · manual`}</em>
                  </button>
                ))}
              </aside>
              {renderSkillDetail()}
            </div>
          ) : activeKey === "mcp" ? (
            renderMcpSection()
          ) : activeSection.items.length === 0 ? (
            <div className="empty-section">
              No items registered in this section.
            </div>
          ) : (
            <div className="library-list">
              {activeSection.items.map((item, index) => (
                <article className="library-card" key={`${activeKey}-${index}`}>
                  <h3>{itemTitle(item)}</h3>
                  {itemDescription(item) ? <p>{itemDescription(item)}</p> : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <McpConnectorDialog
        dialogRef={mcpDialogRef}
        error={mcpError}
        open={mcpDialogOpen}
        result={mcpResult}
        saving={mcpSaving}
        onClose={() => setMcpDialogOpen(false)}
        onSubmit={(request) => void addMcpConnector(request)}
      />
      <SkillEditDialog
        dialogRef={editDialogRef}
        draft={draft}
        saving={saving}
        onClose={() => setDraft(null)}
        onSave={() => void saveDraft()}
        onUpdateDraft={setDraft}
      />
      <SkillImportDialog
        dialogRef={importDialogRef}
        importError={importError}
        installingImport={installingImport}
        pendingImport={pendingImport}
        onClose={() => setPendingImport(null)}
        onInstall={(mode) => void installPendingImport(mode)}
      />
      <SkillTrustOverrideDialog
        dialogRef={trustDialogRef}
        skill={unsafeEnableSkill}
        onCancel={() => setUnsafeEnableSkill(null)}
        onConfirm={(skill) => {
          setUnsafeEnableSkill(null);
          void saveSkillEnabled(skill, true);
        }}
      />
    </main>
  );
}

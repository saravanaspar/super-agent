import { mkdirSync, readdirSync, watch, type FSWatcher, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SkillEvalRunRecord,
  SkillEvalRunRequest,
  SkillExportResult,
  SkillGitHubInstallRequest,
  SkillImportAdapterRequest,
  SkillImportAdapterResult,
  SkillFileRecord,
  SkillImportMode,
  SkillImportRequest,
  SkillImportValidationIssue,
  SkillImportValidationResult,
  SkillPatchRequest,
  SkillRegistryEntry,
  SkillRegistryInstallRequest,
  SkillRegistrySearchRequest,
  SkillProposalCreateRequest,
  SkillProposalRecord,
  SkillRecord,
  SkillRollbackSnapshot,
  SkillRootDiagnostic,
  SkillRootSyncResult,
  SkillResourceManifestItem,
  SkillScriptRunHistory,
  SkillAuditExport,
  SkillAuditExportVerification,
  SkillAuditLogRecord,
  SkillCredentialReport,
  SkillCredentialSaveRequest,
  SkillUpdateAllResult,
  SkillUpdateCandidate,
  SkillUpdateRequest,
  SkillVerificationResult,
} from "@shared/types";
import { diffSkillFiles, type SkillRepository } from "@persistence/skillRepository";
import { BUILT_IN_SKILLS } from "./skillCreatorSkill";
import {
  buildSkillMarkdown,
  parseSkillMarkdown,
  validateSkillFiles,
} from "./skillValidation";
import { extractSkillDependencyMetadata, runSkillPreflight } from "./skillMetadata";
import { hashSkillFiles } from "./skillHash";
import { skillFileByteLength, skillFileText } from "./skillFileData";
import { criticalSkillFinding, scanSkillFiles, trustLevelForSkill } from "./skillSecurity";
import { resolveSkillRoots, scanSkillRoots, skillUserRoot, writeSkillPackageToRoot, type SkillRoot } from "./skillRoots";
import { adaptSkillLayout, fetchRemoteBuffer, parseRegistryIndex, resolveGitHubSkillSourceFromApi, verificationFromFindings, verifySkillSignature } from "./skillDistribution";
import {
  applyPatchOperations,
  buildSkillResourceManifest,
  createZip,
  emptyDependencyMetadata,
  filePackageSize,
  filesFromUpload,
  gradeSkillEvalCase,
  isUnsafePath,
  mergedFiles,
  normalizePatchPath,
  normalizeSkillFilePath,
  parseSkillEvals,
  reviewSkillPackage,
  selectedProposalFiles,
  skillPackageHash,
  skillRecordFromFiles,
  validationIssue,
  type SkillContextBuildResult,
  type SkillContextOptions,
  type SkillRegistryOptions,
} from "./skillRegistrySupport";
import { buildSkillContext } from "./skillContext";
import { runBulkSkillAction, type SkillBulkAction } from "./skillBulkActions";
import { filesFromRemoteSkillArchive, resolveSkillUpdateSource } from "./skillRemoteArchive";
import { clearSkillState, hasTrustedOverride, persistSkillState, readPersistedSkillState } from "./skillStateFile";
import {
  buildSkillSetupPlan,
  compareSkills,
  evaluateSkillPolicy,
  filterSkillsByPolicy,
  listSkillBundles,
  loadSkillAdminPolicy,
  marketplaceReadiness,
} from "./skillProductionFeatures";
import { buildSkillCredentialReport, saveSkillCredentials, skillCredentialEnv } from "./skillCredentials";
import { buildSkillAuditExport, verifySkillAuditExport as verifyAuditExportPayload } from "./skillAuditExport";
export { buildSkillResourceManifest } from "./skillRegistrySupport";
const WATCH_SCAN_DEPTH = 6;
const MAX_WATCH_DIRECTORIES_PER_ROOT = 2000;
const WATCH_EXCLUDED_DIRS = new Set([
  ".git",
  ".github",
  ".super-agent-cache",
  "node_modules",
  "dist",
  "out",
  ".venv",
  "venv",
  "__pycache__",
]);

interface SkillRootWatchResult {
  watchedDirectories: number;
  error: string | null;
}

export class SkillRegistry {
  private readonly watchers: FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private roots: SkillRoot[] = [];
  private rootDiagnostics: SkillRootDiagnostic[] = [];
  constructor(
    private readonly repository: SkillRepository,
    private readonly options: SkillRegistryOptions = {},
  ) {}
  initializeBuiltIns(): void {
    this.repository.removeBuiltInsExcept(
      BUILT_IN_SKILLS.map((skill) => skill.id),
    );
    this.seedBuiltIns();
    if (this.options.workspaceDir) {
      this.refreshSkillRoots();
      this.startWatchers();
    }
  }
  private seedBuiltIns(): void {
    for (const skill of BUILT_IN_SKILLS) {
      this.repository.seedBuiltIn({
        ...skill,
        rootPath: "built-in://skills",
        sourcePath: `built-in://${skill.id}/SKILL.md`,
        sourceRank: 70,
        writable: false,
      });
    }
  }
  configureRoots(options: Pick<SkillRegistryOptions, "workspaceDir" | "pluginRoots" | "onRootsChanged">): SkillRootSyncResult {
    Object.assign(this.options, options);
    const result = this.refreshSkillRoots();
    this.startWatchers();
    return result;
  }
  rootStatus(): SkillRootDiagnostic[] {
    return this.rootDiagnostics;
  }
  refreshSkillRoots(): SkillRootSyncResult {
    const workspaceDir = this.options.workspaceDir;
    if (!workspaceDir) {
      return { added: [], removed: [], updated: [], unchanged: [], active: 0, shadowed: 0, roots: [] };
    }
    this.seedBuiltIns();
    const previousSkills = this.repository.list();
    const before = new Map(previousSkills.map((skill) => [skill.id, skill.packageHash ?? ""]));
    this.migrateLocalSkillsToUserRoot();
    this.roots = resolveSkillRoots(
      workspaceDir,
      this.options.pluginRoots ?? [],
      this.options.userSkillRoot,
      this.options.agentsSkillRoot,
    );
    for (const root of this.roots.filter((item) => item.writable)) {
      mkdirSync(root.path, { recursive: true });
    }
    const scan = scanSkillRoots(this.roots);
    this.rootDiagnostics = scan.diagnostics;
    this.repository.replaceRootManagedSkills(this.applyPersistedSkillState(scan.records, previousSkills));
    const after = new Map(this.repository.list().map((skill) => [skill.id, skill.packageHash ?? ""]));
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    for (const [id, hash] of after) {
      if (!before.has(id)) added.push(id);
      else if (before.get(id) !== hash) updated.push(id);
      else unchanged.push(id);
    }
    const removed = [...before.keys()].filter((id) => !after.has(id));
    return {
      added,
      removed,
      updated,
      unchanged,
      active: scan.records.filter((skill) => !skill.shadowedBy).length,
      shadowed: scan.records.filter((skill) => Boolean(skill.shadowedBy)).length,
      roots: scan.diagnostics,
    };
  }
  close(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }
  private startWatchers(): void {
    this.close();
    const results = new Map<string, SkillRootWatchResult>();
    for (const root of this.roots) {
      results.set(root.id, this.watchSkillRoot(root));
    }

    this.rootDiagnostics = this.rootDiagnostics.map((diagnostic) => {
      const result = results.get(diagnostic.id);
      if (!result) return { ...diagnostic, watching: false };
      if (result.watchedDirectories > 0) {
        return {
          ...diagnostic,
          watching: true,
          message: result.error
            ? `Watching ${result.watchedDirectories} directories; ${result.error}`
            : `Watching ${result.watchedDirectories} directories.`,
        };
      }
      if (diagnostic.status === "missing") return { ...diagnostic, watching: false };
      return {
        ...diagnostic,
        watching: false,
        status: "error",
        message: result.error ?? "No filesystem watcher could be started for this skill root.",
      };
    });
  }
  private watchSkillRoot(root: SkillRoot): SkillRootWatchResult {
    const directories = this.watchDirectoriesForRoot(root.path);
    if (!directories.length) return { watchedDirectories: 0, error: null };

    let watchedDirectories = 0;
    let error: string | null = null;
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, () => this.scheduleRootRefresh());
        watcher.on("error", (watchError) => {
          error = watchError.message;
          this.scheduleRootRefresh();
        });
        this.watchers.push(watcher);
        watchedDirectories += 1;
      } catch (watchError) {
        error = watchError instanceof Error ? watchError.message : String(watchError);
      }
    }

    return { watchedDirectories, error };
  }
  private watchDirectoriesForRoot(rootPath: string): string[] {
    const directories: string[] = [];
    const visit = (directory: string, depth: number): void => {
      if (directories.length >= MAX_WATCH_DIRECTORIES_PER_ROOT || depth > WATCH_SCAN_DEPTH) return;
      directories.push(directory);
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || WATCH_EXCLUDED_DIRS.has(entry.name)) continue;
        visit(join(directory, entry.name), depth + 1);
      }
    };
    try {
      visit(rootPath, 0);
    } catch {
      return [];
    }
    return directories;
  }
  private scheduleRootRefresh(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const result = this.refreshSkillRoots();
      this.startWatchers();
      this.options.onRootsChanged?.(result);
    }, 250);
    this.watchTimer.unref?.();
  }
  private targetUserRoot(): string {
    return this.options.userSkillRoot ?? skillUserRoot();
  }
  private applyPersistedSkillState(records: SkillRecord[], previous: SkillRecord[]): SkillRecord[] {
    const bySourcePath = new Map(previous.filter((skill) => skill.sourcePath).map((skill) => [skill.sourcePath, skill]));
    const byId = new Map(previous.map((skill) => [skill.id, skill]));
    return records.map((record) => {
      const old = (record.sourcePath ? bySourcePath.get(record.sourcePath) : null) ?? byId.get(record.id);
      const shadowed = Boolean(record.shadowedBy);
      if (record.source === "built-in") {
        return {
          ...record,
          enabled: shadowed ? false : record.enabled,
          autoRouting: shadowed ? false : record.autoRouting,
          installedAt: old?.installedAt || record.installedAt,
          lastUsedAt: old?.lastUsedAt ?? record.lastUsedAt,
          useCount: old?.useCount ?? record.useCount,
        };
      }
      const persisted = readPersistedSkillState(this.options.workspaceDir, record);
      const unsafe = record.trustLevel === "quarantined" || record.trustLevel === "untrusted";
      const trustedOverride = unsafe && hasTrustedOverride(this.options.workspaceDir, record);
      return {
        ...record,
        enabled: shadowed ? false : unsafe ? trustedOverride && (persisted?.enabled ?? old?.enabled ?? false) : (persisted?.enabled ?? old?.enabled ?? record.enabled),
        autoRouting: shadowed ? false : unsafe ? trustedOverride && (persisted?.autoRouting ?? old?.autoRouting ?? false) : (persisted?.autoRouting ?? old?.autoRouting ?? record.autoRouting),
        installedAt: old?.installedAt || record.installedAt,
        lastUsedAt: old?.lastUsedAt ?? record.lastUsedAt,
        useCount: old?.useCount ?? record.useCount,
        lifecycleState: persisted?.lifecycleState ?? old?.lifecycleState ?? record.lifecycleState,
        pinned: persisted?.pinned ?? old?.pinned ?? record.pinned,
        archivedAt: persisted?.archivedAt ?? old?.archivedAt ?? record.archivedAt,
        staleReason: old?.staleReason ?? record.staleReason,
        originUrl: old?.originUrl ?? record.originUrl,
        sourceArchiveUrl: old?.sourceArchiveUrl ?? record.sourceArchiveUrl,
        sourceSubpath: old?.sourceSubpath ?? record.sourceSubpath,
        registryUrl: old?.registryUrl ?? record.registryUrl,
        publisher: old?.publisher ?? record.publisher,
        expectedPackageHash: old?.expectedPackageHash ?? record.expectedPackageHash,
        signature: old?.signature ?? record.signature,
        publicKey: old?.publicKey ?? record.publicKey,
        verifiedAt: old?.verifiedAt ?? record.verifiedAt,
        verificationStatus: old?.verificationStatus ?? record.verificationStatus
      };
    });
  }
  private migrateLocalSkillsToUserRoot(): void {
    for (const skill of this.repository.list().filter((item) => item.source === "local" && item.id !== "skill-creator")) {
      const written = writeSkillPackageToRoot(this.targetUserRoot(), skill.id, mergedFiles(skill));
      this.repository.upsert({
        ...skill,
        source: "user",
        rootPath: this.targetUserRoot(),
        sourcePath: written.skillPath,
        sourceRank: 30,
        writable: true,
      });
    }
  }
  private persistUserState(skill: SkillRecord, previous?: SkillRecord | null): void {
    const unsafe = skill.trustLevel === "quarantined" || skill.trustLevel === "untrusted";
    const enablingUnsafe = unsafe && skill.enabled && previous?.enabled !== true;
    persistSkillState(this.options.workspaceDir, skill, enablingUnsafe ? {
      trustOverrideAt: new Date().toISOString(),
      trustOverrideReason: skill.quarantineReason ?? "User manually enabled an unsafe skill after reviewing scanner findings.",
      trustOverridePackageHash: skill.packageHash ?? null,
    } : {});
  }
  list(): SkillRecord[] {
    return this.repository.list();
  }
  get(id: string): SkillRecord | null {
    return this.repository.get(id);
  }
  skillRecordFromFiles(
    files: SkillFileRecord[],
    options: {
      enabled?: boolean | undefined;
      autoRouting?: boolean | undefined;
      version?: string | null | undefined;
      originUrl?: string | null | undefined;
      sourceArchiveUrl?: string | null | undefined;
      sourceSubpath?: string | null | undefined;
      registryUrl?: string | null | undefined;
      publisher?: string | null | undefined;
      expectedPackageHash?: string | null | undefined;
      signature?: string | null | undefined;
    } = {},
  ): SkillRecord {
    return skillRecordFromFiles(files, options);
  }
  skillRecordFromParts(input: {
    name: string;
    description: string;
    instructions: string;
    files?: SkillFileRecord[];
    enabled?: boolean;
    autoRouting?: boolean;
    version?: string | null;
  }): SkillRecord {
    const files = [
      {
        path: "SKILL.md",
        content: buildSkillMarkdown(
          input.name,
          input.description,
          input.instructions,
        ),
      },
      ...(input.files ?? []),
    ];
    return skillRecordFromFiles(files, {
      enabled: input.enabled,
      autoRouting: input.autoRouting,
      version: input.version,
    });
  }
  installGeneratedSkill(
    skill: SkillRecord,
    mode: SkillImportMode = "replace",
  ): SkillRecord {
    if (!this.options.workspaceDir && !this.options.userSkillRoot) {
      return this.repository.installLocal(skill, mode);
    }
    const existing = this.repository.get(skill.id);
    const saved = this.repository.installLocal({
      ...skill,
      source: "user",
      rootPath: this.targetUserRoot(),
      sourceRank: 30,
      writable: true,
    }, mode);
    const written = writeSkillPackageToRoot(this.targetUserRoot(), saved.id, mergedFiles(saved));
    const indexed = this.repository.upsert({
      ...saved,
      source: "user",
      rootPath: this.targetUserRoot(),
      sourcePath: written.skillPath,
      sourceRank: 30,
      writable: true,
    });
    this.persistUserState(indexed, existing);
    if (this.options.workspaceDir) this.refreshSkillRoots();
    return this.repository.get(indexed.id) ?? indexed;
  }
  update(skill: SkillUpdateRequest): SkillRecord {
    const existing = this.repository.get(skill.id);
    const saved = this.repository.update(skill);
    this.persistUserState(saved, existing);
    if (existing?.writable && existing.rootPath && existing.sourcePath && !existing.shadowedBy) {
      const written = writeSkillPackageToRoot(existing.rootPath, saved.id, mergedFiles(saved));
      const indexed = this.repository.upsert({ ...saved, rootPath: existing.rootPath, sourcePath: written.skillPath, writable: true });
      this.persistUserState(indexed, existing);
      if (this.options.workspaceDir) this.refreshSkillRoots();
      return this.repository.get(indexed.id) ?? indexed;
    }
    return saved;
  }
  previewImport(upload: SkillImportRequest): SkillImportValidationResult {
    const packageSize = Buffer.from(upload.dataBase64, "base64").length;
    const base = {
      filename: upload.filename,
      packageSize,
      valid: false,
      skill: null,
      existingSkillId: null,
      errors: [] as SkillImportValidationIssue[],
      warnings: [] as SkillImportValidationIssue[],
      files: [] as Array<{ path: string; size: number }>,
      dependencyMetadata: emptyDependencyMetadata(),
    } satisfies SkillImportValidationResult;
    try {
      const files = filesFromUpload(upload);
      const validation = validateSkillFiles(files);
      const scanFindings = scanSkillFiles(files);
      const dependencyMetadata = extractSkillDependencyMetadata(files);
      const trustLevel = trustLevelForSkill("local", scanFindings);
      const critical = criticalSkillFinding(scanFindings);
      const rootSkill = files.find((file) => file.path === "SKILL.md");
      const parsed = rootSkill ? parseSkillMarkdown(rootSkill.content) : null;
      const existing = parsed ? this.repository.get(parsed.name) : null;
      const warnings: SkillImportValidationIssue[] = [];
      if (existing) {
        warnings.push(
          validationIssue(
            "duplicate-skill",
            existing.source === "built-in"
              ? `A built-in skill already uses '${existing.id}' and cannot be replaced.`
              : `A local skill already uses '${existing.id}'. Choose Replace or Install as copy.`,
          ),
        );
      }
      const errors = validation.valid
        ? []
        : [
            validationIssue(
              "validation-failed",
              validation.message,
              "SKILL.md",
            ),
          ];
      if (existing?.source === "built-in") {
        errors.push(
          validationIssue(
            "protected-skill",
            `The built-in skill '${existing.id}' is protected. Rename the uploaded skill or install a different package.`,
          ),
        );
      }
      if (critical) {
        warnings.push(
          validationIssue(
            "skill-quarantined",
            `Critical scanner finding: ${critical.message}. The skill will be installed disabled and excluded from auto-routing until fixed.`,
            critical.path,
          ),
        );
      }
      for (const finding of scanFindings.filter((item) => item.severity === "warn")) {
        warnings.push(
          validationIssue(finding.ruleId, finding.message, finding.path),
        );
      }
      if (files.length === 1) {
        warnings.push(
          validationIssue(
            "single-file",
            "This package only contains SKILL.md.",
          ),
        );
      }
      return {
        ...base,
        valid: validation.valid && existing?.source !== "built-in",
        skill: parsed
          ? {
              id: parsed.name,
              name: parsed.name,
              description: parsed.description,
              version: null,
              fileCount: files.length,
              packageSize: filePackageSize(files),
              trustLevel,
              scanFindings,
            }
          : null,
        existingSkillId: existing?.id ?? null,
        errors,
        warnings,
        files: files.map((file) => ({
          path: file.path,
          size: skillFileByteLength(file),
        })),
        dependencyMetadata,
      };
    } catch (error) {
      return {
        ...base,
        errors: [
          validationIssue(
            "read-failed",
            error instanceof Error
              ? error.message
              : "Could not read skill package.",
          ),
        ],
      };
    }
  }
  importSkill(upload: SkillImportRequest): SkillRecord {
    const preview = this.previewImport(upload);
    if (!preview.valid) {
      const message =
        preview.errors.map((issue) => issue.message).join("\n") ||
        "Skill import failed.";
      throw new Error(message);
    }
    return this.installGeneratedSkill(
      skillRecordFromFiles(filesFromUpload(upload)),
      upload.installMode ?? "replace",
    );
  }
  createProposal(input: SkillProposalCreateRequest): SkillProposalRecord {
    const files = input.files.map((file) => ({
      path: normalizePatchPath(file.path),
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}),
    }));
    const validation = validateSkillFiles(files);
    if (!validation.valid) throw new Error(validation.message);
    const parsed = parseSkillMarkdown(skillFileText(files.find((file) => file.path === "SKILL.md") ?? { path: "SKILL.md", content: "" }));
    const skillId = input.skillId?.trim() || parsed.name;
    const existing = this.repository.get(skillId);
    const review = reviewSkillPackage(files);
    const scanFindings = scanSkillFiles(files);
    const critical = criticalSkillFinding(scanFindings);
    const now = new Date().toISOString();
    const proposal: SkillProposalRecord = {
      id: `proposal-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      createdAt: now,
      updatedAt: now,
      skillId,
      skillName: parsed.name,
      title: input.title.trim(),
      reason: input.reason.trim(),
      source: input.source ?? "tool",
      status: critical || !review.passed ? "quarantined" : "pending",
      operation: input.operation ?? (existing ? "update" : "create"),
      proposedFiles: files,
      basePackageHash: existing?.packageHash ?? null,
      targetPackageHash: hashSkillFiles(files),
      diff: diffSkillFiles(existing ? mergedFiles(existing) : [], files),
      scanFindings,
      review,
      quarantineReason: critical?.message ?? (!review.passed ? review.summary : null)
    };
    return this.repository.saveProposal(proposal);
  }
  createPatchProposal(input: SkillPatchRequest): SkillProposalRecord {
    const existing = this.repository.get(input.skillId);
    if (!existing) throw new Error("Skill not found.");
    if (existing.writable === false || existing.shadowedBy) throw new Error("This skill is read-only or shadowed and cannot be patched.");
    return this.createProposal({
      skillId: existing.id,
      title: input.title,
      reason: input.reason,
      source: input.source ?? "tool",
      operation: "update",
      files: applyPatchOperations(mergedFiles(existing), input)
    });
  }
  listProposals(skillId?: string): SkillProposalRecord[] {
    return this.repository.listProposals(skillId);
  }
  rejectProposal(id: string): SkillProposalRecord {
    const proposal = this.repository.updateProposalStatus(id, "rejected");
    if (!proposal) throw new Error("Skill proposal not found.");
    return proposal;
  }
  applyProposal(id: string, acceptedPaths?: string[]): SkillRecord {
    const proposal = this.repository.getProposal(id);
    if (!proposal) throw new Error("Skill proposal not found.");
    if (proposal.status === "quarantined") throw new Error("Quarantined proposals cannot be applied until fixed.");
    if (proposal.status !== "pending") throw new Error(`Proposal is ${proposal.status}.`);
    const existing = this.repository.get(proposal.skillId);
    if (existing) {
      this.repository.saveSnapshot({
        skillId: existing.id,
        skillName: existing.name,
        reason: `Before applying proposal ${proposal.id}`,
        packageHash: existing.packageHash ?? hashSkillFiles(mergedFiles(existing)),
        files: mergedFiles(existing)
      });
    }
    const appliedFiles = selectedProposalFiles(proposal, existing, acceptedPaths);
    const validation = validateSkillFiles(appliedFiles);
    if (!validation.valid) throw new Error(validation.message);
    const record = skillRecordFromFiles(appliedFiles, {
      enabled: existing?.enabled ?? true,
      autoRouting: existing?.autoRouting ?? true,
      version: existing?.version ?? null,
      originUrl: existing?.originUrl ?? null,
      sourceArchiveUrl: existing?.sourceArchiveUrl ?? null,
      sourceSubpath: existing?.sourceSubpath ?? null,
      registryUrl: existing?.registryUrl ?? null,
      publisher: existing?.publisher ?? null,
      expectedPackageHash: existing?.expectedPackageHash ?? null,
      signature: existing?.signature ?? null,
      publicKey: existing?.publicKey ?? null,
    });
    const saved = this.installGeneratedSkill({ ...record, id: proposal.skillId }, "replace");
    this.repository.updateProposalStatus(id, "applied");
    return saved;
  }
  listSnapshots(skillId: string): SkillRollbackSnapshot[] {
    return this.repository.listSnapshots(skillId);
  }
  restoreSnapshot(snapshotId: string): SkillRecord {
    const snapshot = this.repository.getSnapshot(snapshotId);
    if (!snapshot) throw new Error("Skill rollback snapshot not found.");
    const existing = this.repository.get(snapshot.skillId);
    if (existing) {
      this.repository.saveSnapshot({
        skillId: existing.id,
        skillName: existing.name,
        reason: `Before restoring snapshot ${snapshot.id}`,
        packageHash: existing.packageHash ?? hashSkillFiles(mergedFiles(existing)),
        files: mergedFiles(existing)
      });
    }
    const record = skillRecordFromFiles(snapshot.files, {
      enabled: existing?.enabled ?? true,
      autoRouting: existing?.autoRouting ?? true,
      version: existing?.version ?? null,
      originUrl: existing?.originUrl ?? null,
      sourceArchiveUrl: existing?.sourceArchiveUrl ?? null,
      sourceSubpath: existing?.sourceSubpath ?? null,
      registryUrl: existing?.registryUrl ?? null,
      publisher: existing?.publisher ?? null,
      expectedPackageHash: existing?.expectedPackageHash ?? null,
      signature: existing?.signature ?? null,
      publicKey: existing?.publicKey ?? null,
    });
    return this.installGeneratedSkill({ ...record, id: snapshot.skillId }, "replace");
  }
  exportSkill(id: string): SkillExportResult {
    const skill = this.repository.get(id);
    if (!skill) throw new Error("Skill not found.");
    const files = mergedFiles(skill);
    const manifest = {
      schemaVersion: 1 as const,
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      source: skill.source,
      trustLevel: skill.trustLevel,
      packageHash: skillPackageHash(skill),
      packageSize: skill.packageSize,
      exportedAt: new Date().toISOString(),
      installedAt: skill.installedAt,
      updatedAt: skill.updatedAt,
      fileCount: files.length,
      dependencies: skill.dependencyMetadata,
      scanFindings: skill.scanFindings,
      originUrl: skill.originUrl ?? null,
      sourceArchiveUrl: skill.sourceArchiveUrl ?? null,
      sourceSubpath: skill.sourceSubpath ?? null,
      publisher: skill.publisher ?? null,
      expectedPackageHash: skill.expectedPackageHash ?? null,
      signature: skill.signature ?? null,
      publicKey: skill.publicKey ?? null,
    };
    const archive = createZip([
      ...files,
      { path: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    ]);
    return {
      filename: `${skill.id}.skill`,
      dataBase64: archive.toString("base64"),
      mimeType: "application/zip",
      manifest,
    };
  }
  updateLifecycle(id: string, action: "pin" | "unpin" | "archive" | "restore"): SkillRecord {
    const saved = this.repository.updateLifecycle(id, action);
    this.persistUserState(saved, saved);
    if (this.options.workspaceDir) this.refreshSkillRoots();
    return this.repository.get(saved.id) ?? saved;
  }
  delete(id: string): void {
    const skill = this.repository.get(id);
    if (skill?.pinned) throw new Error("This skill is pinned. Unpin it before uninstalling it.");
    if (skill) clearSkillState(this.options.workspaceDir, skill);
    if (skill?.writable && skill.sourcePath && !skill.shadowedBy) {
      rmSync(dirname(skill.sourcePath), { recursive: true, force: true });
      if (this.options.workspaceDir) {
        this.refreshSkillRoots();
        return;
      }
    }
    this.repository.delete(id);
  }
  buildContext(options: SkillContextOptions): SkillContextBuildResult {
    return buildSkillContext({
      skills: filterSkillsByPolicy(this.repository.list(), this.options.workspaceDir, options.agentId),
      options,
    });
  }

  scriptExecutionPolicy(skill: SkillRecord): { allowed: boolean; reasons: string[] } {
    const policy = loadSkillAdminPolicy(this.options.workspaceDir);
    const decision = evaluateSkillPolicy([skill], policy)[0];
    const reasons = [...(decision?.reasons ?? [])];
    if (skill.shadowedBy) reasons.push(`skill is shadowed by ${skill.shadowedBy}`);
    if (skill.lifecycleState === "archived") reasons.push("skill is archived");
    if (skill.trustLevel === "quarantined") reasons.push(`skill is quarantined${skill.quarantineReason ? `: ${skill.quarantineReason}` : ""}`);
    if (skill.trustLevel === "untrusted" && !policy.untrustedScriptsEnabled) {
      reasons.push("untrusted skill scripts are disabled by project/admin policy");
    }
    return { allowed: reasons.length === 0, reasons };
  }
  skillPolicyReport(agentId?: string) {
    const skills = this.repository.list();
    const policy = loadSkillAdminPolicy(this.options.workspaceDir);
    return { policy, decisions: evaluateSkillPolicy(skills, policy, agentId) };
  }
  listBundles() {
    return listSkillBundles(this.repository.list(), this.options.workspaceDir);
  }
  compareSkills(leftSkillId: string, rightSkillId: string) {
    const left = this.repository.get(leftSkillId);
    const right = this.repository.get(rightSkillId);
    if (!left || !right) throw new Error("Both skills must exist to compare them.");
    return compareSkills(left, right);
  }
  credentialReport(skillId: string): SkillCredentialReport {
    const skill = this.repository.get(skillId);
    if (!skill) throw new Error("Skill not found.");
    return buildSkillCredentialReport(skill, this.options.workspaceDir, this.options.credentialCodec);
  }
  saveCredentials(request: SkillCredentialSaveRequest): SkillCredentialReport {
    const skill = this.repository.get(request.skillId);
    if (!skill) throw new Error("Skill not found.");
    const report = saveSkillCredentials(skill, request, this.options.credentialCodec);
    this.repository.recordAuditLog({
      action: "skill.credentials.save",
      skillId: skill.id,
      skillName: skill.name,
      actor: "user",
      status: "ok",
      packageHash: skill.packageHash ?? null,
      detail: {
        envKeys: Object.keys(request.env ?? {}).sort(),
        fileKeys: Object.keys(request.files ?? {}).sort(),
      },
    });
    return report;
  }
  credentialEnv(skillId: string, names: string[]): Record<string, string> {
    return skillCredentialEnv(skillId, names, this.options.credentialCodec);
  }
  setupPlan(skillId: string) {
    const skill = this.repository.get(skillId);
    if (!skill) throw new Error("Skill not found.");
    return buildSkillSetupPlan(skill);
  }
  marketplaceReadiness(skillId: string) {
    const skill = this.repository.get(skillId);
    if (!skill) throw new Error("Skill not found.");
    return marketplaceReadiness(skill);
  }
  allowNetworkByDefault(): boolean {
    return loadSkillAdminPolicy(this.options.workspaceDir).allowNetworkByDefault;
  }
  bulkAction(skillIds: string[], action: SkillBulkAction) {
    return runBulkSkillAction({
      get: (skillId) => this.repository.get(skillId),
      update: (request) => this.update(request),
      updateLifecycle: (skillId, lifecycleAction) => this.updateLifecycle(skillId, lifecycleAction),
      verifySkill: (skillId) => this.verifySkill(skillId),
      recordAuditLog: (input) => this.repository.recordAuditLog(input),
    }, skillIds, action);
  }
  async installFromGitHub(request: SkillGitHubInstallRequest): Promise<SkillRecord> {
    const source = await resolveGitHubSkillSourceFromApi(request.url, request.skillPath);
    const archive = await fetchRemoteBuffer(source.archiveUrl);
    const files = filesFromRemoteSkillArchive(archive, source.skillPath ?? undefined);
    const packageHash = hashSkillFiles(files);
    const record = skillRecordFromFiles(files, {
      enabled: true,
      autoRouting: true,
      originUrl: source.originUrl,
      sourceArchiveUrl: source.archiveUrl,
      sourceSubpath: source.skillPath,
      publisher: source.repo,
      expectedPackageHash: packageHash,
    });
    return this.installGeneratedSkill(record, request.installMode ?? "replace");
  }
  async searchRegistry(request: SkillRegistrySearchRequest): Promise<SkillRegistryEntry[]> {
    const raw = (await fetchRemoteBuffer(request.registryUrl)).toString("utf8");
    const query = request.query?.trim().toLowerCase() ?? "";
    const entries = parseRegistryIndex(raw, request.registryUrl);
    if (!query) return entries;
    return entries.filter((entry) => [entry.name, entry.description, entry.id, ...entry.tags].join("\n").toLowerCase().includes(query));
  }
  async installFromRegistry(request: SkillRegistryInstallRequest): Promise<SkillRecord> {
    const entries = await this.searchRegistry({ registryUrl: request.registryUrl });
    const entry = entries.find((item) => item.id === request.entryId);
    if (!entry) throw new Error("Registry entry not found.");
    if (!entry.packageHash && (!entry.signature || !entry.publicKey)) {
      throw new Error(`Registry entry '${entry.name}' must provide packageHash or a signature/publicKey pair before it can be installed.`);
    }
    const archive = await fetchRemoteBuffer(entry.archiveUrl);
    const files = filesFromRemoteSkillArchive(archive);
    const packageHash = hashSkillFiles(files);
    if (entry.packageHash && entry.packageHash !== packageHash) {
      throw new Error(`Registry package hash mismatch for ${entry.name}.`);
    }
    const signatureValid = verifySkillSignature({
      packageHash,
      publisher: entry.publisher,
      signature: entry.signature,
      publicKey: entry.publicKey,
    });
    if ((entry.signature || entry.publicKey) && signatureValid !== true) {
      throw new Error(`Registry signature verification failed for ${entry.name}.`);
    }
    const record = skillRecordFromFiles(files, {
      enabled: true,
      autoRouting: true,
      originUrl: entry.archiveUrl,
      sourceArchiveUrl: entry.archiveUrl,
      registryUrl: request.registryUrl,
      publisher: entry.publisher,
      expectedPackageHash: entry.packageHash,
      signature: entry.signature,
      publicKey: entry.publicKey,
    });
    const saved = this.installGeneratedSkill(record, request.installMode ?? "replace");
    return this.repository.upsert({
      ...saved,
      publisher: entry.publisher,
      expectedPackageHash: entry.packageHash,
      signature: entry.signature,
      publicKey: entry.publicKey,
      originUrl: entry.archiveUrl,
      sourceArchiveUrl: entry.archiveUrl,
      registryUrl: request.registryUrl,
    });
  }
  verifySkill(id: string, expectedHash?: string | null, publicKey?: string | null): SkillVerificationResult {
    const skill = this.repository.get(id);
    if (!skill) throw new Error("Skill not found.");
    const files = mergedFiles(skill);
    const review = reviewSkillPackage(files);
    const packageHash = hashSkillFiles(files);
    const signatureValid = verifySkillSignature({
      packageHash,
      publisher: skill.publisher ?? null,
      signature: skill.signature ?? null,
      publicKey: publicKey ?? skill.publicKey ?? null,
    });
    const result = verificationFromFindings({
      skillId: skill.id,
      packageHash,
      expectedHash: expectedHash ?? skill.expectedPackageHash ?? null,
      signatureValid,
      publisher: skill.publisher ?? null,
      originUrl: skill.originUrl ?? null,
      findings: review.findings,
    });
    this.repository.upsert({ ...skill, packageHash, verifiedAt: result.verifiedAt, verificationStatus: result.status });
    return result;
  }
  verifyAllSkills(): SkillVerificationResult[] {
    return this.repository.list().filter((skill) => !skill.shadowedBy).map((skill) => this.verifySkill(skill.id));
  }
  async updateAllSkills(createProposals = true): Promise<SkillUpdateAllResult> {
    const checked: SkillUpdateCandidate[] = [];
    const proposalsCreated: SkillProposalRecord[] = [];
    for (const skill of this.repository.list().filter((item) => !item.shadowedBy && item.source !== "built-in")) {
      if (!skill.originUrl) {
        checked.push({ skillId: skill.id, name: skill.name, originUrl: null, currentHash: skillPackageHash(skill), remoteHash: null, status: "missing_origin", message: "Skill has no tracked origin URL." });
        continue;
      }
      try {
        const resolvedSource = await resolveSkillUpdateSource(skill);
        const archive = await fetchRemoteBuffer(resolvedSource.archiveUrl);
        const files = filesFromRemoteSkillArchive(archive, resolvedSource.skillPath ?? undefined);
        const remoteHash = hashSkillFiles(files);
        const currentHash = skillPackageHash(skill);
        if (remoteHash === currentHash) {
          checked.push({ skillId: skill.id, name: skill.name, originUrl: skill.originUrl, currentHash, remoteHash, status: "current", message: "Already current." });
          continue;
        }
        let proposalId: string | null = null;
        if (createProposals) {
          const proposal = this.createProposal({
            skillId: skill.id,
            title: `Update ${skill.name} from source`,
            reason: `Remote package hash changed from ${currentHash.slice(0, 12)} to ${remoteHash.slice(0, 12)}.`,
            source: "tool",
            operation: "update",
            files,
          });
          proposalId = proposal.id;
          proposalsCreated.push(proposal);
        }
        checked.push({ skillId: skill.id, name: skill.name, originUrl: skill.originUrl, currentHash, remoteHash, status: "update_available", message: proposalId ? "Update proposal created." : "Update available.", proposalId });
      } catch (error) {
        checked.push({ skillId: skill.id, name: skill.name, originUrl: skill.originUrl, currentHash: skillPackageHash(skill), remoteHash: null, status: "fetch_failed", message: error instanceof Error ? error.message : "Remote fetch failed." });
      }
    }
    return { checked, proposalsCreated };
  }
  adaptImport(request: SkillImportAdapterRequest): SkillImportAdapterResult {
    return adaptSkillLayout(request.layout, request.files);
  }
  runEvals(request: SkillEvalRunRequest): SkillEvalRunRecord {
    const skill = this.repository.get(request.skillId);
    if (!skill) throw new Error("Skill not found.");
    const startedAt = new Date().toISOString();
    const outputById = new Map((request.outputs ?? []).map((item) => [item.id, item.output]));
    const parsedEvals = parseSkillEvals(skill);
    const results = parsedEvals.map((evalCase) => gradeSkillEvalCase(evalCase, outputById.get(evalCase.id) ?? evalCase.staticOutput ?? undefined));
    const total = results.length;
    const passed = results.filter((item) => item.status === "passed").length;
    const failed = results.filter((item) => item.status === "failed").length;
    const warnings = results.filter((item) => item.status === "warning").length;
    const score = total ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / total) : 0;
    const requestedBaseline = request.baselineRunId ? this.repository.getEvalRun(request.baselineRunId) : null;
    if (requestedBaseline && requestedBaseline.skillId !== skill.id) throw new Error("Baseline eval run belongs to a different skill.");
    const baseline = requestedBaseline ?? this.repository.listEvalRuns(skill.id, 1)[0] ?? null;
    const record: SkillEvalRunRecord = {
      id: `eval-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      skillId: skill.id,
      skillName: skill.name,
      packageHash: skillPackageHash(skill),
      startedAt,
      finishedAt: new Date().toISOString(),
      status: failed > 0 ? "failed" : warnings > 0 ? "warning" : "passed",
      score,
      total,
      passed,
      failed,
      warnings,
      baselineRunId: baseline?.id ?? null,
      baselineScore: baseline?.score ?? null,
      deltaScore: baseline ? score - baseline.score : null,
      results,
    };
    return this.repository.saveEvalRun(record);
  }
  listEvalRuns(skillId: string): SkillEvalRunRecord[] {
    return this.repository.listEvalRuns(skillId);
  }
  markUsed(ids: string[]): void {
    this.repository.markUsed(ids);
  }
  recordScriptRun(run: SkillScriptRunHistory): void {
    this.repository.recordScriptRun(run);
    this.repository.markUsed([run.skillId]);
  }
  listScriptRuns(skillId: string, limit?: number): SkillScriptRunHistory[] {
    return this.repository.listScriptRuns(skillId, limit);
  }
  recordAuditLog(input: Omit<SkillAuditLogRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): SkillAuditLogRecord {
    return this.repository.recordAuditLog(input);
  }
  listAuditLogs(skillId?: string, limit?: number): SkillAuditLogRecord[] {
    return this.repository.listAuditLogs(skillId, limit);
  }
  exportAuditLog(skillId?: string, limit = 500): SkillAuditExport {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return buildSkillAuditExport(this.repository.listAuditLogs(skillId, boundedLimit), {
      ...(skillId ? { skillId } : {}),
      limit: boundedLimit,
    });
  }
  verifyAuditExport(payload: SkillAuditExport): SkillAuditExportVerification {
    return verifyAuditExportPayload(payload);
  }
  getResourceManifest(id: string): SkillResourceManifestItem[] {
    const skill = this.repository.get(id);
    if (!skill) throw new Error("Skill not found.");
    return buildSkillResourceManifest(skill);
  }
  readSkillFile(id: string, path: string): SkillFileRecord {
    const skill = this.repository.get(id);
    if (!skill) throw new Error("Skill not found.");
    const requestedPath = normalizeSkillFilePath(path);
    if (!requestedPath || isUnsafePath(requestedPath)) {
      throw new Error("Unsafe skill file path.");
    }
    const file = mergedFiles(skill).find(
      (candidate) => normalizeSkillFilePath(candidate.path) === requestedPath,
    );
    if (!file) throw new Error(`Skill file not found: ${requestedPath}`);
    this.repository.markUsed([skill.id]);
    return file;
  }
  preflight(id: string, workspaceDir?: string) {
    const skill = this.repository.get(id);
    if (!skill) throw new Error("Skill not found.");
    return runSkillPreflight(
      skill.dependencyMetadata,
      this.credentialEnv(id, skill.dependencyMetadata.requiredEnv),
      workspaceDir,
    );
  }
  enabledContext(): string {
    return this.repository.enabledInstructions();
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { SkillAuditLogRecord, SkillEvalRunRecord, SkillFileDiff, SkillFileRecord, SkillProposalRecord, SkillRecord, SkillRollbackSnapshot, SkillScriptRunHistory, SkillSource, SkillUpdateRequest } from "@shared/types";
import { extractSkillDependencyMetadata } from "@skills-system/skillMetadata";
import { normalizeSkillFileRecord, skillFileByteLength, skillFileToBuffer } from "@skills-system/skillFileData";
import { criticalSkillFinding, scanSkillFiles, trustLevelForSkill } from "@skills-system/skillSecurity";
import { hashSkillFiles } from "@skills-system/skillHash";
import type { LocalDatabase, SqlRow } from "./localDatabase";
import { mapSkill, mapSkillAuditLog, mapSkillEvalRun, mapSkillScriptRun } from "./rowMappers";
import {
  buildSkillMarkdown,
  rewriteSkillMarkdownIdentity,
  syncSkillMarkdownFile,
  validateSkillFiles
} from "@skills-system/skillValidation";

const emptyDependencyMetadata = () => ({
  requiredBins: [],
  requiredEnv: [],
  requiredFiles: [],
  packages: [],
  platforms: [],
  permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null }
});


const parseJsonArray = (value: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseSkillFilesJson = (value: string): SkillFileRecord[] =>
  parseJsonArray(value).flatMap((item): SkillFileRecord[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string") return [];
    return [normalizeSkillFileRecord({
      path: record.path,
      content: record.content,
      ...(record.encoding === "base64" ? { encoding: "base64" as const } : {})
    })];
  });

const parseSkillFileDiffJson = (value: string): SkillFileDiff[] =>
  parseJsonArray(value).flatMap((item): SkillFileDiff[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const status = record.status;
    if (status !== "added" && status !== "changed" && status !== "deleted" && status !== "unchanged") return [];
    if (typeof record.path !== "string") return [];
    return [{
      path: record.path,
      status,
      beforeSize: typeof record.beforeSize === "number" ? record.beforeSize : 0,
      afterSize: typeof record.afterSize === "number" ? record.afterSize : 0,
      beforeHash: typeof record.beforeHash === "string" ? record.beforeHash : null,
      afterHash: typeof record.afterHash === "string" ? record.afterHash : null
    }];
  });

const parseReviewJson = (value: string): SkillProposalRecord["review"] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid review");
    const record = parsed as SkillProposalRecord["review"];
    return {
      passed: record.passed === true,
      score: typeof record.score === "number" ? record.score : 0,
      summary: typeof record.summary === "string" ? record.summary : "No review summary.",
      findings: Array.isArray(record.findings) ? record.findings : []
    };
  } catch {
    return { passed: false, score: 0, summary: "Review data could not be read.", findings: [] };
  }
};

const mapProposal = (row: SqlRow): SkillProposalRecord => ({
  id: String(row.id ?? ""),
  createdAt: String(row.created_at ?? ""),
  updatedAt: String(row.updated_at ?? ""),
  skillId: String(row.skill_id ?? ""),
  skillName: String(row.skill_name ?? ""),
  title: String(row.title ?? ""),
  reason: String(row.reason ?? ""),
  source: String(row.source ?? "tool") === "agent" ? "agent" : String(row.source ?? "tool") === "user" ? "user" : "tool",
  status: ["pending", "applied", "rejected", "quarantined"].includes(String(row.status ?? "")) ? String(row.status) as SkillProposalRecord["status"] : "pending",
  operation: ["create", "update", "delete"].includes(String(row.operation ?? "")) ? String(row.operation) as SkillProposalRecord["operation"] : "update",
  proposedFiles: parseSkillFilesJson(String(row.proposed_files_json ?? "[]")),
  basePackageHash: row.base_package_hash === null ? null : String(row.base_package_hash ?? "") || null,
  targetPackageHash: String(row.target_package_hash ?? ""),
  diff: parseSkillFileDiffJson(String(row.diff_json ?? "[]")),
  scanFindings: JSON.parse(String(row.scan_findings_json ?? "[]")) as SkillProposalRecord["scanFindings"],
  review: parseReviewJson(String(row.review_json ?? "{}")),
  quarantineReason: row.quarantine_reason === null ? null : String(row.quarantine_reason ?? "") || null
});

const mapSnapshot = (row: SqlRow): SkillRollbackSnapshot => ({
  id: String(row.id ?? ""),
  skillId: String(row.skill_id ?? ""),
  skillName: String(row.skill_name ?? ""),
  createdAt: String(row.created_at ?? ""),
  reason: String(row.reason ?? ""),
  packageHash: String(row.package_hash ?? ""),
  files: parseSkillFilesJson(String(row.files_json ?? "[]"))
});

const hashText = (file: SkillFileRecord): string =>
  createHash("sha256").update(skillFileToBuffer(file)).digest("hex");
const STALE_AFTER_DAYS = 30;

const staleReasonForSkill = (skill: SkillRecord, now = Date.now()): string | null => {
  if (skill.source === "built-in" || skill.shadowedBy || skill.pinned || skill.lifecycleState === "archived") return null;
  const activity = Date.parse(skill.lastUsedAt ?? skill.updatedAt ?? skill.installedAt);
  if (!Number.isFinite(activity)) return null;
  const days = Math.floor((now - activity) / 86_400_000);
  if (days < STALE_AFTER_DAYS) return null;
  if ((skill.useCount ?? 0) === 0) return `Never used for ${days} days.`;
  return `Unused for ${days} days.`;
};

const withLifecycle = (skill: SkillRecord): SkillRecord => {
  const archived = skill.lifecycleState === "archived";
  const staleReason = staleReasonForSkill(skill);
  return {
    ...skill,
    lifecycleState: archived ? "archived" : staleReason ? "stale" : "active",
    staleReason,
  };
};

export const diffSkillFiles = (before: SkillFileRecord[], after: SkillFileRecord[]): SkillFileDiff[] => {
  const beforeMap = new Map(before.map((file) => [file.path, file]));
  const afterMap = new Map(after.map((file) => [file.path, file]));
  const paths = Array.from(new Set([...beforeMap.keys(), ...afterMap.keys()])).sort();
  return paths.map((path) => {
    const oldFile = beforeMap.get(path);
    const newFile = afterMap.get(path);
    const beforeHash = oldFile ? hashText(oldFile) : null;
    const afterHash = newFile ? hashText(newFile) : null;
    const status = !oldFile ? "added" : !newFile ? "deleted" : beforeHash === afterHash ? "unchanged" : "changed";
    return {
      path,
      status,
      beforeSize: oldFile ? skillFileByteLength(oldFile) : 0,
      afterSize: newFile ? skillFileByteLength(newFile) : 0,
      beforeHash,
      afterHash
    };
  });
};

const normalizeFiles = (files: SkillFileRecord[] | undefined): SkillFileRecord[] =>
  (files ?? [])
    .map((file) => ({
      path: file.path.trim().replace(/\\/g, "/"),
      content: file.content,
      ...(file.encoding === "base64" ? { encoding: "base64" as const } : {})
    }))
    .filter((file) => file.path.length > 0);

const packageSize = (files: SkillFileRecord[]): number =>
  files.reduce((total, file) => total + file.path.length + skillFileByteLength(file), 0);

const normalizeVersion = (version: string | null | undefined): string | null => {
  const trimmed = typeof version === "string" ? version.trim() : "";
  return trimmed ? trimmed : null;
};

const uniqueSkillId = (baseId: string, existingIds: Set<string>): string => {
  let candidate = `${baseId}-copy`;
  let index = 2;

  while (existingIds.has(candidate)) {
    candidate = `${baseId}-copy-${index}`;
    index += 1;
  }

  return candidate;
};

const hasRemoteProvenance = (skill: SkillRecord): boolean =>
  Boolean(skill.originUrl || skill.sourceArchiveUrl || skill.registryUrl);

const deriveTrustLevel = (skill: SkillRecord, scanFindings: ReturnType<typeof scanSkillFiles>): SkillRecord["trustLevel"] => {
  const baseline = trustLevelForSkill(skill.source, scanFindings);
  if (baseline === "built-in" || baseline === "quarantined") return baseline;
  if (skill.verificationStatus === "verified") return "verified";
  if (skill.verificationStatus === "failed") return "untrusted";
  if (hasRemoteProvenance(skill) && !skill.expectedPackageHash && !skill.signature) return "untrusted";
  return baseline;
};

const enrichSkillRecord = (skill: SkillRecord): SkillRecord => {
  const scanFindings = scanSkillFiles(skill.files);
  const dependencyMetadata = extractSkillDependencyMetadata(skill.files);
  const trustLevel = deriveTrustLevel(skill, scanFindings);
  const critical = criticalSkillFinding(scanFindings);

  return {
    ...skill,
    trustLevel,
    quarantineReason: critical?.message ?? (trustLevel === "untrusted" ? "Skill source or verification status is untrusted." : null),
    scanFindings,
    dependencyMetadata,
    packageHash: hashSkillFiles(skill.files)
  };
};

const normalizeUpdate = (
  skill: SkillUpdateRequest,
  existing: SkillRecord | null
): SkillRecord => {
  const id = skill.id.trim();
  const name = skill.name.trim();
  const description = skill.description.trim();
  const instructions = skill.instructions.trim();
  const skillMarkdown = buildSkillMarkdown(name, description, instructions);
  const baseFiles = normalizeFiles(skill.files ?? existing?.files);
  const files = syncSkillMarkdownFile(baseFiles, skillMarkdown);
  const source = existing?.source ?? "local";
  const enabled = source === "built-in" ? true : skill.enabled;
  const autoRouting =
    source === "built-in" ? true : (skill.autoRouting ?? existing?.autoRouting ?? skill.enabled);
  const now = new Date().toISOString();

  return enrichSkillRecord({
    id,
    name,
    description,
    instructions,
    enabled,
    autoRouting,
    source,
    trustLevel: source === "built-in" ? "built-in" : "local",
    quarantineReason: null,
    scanFindings: [],
    dependencyMetadata: emptyDependencyMetadata(),
    files,
    version: normalizeVersion(skill.version ?? existing?.version ?? null),
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    packageSize: packageSize(files),
    packageHash: hashSkillFiles(files),
    rootPath: existing?.rootPath ?? null,
    sourcePath: existing?.sourcePath ?? null,
    sourceRank: existing?.sourceRank ?? 100,
    pluginId: existing?.pluginId ?? null,
    shadowedBy: existing?.shadowedBy ?? null,
    shadowReason: existing?.shadowReason ?? null,
    writable: existing?.writable,
    lastUsedAt: existing?.lastUsedAt ?? null,
    useCount: existing?.useCount ?? 0,
    lifecycleState: existing?.lifecycleState ?? "active",
    pinned: existing?.pinned ?? false,
    archivedAt: existing?.archivedAt ?? null,
    originUrl: existing?.originUrl ?? null,
    sourceArchiveUrl: existing?.sourceArchiveUrl ?? null,
    sourceSubpath: existing?.sourceSubpath ?? null,
    registryUrl: existing?.registryUrl ?? null,
    publisher: existing?.publisher ?? null,
    expectedPackageHash: existing?.expectedPackageHash ?? null,
    signature: existing?.signature ?? null,
    publicKey: existing?.publicKey ?? null,
    verifiedAt: existing?.verifiedAt ?? null,
    verificationStatus: existing?.verificationStatus ?? "unverified"
  });
};

const assertEditableSkill = (skill: SkillRecord | null): void => {
  if (skill?.source === "built-in" || skill?.writable === false || skill?.shadowedBy) {
    throw new Error("This skill is read-only, built-in, or shadowed and cannot be edited or uninstalled.");
  }
};

const assertMutableSkillState = (skill: SkillRecord | null): void => {
  if (skill?.source === "built-in" || skill?.shadowedBy) {
    throw new Error("This skill is built-in or shadowed and cannot change routing or lifecycle state.");
  }
};

const validateRecord = (skill: SkillRecord): void => {
  if (!skill.id) throw new Error("Skill ID is required.");
  if (!skill.name) throw new Error("Skill name is required.");
  if (!skill.description) throw new Error("Skill description is required.");
  if (!skill.instructions) throw new Error("Skill instructions are required.");

  const validation = validateSkillFiles(skill.files);
  if (!validation.valid) {
    throw new Error(validation.message);
  }
};

const unsafeSkill = (skill: SkillRecord): boolean =>
  skill.trustLevel === "quarantined" || skill.trustLevel === "untrusted";

const disabledByTrust = (skill: SkillRecord): SkillRecord =>
  unsafeSkill(skill) ? { ...skill, enabled: false, autoRouting: false } : skill;

const scanFindingsForAudit = (skill: SkillRecord) =>
  skill.scanFindings.map((finding) => ({
    severity: finding.severity,
    ruleId: finding.ruleId,
    message: finding.message,
    ...(finding.path ? { path: finding.path } : {}),
    ...(typeof finding.line === "number" ? { line: finding.line } : {}),
    ...(finding.excerpt ? { excerpt: finding.excerpt } : {}),
  }));


export class SkillRepository {
  constructor(private readonly database: LocalDatabase) {}

  seedBuiltIn(skill: SkillRecord): void {
    const validation = validateSkillFiles(skill.files);
    if (!validation.valid) {
      throw new Error(`Invalid built-in skill '${skill.id}': ${validation.message}`);
    }

    const existing = this.get(skill.id);
    const now = new Date().toISOString();
    this.upsert({
      ...skill,
      enabled: true,
      autoRouting: true,
      source: "built-in",
      trustLevel: "built-in",
      quarantineReason: null,
      scanFindings: [],
      dependencyMetadata: emptyDependencyMetadata(),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      packageSize: packageSize(skill.files),
      packageHash: hashSkillFiles(skill.files),
      lastUsedAt: existing?.lastUsedAt ?? null,
      useCount: existing?.useCount ?? 0
    });
  }

  removeBuiltInsExcept(ids: string[]): void {
    if (ids.length === 0) {
      this.database.execute("DELETE FROM skills WHERE source = 'built-in'");
      return;
    }

    const placeholders = ids.map(() => "?").join(", ");
    this.database.execute(
      `DELETE FROM skills WHERE source = 'built-in' AND id NOT IN (${placeholders})`,
      ids
    );
  }

  upsert(skill: SkillRecord): SkillRecord {
    const enriched = enrichSkillRecord(skill);
    this.database.execute(
      `INSERT INTO skills (id, name, description, instructions, enabled, auto_routing, source, trust_level, quarantine_reason, scan_findings_json, dependency_metadata_json, files_json, version, installed_at, updated_at, package_size, package_hash, root_path, source_path, source_rank, plugin_id, shadowed_by, shadow_reason, writable, last_used_at, use_count, lifecycle_state, pinned, archived_at, origin_url, source_archive_url, source_subpath, registry_url, publisher, expected_package_hash, signature, public_key, verified_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       instructions = excluded.instructions,
       enabled = excluded.enabled,
       auto_routing = excluded.auto_routing,
       source = excluded.source,
       trust_level = excluded.trust_level,
       quarantine_reason = excluded.quarantine_reason,
       scan_findings_json = excluded.scan_findings_json,
       dependency_metadata_json = excluded.dependency_metadata_json,
       files_json = excluded.files_json,
       version = excluded.version,
       installed_at = excluded.installed_at,
       updated_at = excluded.updated_at,
       package_size = excluded.package_size,
       package_hash = excluded.package_hash,
       root_path = excluded.root_path,
       source_path = excluded.source_path,
       source_rank = excluded.source_rank,
       plugin_id = excluded.plugin_id,
       shadowed_by = excluded.shadowed_by,
       shadow_reason = excluded.shadow_reason,
       writable = excluded.writable,
       last_used_at = excluded.last_used_at,
       use_count = excluded.use_count,
       lifecycle_state = excluded.lifecycle_state,
       pinned = excluded.pinned,
       archived_at = excluded.archived_at,
       origin_url = excluded.origin_url,
       source_archive_url = excluded.source_archive_url,
       source_subpath = excluded.source_subpath,
       registry_url = excluded.registry_url,
       publisher = excluded.publisher,
       expected_package_hash = excluded.expected_package_hash,
       signature = excluded.signature,
       public_key = excluded.public_key,
       verified_at = excluded.verified_at,
       verification_status = excluded.verification_status`,
      [
        enriched.id,
        enriched.name,
        enriched.description,
        enriched.instructions,
        enriched.enabled ? 1 : 0,
        enriched.autoRouting ? 1 : 0,
        enriched.source,
        enriched.trustLevel,
        enriched.quarantineReason,
        JSON.stringify(enriched.scanFindings),
        JSON.stringify(enriched.dependencyMetadata),
        JSON.stringify(enriched.files),
        enriched.version,
        enriched.installedAt,
        enriched.updatedAt,
        enriched.packageSize,
        enriched.packageHash ?? hashSkillFiles(enriched.files),
        enriched.rootPath ?? null,
        enriched.sourcePath ?? null,
        enriched.sourceRank ?? 100,
        enriched.pluginId ?? null,
        enriched.shadowedBy ?? null,
        enriched.shadowReason ?? null,
        enriched.writable === false ? 0 : 1,
        enriched.lastUsedAt ?? null,
        enriched.useCount ?? 0,
        enriched.lifecycleState ?? "active",
        enriched.pinned ? 1 : 0,
        enriched.archivedAt ?? null,
        enriched.originUrl ?? null,
        enriched.sourceArchiveUrl ?? null,
        enriched.sourceSubpath ?? null,
        enriched.registryUrl ?? null,
        enriched.publisher ?? null,
        enriched.expectedPackageHash ?? null,
        enriched.signature ?? null,
        enriched.publicKey ?? null,
        enriched.verifiedAt ?? null,
        enriched.verificationStatus ?? "unverified"
      ]
    );

    return withLifecycle(enriched);
  }

  update(skill: SkillUpdateRequest): SkillRecord {
    const existing = this.get(skill.id);
    if (!existing) throw new Error("Skill not found.");
    assertMutableSkillState(existing);
    if (existing.writable === false) {
      const saved = this.upsert({
        ...existing,
        enabled: skill.enabled,
        autoRouting: skill.enabled ? (skill.autoRouting ?? existing.autoRouting) : false,
        updatedAt: new Date().toISOString(),
      });
      this.recordAuditLog({
        action: "skill.update_state",
        skillId: saved.id,
        skillName: saved.name,
        actor: "user",
        status: unsafeSkill(saved) ? "warning" : "ok",
        packageHash: saved.packageHash ?? null,
        detail: {
          previousEnabled: existing.enabled,
          nextEnabled: saved.enabled,
          previousAutoRouting: existing.autoRouting,
          nextAutoRouting: saved.autoRouting,
          trustLevel: saved.trustLevel,
          quarantineReason: saved.quarantineReason,
          scanFindings: scanFindingsForAudit(saved),
        },
      });
      return saved;
    }
    assertEditableSkill(existing);
    const normalized = normalizeUpdate(skill, existing);
    validateRecord(normalized);
    const saved = this.upsert(normalized);
    this.recordAuditLog({
      action: "skill.update",
      skillId: saved.id,
      skillName: saved.name,
      actor: "user",
      status: unsafeSkill(saved) ? "warning" : "ok",
      packageHash: saved.packageHash ?? null,
      detail: {
        previousEnabled: existing.enabled,
        nextEnabled: saved.enabled,
        previousAutoRouting: existing.autoRouting,
        nextAutoRouting: saved.autoRouting,
        trustLevel: saved.trustLevel,
        quarantineReason: saved.quarantineReason,
        scanFindings: scanFindingsForAudit(saved),
      },
    });
    return saved;
  }

  installLocal(skill: SkillRecord, mode: "replace" | "copy" = "replace"): SkillRecord {
    const existing = this.get(skill.id);
    assertEditableSkill(existing);

    const now = new Date().toISOString();
    let id = skill.id.trim();
    let name = skill.name.trim();
    const description = skill.description.trim();
    const instructions = skill.instructions.trim();

    if (existing && mode === "copy") {
      id = uniqueSkillId(id, new Set(this.list().map((item) => item.id)));
      name = id;
    }

    const normalizedFiles = normalizeFiles(skill.files);
    let files = normalizedFiles.some((file) => file.path === "SKILL.md")
      ? normalizedFiles
      : syncSkillMarkdownFile(normalizedFiles, buildSkillMarkdown(name, description, instructions));

    if (existing && mode === "copy") {
      files = files.map((file) =>
        file.path === "SKILL.md"
          ? { ...file, content: rewriteSkillMarkdownIdentity(file.content, name, description) }
          : file
      );
    }

    const normalized: SkillRecord = {
      ...skill,
      id,
      name,
      description,
      instructions,
      enabled: skill.enabled,
      autoRouting: skill.autoRouting,
      source: skill.source === "local" ? "local" : skill.source === "user" ? "user" : "user",
      trustLevel: "local",
      quarantineReason: null,
      scanFindings: [],
      dependencyMetadata: emptyDependencyMetadata(),
      files,
      version: normalizeVersion(skill.version),
      installedAt: mode === "replace" && existing ? existing.installedAt : now,
      updatedAt: now,
      packageSize: packageSize(files),
      packageHash: hashSkillFiles(files),
      rootPath: skill.rootPath ?? existing?.rootPath ?? null,
      sourcePath: skill.sourcePath ?? existing?.sourcePath ?? null,
      sourceRank: skill.sourceRank ?? existing?.sourceRank ?? 30,
      pluginId: skill.pluginId ?? existing?.pluginId ?? null,
      shadowedBy: null,
      shadowReason: null,
      writable: true,
      lastUsedAt: existing?.lastUsedAt ?? null,
      useCount: existing?.useCount ?? 0,
      lifecycleState: existing?.lifecycleState ?? "active",
      pinned: existing?.pinned ?? false,
      archivedAt: existing?.archivedAt ?? null,
      staleReason: existing?.staleReason ?? null,
      originUrl: skill.originUrl ?? existing?.originUrl ?? null,
      sourceArchiveUrl: skill.sourceArchiveUrl ?? existing?.sourceArchiveUrl ?? null,
      sourceSubpath: skill.sourceSubpath ?? existing?.sourceSubpath ?? null,
      registryUrl: skill.registryUrl ?? existing?.registryUrl ?? null,
      publisher: skill.publisher ?? existing?.publisher ?? null,
      expectedPackageHash: skill.expectedPackageHash ?? existing?.expectedPackageHash ?? null,
      signature: skill.signature ?? existing?.signature ?? null,
      publicKey: skill.publicKey ?? existing?.publicKey ?? null,
      verifiedAt: existing?.verifiedAt ?? null,
      verificationStatus: existing?.verificationStatus ?? "unverified"
    };

    validateRecord(normalized);
    const saved = this.upsert(disabledByTrust(enrichSkillRecord(normalized)));
    this.recordAuditLog({
      action: existing ? (mode === "copy" ? "skill.install_copy" : "skill.replace") : "skill.install",
      skillId: saved.id,
      skillName: saved.name,
      actor: "user",
      status: unsafeSkill(saved) ? "warning" : "ok",
      packageHash: saved.packageHash ?? null,
      detail: {
        mode,
        source: saved.source,
        trustLevel: saved.trustLevel,
        quarantineReason: saved.quarantineReason,
        scanFindings: scanFindingsForAudit(saved),
      },
    });
    return saved;
  }


  replaceRootManagedSkills(skills: SkillRecord[]): void {
    const managedSources: SkillSource[] = ["workspace", "repo", "user", "plugin", "global"];
    const placeholders = managedSources.map(() => "?").join(", ");
    this.database.execute(
      `DELETE FROM skills WHERE source IN (${placeholders}) OR shadowed_by IS NOT NULL`,
      managedSources
    );
    for (const skill of skills) {
      this.upsert(skill);
    }
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    assertEditableSkill(existing);
    if (existing.pinned) throw new Error("This skill is pinned. Unpin it before uninstalling it.");
    this.recordAuditLog({
      action: "skill.delete",
      skillId: existing.id,
      skillName: existing.name,
      actor: "user",
      status: "ok",
      packageHash: existing.packageHash ?? null,
      detail: { source: existing.source, trustLevel: existing.trustLevel },
    });
    this.database.execute("DELETE FROM skills WHERE id = ?", [id]);
  }

  get(id: string): SkillRecord | null {
    const row = this.database.select(
      "SELECT * FROM skills WHERE id = ? LIMIT 1",
      [id],
      mapSkill
    )[0] ?? null;
    return row ? withLifecycle(row) : null;
  }

  list(): SkillRecord[] {
    return this.database.select("SELECT * FROM skills ORDER BY source ASC, name ASC", [], mapSkill).map(withLifecycle);
  }


  markUsed(ids: string[]): void {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (!uniqueIds.length) return;
    const now = new Date().toISOString();
    for (const id of uniqueIds) {
      this.database.execute(
        "UPDATE skills SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
        [now, id]
      );
    }
  }

  recordScriptRun(run: SkillScriptRunHistory): void {
    this.database.execute(
      `INSERT INTO skill_script_runs (id, skill_id, skill_name, script_path, args_json, cwd, command, status, exit_code, signal, timed_out, stdout, stderr, stdout_truncated, stderr_truncated, duration_ms, started_at, finished_at, actor, package_hash, script_hash, env_keys_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.skillId,
        run.skillName,
        run.scriptPath,
        JSON.stringify(run.args),
        run.cwd,
        run.command,
        run.status,
        run.exitCode,
        run.signal,
        run.timedOut ? 1 : 0,
        run.stdout,
        run.stderr,
        run.stdoutTruncated ? 1 : 0,
        run.stderrTruncated ? 1 : 0,
        run.durationMs,
        run.startedAt,
        run.finishedAt,
        run.actor,
        run.packageHash,
        run.scriptHash,
        JSON.stringify(run.envKeys)
      ]
    );
    this.recordAuditLog({
      action: "skill.script_run",
      skillId: run.skillId,
      skillName: run.skillName,
      actor: run.actor,
      status: run.status === "ok" ? "ok" : run.timedOut ? "blocked" : "failed",
      packageHash: run.packageHash,
      detail: {
        scriptPath: run.scriptPath,
        args: run.args,
        cwd: run.cwd,
        command: run.command,
        exitCode: run.exitCode,
        signal: run.signal,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        stdoutTruncated: run.stdoutTruncated,
        stderrTruncated: run.stderrTruncated,
        envKeys: run.envKeys,
        scriptHash: run.scriptHash,
      },
    });
  }


  saveProposal(proposal: SkillProposalRecord): SkillProposalRecord {
    this.database.execute(
      `INSERT INTO skill_proposals (id, created_at, updated_at, skill_id, skill_name, title, reason, source, status, operation, proposed_files_json, base_package_hash, target_package_hash, diff_json, scan_findings_json, review_json, quarantine_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       status = excluded.status,
       proposed_files_json = excluded.proposed_files_json,
       target_package_hash = excluded.target_package_hash,
       diff_json = excluded.diff_json,
       scan_findings_json = excluded.scan_findings_json,
       review_json = excluded.review_json,
       quarantine_reason = excluded.quarantine_reason`,
      [
        proposal.id, proposal.createdAt, proposal.updatedAt, proposal.skillId, proposal.skillName,
        proposal.title, proposal.reason, proposal.source, proposal.status, proposal.operation,
        JSON.stringify(proposal.proposedFiles), proposal.basePackageHash, proposal.targetPackageHash,
        JSON.stringify(proposal.diff), JSON.stringify(proposal.scanFindings), JSON.stringify(proposal.review),
        proposal.quarantineReason
      ]
    );
    return proposal;
  }

  getProposal(id: string): SkillProposalRecord | null {
    return this.database.select("SELECT * FROM skill_proposals WHERE id = ? LIMIT 1", [id], mapProposal)[0] ?? null;
  }

  listProposals(skillId?: string): SkillProposalRecord[] {
    if (skillId) {
      return this.database.select("SELECT * FROM skill_proposals WHERE skill_id = ? ORDER BY updated_at DESC", [skillId], mapProposal);
    }
    return this.database.select("SELECT * FROM skill_proposals ORDER BY updated_at DESC", [], mapProposal);
  }

  updateProposalStatus(id: string, status: SkillProposalRecord["status"]): SkillProposalRecord | null {
    const existing = this.getProposal(id);
    if (!existing) return null;
    const updated = { ...existing, status, updatedAt: new Date().toISOString() };
    return this.saveProposal(updated);
  }

  saveSnapshot(snapshot: Omit<SkillRollbackSnapshot, "id" | "createdAt"> & { id?: string; createdAt?: string }): SkillRollbackSnapshot {
    const record: SkillRollbackSnapshot = {
      id: snapshot.id ?? randomUUID(),
      createdAt: snapshot.createdAt ?? new Date().toISOString(),
      skillId: snapshot.skillId,
      skillName: snapshot.skillName,
      reason: snapshot.reason,
      packageHash: snapshot.packageHash,
      files: snapshot.files
    };
    this.database.execute(
      `INSERT INTO skill_rollback_snapshots (id, skill_id, skill_name, created_at, reason, package_hash, files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.skillId, record.skillName, record.createdAt, record.reason, record.packageHash, JSON.stringify(record.files)]
    );
    return record;
  }

  getSnapshot(id: string): SkillRollbackSnapshot | null {
    return this.database.select("SELECT * FROM skill_rollback_snapshots WHERE id = ? LIMIT 1", [id], mapSnapshot)[0] ?? null;
  }

  listSnapshots(skillId: string, limit = 20): SkillRollbackSnapshot[] {
    return this.database.select("SELECT * FROM skill_rollback_snapshots WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?", [skillId, limit], mapSnapshot);
  }

  listScriptRuns(skillId: string, limit = 20): SkillScriptRunHistory[] {
    return this.database.select(
      "SELECT * FROM skill_script_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?",
      [skillId, Math.max(1, Math.min(100, Math.trunc(limit)))],
      mapSkillScriptRun
    );
  }



  updateLifecycle(id: string, action: "pin" | "unpin" | "archive" | "restore"): SkillRecord {
    const existing = this.get(id);
    if (!existing) throw new Error("Skill not found.");
    assertMutableSkillState(existing);
    const now = new Date().toISOString();
    const next = { ...existing };
    if (action === "pin") next.pinned = true;
    if (action === "unpin") next.pinned = false;
    if (action === "archive") {
      if (next.pinned) throw new Error("Pinned skills cannot be archived until unpinned.");
      next.lifecycleState = "archived";
      next.archivedAt = now;
    }
    if (action === "restore") {
      next.lifecycleState = "active";
      next.archivedAt = null;
    }
    const saved = this.upsert(next);
    this.recordAuditLog({
      action: `skill.${action}`,
      skillId: saved.id,
      skillName: saved.name,
      actor: "user",
      status: "ok",
      packageHash: saved.packageHash ?? null,
      detail: { lifecycleState: saved.lifecycleState ?? "active", pinned: saved.pinned === true },
    });
    return saved;
  }

  saveEvalRun(run: SkillEvalRunRecord): SkillEvalRunRecord {
    this.database.execute(
      `INSERT INTO skill_eval_runs (id, skill_id, skill_name, package_hash, started_at, finished_at, status, score, total, passed, failed, warnings, baseline_run_id, baseline_score, delta_score, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id, run.skillId, run.skillName, run.packageHash, run.startedAt, run.finishedAt, run.status,
        run.score, run.total, run.passed, run.failed, run.warnings, run.baselineRunId, run.baselineScore,
        run.deltaScore, JSON.stringify(run.results)
      ]
    );
    return run;
  }

  getEvalRun(id: string): SkillEvalRunRecord | null {
    return this.database.select("SELECT * FROM skill_eval_runs WHERE id = ? LIMIT 1", [id], mapSkillEvalRun)[0] ?? null;
  }

  listEvalRuns(skillId: string, limit = 20): SkillEvalRunRecord[] {
    return this.database.select(
      "SELECT * FROM skill_eval_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?",
      [skillId, Math.max(1, Math.min(100, Math.trunc(limit)))],
      mapSkillEvalRun
    );
  }

  recordAuditLog(input: Omit<SkillAuditLogRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): SkillAuditLogRecord {
    const previous = this.database.select(
      "SELECT * FROM skill_audit_log ORDER BY created_at DESC, id DESC LIMIT 1",
      [],
      mapSkillAuditLog,
    )[0] ?? null;
    const previousHash = previous && typeof previous.detail.auditHash === "string"
      ? previous.detail.auditHash
      : null;
    const baseDetail = input.detail;
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const auditHash = createHash("sha256").update(JSON.stringify({
      previousHash,
      id,
      createdAt,
      action: input.action,
      skillId: input.skillId,
      skillName: input.skillName,
      actor: input.actor,
      status: input.status,
      packageHash: input.packageHash,
      detail: baseDetail,
    })).digest("hex");
    const record: SkillAuditLogRecord = {
      id,
      createdAt,
      action: input.action,
      skillId: input.skillId,
      skillName: input.skillName,
      actor: input.actor,
      status: input.status,
      packageHash: input.packageHash,
      detail: { ...baseDetail, previousAuditHash: previousHash, auditHash },
    };
    this.database.execute(
      `INSERT INTO skill_audit_log (id, created_at, action, skill_id, skill_name, actor, status, package_hash, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.createdAt,
        record.action,
        record.skillId,
        record.skillName,
        record.actor,
        record.status,
        record.packageHash,
        JSON.stringify(record.detail),
      ],
    );
    return record;
  }

  listAuditLogs(skillId?: string, limit = 100): SkillAuditLogRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    if (skillId) {
      return this.database.select(
        "SELECT * FROM skill_audit_log WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?",
        [skillId, boundedLimit],
        mapSkillAuditLog,
      );
    }
    return this.database.select(
      "SELECT * FROM skill_audit_log ORDER BY created_at DESC LIMIT ?",
      [boundedLimit],
      mapSkillAuditLog,
    );
  }

  enabledInstructions(): string {
    const enabled = this.list().filter((skill) => skill.enabled && skill.autoRouting && !skill.shadowedBy && skill.lifecycleState !== "archived");
    if (!enabled.length) return "";
    return enabled.map((skill) => [
      `Skill: ${skill.name} (${skill.id})`,
      `Description: ${skill.description}`,
      "Full instructions are not bulk-injected. Use skill.view to read SKILL.md before applying this skill workflow.",
    ].join("\n")).join("\n\n");
  }
}

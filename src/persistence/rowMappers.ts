import type {
  ArtifactKind,
  ArtifactRecord,
  ChatMessage,
  MessageRole,
  MessageStatus,
  SkillDependencyMetadata,
  SkillFileRecord,
  SkillRecord,
  SkillEvalRunRecord,
  SkillScanFinding,
  SkillScriptRunHistory,
  SkillAuditLogRecord,
  WorkspaceActionLog
} from "@shared/types";
import { parseJsonRecord } from "@shared/json";
import { normalizeSkillFileRecord } from "@skills-system/skillFileData";
import type { SqlRow } from "./localDatabase";

const asText = (row: SqlRow, key: string): string => String(row[key] ?? "");

const parseSkillFiles = (value: string): SkillFileRecord[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SkillFileRecord[] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.content !== "string") {
        return [];
      }
      return [normalizeSkillFileRecord({
        path: record.path,
        content: record.content,
        ...(record.encoding === "base64" ? { encoding: "base64" as const } : {})
      })];
    });
  } catch {
    return [];
  }
};

const emptyDependencyMetadata = (): SkillDependencyMetadata => ({
  requiredBins: [],
  requiredEnv: [],
  requiredFiles: [],
  packages: [],
  platforms: [],
  permissions: { allowNetwork: false, allowedEnv: [], writeRoots: [".", ".super-agent/skill-runs"], maxRuntimeMs: null }
});

const parseSkillScanFindings = (value: string): SkillScanFinding[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SkillScanFinding[] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const severity = record.severity;
      if (severity !== "info" && severity !== "warn" && severity !== "critical") return [];
      if (typeof record.ruleId !== "string" || typeof record.message !== "string") return [];
      return [{
        severity,
        ruleId: record.ruleId,
        message: record.message,
        ...(typeof record.path === "string" ? { path: record.path } : {}),
        ...(typeof record.line === "number" ? { line: record.line } : {}),
        ...(typeof record.excerpt === "string" ? { excerpt: record.excerpt } : {})
      }];
    });
  } catch {
    return [];
  }
};

const parseSkillDependencyMetadata = (value: string): SkillDependencyMetadata => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return emptyDependencyMetadata();
    const record = parsed as Partial<SkillDependencyMetadata>;
    return {
      requiredBins: Array.isArray(record.requiredBins) ? record.requiredBins.filter((item): item is string => typeof item === "string") : [],
      requiredEnv: Array.isArray(record.requiredEnv) ? record.requiredEnv.filter((item): item is string => typeof item === "string") : [],
      requiredFiles: Array.isArray(record.requiredFiles) ? record.requiredFiles.filter((item): item is string => typeof item === "string") : [],
      packages: Array.isArray(record.packages)
        ? record.packages.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const packageRecord = item as unknown as Record<string, unknown>;
            if (typeof packageRecord.manager !== "string" || typeof packageRecord.name !== "string") return [];
            return [{
              manager: packageRecord.manager,
              name: packageRecord.name,
              ...(typeof packageRecord.version === "string" ? { version: packageRecord.version } : {})
            }];
          })
        : [],
      platforms: Array.isArray(record.platforms) ? record.platforms.filter((item): item is string => typeof item === "string") : [],
      permissions: {
        allowNetwork: typeof record.permissions?.allowNetwork === "boolean" ? record.permissions.allowNetwork : false,
        allowedEnv: Array.isArray(record.permissions?.allowedEnv) ? record.permissions.allowedEnv.filter((item): item is string => typeof item === "string") : [],
        writeRoots: Array.isArray(record.permissions?.writeRoots) ? record.permissions.writeRoots.filter((item): item is string => typeof item === "string") : [".", ".super-agent/skill-runs"],
        maxRuntimeMs: typeof record.permissions?.maxRuntimeMs === "number" ? record.permissions.maxRuntimeMs : null
      }
    };
  } catch {
    return emptyDependencyMetadata();
  }
};

export const mapMessage = (row: SqlRow): ChatMessage => ({
  id: asText(row, "id"),
  sessionId: asText(row, "session_id"),
  role: asText(row, "role") as MessageRole,
  content: asText(row, "content"),
  status: asText(row, "status") as MessageStatus,
  createdAt: asText(row, "created_at"),
  metadata: parseJsonRecord(asText(row, "metadata_json"))
});

export const mapArtifact = (row: SqlRow): ArtifactRecord => ({
  id: asText(row, "id"),
  title: asText(row, "title"),
  kind: asText(row, "kind") as ArtifactKind,
  path: asText(row, "path"),
  contentType: asText(row, "content_type"),
  createdAt: asText(row, "created_at"),
  sessionId: row.session_id === null ? null : asText(row, "session_id")
});

export const mapSkill = (row: SqlRow): SkillRecord => ({
  id: asText(row, "id"),
  name: asText(row, "name"),
  description: asText(row, "description"),
  instructions: asText(row, "instructions"),
  enabled: Number(row.enabled ?? 0) === 1,
  autoRouting: Number(row.auto_routing ?? row.enabled ?? 0) === 1,
  source: (["workspace", "repo", "user", "plugin", "global", "built-in", "local"].includes(asText(row, "source")) ? asText(row, "source") : "local") as SkillRecord["source"],
  trustLevel: (["built-in", "verified", "local", "uploaded", "community", "untrusted", "quarantined"].includes(asText(row, "trust_level")) ? asText(row, "trust_level") : asText(row, "source") === "built-in" ? "built-in" : "local") as SkillRecord["trustLevel"],
  quarantineReason: asText(row, "quarantine_reason") || null,
  scanFindings: parseSkillScanFindings(asText(row, "scan_findings_json")),
  dependencyMetadata: parseSkillDependencyMetadata(asText(row, "dependency_metadata_json")),
  files: parseSkillFiles(asText(row, "files_json")),
  version: asText(row, "version") || null,
  installedAt: asText(row, "installed_at") || new Date(0).toISOString(),
  updatedAt: asText(row, "updated_at") || new Date(0).toISOString(),
  packageSize: Number(row.package_size ?? 0),
  packageHash: asText(row, "package_hash"),
  rootPath: asText(row, "root_path") || null,
  sourcePath: asText(row, "source_path") || null,
  sourceRank: Number(row.source_rank ?? 100),
  pluginId: asText(row, "plugin_id") || null,
  shadowedBy: asText(row, "shadowed_by") || null,
  shadowReason: asText(row, "shadow_reason") || null,
  writable: Number(row.writable ?? 1) === 1,
  lastUsedAt: asText(row, "last_used_at") || null,
  useCount: Number(row.use_count ?? 0),
  lifecycleState: (["active", "stale", "archived"].includes(asText(row, "lifecycle_state")) ? asText(row, "lifecycle_state") : "active") as SkillRecord["lifecycleState"],
  pinned: Number(row.pinned ?? 0) === 1,
  archivedAt: asText(row, "archived_at") || null,
  staleReason: null,
  originUrl: asText(row, "origin_url") || null,
  sourceArchiveUrl: asText(row, "source_archive_url") || null,
  sourceSubpath: asText(row, "source_subpath") || null,
  registryUrl: asText(row, "registry_url") || null,
  publisher: asText(row, "publisher") || null,
  expectedPackageHash: asText(row, "expected_package_hash") || null,
  signature: asText(row, "signature") || null,
  publicKey: asText(row, "public_key") || null,
  verifiedAt: asText(row, "verified_at") || null,
  verificationStatus: (["unverified", "verified", "failed"].includes(asText(row, "verification_status")) ? asText(row, "verification_status") : "unverified") as SkillRecord["verificationStatus"]
});

export const mapWorkspaceLog = (row: SqlRow): WorkspaceActionLog => ({
  id: asText(row, "id"),
  action: asText(row, "action"),
  status: asText(row, "status") as WorkspaceActionLog["status"],
  detail: parseJsonRecord(asText(row, "detail_json")),
  createdAt: asText(row, "created_at")
});

export const mapSkillAuditLog = (row: SqlRow): SkillAuditLogRecord => ({
  id: asText(row, "id"),
  createdAt: asText(row, "created_at"),
  action: asText(row, "action"),
  skillId: asText(row, "skill_id") || null,
  skillName: asText(row, "skill_name") || null,
  actor: (["agent", "user", "system"].includes(asText(row, "actor")) ? asText(row, "actor") : "system") as SkillAuditLogRecord["actor"],
  status: (["ok", "failed", "blocked", "warning"].includes(asText(row, "status")) ? asText(row, "status") : "ok") as SkillAuditLogRecord["status"],
  packageHash: asText(row, "package_hash") || null,
  detail: parseJsonRecord(asText(row, "detail_json"))
});


const parseStringArray = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

export const mapSkillScriptRun = (row: SqlRow): SkillScriptRunHistory => ({
  id: asText(row, "id"),
  skillId: asText(row, "skill_id"),
  skillName: asText(row, "skill_name"),
  scriptPath: asText(row, "script_path"),
  args: parseStringArray(asText(row, "args_json")),
  cwd: asText(row, "cwd"),
  command: asText(row, "command"),
  status: asText(row, "status") as SkillScriptRunHistory["status"],
  exitCode: row.exit_code === null ? null : Number(row.exit_code ?? 0),
  signal: asText(row, "signal") || null,
  timedOut: Number(row.timed_out ?? 0) === 1,
  stdout: asText(row, "stdout"),
  stderr: asText(row, "stderr"),
  stdoutTruncated: Number(row.stdout_truncated ?? 0) === 1,
  stderrTruncated: Number(row.stderr_truncated ?? 0) === 1,
  durationMs: Number(row.duration_ms ?? 0),
  startedAt: asText(row, "started_at"),
  finishedAt: asText(row, "finished_at"),
  actor: asText(row, "actor") === "user" ? "user" : "agent",
  packageHash: asText(row, "package_hash"),
  scriptHash: asText(row, "script_hash"),
  envKeys: parseStringArray(asText(row, "env_keys_json"))
});


const parseEvalResults = (value: string): SkillEvalRunRecord["results"] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SkillEvalRunRecord["results"] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const status = record.status;
      if (status !== "passed" && status !== "failed" && status !== "warning") return [];
      return [{
        id: typeof record.id === "string" ? record.id : "",
        prompt: typeof record.prompt === "string" ? record.prompt : "",
        status,
        score: typeof record.score === "number" ? record.score : 0,
        findings: Array.isArray(record.findings) ? record.findings as SkillEvalRunRecord["results"][number]["findings"] : []
      }];
    });
  } catch {
    return [];
  }
};

export const mapSkillEvalRun = (row: SqlRow): SkillEvalRunRecord => ({
  id: asText(row, "id"),
  skillId: asText(row, "skill_id"),
  skillName: asText(row, "skill_name"),
  packageHash: asText(row, "package_hash"),
  startedAt: asText(row, "started_at"),
  finishedAt: asText(row, "finished_at"),
  status: (["passed", "failed", "warning"].includes(asText(row, "status")) ? asText(row, "status") : "failed") as SkillEvalRunRecord["status"],
  score: Number(row.score ?? 0),
  total: Number(row.total ?? 0),
  passed: Number(row.passed ?? 0),
  failed: Number(row.failed ?? 0),
  warnings: Number(row.warnings ?? 0),
  baselineRunId: asText(row, "baseline_run_id") || null,
  baselineScore: row.baseline_score === null ? null : Number(row.baseline_score ?? 0),
  deltaScore: row.delta_score === null ? null : Number(row.delta_score ?? 0),
  results: parseEvalResults(asText(row, "results_json"))
});

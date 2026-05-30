import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { JsonRecord } from "@shared/json";
import type { SkillFileDiff, SkillRecord } from "@shared/types";
import { diffSkillFiles } from "@persistence/skillRepository";
import { mergedFiles, skillPackageHash } from "./skillContext";
import { skillFileByteLength, skillFileText } from "./skillFileData";

export interface SkillAdminPolicy {
  uploadsEnabled: boolean;
  untrustedScriptsEnabled: boolean;
  requireVerifiedRegistry: boolean;
  allowedSkills: string[];
  blockedSkills: string[];
  agentAllowlists: Record<string, string[]>;
  allowNetworkByDefault: boolean;
  allowedPublishers: string[];
}

export interface SkillPolicyDecision {
  skillId: string;
  allowed: boolean;
  reasons: string[];
}

export interface SkillBundleRecord {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  missingSkillIds: string[];
  source: "metadata" | "policy" | "derived";
}

export interface SkillCompareResult {
  left: SkillCompareSide;
  right: SkillCompareSide;
  samePackageHash: boolean;
  fileDiff: SkillFileDiff[];
  metadataDiff: JsonRecord;
}

export interface SkillCompareSide {
  id: string;
  name: string;
  source: string;
  packageHash: string;
  fileCount: number;
  packageSize: number;
  updatedAt: string;
  version: string | null;
}

export interface SkillSetupPlan {
  skillId: string;
  skillName: string;
  dryRun: true;
  commands: Array<{ manager: string; command: string; packageName: string }>;
  requiredBins: string[];
  requiredEnv: string[];
  requiredFiles: string[];
  platformWarnings: string[];
  notes: string[];
}

export interface SkillCredentialReport {
  skillId: string;
  skillName: string;
  storagePath: string;
  encryptionAvailable: boolean;
  requiredEnv: Array<{ name: string; configured: boolean; source: "stored" | "missing"; secret: true }>;
  requiredFiles: Array<{ path: string; configuredPath: string | null; exists: boolean }>;
  instructions: string[];
}

export interface SkillMarketplaceReadiness {
  skillId: string;
  skillName: string;
  ready: boolean;
  blockers: string[];
  warnings: string[];
  manifest: JsonRecord;
}


const userConfigDir = (): string => resolve(homedir(), ".super-agent");

const policyPaths = (workspaceDir?: string): string[] => [
  join(userConfigDir(), "skill-policy.json"),
  ...(workspaceDir
    ? [
        join(workspaceDir, ".super-agent", "skill-policy.json"),
        join(workspaceDir, "super-agent.skill-policy.json"),
      ]
    : []),
];

const bundlePaths = (workspaceDir?: string): string[] => [
  join(userConfigDir(), "skill-bundles.json"),
  ...(workspaceDir ? [join(workspaceDir, ".super-agent", "skill-bundles.json")] : []),
];

const DEFAULT_POLICY: SkillAdminPolicy = {
  uploadsEnabled: true,
  untrustedScriptsEnabled: false,
  requireVerifiedRegistry: false,
  allowedSkills: [],
  blockedSkills: [],
  agentAllowlists: {},
  allowNetworkByDefault: false,
  allowedPublishers: [],
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asStringMap = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const values = asStringArray(raw);
    if (values.length) result[key] = values;
  }
  return result;
};

export const loadSkillAdminPolicy = (workspaceDir?: string): SkillAdminPolicy => {
  const paths = policyPaths(workspaceDir);
  const file = paths.find((candidate) => existsSync(candidate));
  if (!file) return DEFAULT_POLICY;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return {
      uploadsEnabled: asBoolean(record.uploadsEnabled, DEFAULT_POLICY.uploadsEnabled),
      untrustedScriptsEnabled: asBoolean(record.untrustedScriptsEnabled, DEFAULT_POLICY.untrustedScriptsEnabled),
      requireVerifiedRegistry: asBoolean(record.requireVerifiedRegistry, DEFAULT_POLICY.requireVerifiedRegistry),
      allowedSkills: asStringArray(record.allowedSkills),
      blockedSkills: asStringArray(record.blockedSkills),
      agentAllowlists: asStringMap(record.agentAllowlists),
      allowNetworkByDefault: asBoolean(record.allowNetworkByDefault, DEFAULT_POLICY.allowNetworkByDefault),
      allowedPublishers: asStringArray(record.allowedPublishers),
    };
  } catch {
    return DEFAULT_POLICY;
  }
};

const matchesSkillSelector = (skill: SkillRecord, selectors: string[]): boolean =>
  selectors.some((selector) => selector === skill.id || selector === skill.name || selector === skill.sourcePath);

export const evaluateSkillPolicy = (
  skills: SkillRecord[],
  policy: SkillAdminPolicy,
  agentId?: string,
): SkillPolicyDecision[] => {
  const agentAllowlist = agentId ? policy.agentAllowlists[agentId] : undefined;
  return skills.map((skill) => {
    const reasons: string[] = [];
    if (matchesSkillSelector(skill, policy.blockedSkills)) reasons.push("blocked by project/admin policy");
    if (policy.allowedSkills.length && !matchesSkillSelector(skill, policy.allowedSkills)) reasons.push("not present in project/admin allowlist");
    if (agentAllowlist && !matchesSkillSelector(skill, agentAllowlist)) reasons.push(`not present in ${agentId} agent allowlist`);
    if (policy.allowedPublishers.length && skill.publisher && !policy.allowedPublishers.includes(skill.publisher)) reasons.push("publisher is not allowlisted");
    if (policy.requireVerifiedRegistry && skill.registryUrl && skill.verificationStatus !== "verified") reasons.push("registry skill is not verified");
    return { skillId: skill.id, allowed: reasons.length === 0, reasons };
  });
};

export const filterSkillsByPolicy = (
  skills: SkillRecord[],
  workspaceDir?: string,
  agentId?: string,
): SkillRecord[] => {
  const policy = loadSkillAdminPolicy(workspaceDir);
  const decisions = new Map(evaluateSkillPolicy(skills, policy, agentId).map((item) => [item.skillId, item]));
  return skills.filter((skill) => decisions.get(skill.id)?.allowed !== false);
};

const metadataList = (skill: SkillRecord, key: string): string[] => {
  const root = mergedFiles(skill).find((file) => file.path === "SKILL.md");
  const content = root ? skillFileText(root) : "";
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "im").exec(content);
  if (!match) return [];
  const raw = match[1]?.trim() ?? "";
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
  return raw ? [raw.replace(/^['\"]|['\"]$/g, "")] : [];
};

export const listSkillBundles = (skills: SkillRecord[], workspaceDir?: string): SkillBundleRecord[] => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const bundles: SkillBundleRecord[] = [];
  for (const bundlePath of bundlePaths(workspaceDir).filter((candidate) => existsSync(candidate))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(bundlePath, "utf8"));
      const items = Array.isArray(parsed) ? parsed : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
        const skillIds = asStringArray(record.skillIds);
        if (!id || !skillIds.length) continue;
        bundles.push({
          id,
          name: typeof record.name === "string" ? record.name : id,
          description: typeof record.description === "string" ? record.description : "User skill bundle.",
          skillIds: skillIds.filter((skillId) => byId.has(skillId)),
          missingSkillIds: skillIds.filter((skillId) => !byId.has(skillId)),
          source: "policy",
        });
      }
    } catch {
      // Invalid bundle files are ignored; diagnostics are exposed by the policy file editor/tests.
    }
  }
  for (const skill of skills) {
    const related = metadataList(skill, "related_skills");
    if (related.length) {
      bundles.push({
        id: `${skill.id}-related`,
        name: `${skill.name} related skills`,
        description: `Skills declared as related to ${skill.name}.`,
        skillIds: [skill.id, ...related.filter((skillId) => byId.has(skillId))],
        missingSkillIds: related.filter((skillId) => !byId.has(skillId)),
        source: "metadata",
      });
    }
  }
  return bundles;
};

export const compareSkills = (left: SkillRecord, right: SkillRecord): SkillCompareResult => {
  const leftFiles = mergedFiles(left);
  const rightFiles = mergedFiles(right);
  return {
    left: compareSide(left, leftFiles),
    right: compareSide(right, rightFiles),
    samePackageHash: skillPackageHash(left) === skillPackageHash(right),
    fileDiff: diffSkillFiles(leftFiles, rightFiles),
    metadataDiff: {
      nameChanged: left.name !== right.name,
      descriptionChanged: left.description !== right.description,
      versionChanged: left.version !== right.version,
      sourceChanged: left.source !== right.source,
      verificationChanged: left.verificationStatus !== right.verificationStatus,
    },
  };
};

const compareSide = (skill: SkillRecord, files: SkillRecord["files"]): SkillCompareSide => ({
  id: skill.id,
  name: skill.name,
  source: skill.source,
  packageHash: skillPackageHash(skill),
  fileCount: files.length,
  packageSize: files.reduce((sum, file) => sum + skillFileByteLength(file), 0),
  updatedAt: skill.updatedAt,
  version: skill.version,
});

const setupCommand = (manager: string, name: string): string => {
  if (manager === "npm") return `npm install ${name}`;
  if (manager === "pip") return `python -m pip install ${name}`;
  if (manager === "cargo") return `cargo install ${name}`;
  if (manager === "go") return `go install ${name}`;
  return `${manager} install ${name}`;
};

export const buildSkillSetupPlan = (skill: SkillRecord): SkillSetupPlan => ({
  skillId: skill.id,
  skillName: skill.name,
  dryRun: true,
  commands: skill.dependencyMetadata.packages.map((pkg) => ({
    manager: pkg.manager,
    packageName: pkg.name,
    command: setupCommand(pkg.manager, pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name),
  })),
  requiredBins: skill.dependencyMetadata.requiredBins,
  requiredEnv: skill.dependencyMetadata.requiredEnv,
  requiredFiles: skill.dependencyMetadata.requiredFiles,
  platformWarnings: skill.dependencyMetadata.platforms.length && !skill.dependencyMetadata.platforms.includes(process.platform)
    ? [`Current platform ${process.platform} is not declared in skill platforms: ${skill.dependencyMetadata.platforms.join(", ")}.`]
    : [],
  notes: [
    "This is a dry-run setup plan. No command is executed by this tool.",
    "Review package managers and versions before running setup commands manually or through an approved shell flow.",
  ],
});

export const buildCredentialReport = (skill: SkillRecord, workspaceDir?: string): SkillCredentialReport => ({
  skillId: skill.id,
  skillName: skill.name,
  storagePath: "skill credential store",
  encryptionAvailable: false,
  requiredEnv: skill.dependencyMetadata.requiredEnv.map((name) => ({
    name,
    configured: false,
    source: "missing" as const,
    secret: true as const,
  })),
  requiredFiles: skill.dependencyMetadata.requiredFiles.map((path) => ({
    path,
    configuredPath: null,
    exists: existsSync(path) || (workspaceDir ? existsSync(join(workspaceDir, path)) : false),
  })),
  instructions: [
    "Configure required secrets through the skill credential store.",
    "Do not paste secret values into chat or rely on the host process environment.",
    "Only allow declared env names into skill script execution.",
  ],
});

export const marketplaceReadiness = (skill: SkillRecord): SkillMarketplaceReadiness => {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const manifest: JsonRecord = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version ?? null,
    packageHash: skillPackageHash(skill),
    publisher: skill.publisher ?? null,
    verificationStatus: skill.verificationStatus ?? "unverified",
    dependencyMetadata: skill.dependencyMetadata as unknown as JsonRecord,
    files: mergedFiles(skill).map((file) => ({ path: file.path, size: skillFileByteLength(file) })),
  };
  if (!skill.version) blockers.push("version is missing");
  if (!skill.publisher) blockers.push("publisher is missing");
  if (skill.scanFindings.some((finding) => finding.severity === "critical")) blockers.push("critical scanner findings exist");
  if (skill.verificationStatus !== "verified") warnings.push("skill is not verified yet");
  if (!skill.expectedPackageHash && !skill.signature) warnings.push("no expected hash or signature is attached");
  return { skillId: skill.id, skillName: skill.name, ready: blockers.length === 0, blockers, warnings, manifest };
};

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  SkillFileRecord,
  SkillRecord,
  SkillRootDiagnostic,
  SkillRootKind,
  SkillSource,
} from "@shared/types";
import { extractSkillDependencyMetadata } from "./skillMetadata";
import { hashSkillFiles } from "./skillHash";
import {
  skillFileByteLength,
  skillFileFromBuffer,
  skillFileToBuffer,
} from "./skillFileData";
import {
  criticalSkillFinding,
  scanSkillFiles,
  trustLevelForSkill,
} from "./skillSecurity";
import { parseSkillMarkdown, validateSkillFiles } from "./skillValidation";

const MAX_SCAN_DEPTH = 6;
const MAX_SKILLS_PER_ROOT = 2000;
const EXCLUDED_DIRS = new Set([
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
const SUPPORT_ROOTS = new Set([
  "references",
  "templates",
  "scripts",
  "assets",
  "evals",
  "agents",
]);

export interface SkillRoot {
  id: string;
  kind: SkillRootKind;
  path: string;
  rank: number;
  writable: boolean;
  pluginId?: string | undefined;
}

export interface PluginSkillRootInput {
  path: string;
  pluginId: string;
  enabled: boolean;
}

export interface SkillRootScanResult {
  records: SkillRecord[];
  diagnostics: SkillRootDiagnostic[];
}

const nowIso = (): string => new Date().toISOString();

const pathId = (value: string): string =>
  createHash("sha256").update(resolve(value)).digest("hex").slice(0, 12);

const normalizePath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");

const sourceForRoot = (kind: SkillRootKind): SkillSource =>
  kind === "built-in" ? "built-in" : kind;

export const skillConfigRoot = (): string => resolve(homedir(), ".super-agent");

const userRoot = (): string => join(skillConfigRoot(), "skills");

const agentsRoot = (): string => resolve(homedir(), ".agents", "skills");

const rootLockMessage = (root: string): string | undefined => {
  const lockPath = join(root, ".skill-lock.json");
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Record<
      string,
      unknown
    >;
    const message = parsed.message ?? parsed.reason;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    return ".skill-lock.json could not be parsed; root remains read-only.";
  }
  return ".skill-lock.json present; root is read-only.";
};

const dedupeRoots = (roots: SkillRoot[]): SkillRoot[] => {
  const seen = new Set<string>();
  const result: SkillRoot[] = [];
  for (const root of roots) {
    const key = resolve(root.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...root, path: key });
  }
  return result;
};

export const skillUserRoot = (): string => userRoot();

export const resolveSkillRoots = (
  _workspaceDir: string,
  _pluginRoots: PluginSkillRootInput[] = [],
  userRootOverride?: string,
  agentsRootOverride?: string,
  _builtInRootOverride?: string,
): SkillRoot[] => {
  const primaryUserRoot = userRootOverride ?? userRoot();
  const readOnlyAgentsRoot = agentsRootOverride ?? agentsRoot();
  const roots: SkillRoot[] = [
    {
      id: "user-super-agent",
      kind: "user",
      path: primaryUserRoot,
      rank: 30,
      writable: true,
    },
    {
      id: "user-agents",
      kind: "user",
      path: readOnlyAgentsRoot,
      rank: 31,
      writable: false,
    },
  ];

  return dedupeRoots(roots).sort((a, b) => a.rank - b.rank);
};

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
};

const safeRealpath = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const findSkillMarkdownFiles = (root: string): string[] => {
  const found: string[] = [];
  const rootReal = safeRealpath(root);
  if (!rootReal) return found;
  const visit = (dir: string, depth: number): void => {
    if (found.length >= MAX_SKILLS_PER_ROOT || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(join(dir, "SKILL.md"));
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
      const next = join(dir, entry.name);
      const nextReal = safeRealpath(next);
      if (!nextReal || !isInside(rootReal, nextReal)) continue;
      visit(next, depth + 1);
    }
  };
  visit(root, 0);
  return found;
};

const readSkillFiles = (skillDir: string): SkillFileRecord[] => {
  const files: SkillFileRecord[] = [];
  const skillDirReal = safeRealpath(skillDir);
  if (!skillDirReal) return files;
  const readFile = (filePath: string): void => {
    const real = safeRealpath(filePath);
    if (!real || !isInside(skillDirReal, real)) return;
    const rel = normalizePath(relative(skillDir, filePath));
    files.push(skillFileFromBuffer(rel, readFileSync(filePath)));
  };
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const next = join(dir, entry.name);
      const rel = normalizePath(relative(skillDir, next));
      if (entry.isDirectory()) {
        const top = rel.split("/")[0] ?? "";
        if (SUPPORT_ROOTS.has(top)) visit(next);
      } else if (entry.isFile()) {
        if (rel === "SKILL.md" || SUPPORT_ROOTS.has(rel.split("/")[0] ?? "")) {
          readFile(next);
        }
      }
    }
  };
  visit(skillDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
};

const recordFromRootFiles = (
  root: SkillRoot,
  skillDir: string,
  files: SkillFileRecord[],
): SkillRecord | null => {
  const validation = validateSkillFiles(files);
  if (!validation.valid) return null;
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) return null;
  const parsed = parseSkillMarkdown(skillMd.content);
  const scanFindings = scanSkillFiles(files);
  const critical = criticalSkillFinding(scanFindings);
  const trustLevel = trustLevelForSkill(sourceForRoot(root.kind), scanFindings);
  const hash = hashSkillFiles(files);
  const now = nowIso();
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body,
    enabled: trustLevel !== "quarantined",
    autoRouting: trustLevel !== "quarantined",
    source: sourceForRoot(root.kind),
    trustLevel,
    quarantineReason: critical?.message ?? null,
    scanFindings,
    dependencyMetadata: extractSkillDependencyMetadata(files),
    files,
    version: null,
    installedAt: now,
    updatedAt: now,
    packageSize: files.reduce(
      (total, file) => total + file.path.length + skillFileByteLength(file),
      0,
    ),
    packageHash: hash,
    rootPath: root.path,
    sourcePath: join(skillDir, "SKILL.md"),
    sourceRank: root.rank,
    pluginId: root.pluginId ?? null,
    shadowedBy: null,
    shadowReason: null,
    writable: root.writable,
    lastUsedAt: null,
    useCount: 0,
  };
};

const shadowRecord = (
  record: SkillRecord,
  winner: SkillRecord,
): SkillRecord => ({
  ...record,
  id: `${record.id}::shadow::${pathId(record.sourcePath ?? record.rootPath ?? record.id)}`,
  enabled: false,
  autoRouting: false,
  shadowedBy: winner.id,
  shadowReason: `Shadowed by ${winner.source} skill '${winner.name}' from ${winner.rootPath ?? winner.sourcePath ?? "higher-precedence root"}.`,
});

export const scanSkillRoots = (roots: SkillRoot[]): SkillRootScanResult => {
  const diagnostics: SkillRootDiagnostic[] = [];
  const candidates: SkillRecord[] = [];

  for (const root of roots) {
    const exists = existsSync(root.path);
    const lockMessage = root.writable ? undefined : rootLockMessage(root.path);
    diagnostics.push({
      id: root.id,
      kind: root.kind,
      path: root.path,
      rank: root.rank,
      writable: root.writable,
      watching: exists,
      ...(root.pluginId ? { pluginId: root.pluginId } : {}),
      status: exists ? "active" : "missing",
      ...(lockMessage ? { message: lockMessage } : {}),
    });
    if (!exists) continue;
    for (const skillMd of findSkillMarkdownFiles(root.path)) {
      const record = recordFromRootFiles(
        root,
        dirname(skillMd),
        readSkillFiles(dirname(skillMd)),
      );
      if (record) candidates.push(record);
    }
  }

  const byName = new Map<string, SkillRecord[]>();
  for (const record of candidates) {
    const key = record.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), record]);
  }

  const records: SkillRecord[] = [];
  for (const group of byName.values()) {
    const ordered = group.sort(
      (a, b) => (a.sourceRank ?? 100) - (b.sourceRank ?? 100),
    );
    const winner = ordered[0];
    if (!winner) continue;
    records.push(
      winner,
      ...ordered.slice(1).map((record) => shadowRecord(record, winner)),
    );
  }

  return {
    records: records.sort(
      (a, b) =>
        (a.sourceRank ?? 100) - (b.sourceRank ?? 100) ||
        a.name.localeCompare(b.name),
    ),
    diagnostics,
  };
};

export const writeSkillPackageToRoot = (
  root: string,
  skillId: string,
  files: SkillFileRecord[],
): { skillDir: string; skillPath: string } => {
  const safeId = skillId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safeId) throw new Error("Skill ID is required.");
  const skillDir = resolve(root, safeId);
  const rootResolved = resolve(root);
  if (!isInside(rootResolved, skillDir))
    throw new Error("Skill path escapes user skill root.");
  rmSync(skillDir, { recursive: true, force: true });
  for (const file of files) {
    const rel = normalizePath(file.path);
    const target = resolve(skillDir, rel);
    if (!isInside(skillDir, target))
      throw new Error(`Unsafe skill file path: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, skillFileToBuffer(file));
  }
  return { skillDir, skillPath: join(skillDir, "SKILL.md") };
};

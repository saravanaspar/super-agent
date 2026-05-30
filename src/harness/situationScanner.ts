import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { JsonRecord, JsonValue } from "@shared/json";
import {
  classifyProjectFile,
  inferVerificationPlan,
  shouldIgnoreDirectoryName,
  type ClassifiedProjectFile,
  type VerificationPlan
} from "./languageProfiles";
import { awarenessChecklist, superAgentProductInvariants } from "./productInvariants";
import { gate, summarizeGates, type CompletionGate } from "./completionGates";

export interface SituationScanOptions {
  root: string;
  maxFiles?: number;
  maxDepth?: number;
  maxManifestBytes?: number;
  deadlineMs?: number;
}

export interface RepoStateSnapshot {
  workspacePath: string;
  files: ClassifiedProjectFile[];
  sourceFiles: string[];
  configFiles: string[];
  testFiles: string[];
  docFiles: string[];
  ignored: Array<{ path: string; reason: string }>;
  languages: string[];
  packageManagers: string[];
  packageScripts: Record<string, string>;
  verificationPlan: VerificationPlan;
  completionGates: CompletionGate[];
  invariants: readonly string[];
  awarenessChecklist: readonly string[];
  truncated: boolean;
  deadlineReached: boolean;
}

const defaultMaxFiles = 5000;
const defaultMaxDepth = 24;
const defaultManifestBytes = 256 * 1024;
const defaultDeadlineMs = 15000;

const normalizeRelative = (value: string): string => value.replace(/\\/g, "/") || ".";

const safeReadText = (path: string, maxBytes: number): string | null => {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const parsePackageJson = (root: string, maxManifestBytes: number): { scripts: Record<string, string>; packageManager?: string } => {
  const text = safeReadText(join(root, "package.json"), maxManifestBytes);
  if (!text) return { scripts: {} };

  try {
    const parsed = JSON.parse(text) as { scripts?: unknown; packageManager?: unknown };
    const scripts: Record<string, string> = {};
    if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
      for (const [key, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") scripts[key] = value;
      }
    }
    return {
      scripts,
      ...(typeof parsed.packageManager === "string" ? { packageManager: parsed.packageManager } : {})
    };
  } catch {
    return { scripts: {} };
  }
};

const walk = (
  root: string,
  dir: string,
  state: {
    files: ClassifiedProjectFile[];
    ignored: Array<{ path: string; reason: string }>;
    count: number;
    truncated: boolean;
    deadlineReached: boolean;
  },
  options: { maxFiles: number; maxDepth: number; deadlineAt: number },
  depth = 0
): void => {
  if (Date.now() > options.deadlineAt) {
    state.deadlineReached = true;
    return;
  }
  if (depth > options.maxDepth || state.count >= options.maxFiles) {
    state.truncated = true;
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (Date.now() > options.deadlineAt) {
      state.deadlineReached = true;
      return;
    }

    const absolute = join(dir, entry.name);
    const rel = normalizeRelative(relative(root, absolute));

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectoryName(entry.name)) {
        state.ignored.push({ path: rel, reason: `ignored directory ${entry.name}` });
        continue;
      }
      walk(root, absolute, state, options, depth + 1);
      continue;
    }

    if (!entry.isFile()) continue;
    const classified = classifyProjectFile(rel);
    if (!classified.reviewable) {
      if (classified.kind !== "other") state.ignored.push({ path: rel, reason: classified.reason });
      continue;
    }

    state.files.push(classified);
    state.count += 1;
    if (state.count >= options.maxFiles) {
      state.truncated = true;
      return;
    }
  }
};

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const buildGates = (snapshot: Omit<RepoStateSnapshot, "completionGates">): CompletionGate[] => [
  gate("workspace-scanned", "Workspace inspected", true, "pass", { evidence: snapshot.workspacePath }),
  gate("source-inventory", "Reviewable source/config/test/doc inventory built", true, snapshot.files.length > 0 ? "pass" : "fail", {
    evidence: `${snapshot.files.length} reviewable files discovered`
  }),
  gate("generated-junk-skipped", "Generated/dependency/cache junk skipped", true, "pass", {
    evidence: `${snapshot.ignored.length} ignored entries recorded`
  }),
  gate("verification-plan", "Verification plan inferred from actual files/scripts", true, snapshot.verificationPlan.commands.length > 0 ? "pass" : "skipped", {
    ...(snapshot.verificationPlan.commands.length === 0 ? { reason: "No deterministic verification command inferred from repository files." } : {}),
    evidence: snapshot.verificationPlan.commands.map(item => item.command).join("; ")
  }),
  gate("product-invariants", "Super Agent product invariants loaded", true, "pass", {
    evidence: `${superAgentProductInvariants.length} invariants`
  })
];

export const scanSituation = (options: SituationScanOptions): RepoStateSnapshot => {
  const root = resolve(options.root);
  const maxFiles = options.maxFiles ?? defaultMaxFiles;
  const maxDepth = options.maxDepth ?? defaultMaxDepth;
  const maxManifestBytes = options.maxManifestBytes ?? defaultManifestBytes;
  const deadlineAt = Date.now() + (options.deadlineMs ?? defaultDeadlineMs);
  const scanState = {
    files: [] as ClassifiedProjectFile[],
    ignored: [] as Array<{ path: string; reason: string }>,
    count: 0,
    truncated: false,
    deadlineReached: false
  };

  walk(root, root, scanState, { maxFiles, maxDepth, deadlineAt });
  const allPaths = [
    ...scanState.files.map(file => file.path),
    ...scanState.ignored.map(file => file.path)
  ];
  const packageJson = parsePackageJson(root, maxManifestBytes);
  const verificationPlan = inferVerificationPlan({
    files: allPaths,
    scripts: packageJson.scripts,
    ...(packageJson.packageManager ? { packageJsonPackageManager: packageJson.packageManager } : {})
  });
  const snapshotWithoutGates = {
    workspacePath: root,
    files: scanState.files.sort((a, b) => a.path.localeCompare(b.path)),
    sourceFiles: scanState.files.filter(file => file.kind === "source").map(file => file.path).sort(),
    configFiles: scanState.files.filter(file => file.kind === "config").map(file => file.path).sort(),
    testFiles: scanState.files.filter(file => file.kind === "test").map(file => file.path).sort(),
    docFiles: scanState.files.filter(file => file.kind === "docs").map(file => file.path).sort(),
    ignored: scanState.ignored.slice(0, 500),
    languages: unique(verificationPlan.languages),
    packageManagers: verificationPlan.packageManagers,
    packageScripts: packageJson.scripts,
    verificationPlan,
    invariants: superAgentProductInvariants,
    awarenessChecklist,
    truncated: scanState.truncated,
    deadlineReached: scanState.deadlineReached
  } satisfies Omit<RepoStateSnapshot, "completionGates">;

  return {
    ...snapshotWithoutGates,
    completionGates: buildGates(snapshotWithoutGates)
  };
};

const jsonClone = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const scanToJson = (snapshot: RepoStateSnapshot): JsonRecord => ({
  workspacePath: snapshot.workspacePath,
  sourceFiles: snapshot.sourceFiles,
  configFiles: snapshot.configFiles,
  testFiles: snapshot.testFiles,
  docFiles: snapshot.docFiles,
  ignored: snapshot.ignored,
  languages: snapshot.languages,
  packageManagers: snapshot.packageManagers,
  packageScripts: snapshot.packageScripts,
  verificationPlan: jsonClone(snapshot.verificationPlan),
  completionGates: jsonClone(snapshot.completionGates),
  gateSummary: summarizeGates(snapshot.completionGates),
  invariants: [...snapshot.invariants],
  awarenessChecklist: [...snapshot.awarenessChecklist],
  truncated: snapshot.truncated,
  deadlineReached: snapshot.deadlineReached,
  files: snapshot.files.map(file => ({ path: file.path, kind: file.kind, languages: file.languages, reason: file.reason }))
});

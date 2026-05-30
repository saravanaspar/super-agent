import type {
  AgentCommandInvocation,
  ToolResultRecord
} from "@shared/types";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import {
  classifyProjectFile,
  containsIgnoredDirectory,
  inferVerificationPlan,
  isReviewableProjectFile,
  shouldIgnoreDirectoryName,
  type VerificationPlan
} from "../harness/languageProfiles";
import { superAgentProductInvariants } from "../harness/productInvariants";

export interface ReviewFileProgress {
  path: string;
  totalLines: number | null;
  readUntilLine: number;
  complete: boolean;
  blocked: boolean;
}

export interface ReviewRuntimeState {
  active: boolean;
  explicit: boolean;
  target: string;
  listed: boolean;
  files: string[];
  directories: string[];
  scannedDirectories: string[];
  readFiles: Map<string, ReviewFileProgress>;
  packageScripts: Record<string, string>;
  packageManager: string | null;
  verificationPlan: VerificationPlan;
  safeCheckRan: boolean;
  safeCheckBlocked: boolean;
  safeCheckFailed: boolean;
  safeCheckIssue: string | null;
  blockedShellIssues: string[];
  successfulVerificationCommands: string[];
  usedSymbols: Set<string>;
  zeroDeclarationSymbols: Set<string>;
  undefinedSymbolRisks: string[];
}

export interface ReviewVerificationResult {
  complete: boolean;
  partial: boolean;
  summary: string;
  nextAction: string;
  files: Array<{
    path: string;
    totalLines: number | null;
    readUntilLine: number;
    complete: boolean;
    blocked: boolean;
  }>;
  listed: boolean;
  safeCheckRan: boolean;
  safeCheckBlocked: boolean;
  safeCheckFailed: boolean;
  safeCheckIssue: string | null;
  blockedShellIssues: string[];
  successfulVerificationCommands: string[];
  undefinedSymbolRisks: string[];
  verificationPlan: VerificationPlan;
  unscannedDirectories: string[];
}

const maxReviewInventoryFiles = 5000;

const asRecord = (value: unknown): JsonRecord => toJsonRecord(value);

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readNumber = (value: unknown): number | null => {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
};

const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "");

const trimTrailingSlash = (value: string): string =>
  value.replace(/\/+$/, "");

const basename = (value: string): string => {
  const normalized = normalizePath(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
};


const isReviewableFile = (path: string): boolean => isReviewableProjectFile(path);

const emptyVerificationPlan = (): VerificationPlan =>
  inferVerificationPlan({ files: [] });

export const buildReviewRuntimeState = (
  command: AgentCommandInvocation | null | undefined,
  prompt: string
): ReviewRuntimeState | null => {
  const explicit = command?.name === "review";

  if (!explicit) {
    return null;
  }

  return {
    active: true,
    explicit,
    target: explicit ? command?.reviewTarget ?? command?.input ?? prompt : prompt,
    listed: false,
    files: [],
    directories: [],
    scannedDirectories: [],
    readFiles: new Map(),
    packageScripts: {},
    packageManager: null,
    verificationPlan: emptyVerificationPlan(),
    safeCheckRan: false,
    safeCheckBlocked: false,
    safeCheckFailed: false,
    safeCheckIssue: null,
    blockedShellIssues: [],
    successfulVerificationCommands: [],
    usedSymbols: new Set(),
    zeroDeclarationSymbols: new Set(),
    undefinedSymbolRisks: []
  };
};

const joinRelative = (base: string, name: string): string => {
  const normalizedBase = normalizePath(base);
  const normalizedName = normalizePath(name);

  if (!normalizedBase || normalizedBase === ".") {
    return normalizedName;
  }

  return `${trimTrailingSlash(normalizedBase)}/${normalizedName}`;
};

const refreshVerificationPlan = (state: ReviewRuntimeState): void => {
  state.verificationPlan = inferVerificationPlan({
    files: state.files,
    scripts: state.packageScripts,
    ...(state.packageManager ? { packageJsonPackageManager: state.packageManager } : {})
  });
};

const addReviewFile = (state: ReviewRuntimeState, path: string): void => {
  const normalizedPath = normalizeReadPathForState(state, path);

  if (!normalizedPath || !isReviewableFile(normalizedPath)) return;
  if (state.files.length >= maxReviewInventoryFiles) return;
  if (!state.files.includes(normalizedPath)) {
    state.files.push(normalizedPath);
    refreshVerificationPlan(state);
  }
};

const addReviewDirectory = (state: ReviewRuntimeState, path: string): void => {
  const normalizedPath = normalizeReadPathForState(state, path);
  const name = basename(normalizedPath);
  if (!normalizedPath || normalizedPath === "." || shouldIgnoreDirectoryName(name) || containsIgnoredDirectory(normalizedPath)) return;
  if (!state.directories.includes(normalizedPath)) state.directories.push(normalizedPath);
};

const markDirectoryScanned = (state: ReviewRuntimeState, path: string): void => {
  const normalizedPath = normalizePath(path || ".") || ".";
  if (!state.scannedDirectories.includes(normalizedPath)) state.scannedDirectories.push(normalizedPath);
};

const updateFromLs = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  const data = result.data;
  const record = asRecord(data);
  const relativeBase = readString(record.relative) || ".";
  const rawEntries = readArray(record.entries).length > 0
    ? readArray(record.entries)
    : readArray(data);

  state.listed = true;
  markDirectoryScanned(state, relativeBase);

  for (const entry of rawEntries) {
    const item = asRecord(entry);
    const name = readString(item.name);
    const type = readString(item.type);

    if (!name) continue;
    if (type === "dir") {
      addReviewDirectory(state, joinRelative(relativeBase, name));
      continue;
    }
    if (type === "file") addReviewFile(state, joinRelative(relativeBase, name));
  }
};


const updateFromProjectIndex = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  const data = asRecord(result.data);
  for (const file of readArray(data.files)) {
    const item = asRecord(file);
    const path = readString(item.path);
    if (path) addReviewFile(state, path);
  }
  state.listed = true;
  refreshVerificationPlan(state);
};

const updateFromSituationScan = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  const data = asRecord(result.data);
  const allFiles = [
    ...readArray(data.sourceFiles),
    ...readArray(data.configFiles),
    ...readArray(data.testFiles),
    ...readArray(data.docFiles)
  ];

  for (const file of allFiles) {
    if (typeof file === "string") addReviewFile(state, file);
  }

  const scripts = asRecord(data.packageScripts);
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") state.packageScripts[key] = value;
  }

  const managers = readArray(data.packageManagers).filter((item): item is string => typeof item === "string");
  state.packageManager = managers[0] ?? state.packageManager;

  const plan = asRecord(data.verificationPlan) as unknown as VerificationPlan;
  if (Array.isArray(plan.commands) && Array.isArray(plan.languages)) {
    state.verificationPlan = plan;
  } else {
    refreshVerificationPlan(state);
  }

  state.listed = true;
  markDirectoryScanned(state, ".");
};

const parsePackageJsonEvidence = (state: ReviewRuntimeState, path: string, content: string): void => {
  if (basename(path) !== "package.json" || !content.trim()) return;

  try {
    const parsed = JSON.parse(content) as { scripts?: unknown; packageManager?: unknown };
    if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
      for (const [key, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") state.packageScripts[key] = value;
      }
    }
    state.packageManager = typeof parsed.packageManager === "string" ? parsed.packageManager : state.packageManager;
    refreshVerificationPlan(state);
  } catch {
    // malformed package.json is a review finding; the model will see the read content/error.
  }
};

const normalizeReadPathForState = (
  state: ReviewRuntimeState,
  path: string
): string => {
  const normalizedPath = normalizePath(path);

  if (!normalizedPath.startsWith("/")) {
    return normalizedPath;
  }

  const matches = state.files
    .filter((file) => normalizedPath.endsWith(`/${normalizePath(file)}`))
    .sort((left, right) => right.length - left.length);
  const best = matches[0];
  const secondBest = matches[1];

  if (best && (!secondBest || best.length > secondBest.length)) {
    return best;
  }

  return normalizedPath;
};

const updateReadProgress = (
  state: ReviewRuntimeState,
  rawData: unknown,
  options: { resultBlocked: boolean; resultOk: boolean }
): void => {
  const data = asRecord(rawData);
  const path = readString(data.path);

  if (!path) return;

  const normalizedPath = normalizeReadPathForState(state, path);
  const offset = readNumber(data.offset) ?? 1;
  const returnedLines = readNumber(data.returned_lines) ?? 0;
  const totalLines = readNumber(data.total_lines);
  const unchanged = data.unchanged_since_last_read === true;
  const readUntilLine = Math.max(offset + returnedLines - 1, 0);
  const previous = state.readFiles.get(normalizedPath);
  const previousReadUntilLine = previous?.readUntilLine ?? 0;
  const blocked = options.resultBlocked || data.blocked === true;

  if (blocked) {
    state.readFiles.set(normalizedPath, {
      path: normalizedPath,
      totalLines: previous?.totalLines ?? totalLines,
      readUntilLine: Math.max(previousReadUntilLine, offset - 1),
      complete: true,
      blocked: true
    });
    return;
  }

  if (!options.resultOk || data.ok === false || readString(data.error)) {
    state.readFiles.set(normalizedPath, {
      path: normalizedPath,
      totalLines: previous?.totalLines ?? totalLines,
      readUntilLine: previousReadUntilLine,
      complete: false,
      blocked: previous?.blocked === true
    });
    return;
  }

  const mergedReadUntilLine = unchanged
    ? previousReadUntilLine
    : Math.max(previousReadUntilLine, readUntilLine);
  const mergedTotalLines = totalLines ?? previous?.totalLines ?? null;
  const complete = mergedTotalLines !== null
    ? mergedReadUntilLine >= mergedTotalLines
    : previous?.complete === true;

  state.readFiles.set(normalizedPath, {
    path: normalizedPath,
    totalLines: mergedTotalLines,
    readUntilLine: mergedReadUntilLine,
    complete,
    blocked: previous?.blocked === true
  });

  addReviewFile(state, normalizedPath);
  parsePackageJsonEvidence(state, normalizedPath, readString(data.content));
};

const updateFromReadFile = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  updateReadProgress(state, result.data, {
    resultBlocked: result.blocked,
    resultOk: result.ok
  });
};


const compactShellOutput = (data: JsonRecord): string => {
  const output = [readString(data.stderr), readString(data.stdout)]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");

  return output.length > 500 ? `${output.slice(0, 500)}...` : output;
};

const shellCheckIssue = (command: string, data: JsonRecord): string => {
  const output = compactShellOutput(data);
  const exitCode = readNumber(data.exit_code);
  const exitLabel = exitCode === null ? "" : ` exited with ${exitCode}`;

  if (/npm:\s+not found|npm: not found|command not found: npm/i.test(output)) {
    return `Verification skipped: npm is not installed in this environment. Command \`${command}\`${exitLabel}.`;
  }

  const suffix = output ? ` Output: ${output}` : "";
  return `Verification command \`${command}\`${exitLabel || " failed"}.${suffix}`;
};

const blockedShellIssue = (command: string, message: string): string =>
  `Shell command \`${command || "unknown"}\` was blocked and did not run.${message ? ` Reason: ${message}` : ""}`;

const addBlockedShellIssue = (state: ReviewRuntimeState, issue: string): void => {
  if (!state.blockedShellIssues.includes(issue)) {
    state.blockedShellIssues.push(issue);
  }
};

const normalizeShellCommand = (command: string): string =>
  command.trim().replace(/\s+/g, " ").toLowerCase();

const shellCommandSegments = (command: string): string[] =>
  command
    .split(/\s*(?:&&|;|\|\|)\s*/)
    .map(normalizeShellCommand)
    .filter(Boolean);

const shellSegmentStartsWithCommand = (
  segment: string,
  expectedCommand: string
): boolean => {
  const expected = normalizeShellCommand(expectedCommand);
  return segment === expected || segment.startsWith(`${expected} `);
};

const verificationCommandMatches = (state: ReviewRuntimeState, command: string): boolean => {
  const segments = shellCommandSegments(command);
  if (segments.length === 0) return false;
  if (state.verificationPlan.commands.some(item => segments.some(segment => shellSegmentStartsWithCommand(segment, item.command)))) return true;

  return [
    "python -m py_compile",
    "python -m compileall",
    "npm run typecheck",
    "npm run lint",
    "npm run test:e2e",
    "npm run e2e",
    "npm test",
    "pnpm run typecheck",
    "pnpm run lint",
    "pnpm run test:e2e",
    "pnpm run e2e",
    "pnpm test",
    "yarn typecheck",
    "yarn lint",
    "yarn test:e2e",
    "yarn e2e",
    "yarn test",
    "bun run test:e2e",
    "bun run e2e",
    "bun test",
    "npx playwright test",
    "playwright test",
    "npx cypress run",
    "cypress run",
    "pytest",
    "python -m pytest",
    "cargo check",
    "cargo test",
    "go test",
    "go vet",
    "dotnet build",
    "dotnet test",
    "mvn test",
    "gradle test",
    "swift test",
    "dart test",
    "flutter test",
    "composer test",
    "phpunit",
    "bundle exec",
    "make test",
    "make check",
    "cmake --build",
    "npx tsc",
    "tsc",
    "npx eslint",
    "eslint"
  ].some(marker => segments.some(segment => shellSegmentStartsWithCommand(segment, marker)));
};

const updateFromShell = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  const data = asRecord(result.data);
  const rawCommand = readString(data.command);
  const matchesVerification = verificationCommandMatches(state, rawCommand);

  if (result.blocked) {
    const issue = blockedShellIssue(rawCommand || result.toolName, result.message);
    addBlockedShellIssue(state, issue);

    if (matchesVerification) {
      state.safeCheckBlocked = true;
      state.safeCheckIssue = issue;
    }

    return;
  }

  if (matchesVerification) {
    state.safeCheckRan = true;

    if (!result.ok || data.exit_code !== 0 || data.timed_out === true) {
      state.safeCheckFailed = true;
      state.safeCheckIssue = data.timed_out === true
        ? `Verification command \`${rawCommand || result.toolName}\` timed out before completion.`
        : shellCheckIssue(rawCommand || result.toolName, data);
    } else if (rawCommand && !state.successfulVerificationCommands.includes(rawCommand)) {
      state.successfulVerificationCommands.push(rawCommand);
    }
  }
};

const simpleSymbolPattern = /^[A-Za-z_$][\w$]*$/;

const declarationSymbolFromPattern = (pattern: string): string | null => {
  const match = /\b(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)\b/.exec(pattern);

  return match?.[1] ?? null;
};

const simpleSymbolFromPattern = (pattern: string): string | null => {
  const trimmed = pattern.trim();

  return simpleSymbolPattern.test(trimmed) ? trimmed : null;
};

const recordUndefinedSymbolRisk = (
  state: ReviewRuntimeState,
  symbol: string
): void => {
  if (!state.usedSymbols.has(symbol) || !state.zeroDeclarationSymbols.has(symbol)) return;
  if (!state.undefinedSymbolRisks.includes(symbol)) state.undefinedSymbolRisks.push(symbol);
};

const updateFromGrep = (
  state: ReviewRuntimeState,
  result: ToolResultRecord
): void => {
  if (!result.ok || result.blocked) return;

  const data = asRecord(result.data);
  const pattern = readString(data.pattern);
  const count = readNumber(data.count) ?? 0;
  if (!pattern) return;

  const declarationSymbol = declarationSymbolFromPattern(pattern);
  const simpleSymbol = simpleSymbolFromPattern(pattern);

  if (count > 0 && simpleSymbol) {
    state.usedSymbols.add(simpleSymbol);
    recordUndefinedSymbolRisk(state, simpleSymbol);
  }

  if (count === 0 && declarationSymbol) {
    state.zeroDeclarationSymbols.add(declarationSymbol);
    recordUndefinedSymbolRisk(state, declarationSymbol);
  }
};

export const updateReviewStateFromToolResult = (
  state: ReviewRuntimeState | null,
  result: ToolResultRecord
): void => {
  if (!state) return;

  if (result.toolName === "situation_scan") {
    updateFromSituationScan(state, result);
    return;
  }

  if (result.toolName === "ls") {
    updateFromLs(state, result);
    return;
  }


  if (result.toolName === "project_index") {
    updateFromProjectIndex(state, result);
    return;
  }

  if (result.toolName === "read_file") {
    updateFromReadFile(state, result);
    return;
  }

  if (result.toolName === "grep") {
    updateFromGrep(state, result);
    return;
  }

  if (result.toolName === "bash") {
    updateFromShell(state, result);
  }
};

const fileProgressList = (state: ReviewRuntimeState) =>
  [...state.readFiles.values()].sort((a, b) => a.path.localeCompare(b.path));

const readPathCoversInventoryPath = (readPath: string, inventoryPath: string): boolean =>
  normalizePath(readPath) === normalizePath(inventoryPath);

const readProgressForInventoryPath = (
  state: ReviewRuntimeState,
  inventoryPath: string
): ReviewFileProgress | null =>
  fileProgressList(state).find((file) => readPathCoversInventoryPath(file.path, inventoryPath)) ?? null;

const unreadReviewFiles = (state: ReviewRuntimeState): string[] =>
  state.files
    .filter(isReviewableFile)
    .filter((file) => readProgressForInventoryPath(state, file) === null);

const partialReadFiles = (state: ReviewRuntimeState): ReviewFileProgress[] => {
  const byPath = new Map<string, ReviewFileProgress>();

  for (const file of state.files) {
    const progress = readProgressForInventoryPath(state, file);
    if (progress && !progress.complete) byPath.set(progress.path, progress);
  }

  for (const progress of fileProgressList(state)) {
    if (!progress.complete) byPath.set(progress.path, progress);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
};

const blockedReadFiles = (state: ReviewRuntimeState): ReviewFileProgress[] =>
  fileProgressList(state).filter((file) => file.blocked);

const unscannedDirectories = (state: ReviewRuntimeState): string[] => {
  const scanned = new Set(state.scannedDirectories);
  return state.directories.filter(directory => !scanned.has(directory));
};

const shouldRunSafeCheck = (state: ReviewRuntimeState): boolean =>
  state.explicit &&
  !state.safeCheckRan &&
  !state.safeCheckBlocked &&
  state.verificationPlan.commands.length > 0;

const safeCheckInstruction = (state: ReviewRuntimeState): string => {
  const commands = state.verificationPlan.commands.slice(0, 4);
  if (commands.length === 0) return "No deterministic verification command was inferred from actual repo files/scripts.";

  return [
    "Run one applicable inferred verification command before final review; do not invent missing scripts.",
    ...commands.map(item => `- ${item.command} (${item.reason})`)
  ].join("\n");
};

export const verifyReviewProgress = (
  state: ReviewRuntimeState | null
): ReviewVerificationResult | null => {
  if (!state) return null;

  const files = fileProgressList(state);
  const unread = unreadReviewFiles(state);
  const partial = partialReadFiles(state);
  const blocked = blockedReadFiles(state);
  const dirs = unscannedDirectories(state);
  const successfulVerificationCommands = [...state.successfulVerificationCommands];
  const undefinedSymbolRisks = [...state.undefinedSymbolRisks];

  if (!state.listed && files.length === 0) {
    return {
      complete: false,
      partial: true,
      summary: "Repository situation has not been scanned yet.",
      nextAction:
        "Run situation_scan first. It must identify languages, package managers, source/config/test/doc files, ignored generated folders, product invariants, and inferred verification commands before any final review.",
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  if (dirs.length > 0 && state.files.length < maxReviewInventoryFiles) {
    const next = dirs[0] ?? "";
    return {
      complete: false,
      partial: true,
      summary: `${dirs.length} discovered director${dirs.length === 1 ? "y" : "ies"} still need source inventory.` ,
      nextAction: `List ${next} or run situation_scan/project_index for the workspace before producing final review findings. Skip only generated/dependency/build/cache folders by name.`,
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  if (unread.length > 0) {
    const next = unread[0] ?? "";

    return {
      complete: false,
      partial: true,
      summary: `${unread.length} reviewable source/config/test/doc file${
        unread.length === 1 ? "" : "s"
      } still unread.`,
      nextAction: `Read ${next} before producing final review findings. Use one bounded read_file range at a time.`,
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  if (partial.length > 0) {
    const next = partial[0]!;
    const nextOffset = next.readUntilLine + 1;

    return {
      complete: false,
      partial: true,
      summary: `${partial.length} file${
        partial.length === 1 ? "" : "s"
      } were only partially read.`,
      nextAction: `Continue reading ${next.path} from line ${nextOffset} before producing final review findings.`,
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  if (shouldRunSafeCheck(state)) {
    return {
      complete: false,
      partial: true,
      summary: "Readable project evidence is complete, but inferred verification has not run yet.",
      nextAction: safeCheckInstruction(state),
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  if (files.length === 0) {
    return {
      complete: true,
      partial: false,
      summary: "No reviewable source/config/test/doc files were found after scanning the selected workspace.",
      nextAction:
        "Produce a final review stating that no reviewable project files were found. Include the selected workspace scope, ignored generated/dependency folders, verification not run, and ask the user to select the intended project if this workspace is wrong.",
      files,
      listed: state.listed,
      safeCheckRan: state.safeCheckRan,
      safeCheckBlocked: state.safeCheckBlocked,
      safeCheckFailed: state.safeCheckFailed,
      safeCheckIssue: state.safeCheckIssue,
      blockedShellIssues: [...state.blockedShellIssues],
      successfulVerificationCommands,
      undefinedSymbolRisks,
      verificationPlan: state.verificationPlan,
      unscannedDirectories: dirs
    };
  }

  const verificationNotes = [
    state.safeCheckIssue ? `Verification note: ${state.safeCheckIssue}` : null,
    ...state.blockedShellIssues.map((issue) => `Blocked shell note: ${issue}`)
  ].filter((note): note is string => note !== null);
  const verificationNote = verificationNotes.length > 0
    ? ` ${verificationNotes.join(" ")}`
    : "";
  const finalSummary = blocked.length > 0
    ? `Review evidence is complete for available project files; ${blocked.length} file read${
        blocked.length === 1 ? " was" : "s were"
      } blocked and must be reported as blocked.${verificationNote}`
    : `Review evidence is complete for ${files.length} source file${
        files.length === 1 ? "" : "s"
      } across source/config/test/doc scope.${verificationNote}`;
  const verificationCommands = state.verificationPlan.commands.map(item => item.command).join(", ");
  const finalNextAction = blocked.length > 0
    ? "Produce final review findings with severity, evidence, concrete fixes, and a clear blocked-check note for inaccessible file ranges. Do not retry blocked tool calls."
    : "Produce final review findings with severity, evidence, and concrete fixes. Do not say no issues unless checks and reads support it.";
  const verificationTruthRule = "Do not use phrases like executed conceptually, builds and runs, started successfully, passed, or no runtime errors unless an actual tool result proves that command ran.";
  const undefinedSymbolRule = "When existing search evidence shows a symbol is used and declaration searches returned zero matches, report it as an undefined-symbol/runtime finding before finalizing.";
  const undefinedSymbolNote = state.undefinedSymbolRisks.length > 0
    ? ` Search evidence indicates these symbols are used but declaration searches returned zero matches: ${state.undefinedSymbolRisks.join(", ")}. Report them as undefined-symbol/runtime findings.`
    : "";

  return {

    complete: true,
    partial: false,
    summary: finalSummary,
    nextAction: [
      verificationNotes.length > 0
        ? `${finalNextAction} State these verification limitations exactly and do not claim blocked commands ran: ${verificationNotes.join(" ")}`
        : finalNextAction,
      verificationCommands ? `Mention verification commands considered/run: ${verificationCommands}.` : "Mention that no deterministic verification command was inferred.",
      verificationTruthRule,
      `${undefinedSymbolRule}${undefinedSymbolNote}`,
      `Preserve these product invariants in the assessment: ${superAgentProductInvariants.slice(0, 4).join(" ")}`
    ].join(" "),
    files,
    listed: state.listed,
    safeCheckRan: state.safeCheckRan,
    safeCheckBlocked: state.safeCheckBlocked,
    safeCheckFailed: state.safeCheckFailed,
    safeCheckIssue: state.safeCheckIssue,
    blockedShellIssues: [...state.blockedShellIssues],
    successfulVerificationCommands,
    undefinedSymbolRisks,
    verificationPlan: state.verificationPlan,
    unscannedDirectories: dirs
  };
};

export const reviewProgressMessage = (
  verification: ReviewVerificationResult
): string => {
  const blockedCount = verification.files.filter((file) => file.blocked).length;
  const partialCount = verification.files.filter((file) => !file.complete).length;

  if (!verification.listed && verification.files.length === 0) {
    return "Scanning repository situation.";
  }

  if (verification.complete) {
    return blockedCount > 0
      ? "Review evidence is ready with blocked reads noted."
      : "Review evidence is ready.";
  }

  if (verification.unscannedDirectories.length > 0) {
    return "Expanding source inventory."
  }

  if (partialCount > 0 || verification.safeCheckBlocked) {
    return "Review evidence is partially blocked; continuing from available evidence.";
  }

  return "Inspecting source files.";
};

export const reviewContinuationMessage = (
  verification: ReviewVerificationResult
): string =>
  [
    `Internal review state: ${verification.summary}`,
    verification.safeCheckIssue
      ? `Verification limitation to report: ${verification.safeCheckIssue}`
      : "",
    verification.blockedShellIssues.length > 0
      ? `Blocked shell commands to report as not run: ${verification.blockedShellIssues.join(" | ")}`
      : "",
    verification.undefinedSymbolRisks.length > 0
      ? `Undefined-symbol findings required from search evidence: ${verification.undefinedSymbolRisks.join(", ")}`
      : "",
    `Next required review step: ${verification.nextAction}`,
    verification.complete
      ? "The checklist is complete enough to produce the final review."
      : "Do not produce final review findings until the checklist is complete or the next required tool call is blocked.",
    "Use situation_scan as the preferred first review tool. It gives a language-agnostic repo state, source inventory, ignored generated folders, product invariants, and verification plan.",
    "Review scope must be source-complete for the selected target: inventory all reviewable source/config/test/doc files and skip dependency/generated/build folders such as node_modules, .venv, .next, target, dist, build, out, coverage, and caches.",
    "Do not invent npm/pnpm/yarn/pytest/cargo/go/dotnet/maven/gradle/make/cmake commands. Use only commands inferred from actual files/scripts or explicitly state that no deterministic command was available.",
    "A final review must include: checked files, verification commands considered/run, critical/high/medium/low findings, security issues, runtime bugs, dependency/config issues, Docker/deployment issues, and concrete fixes.",
    "Do not say a command ran, executed conceptually, built, started, passed, or had no runtime errors unless an actual returned tool result proves it. Otherwise mark verification as not run/skipped.",
    "If search evidence shows a symbol is used and a declaration search returned zero matches, include that undefined-symbol/runtime issue in final findings.",
    "If the exact next tool call is blocked, denied, or reported as duplicate/no-progress, do not retry it in a loop. Report that check as blocked or use the existing evidence instead of saying no issues."
  ].filter(Boolean).join("\n");

export const reviewStateMetadata = (
  verification: ReviewVerificationResult
): JsonRecord => ({
  complete: verification.complete,
  partial: verification.partial,
  summary: verification.summary,
  nextAction: verification.nextAction,
  listed: verification.listed,
  safeCheckRan: verification.safeCheckRan,
  safeCheckBlocked: verification.safeCheckBlocked,
  safeCheckFailed: verification.safeCheckFailed,
  safeCheckIssue: verification.safeCheckIssue,
  blockedShellIssues: verification.blockedShellIssues,
  successfulVerificationCommands: verification.successfulVerificationCommands,
  undefinedSymbolRisks: verification.undefinedSymbolRisks,
  verificationPlan: toJsonRecord(verification.verificationPlan),
  unscannedDirectories: verification.unscannedDirectories,
  files: verification.files.map((file) => ({
    path: file.path,
    classification: classifyProjectFile(file.path).kind,
    totalLines: file.totalLines,
    readUntilLine: file.readUntilLine,
    complete: file.complete,
    blocked: file.blocked
  }))
});

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { containsIgnoredDirectory, shouldIgnoreDirectoryName } from "@shared/ignorePolicy";
import type { ToolResultRecord } from "@shared/types";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type { GoalCriterion, GoalEvidenceRecord, GoalRuntimeState, GoalVerificationResult, MeasuredItem, MetricName } from "./goalRuntimeTypes";
import { requiresVerificationCommand } from "./goalRuntimePolicy";
import { isWordBodyChar, isWordJoiner, normalizeTerm, tokenize, tokenValues } from "./goalCriteria";

interface Heading {
  level: number;
  title: string;
  lineNumber: number;
}

const textFileExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".text"
]);

const maxDiscoveryDepth = 3;
const maxDiscoveredFiles = 50;
const maxGoalTargetBytes = 5 * 1024 * 1024;

const readRecord = (value: unknown): JsonRecord => toJsonRecord(value);

const readString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");

const extensionOf = (path: string): string => {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
};

const isInsideWorkspace = (workspaceDir: string, candidate: string): boolean => {
  const workspace = resolve(workspaceDir);
  const resolved = resolve(candidate);
  const rel = relative(workspace, resolved);

  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const safeResolve = (
  workspaceDir: string,
  targetPath: string
): string | null => {
  const candidate = resolve(workspaceDir, targetPath);

  if (!isInsideWorkspace(workspaceDir, candidate)) {
    return null;
  }

  const relativeCandidate = relativeDisplayPath(workspaceDir, candidate);
  return containsIgnoredDirectory(relativeCandidate) ? null : candidate;
};

const discoverTextFiles = (
  workspaceDir: string,
  directory = workspaceDir,
  depth = 0,
  collected: string[] = []
): string[] => {
  if (depth > maxDiscoveryDepth || collected.length >= maxDiscoveredFiles) {
    return collected;
  }

  if (!existsSync(directory)) {
    return collected;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || shouldIgnoreDirectoryName(entry.name)) continue;

    const absolute = join(directory, entry.name);
    const relativePath = relativeDisplayPath(workspaceDir, absolute);
    if (containsIgnoredDirectory(relativePath)) continue;

    if (entry.isDirectory()) {
      discoverTextFiles(workspaceDir, absolute, depth + 1, collected);
      continue;
    }

    if (!entry.isFile()) continue;

    if (textFileExtensions.has(extensionOf(entry.name))) {
      collected.push(absolute);
    }

    if (collected.length >= maxDiscoveredFiles) {
      break;
    }
  }

  return collected;
};

const resolveTargetFile = (
  workspaceDir: string,
  targetPath: string | null
): string | null => {
  if (targetPath) {
    const resolved = safeResolve(workspaceDir, targetPath);

    if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
      return resolved;
    }

    return null;
  }

  const candidates = discoverTextFiles(workspaceDir);

  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  const essayCandidate = candidates.find(
    candidate => basename(candidate).toLowerCase() === "essay.txt"
  );

  return essayCandidate ?? null;
};

const splitLines = (content: string): string[] => {
  const lines: string[] = [];
  let current = "";

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";

    if (char === "\r") {
      if (content[index + 1] === "\n") {
        index += 1;
      }

      lines.push(current);
      current = "";
      continue;
    }

    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  lines.push(current);
  return lines;
};

const trimLeft = (value: string): string => {
  let index = 0;

  while (index < value.length) {
    const char = value[index] ?? "";

    if (char !== " " && char !== "\t") {
      break;
    }

    index += 1;
  }

  return value.slice(index);
};

const trimRight = (value: string): string => {
  let index = value.length - 1;

  while (index >= 0) {
    const char = value[index] ?? "";

    if (char !== " " && char !== "\t") {
      break;
    }

    index -= 1;
  }

  return value.slice(0, index + 1);
};

const trim = (value: string): string => trimRight(trimLeft(value));

const headingFromLine = (
  line: string,
  lineNumber: number
): Heading | null => {
  const trimmed = trimLeft(line);
  let level = 0;

  while (level < trimmed.length && trimmed[level] === "#") {
    level += 1;
  }

  if (level < 1 || level > 6) {
    return null;
  }

  const next = trimmed[level] ?? "";

  if (next !== " " && next !== "\t") {
    return null;
  }

  const title = trim(trimmed.slice(level));

  if (!title) {
    return null;
  }

  return { level, title, lineNumber };
};

const countWords = (content: string): number => {
  let count = 0;
  let inWord = false;
  let previousWasBody = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";

    if (isWordBodyChar(char)) {
      if (!inWord) {
        count += 1;
        inWord = true;
      }

      previousWasBody = true;
      continue;
    }

    if (
      inWord &&
      previousWasBody &&
      isWordJoiner(char) &&
      index + 1 < content.length &&
      isWordBodyChar(content[index + 1] ?? "")
    ) {
      previousWasBody = false;
      continue;
    }

    inWord = false;
    previousWasBody = false;
  }

  return count;
};

const countCharacters = (content: string): number =>
  [...content].length;

const metricValue = (
  metric: MetricName,
  content: string,
  lineCount: number
): number | null => {
  if (metric === "words") {
    return countWords(content);
  }

  if (metric === "characters") {
    return countCharacters(content);
  }

  if (metric === "lines") {
    return lineCount;
  }

  return null;
};

const readMetric = (record: JsonRecord, metric: MetricName): number | null => {
  const value = record[metric];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const analyzeItems = (
  content: string,
  itemName: string
): MeasuredItem[] => {
  const lines = splitLines(content);
  const normalizedItem = normalizeTerm(itemName);
  const headings = lines
    .map((line, index) => headingFromLine(line, index + 1))
    .filter((heading): heading is Heading => heading !== null)
    .filter(heading =>
      tokenValues(tokenize(heading.title)).has(normalizedItem)
    );

  const sourceHeadings =
    headings.length > 0
      ? headings
      : lines
          .map((line, index) => headingFromLine(line, index + 1))
          .filter((heading): heading is Heading => heading !== null);

  if (sourceHeadings.length === 0) {
    return [
      {
        index: 1,
        title: "Document",
        startLine: 1,
        endLine: lines.length,
        metrics: {
          words: countWords(content),
          characters: countCharacters(content),
          lines: lines.length
        }
      }
    ];
  }

  return sourceHeadings.map((heading, index) => {
    const next = sourceHeadings[index + 1] ?? null;
    const startLine = heading.lineNumber;
    const endLine = next ? next.lineNumber - 1 : lines.length;
    const itemLines = lines.slice(startLine - 1, endLine);
    const itemContent = itemLines.join("\n");

    return {
      index: index + 1,
      title: heading.title,
      startLine,
      endLine,
      metrics: {
        words: countWords(itemContent),
        characters: countCharacters(itemContent),
        lines: itemLines.length
      }
    };
  });
};

const relativeDisplayPath = (
  workspaceDir: string,
  absolutePath: string
): string => {
  const rel = normalizePath(relative(workspaceDir, absolutePath));
  return rel || basename(absolutePath);
};

const readTargetContent = (
  workspaceDir: string,
  targetPath: string | null
):
  | { ok: true; path: string; content: string }
  | { ok: false; reason: string } => {
  const target = resolveTargetFile(workspaceDir, targetPath);

  if (!target) {
    return {
      ok: false,
      reason:
        "Target artifact could not be resolved. Use tools to locate or create the target artifact, then verify again."
    };
  }

  const stat = statSync(target);
  const displayPath = relativeDisplayPath(workspaceDir, target);

  if (containsIgnoredDirectory(displayPath)) {
    return {
      ok: false,
      reason: `${displayPath} is inside an ignored generated/dependency directory. Select a source artifact instead.`
    };
  }

  if (stat.size > maxGoalTargetBytes) {
    return {
      ok: false,
      reason: `${displayPath} is too large for deterministic goal verification (${stat.size} bytes; limit ${maxGoalTargetBytes} bytes). Use bounded reads or a smaller target artifact.`
    };
  }

  return {
    ok: true,
    path: displayPath,
    content: readFileSync(target, "utf8")
  };
};

const verifyExactCountCriterion = (
  criterion: Extract<GoalCriterion, { type: "exact_count" }>,
  workspaceDir: string
): GoalCriterion => {
  const target = readTargetContent(workspaceDir, criterion.targetPath);

  if (!target.ok) {
    return {
      ...criterion,
      actual: null,
      complete: false,
      reason: target.reason
    };
  }

  const items = analyzeItems(target.content, criterion.subject);
  const actual = items.length;
  const complete = actual === criterion.expected;

  return {
    ...criterion,
    actual,
    targetPath: target.path,
    complete,
    reason: complete
      ? `${target.path} has exactly ${actual} ${criterion.subject} item(s).`
      : `${target.path} has ${actual} ${criterion.subject} item(s); exactly ${criterion.expected} are required.`
  };
};

const verifyMinimumTotalCriterion = (
  criterion: Extract<GoalCriterion, { type: "minimum_total" }>,
  workspaceDir: string
): GoalCriterion => {
  const target = readTargetContent(workspaceDir, criterion.targetPath);

  if (!target.ok) {
    return {
      ...criterion,
      actual: null,
      complete: false,
      reason: target.reason
    };
  }

  const lines = splitLines(target.content);
  const actual = metricValue(criterion.metric, target.content, lines.length);
  const complete = actual !== null && actual >= criterion.minimum;

  return {
    ...criterion,
    actual,
    targetPath: target.path,
    complete,
    reason: complete
      ? `${target.path} has ${actual} ${criterion.metricLabel}, meeting the required minimum of ${criterion.minimum}.`
      : actual === null
        ? `${target.path} cannot be measured for ${criterion.metricLabel} by the current deterministic verifier. Use suitable tools to produce evidence.`
        : `${target.path} has ${actual} ${criterion.metricLabel}; ${criterion.minimum - actual} more are required.`
  };
};

const verifyMinimumPerItemCriterion = (
  criterion: Extract<GoalCriterion, { type: "minimum_per_item" }>,
  workspaceDir: string
): GoalCriterion => {
  const target = readTargetContent(workspaceDir, criterion.targetPath);

  if (!target.ok) {
    return {
      ...criterion,
      items: [],
      complete: false,
      reason: target.reason
    };
  }

  const items = analyzeItems(target.content, criterion.itemName);
  const itemCountMatches =
    criterion.expectedItemCount === null ||
    items.length === criterion.expectedItemCount;
  const deficient = items.filter(item => {
    const actual = readMetric(item.metrics, criterion.metric);
    return actual === null || actual < criterion.minimumPerItem;
  });
  const complete =
    itemCountMatches &&
    items.length > 0 &&
    deficient.length === 0;

  const deficientSummary = deficient
    .map(item => {
      const actual = readMetric(item.metrics, criterion.metric);
      return `${item.title}: ${actual ?? "unknown"}/${criterion.minimumPerItem}`;
    })
    .join("; ");

  return {
    ...criterion,
    targetPath: target.path,
    items,
    complete,
    reason: complete
      ? `${target.path} satisfies the per-${criterion.itemName} ${criterion.metricLabel} minimum.`
      : [
          `${target.path} does not satisfy the per-${criterion.itemName} ${criterion.metricLabel} goal.`,
          criterion.expectedItemCount !== null && items.length !== criterion.expectedItemCount
            ? `Current ${criterion.itemName} count: ${items.length}/${criterion.expectedItemCount}.`
            : "",
          deficientSummary
            ? `Deficient ${criterion.itemName} item(s): ${deficientSummary}.`
            : ""
        ]
          .filter(Boolean)
          .join(" ")
  };
};

const successfulEvidence = (state: GoalRuntimeState): GoalEvidenceRecord[] =>
  state.evidence.filter((item) => item.ok && item.kind !== "blocked");

const successfulVerificationEvidence = (
  state: GoalRuntimeState
): GoalEvidenceRecord[] =>
  successfulEvidence(state).filter((item) => item.kind === "verification");

const successfulSituationScanEvidence = (
  state: GoalRuntimeState
): GoalEvidenceRecord[] =>
  successfulEvidence(state).filter((item) => item.kind === "situation_scan");

const successfulFileChangeEvidence = (
  state: GoalRuntimeState
): GoalEvidenceRecord[] =>
  successfulEvidence(state).filter((item) => item.kind === "file_change");

const evidenceSummary = (evidence: GoalEvidenceRecord[]): string =>
  evidence
    .slice(-6)
    .map((item) => {
      if (item.command) return `${item.toolName}: ${item.command}`;
      if (item.path) return `${item.toolName}: ${item.path}`;
      return `${item.toolName}: ${item.summary}`;
    })
    .join("; ");

const verificationPlanCommandsFromScan = (state: GoalRuntimeState): string[] => {
  const scan = [...state.evidence].reverse().find((item) => item.kind === "situation_scan" && item.ok);
  if (!scan) return [];

  const data = readRecord(scan.rawData);
  const plan = readRecord(data.verificationPlan);
  const commands = plan.commands;
  if (!Array.isArray(commands)) return [];

  return commands
    .map((item) => readString(readRecord(item).command))
    .filter(Boolean);
};

const goalHasSituationScan = (state: GoalRuntimeState): boolean =>
  successfulSituationScanEvidence(state).length > 0;


const verifyAcceptanceCriterion = (
  criterion: Extract<GoalCriterion, { type: "acceptance" }>,
  state: GoalRuntimeState
): GoalCriterion => {
  const verificationEvidence = successfulVerificationEvidence(state);
  const fileChangeEvidence = successfulFileChangeEvidence(state);
  const anySuccessfulEvidence = successfulEvidence(state);
  const needsVerification = requiresVerificationCommand(
    `${state.target}\n${criterion.description}`
  );
  const needsSituationScan = state.situationScanRequired || needsVerification;
  const scanCommands = verificationPlanCommandsFromScan(state);

  if (needsSituationScan && !goalHasSituationScan(state)) {
    return {
      ...criterion,
      evidence: null,
      complete: false,
      reason:
        "Run situation_scan first so the goal is grounded in the real workspace, detected languages, source inventory, and inferred verification plan."
    };
  }

  if (needsVerification && fileChangeEvidence.length === 0 && verificationEvidence.length === 0) {
    return {
      ...criterion,
      evidence: anySuccessfulEvidence.length > 0 ? evidenceSummary(anySuccessfulEvidence) : null,
      complete: false,
      reason:
        "This production-grade goal requires concrete tool-backed implementation or verification evidence before finalizing."
    };
  }

  if (needsVerification && scanCommands.length > 0 && verificationEvidence.length === 0) {
    return {
      ...criterion,
      evidence: fileChangeEvidence.length > 0 ? evidenceSummary(fileChangeEvidence) : null,
      complete: false,
      reason: [
        "Workspace changes have evidence, but a successful verification command is still required.",
        `Run the inferred relevant check(s), such as: ${scanCommands.slice(0, 4).join("; ")}.`
      ].join(" ")
    };
  }

  if (needsVerification && verificationEvidence.length === 0) {
    return {
      ...criterion,
      evidence: fileChangeEvidence.length > 0 ? evidenceSummary(fileChangeEvidence) : null,
      complete: fileChangeEvidence.length > 0,
      reason: fileChangeEvidence.length > 0
        ? "No deterministic verification command was inferred from the repository; accepting concrete file-change evidence with situation_scan coverage."
        : "No deterministic verification command was inferred, and no implementation evidence exists yet."
    };
  }

  if (anySuccessfulEvidence.length > 0) {
    return {
      ...criterion,
      evidence: evidenceSummary(anySuccessfulEvidence),
      complete: true,
      reason: "Acceptance criterion has successful tool-backed evidence."
    };
  }

  return {
    ...criterion,
    evidence: null,
    complete: false,
    reason: "Acceptance criterion still needs tool-backed evidence."
  };
};

const verifyCriterion = (
  criterion: GoalCriterion,
  workspaceDir: string,
  state: GoalRuntimeState
): GoalCriterion => {
  if (criterion.type === "exact_count") {
    return verifyExactCountCriterion(criterion, workspaceDir);
  }

  if (criterion.type === "minimum_total") {
    return verifyMinimumTotalCriterion(criterion, workspaceDir);
  }

  if (criterion.type === "minimum_per_item") {
    return verifyMinimumPerItemCriterion(criterion, workspaceDir);
  }

  return verifyAcceptanceCriterion(criterion, state);
};

const criterionSummary = (criterion: GoalCriterion): string => {
  if (criterion.type === "exact_count") {
    const actual = criterion.actual === null ? "unknown" : String(criterion.actual);
    return `${criterion.subject} count ${actual}/${criterion.expected}`;
  }

  if (criterion.type === "minimum_total") {
    const actual = criterion.actual === null ? "unknown" : String(criterion.actual);
    return `${criterion.metricLabel} total ${actual}/${criterion.minimum}`;
  }

  if (criterion.type === "minimum_per_item") {
    const deficient = criterion.items
      .filter(item => {
        const actual = readMetric(item.metrics, criterion.metric);
        return actual === null || actual < criterion.minimumPerItem;
      })
      .map(item => {
        const actual = readMetric(item.metrics, criterion.metric);
        return `${item.index}:${actual ?? "unknown"}/${criterion.minimumPerItem}`;
      });

    if (deficient.length === 0 && criterion.items.length > 0) {
      return `per-${criterion.itemName} ${criterion.metricLabel} passed`;
    }

    return `per-${criterion.itemName} ${criterion.metricLabel} incomplete (${deficient.join(", ") || "unknown"})`;
  }

  return "acceptance evidence required";
};

const nextDeficientItemInstruction = (
  criteria: GoalCriterion[]
): string | null => {
  const perItemCriterion = criteria.find(
    (criterion): criterion is Extract<GoalCriterion, { type: "minimum_per_item" }> =>
      criterion.type === "minimum_per_item"
  );

  if (!perItemCriterion || perItemCriterion.items.length === 0) {
    return null;
  }

  const deficientItem = perItemCriterion.items.find(item => {
    const actual = readMetric(item.metrics, perItemCriterion.metric);
    return actual === null || actual < perItemCriterion.minimumPerItem;
  });

  if (!deficientItem) {
    return null;
  }

  const actual = readMetric(deficientItem.metrics, perItemCriterion.metric);
  const remaining =
    actual === null
      ? perItemCriterion.minimumPerItem
      : perItemCriterion.minimumPerItem - actual;
  const chunkSize = perItemCriterion.metric === "words"
    ? Math.min(Math.max(remaining, 100), 2500)
    : Math.max(remaining, 1);

  return [
    `Next concrete chunk: work only on "${deficientItem.title}".`,
    `Current ${perItemCriterion.metricLabel}: ${actual ?? "unknown"}/${perItemCriterion.minimumPerItem}.`,
    `Add or revise approximately ${chunkSize} ${perItemCriterion.metricLabel} for that item without creating extra items unless the goal requires them.`,
    "After that tool call, verify again and continue automatically with the next deficient item."
  ].join(" ");
};

const verificationCommandPattern =
  /\b(test|tests|test:e2e|e2e|playwright|cypress|vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|typecheck|tsc|lint|eslint|build|compile|check|verify|doctor|electron|ui|browser)\b/i;

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

const shellCommandMatchesExpected = (
  actualCommand: string,
  expectedCommand: string
): boolean =>
  shellCommandSegments(actualCommand).some((segment) =>
    shellSegmentStartsWithCommand(segment, expectedCommand)
  );

const commandMatchesVerificationPlan = (
  state: GoalRuntimeState,
  command: string
): boolean => {
  const plannedCommands = verificationPlanCommandsFromScan(state);

  if (plannedCommands.length === 0) {
    return verificationCommandPattern.test(command);
  }

  return plannedCommands.some((plannedCommand) =>
    shellCommandMatchesExpected(command, plannedCommand)
  );
};

const dataRecord = (result: ToolResultRecord): JsonRecord => readRecord(result.data);

const toolResultPath = (result: ToolResultRecord): string | null => {
  const data = dataRecord(result);
  const path = readString(data.path) || readString(data.relativePath);
  return path ? normalizePath(path) : null;
};

const toolResultCommand = (result: ToolResultRecord): string | null => {
  const data = dataRecord(result);
  const command = readString(data.command);
  return command || null;
};

const isFileChangeTool = (toolName: string): boolean =>
  toolName === "write_file" ||
  toolName === "append_file" ||
  toolName === "edit_file" ||
  toolName === "edit_range";

const isReadTool = (toolName: string): boolean =>
  toolName === "read_file";

const isVerificationToolResult = (
  state: GoalRuntimeState,
  result: ToolResultRecord
): boolean => {
  if (result.toolName !== "bash") {
    return false;
  }

  const command = toolResultCommand(result);
  return command ? commandMatchesVerificationPlan(state, command) : result.ok;
};

const pushGoalEvidence = (
  state: GoalRuntimeState,
  evidence: GoalEvidenceRecord
): void => {
  const duplicate = state.evidence.some(
    (item) =>
      item.kind === evidence.kind &&
      item.toolName === evidence.toolName &&
      item.path === evidence.path &&
      item.command === evidence.command &&
      item.ok === evidence.ok
  );

  if (!duplicate) {
    state.evidence.push(evidence);
  }
};

export const updateGoalStateFromToolResult = (
  state: GoalRuntimeState | null,
  result: ToolResultRecord
): void => {
  if (!state) return;

  const command = toolResultCommand(result);
  const path = toolResultPath(result);

  if (result.blocked) {
    pushGoalEvidence(state, {
      kind: "blocked",
      toolName: result.toolName,
      summary: result.message,
      path,
      command,
      ok: false,
      rawData: result.data
    });
    return;
  }

  if (result.toolName === "situation_scan") {
    pushGoalEvidence(state, {
      kind: "situation_scan",
      toolName: result.toolName,
      summary: result.message,
      path,
      command,
      ok: result.ok,
      rawData: result.data
    });
    return;
  }

  if (isFileChangeTool(result.toolName)) {
    pushGoalEvidence(state, {
      kind: "file_change",
      toolName: result.toolName,
      summary: result.message,
      path,
      command,
      ok: result.ok,
      rawData: result.data
    });
    return;
  }

  if (isVerificationToolResult(state, result)) {
    const data = dataRecord(result);
    const exitCode = typeof data.exit_code === "number" ? data.exit_code : null;
    pushGoalEvidence(state, {
      kind: "verification",
      toolName: result.toolName,
      summary: result.message,
      path,
      command,
      ok: result.ok && (exitCode === null || exitCode === 0),
      rawData: result.data
    });
    return;
  }

  if (result.ok && isReadTool(result.toolName)) {
    pushGoalEvidence(state, {
      kind: "read",
      toolName: result.toolName,
      summary: result.message,
      path,
      command,
      ok: true,
      rawData: result.data
    });
  }
};

export const verifyGoalAcceptance = (
  state: GoalRuntimeState | null,
  workspaceDir: string
): GoalVerificationResult | null => {
  if (!state) return null;

  const criteria = state.criteria.map(criterion =>
    verifyCriterion(criterion, workspaceDir, state)
  );
  const complete =
    criteria.length > 0 && criteria.every(criterion => criterion.complete);
  const summary = complete
    ? `Goal acceptance passed: ${criteria.map(criterionSummary).join(", ")}.`
    : `Goal acceptance incomplete: ${criteria.map(criterionSummary).join(", ")}.`;
  const chunkInstruction = nextDeficientItemInstruction(criteria);
  const nextAction = complete
    ? "Produce the final answer and include the verified acceptance result."
    : [
        "Continue working autonomously. Do not ask the user to continue.",
        goalHasSituationScan(state) ? "Use the existing situation_scan state as the factual workspace baseline." : "Call situation_scan first before planning or editing so the goal is grounded in the real repository and language stack.",
        "Use the user's acceptance criteria and scope as the contract. If the user did not provide scope, create a production-grade internal plan before implementation.",
        "The internal plan must consider security, scalability, enterprise-grade failure modes, tests, and rollback-safe steps.",
        "Break large goals into internal tool-call chunks, then verify after each chunk.",
        chunkInstruction ?? "Use relevant tools to create or collect verification evidence, then continue.",
        "Do not finalize until every acceptance criterion is satisfied."
      ].join(" ");

  return {
    complete,
    partial: !complete,
    summary,
    nextAction,
    criteria
  };
};

export const goalProgressMessage = (
  verification: GoalVerificationResult
): string =>
  verification.complete ? "Goal acceptance passed." : "Goal still in progress.";

export const goalContinuationMessage = (
  verification: GoalVerificationResult
): string =>
  [
    `Internal goal state: ${verification.summary}`,
    `Required next step: ${verification.nextAction}`,
    "Goal rules are absolute.",
    "Use situation_scan as the mandatory first step for code/workspace goals unless it has already succeeded in this run.",
    "Do not call any tool solely to signal completion, summarize completion, or ask the user to type continue until the acceptance criteria pass.",
    "For large goals, use repeated tool calls. Work on the next deficient artifact/item, verify, then continue.",
    "First honor user-specified scope. If scope is missing, form a detailed production-grade plan that accounts for security, scalability, enterprise use, tests, and maintainability.",
    "Do not hardcode domain assumptions. Use the nouns, metrics, files, commands, tests, or artifacts present in the user's goal.",
    "If deterministic verification is unavailable, create explicit tool-backed evidence before finalizing."
  ].join("\n");

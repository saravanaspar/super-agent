import { basename } from "node:path";
import type { AgentCommandInvocation, ChatMessage } from "@shared/types";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type { GoalCriterion, GoalRuntimeState, MetricName } from "./goalRuntimeTypes";
import { requiresVerificationCommand } from "./goalRuntimePolicy";

export interface Token {
  value: string;
  index: number;
  numberValue: number | null;
}

const textFileExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".text"
]);

const metricAliases: Record<string, MetricName> = {
  word: "words",
  words: "words",
  character: "characters",
  characters: "characters",
  char: "characters",
  chars: "characters",
  line: "lines",
  lines: "lines"
};

const genericMetricWords = new Set([
  "word",
  "words",
  "character",
  "characters",
  "char",
  "chars",
  "line",
  "lines",
  "page",
  "pages",
  "slide",
  "slides",
  "file",
  "files",
  "section",
  "sections",
  "item",
  "items"
]);

const scopeWords = new Set([
  "each",
  "per",
  "every"
]);

const exactCountActionWords = new Set([
  "add",
  "build",
  "create",
  "implement",
  "make",
  "write"
]);

const exactCountWords = new Set([
  "total",
  "exactly",
  "need",
  "needs",
  "required",
  "require",
  "must",
  "have",
  "has"
]);

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "u",
  "user",
  "want",
  "with",
  "write"
]);

export const readRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return toJsonRecord(value);
};

export const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";


export const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").trim();

const isDigit = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
};

const isLetter = (char: string): boolean => {
  if (!char) return false;
  return char.toLowerCase() !== char.toUpperCase();
};

const isTokenBodyChar = (char: string): boolean =>
  isLetter(char) || isDigit(char);

export const isWordBodyChar = (char: string): boolean =>
  isLetter(char) || isDigit(char);

export const isWordJoiner = (char: string): boolean =>
  char === "'" || char === "’" || char === "-" || char === "_";

export const normalizeTerm = (value: string): string => {
  const lower = value.toLowerCase();

  if (lower.endsWith("ies") && lower.length > 3) {
    return `${lower.slice(0, -3)}y`;
  }

  if (lower.endsWith("es") && lower.length > 2) {
    return lower.slice(0, -2);
  }

  if (lower.endsWith("s") && lower.length > 1) {
    return lower.slice(0, -1);
  }

  return lower;
};

export const tokenize = (value: string): Token[] => {
  const tokens: Token[] = [];
  let current = "";

  const flush = () => {
    if (!current) return;

    const numeric = current.replaceAll(",", "").replaceAll("_", "");
    const parsed = Number.parseInt(numeric, 10);

    tokens.push({
      value: current.toLowerCase(),
      index: tokens.length,
      numberValue:
        Number.isFinite(parsed) && String(parsed) === numeric
          ? parsed
          : null
    });

    current = "";
  };

  for (const char of value) {
    if (isTokenBodyChar(char) || char === "," || char === "_") {
      current += char;
      continue;
    }

    flush();
  }

  flush();
  return tokens;
};

export const tokenValues = (tokens: Token[]): Set<string> =>
  new Set(tokens.map(token => token.value));

const normalizedEquals = (left: string, right: string): boolean =>
  normalizeTerm(left) === normalizeTerm(right);

const commandText = (
  command: AgentCommandInvocation | null | undefined
): string => {
  if (!command || command.name !== "goal") return "";

  const record = readRecord(command);
  const candidates = [
    record.input,
    record.prompt,
    record.goal,
    record.target,
    record.reviewTarget,
    record.rawInput
  ];

  for (const candidate of candidates) {
    const text = readString(candidate).trim();

    if (text) {
      return text;
    }
  }

  return "";
};

const messageText = (message: ChatMessage): string => {
  const rawCommand = readString(message.metadata.rawCommand);
  return [rawCommand, message.content].filter(Boolean).join("\n");
};

const recentConversationText = (messages: ChatMessage[]): string =>
  messages
    .slice(-12)
    .map(messageText)
    .filter(Boolean)
    .join("\n");

export const extensionOf = (path: string): string => {
  const name = basename(path);
  const index = name.lastIndexOf(".");

  return index >= 0 ? name.slice(index).toLowerCase() : "";
};

const splitByWhitespace = (value: string): string[] => {
  const parts: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      parts.push(current);
      current = "";
    }
  };

  for (const char of value) {
    if (char === " " || char === "\n" || char === "\r" || char === "\t") {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return parts;
};

const trimSimplePunctuation = (value: string): string => {
  let start = 0;
  let end = value.length - 1;

  while (start <= end) {
    const char = value[start] ?? "";

    if (char !== "\"" && char !== "'" && char !== "`") {
      break;
    }

    start += 1;
  }

  while (end >= start) {
    const char = value[end] ?? "";

    if (
      char !== "\"" &&
      char !== "'" &&
      char !== "`" &&
      char !== "," &&
      char !== "." &&
      char !== ";" &&
      char !== ":" &&
      char !== "!" &&
      char !== "?"
    ) {
      break;
    }

    end -= 1;
  }

  return value.slice(start, end + 1);
};

const extractExplicitPath = (text: string): string | null => {
  const parts = splitByWhitespace(text);

  for (const part of parts) {
    const cleaned = trimSimplePunctuation(part);

    if (textFileExtensions.has(extensionOf(cleaned))) {
      return normalizePath(cleaned);
    }
  }

  return null;
};

const extractPathFromMessageMetadata = (message: ChatMessage): string | null => {
  const result = readRecord(message.metadata.result);
  const data = readRecord(result.data);
  const path = readString(data.path);

  return path ? normalizePath(path) : null;
};

const inferTargetPath = (
  goalText: string,
  messages: ChatMessage[]
): string | null => {
  const combined = [goalText, recentConversationText(messages)].join("\n");
  const explicit = extractExplicitPath(combined);

  if (explicit) {
    return explicit;
  }

  for (const message of [...messages].reverse()) {
    const path = extractPathFromMessageMetadata(message);

    if (path && textFileExtensions.has(extensionOf(path))) {
      return path;
    }
  }

  return null;
};

const windowAround = (
  tokens: Token[],
  index: number,
  size: number
): Token[] => {
  const start = Math.max(0, index - size);
  const end = Math.min(tokens.length - 1, index + size);
  return tokens.slice(start, end + 1);
};

const metricFromToken = (token: string): MetricName =>
  metricAliases[token] ?? "unknown";

const metricLabelFromToken = (token: string): string =>
  metricAliases[token] ? metricAliases[token] : token;

const findPerItemRequest = (
  tokens: Token[]
):
  | {
      itemName: string;
      metric: MetricName;
      metricLabel: string;
      minimumPerItem: number;
    }
  | null => {
  for (const token of tokens) {
    if (!scopeWords.has(token.value)) continue;

    const scopeWindow = windowAround(tokens, token.index, 6);
    const numberToken = scopeWindow.find(candidate => candidate.numberValue !== null);
    const metricToken = scopeWindow.find(candidate =>
      genericMetricWords.has(candidate.value)
    );

    if (!numberToken || !metricToken) {
      const beforeScope = tokens.slice(Math.max(0, token.index - 8), token.index);
      const afterScope = tokens.slice(token.index + 1, token.index + 6);
      const nearestNumber = [...beforeScope].reverse().find(
        candidate => candidate.numberValue !== null
      );
      const nearestMetric = [...beforeScope].reverse().find(candidate =>
        genericMetricWords.has(candidate.value)
      );
      const itemCandidate = afterScope.find(
        candidate =>
          candidate.numberValue === null &&
          !stopWords.has(candidate.value) &&
          !genericMetricWords.has(candidate.value)
      );

      if (nearestNumber && nearestMetric && itemCandidate) {
        return {
          itemName: normalizeTerm(itemCandidate.value),
          metric: metricFromToken(nearestMetric.value),
          metricLabel: metricLabelFromToken(nearestMetric.value),
          minimumPerItem: nearestNumber.numberValue ?? 0
        };
      }

      continue;
    }

    const itemCandidate = tokens
      .slice(token.index + 1, Math.min(tokens.length, token.index + 7))
      .find(
        candidate =>
          candidate.numberValue === null &&
          !stopWords.has(candidate.value) &&
          !genericMetricWords.has(candidate.value)
      );

    if (!itemCandidate || numberToken.numberValue === null) {
      continue;
    }

    return {
      itemName: normalizeTerm(itemCandidate.value),
      metric: metricFromToken(metricToken.value),
      metricLabel: metricLabelFromToken(metricToken.value),
      minimumPerItem: numberToken.numberValue
    };
  }

  return null;
};

const findExactItemCount = (
  tokens: Token[],
  itemName: string
): number | null => {
  const normalizedItem = normalizeTerm(itemName);

  for (const token of tokens) {
    if (!normalizedEquals(token.value, normalizedItem)) continue;

    const nearby = windowAround(tokens, token.index, 6);
    const hasExactCue = nearby.some(candidate =>
      exactCountWords.has(candidate.value)
    );

    if (!hasExactCue) continue;

    for (const candidate of nearby) {
      if (candidate.numberValue !== null) {
        return candidate.numberValue;
      }
    }
  }

  return null;
};

const findTotalMinimum = (
  tokens: Token[]
):
  | {
      metric: MetricName;
      metricLabel: string;
      minimum: number;
    }
  | null => {
  for (const token of tokens) {
    if (!genericMetricWords.has(token.value)) continue;

    const metric = metricFromToken(token.value);

    if (metric === "unknown") continue;

    const nearby = windowAround(tokens, token.index, 5);
    const numberToken = nearby.find(candidate => candidate.numberValue !== null);

    if (!numberToken || numberToken.numberValue === null) continue;

    const hasPerItemScope = nearby.some(candidate => scopeWords.has(candidate.value));

    if (hasPerItemScope) continue;

    return {
      metric,
      metricLabel: metricLabelFromToken(token.value),
      minimum: numberToken.numberValue
    };
  }

  return null;
};

const isExactCountSubject = (
  candidate: Token,
  nearby: Token[]
): boolean => {
  if (!genericMetricWords.has(candidate.value)) {
    return true;
  }

  if (candidate.value !== "test" && candidate.value !== "tests") {
    return false;
  }

  return nearby.some((token) => exactCountActionWords.has(token.value));
};

const findExactCounts = (
  tokens: Token[],
  excludedSubject: string | null
): Array<{ subject: string; expected: number }> => {
  const counts: Array<{ subject: string; expected: number }> = [];

  for (const token of tokens) {
    if (token.numberValue === null) continue;

    const nearby = windowAround(tokens, token.index, 5);
    const subject = nearby.find(
      candidate =>
        candidate.index !== token.index &&
        candidate.numberValue === null &&
        !stopWords.has(candidate.value) &&
        !exactCountWords.has(candidate.value) &&
        !exactCountActionWords.has(candidate.value) &&
        isExactCountSubject(candidate, nearby)
    );

    if (!subject) continue;

    const normalizedSubject = normalizeTerm(subject.value);

    if (excludedSubject && normalizedEquals(normalizedSubject, excludedSubject)) {
      continue;
    }

    const hasExactCue = nearby.some(candidate =>
      exactCountWords.has(candidate.value)
    );

    if (!hasExactCue) continue;

    counts.push({
      subject: normalizedSubject,
      expected: token.numberValue
    });
  }

  return counts;
};

const createInitialCriteria = (
  goalText: string,
  messages: ChatMessage[]
): GoalCriterion[] => {
  const targetPath = inferTargetPath(goalText, messages);
  const tokens = tokenize(goalText);
  const criteria: GoalCriterion[] = [];
  const perItem = findPerItemRequest(tokens);

  if (perItem) {
    const expectedItemCount = findExactItemCount(tokens, perItem.itemName);

    criteria.push({
      type: "minimum_per_item",
      itemName: perItem.itemName,
      metric: perItem.metric,
      metricLabel: perItem.metricLabel,
      minimumPerItem: perItem.minimumPerItem,
      expectedItemCount,
      targetPath,
      items: [],
      complete: false,
      reason: "Per-item acceptance has not been verified yet."
    });

    if (expectedItemCount !== null) {
      criteria.push({
        type: "exact_count",
        subject: perItem.itemName,
        expected: expectedItemCount,
        actual: null,
        targetPath,
        complete: false,
        reason: "Exact item count has not been verified yet."
      });
    }

    return criteria;
  }

  const totalMinimum = findTotalMinimum(tokens);

  if (totalMinimum) {
    criteria.push({
      type: "minimum_total",
      metric: totalMinimum.metric,
      metricLabel: totalMinimum.metricLabel,
      minimum: totalMinimum.minimum,
      actual: null,
      targetPath,
      complete: false,
      reason: "Total metric minimum has not been verified yet."
    });
  }

  for (const count of findExactCounts(tokens, null)) {
    criteria.push({
      type: "exact_count",
      subject: count.subject,
      expected: count.expected,
      actual: null,
      targetPath,
      complete: false,
      reason: "Exact count has not been verified yet."
    });
  }

  if (criteria.length === 0) {
    criteria.push({
      type: "acceptance",
      description: goalText.trim() || "Complete the user's goal.",
      evidence: null,
      complete: false,
      reason:
        "This goal requires agent-created acceptance evidence because no simple numeric criterion was detected."
    });
  }

  return criteria;
};

export const buildGoalRuntimeState = (
  command: AgentCommandInvocation | null | undefined,
  messages: ChatMessage[] = []
): GoalRuntimeState | null => {
  if (!command || command.name !== "goal") {
    return null;
  }

  const target = commandText(command);

  return {
    active: true,
    target,
    criteria: createInitialCriteria(target, messages),
    evidence: [],
    situationScanRequired: requiresVerificationCommand(target),
    maxObservedEvidence: 0
  };
};

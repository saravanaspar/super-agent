import type {
  ChatMessage,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import { toJsonRecord, type JsonRecord } from "@shared/json";

interface ReadCoverageRange {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  sourceTool: string;
}

interface DocumentAnalysisEvidence {
  path: string;
  verifiedFullRead: boolean;
  truncated: boolean;
  hasStructuredItems: boolean;
  hasContentPreviews: boolean;
  itemCount: number | null;
}

interface NextReadRange {
  path: string;
  offset: number;
  limit: number;
  totalLines: number;
  reason: string;
}

export interface EvidenceRuntimeState {
  required: boolean;
  satisfied: boolean;
  requiresCompleteRead: boolean;
  requiresDocumentAnalysis: boolean;
  requiresContentExplanation: boolean;
  sawPartialRead: boolean;
  sawToolTruncation: boolean;
  sawDisplayTruncation: boolean;
  lastFailure: string | null;
  reason: string;
  readRanges: ReadCoverageRange[];
  documentAnalyses: DocumentAnalysisEvidence[];
  verifiedEvidence: string[];
}

export interface EvidenceVerificationResult {
  complete: boolean;
  summary: string;
  nextAction: string;
  state: EvidenceRuntimeState;
}

const countTokens = new Set([
  "count",
  "counts",
  "number",
  "numbers",
  "total",
  "totals",
  "many",
  "each",
  "per",
  "list",
  "breakdown",
  "inventory"
]);

const structureTokens = new Set([
  "artifact",
  "artifacts",
  "chapter",
  "chapters",
  "code",
  "document",
  "documents",
  "essay",
  "file",
  "files",
  "folder",
  "folders",
  "heading",
  "headings",
  "line",
  "lines",
  "page",
  "pages",
  "section",
  "sections",
  "slide",
  "slides",
  "text",
  "word",
  "words",
  "workspace"
]);

const completeReadTokens = new Set([
  "all",
  "complete",
  "completely",
  "entire",
  "everything",
  "full",
  "fully",
  "whole"
]);

const explanationTokens = new Set([
  "about",
  "analyse",
  "analyze",
  "audit",
  "content",
  "contents",
  "describe",
  "description",
  "detail",
  "details",
  "explain",
  "explanation",
  "inspect",
  "meaning",
  "read",
  "review",
  "summarize",
  "summarise",
  "summary",
  "understand"
]);

const readToolNames = new Set(["read_file"]);

const deterministicEvidenceKinds = new Set([
  "document_analysis",
  "code_analysis",
  "test_result",
  "verification",
  "evidence"
]);

const defaultReadChunkLimit = 80;
const maxReadChunkLimit = 400;
const minNarrowReadLimit = 12;

const isDigit = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
};

const isLetter = (char: string): boolean => {
  if (!char) return false;
  return char.toLowerCase() !== char.toUpperCase();
};

const isTokenChar = (char: string): boolean =>
  isLetter(char) || isDigit(char);

const tokenize = (value: string): Set<string> => {
  const tokens = new Set<string>();
  let token = "";

  const flush = () => {
    if (token.length > 0) {
      tokens.add(token.toLowerCase());
      token = "";
    }
  };

  for (const char of value) {
    if (isTokenChar(char)) {
      token += char;
      continue;
    }

    flush();
  }

  flush();
  return tokens;
};

const tokenScore = (tokens: Set<string>, candidates: Set<string>): number => {
  let score = 0;

  for (const candidate of candidates) {
    if (tokens.has(candidate)) {
      score += 1;
    }
  }

  return score;
};

const latestUserText = (messages: ChatMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "user") {
      const rawCommand =
        typeof message.metadata.rawCommand === "string"
          ? message.metadata.rawCommand
          : "";

      return [rawCommand, message.content].filter(Boolean).join("\n");
    }
  }

  return "";
};

const readRecord = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return toJsonRecord(value);
};

const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const readString = (record: JsonRecord, key: string): string => {
  const value = record[key];

  return typeof value === "string" ? value : "";
};

const readBoolean = (record: JsonRecord, key: string): boolean =>
  record[key] === true;

const readNumber = (record: JsonRecord, key: string): number | null => {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const textContainsDisplayTruncationMarker = (value: string): boolean =>
  value.includes("[display truncated") ||
  value.includes("[truncated]") ||
  value.includes("inspect with a narrower command or line range");

const normalizePath = (value: string): string =>
  value.replaceAll("\\", "/").trim();

const requiresEvidenceFromText = (text: string): EvidenceRuntimeState => {
  const tokens = tokenize(text);
  const countScore = tokenScore(tokens, countTokens);
  const structureScore = tokenScore(tokens, structureTokens);
  const completeReadScore = tokenScore(tokens, completeReadTokens);
  const explanationScore = tokenScore(tokens, explanationTokens);

  const asksHowMany = tokens.has("how") && tokens.has("many");
  const asksPerStructure =
    tokens.has("per") || tokens.has("each") || tokens.has("breakdown");
  const asksForContentExplanation =
    explanationScore > 0 &&
    (structureScore > 0 || asksPerStructure || tokens.has("content"));
  const asksToReviewArtifacts =
    explanationScore > 0 && structureScore > 0;

  const requiresDocumentAnalysis =
    structureScore > 0 &&
    (countScore > 0 || asksHowMany || asksPerStructure);

  const requiresCompleteRead =
    asksToReviewArtifacts ||
    asksForContentExplanation ||
    (completeReadScore > 0 && (structureScore > 0 || explanationScore > 0));

  const required =
    requiresDocumentAnalysis ||
    requiresCompleteRead ||
    asksForContentExplanation;

  return {
    required,
    satisfied: false,
    requiresCompleteRead,
    requiresDocumentAnalysis,
    requiresContentExplanation: asksForContentExplanation,
    sawPartialRead: false,
    sawToolTruncation: false,
    sawDisplayTruncation: false,
    lastFailure: null,
    reason: required
      ? "The user requested verifiable file, document, folder, count, structure, or content evidence."
      : "",
    readRanges: [],
    documentAnalyses: [],
    verifiedEvidence: []
  };
};

export const buildEvidenceRuntimeState = (
  prompt: string,
  messages: ChatMessage[]
): EvidenceRuntimeState | null => {
  const combined = [latestUserText(messages), prompt].filter(Boolean).join("\n");
  const state = requiresEvidenceFromText(combined);

  return state.required ? state : null;
};

export const isEvidenceToolCall = (call: ToolCallRecord): boolean =>
  call.name === "read_file";

const evidencePathKey = (path: string): string =>
  normalizePath(path).toLowerCase();

const readCoverageRange = (
  result: ToolResultRecord
): ReadCoverageRange | null => {
  const data = readRecord(result.data);
  const path = readString(data, "path");
  const offset = readNumber(data, "offset");
  const returnedLines = readNumber(data, "returned_lines");
  const totalLines = readNumber(data, "total_lines");

  if (!path || returnedLines === null || totalLines === null) {
    return null;
  }

  const startLine =
    offset !== null && offset > 0
      ? Math.floor(offset)
      : 1;
  const safeReturnedLines = Math.max(0, Math.floor(returnedLines));
  const endLine =
    safeReturnedLines > 0
      ? startLine + safeReturnedLines - 1
      : startLine;
  const content = readString(data, "content");
  const truncated =
    readBoolean(data, "truncated") ||
    readBoolean(data, "content_truncated") ||
    textContainsDisplayTruncationMarker(content) ||
    textContainsDisplayTruncationMarker(result.message);

  return {
    path: normalizePath(path),
    startLine,
    endLine,
    totalLines: Math.max(0, Math.floor(totalLines)),
    truncated,
    sourceTool: result.toolName
  };
};

const chapterHasPreview = (chapter: unknown): boolean => {
  const record = readRecord(chapter);
  const preview = readString(record, "preview");

  return preview.trim().length > 0;
};

const documentAnalysisEvidence = (
  result: ToolResultRecord
): DocumentAnalysisEvidence | null => {
  const data = readRecord(result.data);
  const kind = readString(data, "kind");

  if (kind !== "document_analysis") {
    return null;
  }

  const path = readString(data, "path") || result.toolName;
  const chapters = readArray(data.chapters);
  const chapterCount = readNumber(data, "chapterCount");
  const verifiedFullRead = readBoolean(data, "verifiedFullRead");
  const truncated =
    readBoolean(data, "truncated") ||
    readBoolean(data, "content_truncated");

  const itemCount =
    chapterCount !== null
      ? chapterCount
      : chapters.length > 0
        ? chapters.length
        : null;

  return {
    path: normalizePath(path),
    verifiedFullRead,
    truncated,
    hasStructuredItems: itemCount !== null && itemCount > 0,
    hasContentPreviews:
      chapters.length > 0 && chapters.every(chapterHasPreview),
    itemCount
  };
};

const replaceOrAddReadRange = (
  ranges: ReadCoverageRange[],
  next: ReadCoverageRange
): ReadCoverageRange[] => {
  const nextKey = evidencePathKey(next.path);
  const withoutDuplicate = ranges.filter(range => {
    const samePath = evidencePathKey(range.path) === nextKey;
    const sameStart = range.startLine === next.startLine;
    const sameEnd = range.endLine === next.endLine;
    const sameTool = range.sourceTool === next.sourceTool;

    return !(samePath && sameStart && sameEnd && sameTool);
  });

  return [...withoutDuplicate, next];
};

const replaceOrAddDocumentAnalysis = (
  analyses: DocumentAnalysisEvidence[],
  next: DocumentAnalysisEvidence
): DocumentAnalysisEvidence[] => {
  const nextKey = evidencePathKey(next.path);
  const withoutDuplicate = analyses.filter(
    analysis => evidencePathKey(analysis.path) !== nextKey
  );

  return [...withoutDuplicate, next];
};

const sortedRangesForPath = (
  state: EvidenceRuntimeState,
  path: string
): ReadCoverageRange[] => {
  const key = evidencePathKey(path);

  return state.readRanges
    .filter(range => evidencePathKey(range.path) === key)
    .sort((left, right) => left.startLine - right.startLine);
};

const mergedCoverageEnd = (ranges: ReadCoverageRange[]): number => {
  let coverageEnd = 0;

  for (const range of ranges) {
    if (range.truncated) {
      continue;
    }

    if (range.startLine > coverageEnd + 1) {
      break;
    }

    coverageEnd = Math.max(coverageEnd, range.endLine);
  }

  return coverageEnd;
};

const pathTotalLines = (ranges: ReadCoverageRange[]): number => {
  let totalLines = 0;

  for (const range of ranges) {
    totalLines = Math.max(totalLines, range.totalLines);
  }

  return totalLines;
};

const pathFullyCovered = (
  state: EvidenceRuntimeState,
  path: string
): boolean => {
  const ranges = sortedRangesForPath(state, path);
  const totalLines = pathTotalLines(ranges);

  if (totalLines <= 0 || ranges.length === 0) {
    return false;
  }

  return mergedCoverageEnd(ranges) >= totalLines;
};

const knownReadPaths = (state: EvidenceRuntimeState): string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const range of state.readRanges) {
    const key = evidencePathKey(range.path);

    if (seen.has(key)) continue;

    seen.add(key);
    paths.push(range.path);
  }

  return paths;
};

const allKnownReadPathsCovered = (state: EvidenceRuntimeState): boolean => {
  const paths = knownReadPaths(state);

  if (paths.length === 0) {
    return false;
  }

  return paths.every(path => pathFullyCovered(state, path));
};

const earliestTruncatedRange = (
  state: EvidenceRuntimeState
): ReadCoverageRange | null => {
  const truncatedRanges = [...state.readRanges]
    .filter(range => range.truncated)
    .sort((left, right) => {
      const pathCompare = evidencePathKey(left.path).localeCompare(
        evidencePathKey(right.path)
      );

      if (pathCompare !== 0) {
        return pathCompare;
      }

      const startCompare = left.startLine - right.startLine;

      if (startCompare !== 0) {
        return startCompare;
      }

      return left.endLine - right.endLine;
    });

  return truncatedRanges[0] ?? null;
};

const nextReadRange = (
  state: EvidenceRuntimeState
): NextReadRange | null => {
  const truncated = earliestTruncatedRange(state);

  if (truncated) {
    const attemptedLines = Math.max(
      1,
      truncated.endLine - truncated.startLine + 1
    );
    const narrowerLimit = Math.max(
      minNarrowReadLimit,
      Math.floor(attemptedLines / 2)
    );

    return {
      path: truncated.path,
      offset: truncated.startLine,
      limit: Math.min(narrowerLimit, defaultReadChunkLimit),
      totalLines: truncated.totalLines,
      reason:
        "The previous read range was displayed or tool-truncated, so it must be retried with a narrower line range."
    };
  }

  for (const path of knownReadPaths(state)) {
    const ranges = sortedRangesForPath(state, path);
    const totalLines = pathTotalLines(ranges);

    if (totalLines <= 0) continue;

    const coverageEnd = mergedCoverageEnd(ranges);

    if (coverageEnd >= totalLines) {
      continue;
    }

    const offset = coverageEnd + 1;
    const remaining = Math.max(1, totalLines - coverageEnd);
    const limit = Math.min(
      Math.max(remaining, defaultReadChunkLimit),
      maxReadChunkLimit
    );

    return {
      path,
      offset,
      limit,
      totalLines,
      reason:
        coverageEnd === 0
          ? "The file has not been read from the beginning with complete visible evidence."
          : `Only lines 1-${coverageEnd} of ${totalLines} have complete visible evidence.`
    };
  }

  return null;
};

const completeReadEvidenceSatisfied = (
  state: EvidenceRuntimeState
): boolean =>
  state.requiresCompleteRead && allKnownReadPathsCovered(state);

const structuredDocumentEvidenceSatisfied = (
  state: EvidenceRuntimeState
): boolean =>
  state.documentAnalyses.some(
    analysis =>
      analysis.verifiedFullRead &&
      !analysis.truncated &&
      analysis.hasStructuredItems
  );

const contentExplanationEvidenceSatisfied = (
  state: EvidenceRuntimeState
): boolean => {
  if (!state.requiresContentExplanation) {
    return true;
  }

  if (completeReadEvidenceSatisfied(state)) {
    return true;
  }

  return state.documentAnalyses.some(
    analysis =>
      analysis.verifiedFullRead &&
      !analysis.truncated &&
      analysis.hasStructuredItems &&
      analysis.hasContentPreviews
  );
};

const deterministicEvidenceSucceeded = (
  result: ToolResultRecord
): boolean => {
  const data = readRecord(result.data);
  const kind = readString(data, "kind");

  if (!result.ok || readBoolean(data, "truncated")) {
    return false;
  }

  return (
    readBoolean(data, "verifiedFullRead") &&
    deterministicEvidenceKinds.has(kind)
  );
};

export const updateEvidenceStateFromToolResult = (
  state: EvidenceRuntimeState | null,
  result: ToolResultRecord
): void => {
  if (!state) return;

  const data = readRecord(result.data);
  const coverage = readCoverageRange(result);
  const analysis = documentAnalysisEvidence(result);

  if (coverage) {
    state.readRanges = replaceOrAddReadRange(state.readRanges, coverage);

    const partialByLineCoverage =
      coverage.totalLines > 0 && coverage.endLine < coverage.totalLines;
    const partialByStart = coverage.startLine > 1;

    if (partialByLineCoverage || partialByStart) {
      state.sawPartialRead = true;
    }

    if (coverage.truncated) {
      state.sawToolTruncation = true;
    }

    const content = readString(data, "content");

    if (
      textContainsDisplayTruncationMarker(content) ||
      textContainsDisplayTruncationMarker(result.message)
    ) {
      state.sawDisplayTruncation = true;
    }
  }

  if (analysis) {
    state.documentAnalyses = replaceOrAddDocumentAnalysis(
      state.documentAnalyses,
      analysis
    );

    if (
      state.requiresContentExplanation &&
      analysis.verifiedFullRead &&
      analysis.hasStructuredItems &&
      !analysis.hasContentPreviews
    ) {
      state.lastFailure =
        `${analysis.path} was structurally analyzed, but content previews were not included.`;
    }
  }

  if (deterministicEvidenceSucceeded(result)) {
    const path = readString(data, "path") || result.toolName;

    state.satisfied = true;
    state.lastFailure = null;
    state.verifiedEvidence = [
      ...state.verifiedEvidence.filter(item => item !== path),
      path
    ];

    return;
  }

  if (
    result.toolName.includes("analysis") ||
    result.toolName.includes("verify")
  ) {
    if (!result.ok) {
      state.lastFailure = result.message;
    }
  }

  if (readToolNames.has(result.toolName) && coverage && !pathFullyCovered(state, coverage.path)) {
    const next = nextReadRange(state);

    state.lastFailure = next
      ? `${coverage.path} was only partially read. ${next.reason}`
      : `${coverage.path} was only partially read.`;
  }
};

const completeReadSummary = (
  state: EvidenceRuntimeState
): string => {
  const paths = knownReadPaths(state);

  if (paths.length === 0) {
    return "No complete file-read evidence has been collected.";
  }

  const incomplete = paths.filter(path => !pathFullyCovered(state, path));

  if (incomplete.length === 0) {
    return `Complete read evidence exists for ${paths.length} file(s).`;
  }

  return `Partial read evidence remains for ${incomplete.join(", ")}.`;
};

const documentAnalysisSummary = (
  state: EvidenceRuntimeState
): string => {
  if (state.documentAnalyses.length === 0) {
    return "No deterministic document analysis has been collected.";
  }

  const summaries = state.documentAnalyses.map(analysis => {
    const itemCount =
      analysis.itemCount === null
        ? "unknown item count"
        : `${analysis.itemCount} item(s)`;
    const previewState = analysis.hasContentPreviews
      ? "with content previews"
      : "without content previews";

    return `${analysis.path}: ${itemCount}, ${previewState}`;
  });

  return `Document analysis evidence: ${summaries.join("; ")}.`;
};

const incompleteEvidenceReason = (
  state: EvidenceRuntimeState
): string => {
  if (
    state.requiresContentExplanation &&
    structuredDocumentEvidenceSatisfied(state) &&
    !contentExplanationEvidenceSatisfied(state)
  ) {
    return "The document structure was verified, but content explanation requires chapter/section previews or complete non-truncated reads.";
  }

  if (state.sawDisplayTruncation) {
    return "Displayed tool output was truncated, so the visible evidence cannot be treated as complete.";
  }

  if (state.sawToolTruncation) {
    return "A tool result was truncated, so the visible evidence cannot be treated as complete.";
  }

  if (state.sawPartialRead) {
    return "At least one file read returned fewer lines than the file contains.";
  }

  return "Deterministic or complete-read evidence has not been produced yet.";
};

const hasUsableEvidence = (state: EvidenceRuntimeState): boolean => {
  if (state.satisfied) {
    return true;
  }

  if (state.requiresContentExplanation) {
    return contentExplanationEvidenceSatisfied(state);
  }

  if (state.requiresDocumentAnalysis) {
    return structuredDocumentEvidenceSatisfied(state);
  }

  if (state.requiresCompleteRead) {
    return completeReadEvidenceSatisfied(state);
  }

  return state.verifiedEvidence.length > 0;
};

export const verifyEvidenceRequirement = (
  state: EvidenceRuntimeState | null
): EvidenceVerificationResult | null => {
  if (!state) return null;

  if (hasUsableEvidence(state)) {
    return {
      complete: true,
      summary: state.requiresContentExplanation
        ? "Evidence requirement satisfied with content-level evidence."
        : state.requiresDocumentAnalysis
          ? "Evidence requirement satisfied with deterministic structure evidence."
          : "Evidence requirement satisfied with complete-read evidence.",
      nextAction: "Final answer may now use the verified evidence.",
      state
    };
  }

  const next = nextReadRange(state);

  if (next) {
    return {
      complete: false,
      summary: [
        incompleteEvidenceReason(state),
        completeReadSummary(state),
        documentAnalysisSummary(state)
      ].join(" "),
      nextAction: [
        `Read the next missing or truncated range before answering: ${next.path}.`,
        `Use offset ${next.offset} and limit ${next.limit}.`,
        "Do not summarize or finalize from an earlier partial chunk.",
        "After the next read, verify line coverage and truncation again."
      ].join(" "),
      state
    };
  }

  if (
    state.requiresContentExplanation &&
    structuredDocumentEvidenceSatisfied(state) &&
    !contentExplanationEvidenceSatisfied(state)
  ) {
    return {
      complete: false,
      summary: [
        incompleteEvidenceReason(state),
        documentAnalysisSummary(state)
      ].join(" "),
      nextAction: [
        "Read the relevant file completely with bounded read_file ranges.",
        "If one read returns fewer lines than total_lines, continue from returned end + 1.",
        "Do not explain chapters, sections, slides, or file contents from structure-only counts."
      ].join(" "),
      state
    };
  }

  const nextAction = state.requiresDocumentAnalysis
    ? [
        "Read the relevant file completely with bounded read_file ranges.",
        state.requiresContentExplanation
          ? "Use complete visible file content when the user asks what each chapter, section, slide, or file is about."
          : "Complete read evidence is required for count or inventory questions.",
        "If the target file is unknown, list the workspace first, then completely read each relevant file."
      ].join(" ")
    : [
        "Read every relevant file completely before answering.",
        "If a read returns returned_lines lower than total_lines, read the next range automatically.",
        "Do not treat truncated terminal output as complete content."
      ].join(" ");

  return {
    complete: false,
    summary: [
      incompleteEvidenceReason(state),
      completeReadSummary(state),
      documentAnalysisSummary(state)
    ].join(" "),
    nextAction,
    state
  };
};

export const evidenceContinuationMessage = (
  verification: EvidenceVerificationResult
): string =>
  [
    `Internal evidence state: ${verification.summary}`,
    `Required next step: ${verification.nextAction}`,
    "Evidence rules are mandatory for file review, folder review, complete-read, summary, count, line, word, inventory, and per-item tasks.",
    "A read is incomplete when returned_lines is lower than total_lines, even if truncated is false.",
    "A display truncation marker means visible evidence is incomplete.",
    "Structure-only analyzer output may answer counts, but content explanations require previews or complete non-truncated reads.",
    "Continue with narrower ranges, next offsets, deterministic analyzers, or targeted tools. Do not ask the user to continue.",
    "Never infer final content from a preview, stale reasoning, structure-only counts, or only the first chunk."
  ].join("\n");

export const evidenceProgressMessage = (
  verification: EvidenceVerificationResult
): string =>
  verification.complete
    ? "Evidence verified."
    : "Evidence verification still required.";

const readCoverageToJson = (range: ReadCoverageRange): JsonRecord => ({
  path: range.path,
  startLine: range.startLine,
  endLine: range.endLine,
  totalLines: range.totalLines,
  truncated: range.truncated,
  sourceTool: range.sourceTool
});

const documentAnalysisToJson = (
  analysis: DocumentAnalysisEvidence
): JsonRecord => ({
  path: analysis.path,
  verifiedFullRead: analysis.verifiedFullRead,
  truncated: analysis.truncated,
  hasStructuredItems: analysis.hasStructuredItems,
  hasContentPreviews: analysis.hasContentPreviews,
  itemCount: analysis.itemCount
});

const nextReadRangeToJson = (range: NextReadRange | null): JsonRecord | null => {
  if (!range) return null;

  return {
    path: range.path,
    offset: range.offset,
    limit: range.limit,
    totalLines: range.totalLines,
    reason: range.reason
  };
};

export const evidenceStateMetadata = (
  verification: EvidenceVerificationResult
): JsonRecord => ({
  visibility: "internal",
  timelineKind: "evidence_state",
  label: "Evidence state",
  complete: verification.complete,
  summary: verification.summary,
  nextAction: verification.nextAction,
  requiresCompleteRead: verification.state.requiresCompleteRead,
  requiresDocumentAnalysis: verification.state.requiresDocumentAnalysis,
  requiresContentExplanation: verification.state.requiresContentExplanation,
  sawPartialRead: verification.state.sawPartialRead,
  sawToolTruncation: verification.state.sawToolTruncation,
  sawDisplayTruncation: verification.state.sawDisplayTruncation,
  lastFailure: verification.state.lastFailure,
  readRanges: verification.state.readRanges.map(readCoverageToJson),
  documentAnalyses: verification.state.documentAnalyses.map(documentAnalysisToJson),
  verifiedEvidence: verification.state.verifiedEvidence,
  nextReadRange: nextReadRangeToJson(nextReadRange(verification.state))
});
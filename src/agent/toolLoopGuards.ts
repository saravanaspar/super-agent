import { successResult } from "@tool-registry/types";
import type { ToolCallRecord, ToolResultRecord } from "@shared/types";
import { toJsonRecord, type JsonRecord, type JsonValue } from "@shared/json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ToolLoopLimits {
  maxDuplicateToolCalls: number;
}

export type RepeatGuardDecisionKind = "allowed" | "identical_tool" | "covered_read" | "unchanged_read" | "idempotent_no_progress" | "repeated_failure";

export interface RepeatGuardDecision {
  allowed: boolean;
  reason: string | null;
  kind: RepeatGuardDecisionKind;
  path?: string;
}

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

export const toolCallFingerprint = (call: ToolCallRecord): string =>
  `${call.name}:${stableStringify(call.input)}`;

const idempotentNoProgressToolNames = new Set([
  "exists",
  "grep",
  "list_processes",
  "ls",
  "project_index",
  "query_context",
  "read_file",
  "search_web",
  "situation_scan",
  "web_fetch",
  "workspace.path"
]);

export const stateMutationToolNames = new Set([
  "append_file",
  "bash",
  "delete_file",
  "edit_file",
  "edit_range",
  "write_file"
]);

export const fileEditToolNames = new Set([
  "append_file",
  "delete_file",
  "edit_file",
  "edit_range",
  "write_file"
]);

export const codeLikeFilePattern = /\.(?:[cm]?[jt]sx?|mjs|cjs|ts|tsx|py|rs|go|java|kt|kts|swift|php|rb|cs|cpp|cc|cxx|c|h|hpp|scala|dart|lua|sh|bash|zsh|sql|ya?ml|json)$/i;

const resultDataWithLoopGuidance = (
  data: JsonValue,
  guidance: JsonRecord
): JsonValue => {
  if (isRecord(data)) {
    return { ...data, tool_loop_guidance: guidance };
  }

  return { value: data, tool_loop_guidance: guidance };
};

const withLoopGuidance = (
  result: ToolResultRecord,
  guidance: string,
  metadata: JsonRecord
): ToolResultRecord => ({
  ...result,
  message: `${result.message}\n\n${guidance}`,
  data: resultDataWithLoopGuidance(result.data, metadata)
});

const toolResultFingerprint = (result: ToolResultRecord): string =>
  stableStringify({
    ok: result.ok,
    blocked: result.blocked,
    message: result.message,
    data: result.data
  });

export class ConsecutiveToolCallGuard {
  private currentFingerprint: string | null = null;
  private currentCount = 0;
  private readonly exactFailureCounts = new Map<string, number>();
  private readonly toolFailureCounts = new Map<string, number>();
  private readonly idempotentNoProgressByFingerprint = new Map<string, { count: number; resultHash: string }>();

  constructor(
    private readonly warningThreshold: number,
    private readonly hardStopEnabled = false
  ) {}

  check(call: ToolCallRecord): RepeatGuardDecision {
    const fingerprint = toolCallFingerprint(call);

    if (fingerprint === this.currentFingerprint) {
      this.currentCount += 1;
    } else {
      this.currentFingerprint = fingerprint;
      this.currentCount = 1;
    }

    const noProgress = this.idempotentNoProgressByFingerprint.get(fingerprint);

    if (idempotentNoProgressToolNames.has(call.name) && noProgress && noProgress.count >= this.warningThreshold) {
      return {
        allowed: false,
        reason: [
          "Repeated no-progress tool call skipped.",
          "This exact idempotent tool/input already returned the same result repeatedly.",
          "Use the existing result, change the query/range, edit directly, verify differently, or produce the final answer."
        ].join(" "),
        kind: "idempotent_no_progress"
      };
    }

    const exactFailureCount = this.exactFailureCounts.get(fingerprint) ?? 0;
    if (exactFailureCount >= this.warningThreshold) {
      return {
        allowed: false,
        reason: [
          "Repeated failed tool call skipped.",
          "This exact tool/input already failed repeatedly and the previous failure is still valid.",
          "Do not retry it unchanged; inspect the error, change strategy, use a smaller/different input, or answer from existing evidence."
        ].join(" "),
        kind: "repeated_failure"
      };
    }

    if (!this.hardStopEnabled || this.currentCount <= this.warningThreshold + 2) {
      return { allowed: true, reason: null, kind: "allowed" };
    }

    return {
      allowed: false,
      reason: [
        "Repeated identical tool call stopped after multiple unchanged attempts.",
        "Use a different tool/input, inspect the previous result, or produce the final answer."
      ].join(" "),
      kind: "identical_tool"
    };
  }

  recordResult(call: ToolCallRecord, result: ToolResultRecord): ToolResultRecord {
    const warnings: Array<{ guidance: string; metadata: JsonRecord }> = [];
    const fingerprint = toolCallFingerprint(call);

    if (result.ok) {
      this.exactFailureCounts.delete(fingerprint);
      this.toolFailureCounts.delete(call.name);
    } else {
      const exactFailureCount = (this.exactFailureCounts.get(fingerprint) ?? 0) + 1;
      this.exactFailureCounts.set(fingerprint, exactFailureCount);

      if (exactFailureCount > this.warningThreshold) {
        warnings.push({
          guidance: [
            "Repeated failure guidance: this exact tool/input has failed repeatedly.",
            "Do not retry it unchanged; inspect the error, change strategy, use a smaller/different input, or answer from existing evidence."
          ].join(" "),
          metadata: {
            kind: "exact_repeated_failure",
            count: exactFailureCount,
            allowed_next_actions: ["search", "edit", "verify", "final"]
          }
        });
      }

      const toolFailureCount = (this.toolFailureCounts.get(call.name) ?? 0) + 1;
      this.toolFailureCounts.set(call.name, toolFailureCount);

      if (toolFailureCount > this.warningThreshold && toolFailureCount !== exactFailureCount) {
        warnings.push({
          guidance: [
            "Repeated tool failure guidance: this tool has failed repeatedly in this run.",
            "Change the arguments or switch tools instead of continuing the same failure pattern."
          ].join(" "),
          metadata: {
            kind: "same_tool_repeated_failure",
            count: toolFailureCount,
            allowed_next_actions: ["search", "edit", "verify", "final"]
          }
        });
      }
    }

    if (result.ok && stateMutationToolNames.has(call.name)) {
      this.idempotentNoProgressByFingerprint.clear();
    }

    if (result.ok && idempotentNoProgressToolNames.has(call.name)) {
      const resultHash = toolResultFingerprint(result);
      const previous = this.idempotentNoProgressByFingerprint.get(fingerprint);
      const noProgressCount = previous && previous.resultHash === resultHash
        ? previous.count + 1
        : 1;

      this.idempotentNoProgressByFingerprint.set(fingerprint, { count: noProgressCount, resultHash });

      if (noProgressCount >= this.warningThreshold) {
        warnings.push({
          guidance: [
            "No-progress guidance: this exact tool/input is returning the same result repeatedly.",
            "Use the existing result, change the query/range, edit directly, run a different verification, or produce the final answer."
          ].join(" "),
          metadata: {
            kind: "idempotent_no_progress",
            count: noProgressCount,
            allowed_next_actions: ["search_different_pattern", "edit", "verify", "final"]
          }
        });
      }
    }

    return warnings.reduce(
      (current, warning) => withLoopGuidance(current, warning.guidance, warning.metadata),
      result
    );
  }
}

export const sameTurnDuplicateToolResult = (call: ToolCallRecord): ToolResultRecord => {
  const softResult = successResult("Duplicate tool call in the same assistant turn skipped; use the first identical call result.", {
    input: call.input,
    duplicate_tool_call: true,
    same_turn_duplicate: true,
    content_returned: false,
    previous_result_still_valid: true,
    allowed_next_actions: ["search", "edit", "verify", "final"],
    nextAction: "Use the first identical tool result from this turn. Do not emit duplicate tool calls with unchanged input."
  });

  return {
    toolCallId: call.id,
    toolName: call.name,
    risk: call.risk,
    ...softResult
  };
};

const repeatedReadToolNames = new Set(["read_file"]);

const coverageReadToolNames = new Set(["read_file"]);


const malformedToolMarkers = [
  "<think",
  "</think",
  "<tool_call",
  "</tool_call",
  "<function=",
  "</function",
  "<parameter",
  "</parameter"
];

const sourcePayloadKeys = new Set([
  "content",
  "replacement",
  "replace",
  "search",
  "expected_old",
  "patch"
]);

const stringInputLooksMalformed = (value: string): boolean => {
  const lower = value.toLowerCase();

  return malformedToolMarkers.some(marker => lower.includes(marker));
};

export const toolInputLooksMalformed = (input: JsonRecord): boolean => {
  const stack: Array<{ value: unknown; key: string | null }> = [
    { value: input, key: null }
  ];

  while (stack.length > 0) {
    const item = stack.pop();
    const value = item?.value;
    const key = item?.key ?? null;

    if (
      typeof value === "string" &&
      !sourcePayloadKeys.has(key ?? "") &&
      stringInputLooksMalformed(value)
    ) {
      return true;
    }

    if (Array.isArray(value)) {
      for (const item of value as unknown[]) {
        stack.push({ value: item, key });
      }
      continue;
    }

    if (isRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        stack.push({ value: childValue, key: childKey });
      }
    }
  }

  return false;
};

interface ReadCoverage {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number | null;
}

const readToolInputPath = (input: JsonRecord): string => {
  const candidates = [input.path, input.relativePath, input.file, input.filePath];
  const value = candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0);

  return value ? normalizeReadCoveragePath(value) : "";
};

export const normalizeReadCoveragePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();

const readToolInputNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

export const readCoveragePathMatches = (recordedPath: string, requestedPath: string): boolean => {
  if (!recordedPath || !requestedPath) return false;
  if (recordedPath === requestedPath) return true;
  if (recordedPath.endsWith(`/${requestedPath}`)) return true;
  if (requestedPath.endsWith(`/${recordedPath}`)) return true;

  return false;
};

const readCoverageRangesOverlapOrTouch = (left: ReadCoverage, right: ReadCoverage): boolean =>
  readCoveragePathMatches(left.path, right.path) &&
  left.startLine <= right.endLine + 1 &&
  right.startLine <= left.endLine + 1;

const readCoverageCovers = (covered: ReadCoverage, requested: ReadCoverage): boolean =>
  readCoveragePathMatches(covered.path, requested.path) &&
  requested.startLine >= covered.startLine &&
  requested.endLine <= covered.endLine;

const fileMutationToolNames = stateMutationToolNames;

export class RepeatedReadToolGuard {
  private readonly counts = new Map<string, number>();
  private readonly coverage: ReadCoverage[] = [];
  private coveredReadWarningCount = 0;

  constructor(private readonly maxExactReadCalls = 2) {}

  shouldStopReadSpree(): boolean {
    return false;
  }

  private resetReadSpree(): void {
    this.coveredReadWarningCount = 0;
  }

  check(call: ToolCallRecord): RepeatGuardDecision {
    if (!repeatedReadToolNames.has(call.name)) {
      return { allowed: true, reason: null, kind: "allowed" };
    }

    const requestedPath = readToolInputPath(call.input);
    const fullFileCoverage = this.coverage.find((range) =>
      readCoveragePathMatches(range.path, requestedPath) &&
      range.totalLines !== null &&
      range.startLine === 1 &&
      range.endLine >= range.totalLines
    );

    if (fullFileCoverage) {
      this.coveredReadWarningCount += 1;

      return {
        allowed: false,
        reason: [
          "Repeated covered read skipped.",
          `${requestedPath || call.name} was already read completely in this run (${fullFileCoverage.totalLines} lines).`,
          "This file/range is already available in context. Use the previous tool result, grep/search line numbers, edit directly, or produce the final answer."
        ].join(" "),
        kind: "covered_read",
        path: requestedPath || fullFileCoverage.path
      };
    }

    if (coverageReadToolNames.has(call.name)) {
      const requestedOffset = Math.max(1, readToolInputNumber(call.input.offset) ?? 1);
      const requestedLimit = readToolInputNumber(call.input.limit);

      if (requestedLimit !== null) {
        const requested: ReadCoverage = {
          path: requestedPath,
          startLine: requestedOffset,
          endLine: requestedOffset + requestedLimit - 1,
          totalLines: null
        };
        const covered = this.coverage.find((range) => readCoverageCovers(range, requested));

        if (covered) {
          this.coveredReadWarningCount += 1;

          return {
            allowed: false,
            reason: [
              "Repeated covered read skipped.",
              `${requestedPath || call.name} lines ${requested.startLine}-${requested.endLine} were already read in this run.`,
              "This file/range is already available in context. Use the previous tool result, grep/search line numbers, edit directly, or produce the final answer."
            ].join(" "),
            kind: "covered_read",
            path: requestedPath || covered.path
          };
        }
      }
    }

    const fingerprint = toolCallFingerprint(call);
    const count = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, count);

    if (count <= this.maxExactReadCalls) {
      return { allowed: true, reason: null, kind: "allowed" };
    }

    return {
      allowed: false,
      reason: [
        "Repeated unchanged read skipped.",
        `The same read-style tool and exact input were requested ${count} times in this run.`,
        "Use the earlier tool result already in context, read a different range/file,",
        "or produce the review from the collected evidence instead of rereading."
      ].join(" "),
      kind: "unchanged_read"
    };
  }

  recordResult(result: ToolResultRecord): void {
    if (fileMutationToolNames.has(result.toolName) && result.ok) {
      this.coverage.length = 0;
      this.counts.clear();
      this.resetReadSpree();
      return;
    }

    if (result.blocked || !result.ok || !coverageReadToolNames.has(result.toolName)) {
      return;
    }

    this.recordReadCoverage(toJsonRecord(result.data));
  }

  private recordReadCoverage(data: JsonRecord): void {
    const path = readToolInputPath(data);
    const returnedLines = readToolInputNumber(data.returned_lines);
    const totalLines = readToolInputNumber(data.total_lines);

    if (!path || returnedLines === null || returnedLines <= 0) {
      return;
    }

    const startLine = Math.max(1, readToolInputNumber(data.offset) ?? 1);
    const endLine = startLine + returnedLines - 1;
    let next: ReadCoverage = { path, startLine, endLine, totalLines };

    for (let index = this.coverage.length - 1; index >= 0; index -= 1) {
      const current = this.coverage[index]!;

      if (!readCoverageRangesOverlapOrTouch(current, next)) {
        continue;
      }

      next = {
        path: current.path.length <= next.path.length ? current.path : next.path,
        startLine: Math.min(current.startLine, next.startLine),
        endLine: Math.max(current.endLine, next.endLine),
        totalLines: current.totalLines ?? next.totalLines
      };
      this.coverage.splice(index, 1);
    }

    this.coverage.push(next);
  }
}

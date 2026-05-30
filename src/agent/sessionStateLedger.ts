import type { ProviderMessage } from "@providers/interfaces/provider";
import type { RuntimeGateVerification } from "@agent/runtimeGates";
import type {
  ChatMessage,
  RoutedChatSubmitRequest,
  ToolCallRecord,
  ToolResultRecord
} from "@shared/types";
import { toJsonRecord, type JsonRecord } from "@shared/json";

export const SESSION_STATE_PREFIX = "CURRENT SESSION STATE";
const MAX_LEDGER_LINES = 40;

interface ReadFileState {
  path: string;
  totalLines: number | null;
  readUntilLine: number;
  fullyRead: boolean;
  contentAvailable: boolean;
}

interface DuplicateReadState {
  path: string;
  reason: string;
}

interface NoProgressState {
  toolName: string;
  input: string;
}

interface SessionStateLedgerInput {
  request: RoutedChatSubmitRequest;
  messages: ChatMessage[];
  workspaceDir: string;
}

interface BuildSessionStateInput {
  runtimeVerifications: readonly RuntimeGateVerification[];
}

const fileEditToolNames = new Set([
  "append_file",
  "delete_file",
  "edit_file",
  "edit_range",
  "write_file"
]);

const codeLikeFilePattern = /\.(?:[cm]?[jt]sx?|mjs|cjs|ts|tsx|py|rs|go|java|kt|kts|swift|php|rb|cs|cpp|cc|cxx|c|h|hpp|scala|dart|lua|sh|bash|zsh|sql|ya?ml|json)$/i;

const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();

const asRecord = (value: unknown): JsonRecord => toJsonRecord(value);

const readString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const readNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
};

const pathFromRecord = (record: JsonRecord): string => {
  const candidates = [record.path, record.file, record.filePath, record.relativePath];
  const value = candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  return value ? normalizePath(value) : "";
};

const callPath = (call: ToolCallRecord | null): string =>
  call ? pathFromRecord(call.input) : "";

const resultPath = (result: ToolResultRecord): string =>
  pathFromRecord(asRecord(result.data));

const pathMatches = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.endsWith(`/${right}`)) return true;
  return right.endsWith(`/${left}`);
};

const compactInput = (input: JsonRecord): string => {
  try {
    return JSON.stringify(input).slice(0, 180);
  } catch {
    return "[unserializable input]";
  }
};

const shellCommand = (call: ToolCallRecord | null, result: ToolResultRecord): string => {
  const fromCall = readString(call?.input.command);
  if (fromCall) return fromCall;
  return readString(asRecord(result.data).command);
};

const commandLooksLikeVerification = (command: string): boolean =>
  /\b(node\s+--check|npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|verify))|npx\s+(?:tsc|vitest|eslint)|pnpm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|verify))|yarn\s+(?:test|build|lint|typecheck|check)|pytest|python\s+-m\s+pytest|cargo\s+(?:test|check)|go\s+test|swift\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check|verify))\b/i.test(command);

const latestUserText = (messages: readonly ChatMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }

  return "";
};

const hasPriorReviewContext = (messages: readonly ChatMessage[]): boolean =>
  messages.some((message) => {
    const content = message.content.toLowerCase();
    return content.includes("scope reviewed") ||
      content.includes("findings by severity") ||
      content.includes("final review") ||
      content.includes("verdict:") ||
      message.metadata.timelineKind === "review_state";
  });

const userAskedToFixPriorReview = (
  request: RoutedChatSubmitRequest,
  messages: readonly ChatMessage[]
): boolean => {
  const prompt = `${request.prompt}\n${latestUserText(messages)}`.toLowerCase();
  if (!/\b(fix|fixes|fixed|repair|patch|resolve)\b/.test(prompt)) return false;
  return hasPriorReviewContext(messages);
};

const resultMetadata = (message: ChatMessage): ToolResultRecord | null => {
  const result = asRecord(message.metadata.result);
  const toolCallId = readString(result.toolCallId);
  const toolName = readString(result.toolName);

  if (!toolCallId || !toolName) return null;

  return {
    toolCallId,
    toolName,
    ok: result.ok === true,
    risk: result.risk === "medium" || result.risk === "high" ? result.risk : "safe",
    blocked: result.blocked === true,
    message: readString(result.message) || message.content,
    data: result.data ?? null
  };
};

export class SessionStateLedger {
  private readonly readFiles = new Map<string, ReadFileState>();
  private readonly duplicateReads: DuplicateReadState[] = [];
  private readonly noProgressCalls: NoProgressState[] = [];
  private readonly dirtyFiles = new Set<string>();
  private readonly filesRequiringInspection = new Set<string>();
  private readonly filesRequiringVerification = new Set<string>();
  private verificationAttempted = false;
  private verificationSucceeded = false;
  private readonly modeSwitchToFix: boolean;

  constructor(private readonly input: SessionStateLedgerInput) {
    this.modeSwitchToFix = userAskedToFixPriorReview(input.request, input.messages);
    this.seedFromMessages(input.messages);
  }

  recordToolResult(call: ToolCallRecord | null, result: ToolResultRecord): void {
    if (fileEditToolNames.has(result.toolName) && result.ok) {
      this.recordMutation(call, result);
      return;
    }

    if (result.toolName === "read_file") {
      this.recordRead(call, result);
      return;
    }

    if (result.toolName === "bash") {
      this.recordShell(call, result);
    }

    this.recordNoProgress(call, result);
  }

  buildMessage({ runtimeVerifications }: BuildSessionStateInput): ProviderMessage {
    const lines = [SESSION_STATE_PREFIX, ""];

    if (this.modeSwitchToFix) {
      lines.push(
        "Mode switch:",
        "- The user is asking to fix prior review findings.",
        "- Do not restart review; use prior findings and already-read context.",
        "- Make targeted edits, inspect changed regions, then run verification.",
        ""
      );
    }

    lines.push("Review:", `- Project: ${this.input.workspaceDir || "unknown"}`);
    lines.push(...this.reviewLines(runtimeVerifications), "");

    lines.push("Tool loop:");
    lines.push(...this.toolLoopLines(), "");

    lines.push("Edit:");
    lines.push(...this.editLines(), "");

    lines.push("Allowed next actions:");
    lines.push(...this.allowedActionLines(runtimeVerifications));

    return {
      role: "system",
      content: this.compactLines(lines)
    };
  }

  private seedFromMessages(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      const result = resultMetadata(message);
      if (result) this.recordToolResult(null, result);
    }
  }

  private recordMutation(call: ToolCallRecord | null, result: ToolResultRecord): void {
    const path = callPath(call) || resultPath(result);
    if (!path) return;

    this.clearReadCoverage(path);
    this.dirtyFiles.add(path);
    this.filesRequiringInspection.add(path);
    this.verificationAttempted = false;
    this.verificationSucceeded = false;

    if (codeLikeFilePattern.test(path)) {
      this.filesRequiringVerification.add(path);
    }
  }

  private recordRead(call: ToolCallRecord | null, result: ToolResultRecord): void {
    const data = asRecord(result.data);
    const path = resultPath(result) || callPath(call);

    if (data.duplicate_read === true && data.previous_result_still_valid === true) {
      this.addDuplicateRead(path || "read_file", result.message || "previous result valid");
      return;
    }

    if (result.blocked || !result.ok || !path) return;

    const offset = Math.max(1, readNumber(data.offset) ?? 1);
    const returnedLines = readNumber(data.returned_lines) ?? 0;
    const totalLines = readNumber(data.total_lines);
    const readUntilLine = returnedLines > 0 ? offset + returnedLines - 1 : 0;
    const previous = this.findReadState(path);
    const nextReadUntilLine = Math.max(previous?.readUntilLine ?? 0, readUntilLine);
    const nextTotalLines = totalLines ?? previous?.totalLines ?? null;

    this.readFiles.set(previous?.path ?? path, {
      path: previous?.path ?? path,
      totalLines: nextTotalLines,
      readUntilLine: nextReadUntilLine,
      fullyRead: nextTotalLines !== null && nextReadUntilLine >= nextTotalLines,
      contentAvailable: readString(data.content).length > 0 || previous?.contentAvailable === true
    });

    if (this.setHasMatchingPath(this.filesRequiringInspection, path)) {
      this.deleteMatchingPath(this.filesRequiringInspection, path);
    }
  }

  private recordShell(call: ToolCallRecord | null, result: ToolResultRecord): void {
    const command = shellCommand(call, result);
    if (!commandLooksLikeVerification(command)) return;

    this.verificationAttempted = true;
    const data = asRecord(result.data);
    const exitCode = readNumber(data.exit_code);
    const timedOut = data.timed_out === true || data.cancelled === true || data.aborted === true;
    this.verificationSucceeded = result.ok && !result.blocked && exitCode === 0 && !timedOut;

    if (this.verificationSucceeded) {
      this.filesRequiringVerification.clear();
    }
  }

  private recordNoProgress(call: ToolCallRecord | null, result: ToolResultRecord): void {
    const data = asRecord(result.data);
    const guidance = asRecord(data.tool_loop_guidance);
    const noProgress = data.no_progress === true || guidance.kind === "idempotent_no_progress";

    if (!noProgress) return;

    const toolName = call?.name ?? result.toolName;
    const input = call ? compactInput(call.input) : compactInput(asRecord(data.input));
    if (this.noProgressCalls.some((item) => item.toolName === toolName && item.input === input)) return;
    this.noProgressCalls.push({ toolName, input });
  }

  private reviewLines(runtimeVerifications: readonly RuntimeGateVerification[]): string[] {
    const review = runtimeVerifications.find((verification) => verification.kind === "review");
    const metadataFiles = Array.isArray(review?.metadata.files) ? review.metadata.files : [];
    const fileLines = metadataFiles
      .map((file): string | null => {
        const record = asRecord(file);
        const path = readString(record.path);
        if (!path) return null;
        const complete = record.complete === true ? "read complete" : "read incomplete";
        const totalLines = readNumber(record.totalLines);
        const readState = this.findReadState(path);
        const available = readState?.contentAvailable === true ? ", content available" : "";
        return `  - ${path}: ${complete}${totalLines === null ? "" : ` (${totalLines} lines)`}${available}`;
      })
      .filter((line): line is string => line !== null)
      .slice(0, 12);

    const readFileLines = [...this.readFiles.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, 12)
      .map((file) => `  - ${file.path}: ${file.fullyRead ? "read complete" : `read through line ${file.readUntilLine}`}${file.totalLines === null ? "" : ` (${file.totalLines} lines)`}${file.contentAvailable ? ", content available" : ""}`);

    return [
      "- Review files discovered:",
      ...(fileLines.length > 0 ? fileLines : readFileLines.length > 0 ? readFileLines : ["  - none recorded yet"]),
      `- Review coverage: ${review ? review.summary : "not active or not evaluated yet"}`,
      `- Next review action: ${review ? review.nextAction : "follow the current user request"}`
    ];
  }

  private toolLoopLines(): string[] {
    const duplicateLines = this.duplicateReads.slice(-6).map((item) =>
      `  - ${item.path}: already read; previous result valid. Do not call read_file for ${item.path} again unless it changed.`
    );
    const noProgressLines = this.noProgressCalls.slice(-6).map((item) =>
      `  - ${item.toolName} ${item.input} returned the same no-progress result repeatedly.`
    );

    return [
      "- Duplicate read attempts:",
      ...(duplicateLines.length > 0 ? duplicateLines : ["  - none"]),
      "- No-progress calls:",
      ...(noProgressLines.length > 0 ? noProgressLines : ["  - none"]),
      "- Do not repeat exact duplicate/no-progress read, search, list, or context calls."
    ];
  }

  private editLines(): string[] {
    return [
      `- Dirty files: ${this.formatSet(this.dirtyFiles)}.`,
      `- Files requiring inspection: ${this.formatSet(this.filesRequiringInspection)}.`,
      `- Files requiring verification: ${this.formatSet(this.filesRequiringVerification)}.`,
      `- Verification after edit: ${this.verificationSucceeded ? "passed" : this.verificationAttempted ? "attempted but not successful" : "not run"}.`
    ];
  }

  private allowedActionLines(runtimeVerifications: readonly RuntimeGateVerification[]): string[] {
    const review = runtimeVerifications.find((verification) => verification.kind === "review");
    const actions = [
      review?.complete ? "- final review using existing evidence" : "- next required runtime gate action",
      this.filesRequiringInspection.size > 0 ? "- inspect changed file/range" : "- edit only if the user asked to fix or a runtime gate requires it",
      this.filesRequiringVerification.size > 0 ? "- run verification before claiming success" : "- search only with a different query/range if new evidence is needed"
    ];

    if (this.duplicateReads.length > 0) {
      actions.push("- do not reread files marked read complete unless they changed");
    }

    return actions;
  }

  private addDuplicateRead(path: string, reason: string): void {
    const normalizedPath = normalizePath(path);
    if (this.duplicateReads.some((item) => pathMatches(item.path, normalizedPath))) return;
    this.duplicateReads.push({ path: normalizedPath, reason });
  }

  private clearReadCoverage(path: string): void {
    for (const key of [...this.readFiles.keys()]) {
      if (pathMatches(key, path)) this.readFiles.delete(key);
    }
    this.duplicateReads.splice(
      0,
      this.duplicateReads.length,
      ...this.duplicateReads.filter((item) => !pathMatches(item.path, path))
    );
  }

  private findReadState(path: string): ReadFileState | null {
    for (const file of this.readFiles.values()) {
      if (pathMatches(file.path, path)) return file;
    }

    return null;
  }

  private setHasMatchingPath(set: Set<string>, path: string): boolean {
    return [...set].some((item) => pathMatches(item, path));
  }

  private deleteMatchingPath(set: Set<string>, path: string): void {
    for (const item of [...set]) {
      if (pathMatches(item, path)) set.delete(item);
    }
  }

  private formatSet(set: Set<string>): string {
    return set.size > 0 ? [...set].sort().join(", ") : "none";
  }

  private compactLines(lines: string[]): string {
    const compacted = lines.filter((line, index) => line.trim() || lines[index - 1]?.trim());
    if (compacted.length <= MAX_LEDGER_LINES) return compacted.join("\n").trim();

    return [
      ...compacted.slice(0, MAX_LEDGER_LINES - 1),
      `- ${compacted.length - MAX_LEDGER_LINES + 1} additional ledger lines omitted.`
    ].join("\n").trim();
  }
}

export const injectSessionStateMessage = (
  messages: readonly ProviderMessage[],
  sessionStateMessage: ProviderMessage
): ProviderMessage[] => {
  const withoutPriorState = messages.filter(
    (message) => !(message.role === "system" && message.content.startsWith(SESSION_STATE_PREFIX))
  );
  const insertionIndex = withoutPriorState.findIndex((message) => message.role !== "system");

  if (insertionIndex === -1) {
    return [...withoutPriorState, sessionStateMessage];
  }

  return [
    ...withoutPriorState.slice(0, insertionIndex),
    sessionStateMessage,
    ...withoutPriorState.slice(insertionIndex)
  ];
};

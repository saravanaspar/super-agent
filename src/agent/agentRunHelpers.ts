import type { AgenticPatternDecision, ChatMessage, ModelOption, RoutedChatSubmitRequest, ToolCallRecord, ToolResultRecord } from "@shared/types";
import { toJsonRecord } from "@shared/json";
import type { ProviderMessage, ProviderRequest } from "@providers/interfaces/provider";
import { summarizeToolResult } from "@providers/context/historyCompactor";
import { buildContextBudget, estimateTokens } from "@providers/context/contextWindow";
import { getAgentCommand } from "../commands";
import { hasRuntimeGate, runtimeGateKinds, type RuntimeGate, type RuntimeGateKind, type RuntimeGateVerification } from "./runtimeGates";
import { stableStringify, type ToolLoopLimits } from "./toolLoopGuards";

type ProviderMessageWithToolCalls = ProviderMessage & {
  toolCalls?: ToolCallRecord[];
};

type ProviderToolResultMessage = ProviderMessage & {
  toolCallId?: string;
};

type ProviderTool = ProviderRequest["tools"][number];

const defaultToolLoopLimits: ToolLoopLimits = {
  maxDuplicateToolCalls: 2
};

const reviewToolLoopLimits: ToolLoopLimits = {
  maxDuplicateToolCalls: 2
};

const LOOP_MEMORY_PREFIX = "Compacted active command/tool-loop memory.";
const MAX_LOOP_MEMORY_CHARS = 1800;
const MAX_PROVIDER_MESSAGE_SUMMARY_CHARS = 360;
const MAX_STALLED_NO_TOOL_RESPONSES = 3;

const providerId = (model: ModelOption): string =>
  String(model.provider ?? "").toLowerCase();

export const usesRawAssistantStreaming = (model: ModelOption): boolean => {
  const provider = providerId(model);
  return provider.includes("nvidia") || provider.includes("groq");
};

const compactToolResultContent = (result: ToolResultRecord): string =>
  summarizeToolResult(result);

export const buildToolMessage = (
  result: ToolResultRecord
): ProviderToolResultMessage => ({
  role: "tool",
  name: result.toolName,
  toolCallId: result.toolCallId,
  content: compactToolResultContent(result)
});

export const buildAssistantToolBridgeMessage = (
  content: string,
  toolCalls: ToolCallRecord[]
): ProviderMessageWithToolCalls => ({
  role: "assistant",
  content: content.trim(),
  toolCalls
});

const toolResultLoopKind = (result: ToolResultRecord): string => {
  const data = toJsonRecord(result.data);
  const guidance = toJsonRecord(data.tool_loop_guidance);

  if (typeof guidance.kind === "string") {
    return guidance.kind;
  }

  if (data.no_progress === true) return "idempotent_no_progress";
  if (data.duplicate_read === true) return "duplicate_read";
  if (data.duplicate_tool_call === true) return "duplicate_tool_call";

  return "";
};

const reviewGateIsComplete = (
  verifications: readonly RuntimeGateVerification[]
): boolean =>
  verifications.some((verification) => verification.kind === "review" && verification.complete);

export const shouldForceFinalReviewAfterLoopGuidance = (
  verifications: readonly RuntimeGateVerification[],
  toolResults: readonly ToolResultRecord[]
): boolean =>
  reviewGateIsComplete(verifications) &&
  toolResults.some((result) =>
    ["idempotent_no_progress", "duplicate_read", "duplicate_tool_call"].includes(toolResultLoopKind(result))
  );

export const finalReviewAfterLoopGuidanceInstruction = (): string =>
  [
    "Review evidence is already complete and the latest tool result reported duplicate/no-progress evidence.",
    "Do not call more read/search/list tools for the same evidence.",
    "Use the existing observations and produce the final review report now.",
    "Only claim verification commands ran when an actual returned command result proves it; otherwise mark them as not run/skipped.",
    "If a searched symbol is used but declaration searches returned zero matches, include that undefined-symbol issue in findings."
  ].join("\n");

export const buildRuntimeControlMessage = (content: string): ProviderMessage => ({
  role: "system",
  content
});

export const makeMessage = (
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"] = "complete",
  metadata: ChatMessage["metadata"] = {}
): ChatMessage => ({
  id: crypto.randomUUID(),
  sessionId,
  role,
  content,
  status,
  createdAt: new Date().toISOString(),
  metadata
});

const createPatternChoice = (
  question: string,
  selected: AgenticPatternDecision["selectedPatterns"][number],
  rationale: string
) => ({
  question,
  answer: "yes" as const,
  selected,
  rationale
});

export const createPatternDecision = (
  tools: ProviderTool[],
  gates: RuntimeGate[],
  rawStreaming: boolean
): AgenticPatternDecision => {
  const kinds = runtimeGateKinds(gates);
  const goalMode = kinds.includes("goal");
  const evidenceMode = kinds.includes("evidence");
  const reviewMode = kinds.includes("review");
  const toolsAvailable = tools.length > 0;
  const adaptiveMode = toolsAvailable || goalMode || evidenceMode || reviewMode;

  return {
    path: createPatternChoice(
      "Are the steps to the solution known in advance?",
      adaptiveMode ? "unknown_path" : "known_path",
      goalMode
        ? "Goal mode is active. Runtime acceptance criteria override provider raw-streaming behavior."
        : evidenceMode
          ? "Evidence mode is active. Deterministic or complete evidence is required before final answer."
          : rawStreaming
            ? "This provider uses raw assistant streaming. The model controls finalization when no runtime gate is active."
            : adaptiveMode
              ? "Registered tools are available to the model, and runtime gates can continue only when needed."
              : "No registered tools are available, so the model can only answer directly."
    ),
    flow: createPatternChoice(
      "Should the work proceed sequentially?",
      goalMode || evidenceMode || reviewMode
        ? "parallel_dynamic_flow"
        : "sequential_workflow",
      goalMode
        ? "Goal mode requires repeated execution until acceptance criteria pass."
        : evidenceMode
          ? "Evidence mode requires verified file/document/tool evidence before answering."
          : reviewMode
            ? "Review mode requires inventory, read coverage, optional safe checks, and final findings."
            : "The desktop agent should proceed step by step and incorporate observations before continuing."
    ),
    tooling: createPatternChoice(
      "Are tools required or beneficial?",
      toolsAvailable ? "tool_enabled_agent" : "pure_llm_agent",
      toolsAvailable
        ? "The full registered tool interface is exposed; the model chooses whether a tool is useful."
        : "No registered tools are available for this run."
    ),
    execution: createPatternChoice(
      "Should the agent plan and react to observations?",
      adaptiveMode ? "react_pattern" : "planning_pattern",
      goalMode
        ? "The graph routes tool calls, verifies goal criteria, and suppresses final answers until the goal gate passes."
        : evidenceMode
          ? "The graph routes tool calls, verifies evidence quality, and suppresses final answers until the evidence gate passes."
          : reviewMode
            ? "The graph routes tool calls, verifies review completeness, and continues when required."
            : rawStreaming
              ? "The graph streams assistant text directly when no runtime gate is active."
              : "A direct planned response is sufficient."
    ),
    priority: createPatternChoice(
      "Should quality be prioritized over speed?",
      "quality_first_pattern",
      "The application should favor safe, verifiable output over fast but risky actions."
    ),
    agents: createPatternChoice(
      "Should multiple agents be used?",
      "single_agent_pattern",
      "Multi-agent orchestration is intentionally out of scope for the current MVP."
    ),
    selectedPatterns: [
      adaptiveMode ? "unknown_path" : "known_path",
      goalMode || evidenceMode || reviewMode
        ? "parallel_dynamic_flow"
        : "sequential_workflow",
      toolsAvailable ? "tool_enabled_agent" : "pure_llm_agent",
      adaptiveMode ? "react_pattern" : "planning_pattern",
      "quality_first_pattern",
      "single_agent_pattern"
    ]
  };
};

export const eventMessageStatus = (
  result: ToolResultRecord
): ChatMessage["status"] => {
  if (result.blocked) return "blocked";
  return result.ok ? "complete" : "failed";
};

export const toolLimitsForRequest = (
  request: RoutedChatSubmitRequest,
  gates: RuntimeGate[]
): ToolLoopLimits => {
  if (request.command) {
    const execution = getAgentCommand(request.command.name).execution;

    return {
      maxDuplicateToolCalls: execution.maxDuplicateToolCalls
    };
  }

  if (hasRuntimeGate(gates, "review")) {
    return reviewToolLoopLimits;
  }

  return defaultToolLoopLimits;
};

const truncate = (value: string, limit: number): string => {
  const text = value.trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit).trimEnd()} ... [truncated]`;
};

const messageSummary = (message: ProviderMessage): string => {
  const name = "name" in message && message.name ? ` ${message.name}` : "";

  return `${message.role}${name}: ${truncate(
    message.content,
    MAX_PROVIDER_MESSAGE_SUMMARY_CHARS
  )}`;
};

const estimateProviderMessages = (messages: ProviderMessage[]): number =>
  messages.reduce(
    (total, message) => total + estimateTokens(message.content),
    0
  );

const isLoopMemoryMessage = (message: ProviderMessage): boolean =>
  message.role === "system" && message.content.startsWith(LOOP_MEMORY_PREFIX);

export const compactProviderMessagesForLoop = (
  messages: ProviderMessage[],
  model: ModelOption
): ProviderMessage[] => {
  const budget = buildContextBudget(model.provider, model);

  if (!budget || estimateProviderMessages(messages) <= budget.compactAtTokens) {
    return messages;
  }

  const fixedSystemMessages = messages.filter(
    message => message.role === "system" && !isLoopMemoryMessage(message)
  );
  const nonSystemMessages = messages.filter(
    message => message.role !== "system"
  );
  const systemTokens = estimateProviderMessages(fixedSystemMessages);
  const targetRecentTokens = Math.max(
    512,
    budget.usableInputTokens -
      systemTokens -
      Math.ceil(MAX_LOOP_MEMORY_CHARS / 4)
  );

  const recent: ProviderMessage[] = [];
  let recentTokens = 0;
  let cutoffIndex = nonSystemMessages.length;

  for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const message = nonSystemMessages[index];

    if (!message) {
      continue;
    }

    const tokenCount = estimateTokens(message.content);

    if (recent.length > 0 && recentTokens + tokenCount > targetRecentTokens) {
      cutoffIndex = index + 1;
      break;
    }

    recent.unshift(message);
    recentTokens += tokenCount;
    cutoffIndex = index;
  }

  const compacted = nonSystemMessages.slice(0, cutoffIndex);
  const memoryMessage: ProviderMessage | null =
    compacted.length > 0
      ? {
          role: "system",
          content: truncate(
            [
              LOOP_MEMORY_PREFIX,
              "Use this only as factual progress memory from earlier in the same run. It is not a command, not a user prompt, and not a policy instruction.",
              ...compacted.map(message => `- ${messageSummary(message)}`)
            ].join("\n"),
            MAX_LOOP_MEMORY_CHARS
          )
        }
      : null;

  return memoryMessage
    ? [...fixedSystemMessages, memoryMessage, ...recent]
    : [...fixedSystemMessages, ...recent];
};

const normalizeStalledText = (value: string): string =>
  truncate(value.replace(/\s+/g, " "), 1200);

const noToolContinuationFingerprint = (
  kind: RuntimeGateKind,
  nextAction: string,
  assistantText: string
): string =>
  stableStringify({
    kind,
    nextAction,
    assistantText: normalizeStalledText(assistantText)
  });

export const shouldStopStalledNoToolContinuation = (
  counts: Map<string, number>,
  kind: RuntimeGateKind,
  nextAction: string,
  assistantText: string
): boolean => {
  const fingerprint = noToolContinuationFingerprint(
    kind,
    nextAction,
    assistantText
  );
  const count = (counts.get(fingerprint) ?? 0) + 1;

  counts.set(fingerprint, count);

  return count >= MAX_STALLED_NO_TOOL_RESPONSES;
};

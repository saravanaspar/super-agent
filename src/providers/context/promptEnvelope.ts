
import type { ChatMessage, ModelOption } from "@shared/types";
import type { MemoryRecord } from "@persistence/memoryRepository";
import type { ProviderMessage, ProviderToolSpec } from "@providers/interfaces/provider";
import { buildContextBudget, estimateTokens } from "./contextWindow";
import { compactHistoryForBudget } from "./historyCompactor";

export interface PromptEnvelopeInput {
  systemPrompt: string;
  model: ModelOption;
  messages: ChatMessage[];
  memories: MemoryRecord[];
  tools: ProviderToolSpec[];
}

export interface PromptEnvelope {
  instructions: string;
  messages: ProviderMessage[];
  compacted: boolean;
  estimatedInputTokens: number;
}

const MAX_LONG_TERM_MEMORIES = 5;

const buildLongTermMemoryMessage = (
  memories: MemoryRecord[]
): ProviderMessage | null => {
  const contents = memories
    .slice(0, MAX_LONG_TERM_MEMORIES)
    .map((memory) => memory.content.trim())
    .filter(Boolean);

  if (contents.length === 0) {
    return null;
  }

  return {
    role: "system",
    content: `Long-term memory:\n${contents.join("\n")}`
  };
};

const estimateMessages = (messages: ProviderMessage[]): number =>
  messages.reduce((total, message) => total + estimateTokens(message.content), 0);

const estimateTools = (tools: ProviderToolSpec[]): number =>
  tools.reduce(
    (total, tool) =>
      total +
      estimateTokens(
        `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`
      ),
    0
  );

export const buildPromptEnvelope = (input: PromptEnvelopeInput): PromptEnvelope => {
  const budget = buildContextBudget(input.model.provider, input.model);
  const longTermMemory = buildLongTermMemoryMessage(input.memories);
  const fixedPrefix = [...(longTermMemory ? [longTermMemory] : [])];
  const fixedTokenEstimate =
    estimateTokens(input.systemPrompt) + estimateMessages(fixedPrefix) + estimateTools(input.tools);
  const compactAtTokens = budget
    ? Math.max(128, budget.compactAtTokens - fixedTokenEstimate)
    : undefined;
  const usableInputTokens = budget
    ? Math.max(256, budget.usableInputTokens - fixedTokenEstimate)
    : undefined;
  const sessionHistory = compactHistoryForBudget(
    input.messages,
    compactAtTokens,
    usableInputTokens
  );
  const messages = [...fixedPrefix, ...sessionHistory.messages];

  return {
    instructions: input.systemPrompt,
    messages,
    compacted: sessionHistory.compacted,
    estimatedInputTokens:
      estimateTokens(input.systemPrompt) + estimateMessages(messages) + estimateTools(input.tools)
  };
};
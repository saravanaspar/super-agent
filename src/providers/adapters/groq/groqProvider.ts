import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord } from "@shared/types";
import type {
  LlmProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent
} from "@providers/interfaces/provider";
import { ProviderUnavailableError } from "@providers/shared/providerErrors";
import {
  createOpenAiToolNameMapper,
  toInternalToolCallName,
  toProviderToolCallName,
  type OpenAiToolNameMapper
} from "@providers/shared/openAiCompatible";
import { normalizeToolCall } from "@providers/shared/toolNormalization";
import { parseSseJson } from "@providers/streaming/streamReaders";
import { readThinkingText } from "@providers/streaming/thinkingParser";

type GroqToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type GroqMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      tool_calls?: GroqToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

type ProviderMessageWithGroqMetadata = ProviderMessage & {
  toolCallId?: string;
  toolCalls?: ToolCallRecord[];
  metadata?: JsonRecord;
  name?: string;
};

type ProviderTool = ProviderRequest["tools"][number];

type GroqTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

type GroqChatPayload = {
  model: string;
  messages: GroqMessage[];
  stream: true;
  temperature: number;
  max_completion_tokens: number;
  tools?: GroqTool[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  include_reasoning?: boolean;
  reasoning_effort?: "low" | "medium" | "high";
};

type StreamToolCallAccumulator = {
  id: string;
  type: "function";
  index: number;
  function: {
    name: string;
    arguments: string;
  };
};

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const GROQ_MAX_INPUT_TOKENS = 4500;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_TOOL_RESULT_CHARS = 6000;

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const compactText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;

  return `${value.slice(0, maxChars)}\n\n[truncated ${
    value.length - maxChars
  } chars before sending to Groq]`;
};

const stringifyPrimitiveContent = (content: unknown): string => {
  if (typeof content === "number" || typeof content === "boolean") {
    return content.toString();
  }

  if (typeof content === "bigint") {
    return content.toString();
  }

  if (typeof content === "symbol") {
    return content.description ?? "";
  }

  return "";
};

const stringifyContent = (content: unknown): string => {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;

  try {
    const json = JSON.stringify(content);
    return json ?? stringifyPrimitiveContent(content);
  } catch {
    return stringifyPrimitiveContent(content);
  }
};

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, value.length - 1) : value;

const supportsGroqReasoning = (model: string): boolean =>
  model.includes("gpt-oss");

const readToolCallIdFromContent = (content: string): string => {
  try {
    const parsed = asRecord(JSON.parse(content));
    return (
      readString(parsed.toolCallId) ||
      readString(parsed.tool_call_id) ||
      readString(asRecord(parsed.result).toolCallId) ||
      readString(asRecord(parsed.result).tool_call_id)
    );
  } catch {
    return "";
  }
};

const toolCallRecordToGroqToolCall = (
  call: ToolCallRecord,
  mapper: OpenAiToolNameMapper
): GroqToolCall => ({
  id: call.id,
  type: "function",
  function: {
    name: toProviderToolCallName(call.name, mapper),
    arguments: JSON.stringify(call.input ?? {})
  }
});

const groqToolCallToRecord = (
  call: GroqToolCall,
  mapper: OpenAiToolNameMapper
): ToolCallRecord => {
  const normalized = normalizeToolCall({
    name: toInternalToolCallName(call.function.name, mapper),
    arguments: call.function.arguments
  });

  return {
    ...normalized,
    id: call.id || normalized.id
  };
};

const estimateMessageTokens = (messages: GroqMessage[]): number => {
  const chars = messages.reduce((total, message) => {
    const contentChars = stringifyContent(message.content).length;

    if (message.role !== "assistant" || !message.tool_calls) {
      return total + contentChars;
    }

    const toolCallChars = message.tool_calls.reduce(
      (sum, call) =>
        sum +
        call.id.length +
        call.function.name.length +
        call.function.arguments.length,
      0
    );

    return total + contentChars + toolCallChars;
  }, 0);

  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
};

const trimGroqMessages = (
  messages: GroqMessage[],
  maxInputTokens: number
): GroqMessage[] => {
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const kept: GroqMessage[] = [];

  for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const nextMessage = nonSystemMessages[index];

    if (!nextMessage) {
      continue;
    }

    kept.unshift(nextMessage);

    const candidate = [...systemMessages, ...kept];

    if (estimateMessageTokens(candidate) > maxInputTokens) {
      kept.shift();
      break;
    }
  }

  return [...systemMessages, ...kept];
};

const toGroqMessage = (
  message: ProviderMessageWithGroqMetadata,
  mapper: OpenAiToolNameMapper
): GroqMessage | null => {
  const role = message.role;
  const content = stringifyContent(message.content);

  if (role === "system" || role === "user") {
    if (!content.trim()) return null;
    return { role, content };
  }

  if (role === "assistant") {
    if (!content.trim() && !message.toolCalls?.length) return null;

    const toolCalls = message.toolCalls?.map((call) =>
      toolCallRecordToGroqToolCall(call, mapper)
    );

    return {
      role: "assistant",
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {})
    };
  }

  if (role === "tool") {
    const toolCallId =
      readString(message.toolCallId) || readToolCallIdFromContent(content);
    const name = readString(message.name);

    if (!toolCallId) {
      return null;
    }

    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: compactText(content, MAX_TOOL_RESULT_CHARS),
      ...(name ? { name: toProviderToolCallName(name, mapper) } : {})
    };
  }

  return null;
};

const groqRuntimeInstructionAsUser = (content: string): GroqMessage => ({
  role: "user",
  content: [
    "Runtime instruction from the local agent controller:",
    content
  ].join("\n")
});

const detachedGroqToolResultAsUser = (
  message: Extract<GroqMessage, { role: "tool" }>
): GroqMessage => ({
  role: "user",
  content: [
    `Local tool result${message.name ? ` (${message.name})` : ""}:`,
    message.content
  ].join("\n")
});

const normalizeGroqMessageOrder = (messages: GroqMessage[]): GroqMessage[] => {
  const normalized: GroqMessage[] = [];
  const pendingToolCallIds = new Set<string>();
  let seenNonSystemMessage = false;

  for (const message of messages) {
    if (message.role === "system") {
      if (!seenNonSystemMessage) {
        normalized.push(message);
      } else if (message.content.trim()) {
        normalized.push(groqRuntimeInstructionAsUser(message.content));
      }

      continue;
    }

    seenNonSystemMessage = true;

    if (message.role === "assistant") {
      pendingToolCallIds.clear();

      for (const call of message.tool_calls ?? []) {
        pendingToolCallIds.add(call.id);
      }

      normalized.push(message);
      continue;
    }

    if (message.role === "tool") {
      if (pendingToolCallIds.has(message.tool_call_id)) {
        pendingToolCallIds.delete(message.tool_call_id);
        normalized.push(message);
      } else {
        normalized.push(detachedGroqToolResultAsUser(message));
      }

      continue;
    }

    pendingToolCallIds.clear();
    normalized.push(message);
  }

  return normalized;
};

const sanitizeGroqMessages = (
  messages: ProviderMessageWithGroqMetadata[],
  mapper: OpenAiToolNameMapper
): GroqMessage[] =>
  normalizeGroqMessageOrder(
    messages
      .map((message) => toGroqMessage(message, mapper))
      .filter((message): message is GroqMessage => message !== null)
  );

const providerToolToGroqTool = (
  tool: ProviderTool,
  mapper: OpenAiToolNameMapper
): GroqTool => ({
  type: "function",
  function: {
    name: toProviderToolCallName(tool.name, mapper),
    description: tool.description,
    parameters: tool.parameters
  }
});

const selectGroqToolsForRequest = (
  tools: ProviderTool[],
  mapper: OpenAiToolNameMapper
): GroqTool[] | undefined => {
  if (tools.length === 0) return undefined;

  return tools.map((tool) => providerToolToGroqTool(tool, mapper));
};

const readReasoning = (...records: JsonRecord[]): string =>
  readThinkingText(...records);

const readErrorMessage = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => "");

  if (!text) return `Groq request failed with HTTP ${response.status}.`;

  try {
    const parsed = asRecord(JSON.parse(text));
    const error = asRecord(parsed.error);
    return (
      readString(error.message) ||
      readString(parsed.message) ||
      `Groq request failed with HTTP ${response.status}.`
    );
  } catch {
    return text;
  }
};

const readGroqToolCallDelta = (
  raw: unknown
): Partial<StreamToolCallAccumulator> | null => {
  const call = asRecord(raw);
  const fn = asRecord(call.function);
  const index =
    typeof call.index === "number" && Number.isFinite(call.index)
      ? call.index
      : 0;

  return {
    index,
    id: readString(call.id),
    type: "function",
    function: {
      name: readString(fn.name),
      arguments: readString(fn.arguments)
    }
  };
};

const mergeToolCallDelta = (
  current: StreamToolCallAccumulator | undefined,
  delta: Partial<StreamToolCallAccumulator>
): StreamToolCallAccumulator => {
  const existing = current ?? {
    id: "",
    type: "function" as const,
    index: typeof delta.index === "number" ? delta.index : 0,
    function: {
      name: "",
      arguments: ""
    }
  };

  return {
    id: delta.id ? delta.id : existing.id,
    type: "function",
    index: typeof delta.index === "number" ? delta.index : existing.index,
    function: {
      name: `${existing.function.name}${delta.function?.name ?? ""}`,
      arguments: `${existing.function.arguments}${
        delta.function?.arguments ?? ""
      }`
    }
  };
};

export class GroqProvider implements LlmProvider {
  readonly name = "groq" as const;

  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
    }
  ) {}

  listModels() {
    return [];
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const cleanBaseUrl = trimTrailingSlash(
      this.config.baseUrl || DEFAULT_BASE_URL
    );

    if (!this.config.apiKey.trim()) {
      throw new ProviderUnavailableError(
        "Groq API key is missing. Add it in Settings > Providers."
      );
    }

    const toolNameMapper = createOpenAiToolNameMapper(request.tools);
    const payload = this.buildPayload(request, toolNameMapper);
    const response = await this.fetchResponse(cleanBaseUrl, payload, signal);

    const pendingToolCalls = new Map<number, StreamToolCallAccumulator>();
    const emittedToolCallIds = new Set<string>();

    for await (const event of parseSseJson(response.body)) {
      const choice = asJsonRecord(
        Array.isArray(event.choices) ? event.choices[0] : {}
      );
      const delta = asJsonRecord(choice.delta);
      const message = asJsonRecord(choice.message);

      const reasoning = readReasoning(event, choice, delta, message);
      if (reasoning) {
        yield { type: "thinking", delta: reasoning };
      }

      const content = readString(delta.content) || readString(message.content);
      if (content) {
        yield { type: "token", delta: content };
      }

      const toolCallDeltas = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];

      for (const rawToolCall of toolCallDeltas) {
        const toolCallDelta = readGroqToolCallDelta(rawToolCall);
        if (!toolCallDelta) continue;

        const index =
          typeof toolCallDelta.index === "number" ? toolCallDelta.index : 0;

        pendingToolCalls.set(
          index,
          mergeToolCallDelta(pendingToolCalls.get(index), toolCallDelta)
        );
      }

      const finishReason = readString(choice.finish_reason);

      if (finishReason === "tool_calls") {
        for (const pending of [...pendingToolCalls.values()].sort(
          (left, right) => left.index - right.index
        )) {
          const id = pending.id || crypto.randomUUID();
          const name = pending.function.name.trim();

          if (!name || emittedToolCallIds.has(id)) continue;

          emittedToolCallIds.add(id);

          yield {
            type: "tool_call",
            call: groqToolCallToRecord(
              {
                id,
                type: "function",
                function: {
                  name,
                  arguments: pending.function.arguments || "{}"
                }
              },
              toolNameMapper
            )
          };
        }

        pendingToolCalls.clear();
      }
    }

    for (const pending of [...pendingToolCalls.values()].sort(
      (left, right) => left.index - right.index
    )) {
      const id = pending.id || crypto.randomUUID();
      const name = pending.function.name.trim();

      if (!name || emittedToolCallIds.has(id)) continue;

      emittedToolCallIds.add(id);

      yield {
        type: "tool_call",
        call: groqToolCallToRecord(
          {
            id,
            type: "function",
            function: {
              name,
              arguments: pending.function.arguments || "{}"
            }
          },
          toolNameMapper
        )
      };
    }

    yield { type: "done" };
  }

  private buildPayload(
    request: ProviderRequest,
    toolNameMapper: OpenAiToolNameMapper
  ): GroqChatPayload {
    const instructionMessages = request.instructions?.trim()
      ? [{ role: "system" as const, content: request.instructions }]
      : [];
    const sanitized = sanitizeGroqMessages(
      [...instructionMessages, ...request.messages],
      toolNameMapper
    );
    const messages = trimGroqMessages(sanitized, GROQ_MAX_INPUT_TOKENS);
    const model = request.model.model;
    const tools = selectGroqToolsForRequest(request.tools, toolNameMapper);

    return {
      model,
      messages,
      stream: true,
      temperature: 0.2,
      max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
      ...(tools
        ? {
            tools,
            tool_choice: "auto" as const,
            parallel_tool_calls: true
          }
        : {}),
      ...(supportsGroqReasoning(model)
        ? {
            include_reasoning: true,
            reasoning_effort: "low" as const
          }
        : {})
    };
  }

  private async fetchResponse(
    cleanBaseUrl: string,
    payload: GroqChatPayload,
    signal?: AbortSignal
  ): Promise<Response & { body: ReadableStream<Uint8Array> }> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {})
    };

    const response = await fetch(`${cleanBaseUrl}/chat/completions`, init).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";

        throw new ProviderUnavailableError(
          `Groq is unavailable at ${cleanBaseUrl}. ${message}`
        );
      }
    );

    if (!response.ok || !response.body) {
      throw new ProviderUnavailableError(await readErrorMessage(response));
    }

    return response as Response & { body: ReadableStream<Uint8Array> };
  }
}
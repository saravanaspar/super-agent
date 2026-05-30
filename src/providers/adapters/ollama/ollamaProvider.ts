import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ToolCallRecord } from "@shared/types";
import type {
  LlmProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent
} from "@providers/interfaces/provider";
import { normalizeOllamaBaseUrl } from "@providers/shared/providerUrls";
import { validateHttpUrlForNetworkAccess } from "@security/networkPolicy";
import { ProviderUnavailableError } from "@providers/shared/providerErrors";
import { normalizeToolCall } from "@providers/shared/toolNormalization";
import {
  filterRawToolMarkup,
  flushRawToolMarkup,
  type RawToolCall,
  type ToolMarkupFilterState
} from "@providers/streaming/rawToolMarkupParser";
import { parseNdjson } from "@providers/streaming/streamReaders";
import {
  createThinkTagParserState,
  extractTaggedThinking,
  flushTaggedThinking,
  readThinkingText
} from "@providers/streaming/thinkingParser";

const liveThinkingInstruction =
  "When you need to reason, stream that reasoning immediately inside <think> and </think> tags, then stream the final answer outside those tags. Keep tool calls outside <think> tags.";

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const parseToolArguments = (value: unknown): JsonRecord | undefined => {
  if (value === null || value === undefined || value === "") return undefined;

  if (typeof value === "string") {
    try {
      return asJsonRecord(JSON.parse(value));
    } catch {
      return { value };
    }
  }

  return asJsonRecord(value);
};

const readToolCalls = (payload: JsonRecord, message: JsonRecord): unknown[] => {
  if (Array.isArray(message.tool_calls)) return message.tool_calls;
  if (Array.isArray(payload.tool_calls)) return payload.tool_calls;
  return [];
};

const callKey = (call: ToolCallRecord): string =>
  JSON.stringify({ name: call.name, input: call.input });

const normalizeRawToolCall = (rawCall: RawToolCall): ToolCallRecord =>
  normalizeToolCall(
    rawCall.arguments
      ? { name: rawCall.name, arguments: rawCall.arguments }
      : { name: rawCall.name }
  );

const addLiveThinkingInstruction = (
  messages: ProviderMessage[],
  supportsThinking: boolean
): ProviderMessage[] => {
  if (!supportsThinking) return messages;

  const [firstMessage, ...restMessages] = messages;

  if (firstMessage?.role === "system") {
    return [
      {
        ...firstMessage,
        content: `${firstMessage.content}\n\n${liveThinkingInstruction}`
      },
      ...restMessages
    ];
  }

  return [
    { role: "system", content: liveThinkingInstruction },
    ...messages
  ];
};

export class OllamaProvider implements LlmProvider {
  readonly name = "ollama" as const;

  constructor(private readonly baseUrl: string) {}

  listModels() {
    return [];
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const cleanBaseUrl = normalizeOllamaBaseUrl(this.baseUrl);
    const thinkTagState = createThinkTagParserState();
    const rawToolState: ToolMarkupFilterState = { pending: "" };
    const seenToolCalls = new Set<string>();
    let lastDirectThinking = "";

    const directThinkingDelta = (thinking: string): string => {
      if (!thinking) return "";

      if (thinking.startsWith(lastDirectThinking)) {
        const delta = thinking.slice(lastDirectThinking.length);
        lastDirectThinking = thinking;
        return delta;
      }

      lastDirectThinking += thinking;
      return thinking;
    };

    const emitToolCall = function* (
      rawCall: RawToolCall
    ): Generator<ProviderStreamEvent> {
      const normalized = normalizeRawToolCall(rawCall);
      const key = callKey(normalized);

      if (seenToolCalls.has(key)) return;

      seenToolCalls.add(key);
      yield { type: "tool_call", call: normalized };
    };

    const init = this.buildRequest(request, signal);
    const response = await this.fetchResponse(cleanBaseUrl, init);

    for await (const payload of parseNdjson(response.body)) {
      const record = asJsonRecord(payload);
      const message = asJsonRecord(record.message);
      const providerError = readString(record.error);

      if (providerError) {
        yield { type: "error", error: providerError };
        continue;
      }

      const directThinking = directThinkingDelta(
        this.readThinking(record, message)
      );
      const tagged = extractTaggedThinking(
        readString(message.content),
        thinkTagState
      );
      const thinking = directThinking + tagged.thinking;

      if (thinking.length > 0) {
        yield { type: "thinking", delta: thinking };
      }

      const filtered = filterRawToolMarkup(tagged.content, rawToolState);
      if (filtered.content.length > 0) {
        yield { type: "token", delta: filtered.content };
      }

      for (const rawCall of filtered.calls) yield* emitToolCall(rawCall);
      for (const rawCall of readToolCalls(record, message)) {
        const normalized = this.readProviderToolCall(rawCall);
        if (normalized) yield* emitToolCall(normalized);
      }
    }

    const taggedFlush = flushTaggedThinking(thinkTagState);
    if (taggedFlush.thinking.length > 0) {
      yield { type: "thinking", delta: taggedFlush.thinking };
    }

    if (taggedFlush.content.length > 0) {
      const filtered = filterRawToolMarkup(taggedFlush.content, rawToolState);
      if (filtered.content.length > 0) {
        yield { type: "token", delta: filtered.content };
      }
      for (const rawCall of filtered.calls) yield* emitToolCall(rawCall);
    }

    const flushed = flushRawToolMarkup(rawToolState);
    if (flushed.content.length > 0) {
      yield { type: "token", delta: flushed.content };
    }
    for (const rawCall of flushed.calls) yield* emitToolCall(rawCall);

    yield { type: "done" };
  }

  private buildRequest(request: ProviderRequest, signal?: AbortSignal): RequestInit {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model.model,
        messages: addLiveThinkingInstruction(
          [
            ...(request.instructions?.trim()
              ? [{ role: "system" as const, content: request.instructions }]
              : []),
            ...request.messages
          ],
          request.model.supportsThinking
        ),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        stream: true
      })
    };

    if (signal) init.signal = signal;
    return init;
  }

  private async fetchResponse(
    cleanBaseUrl: string,
    init: RequestInit
  ): Promise<Response & { body: ReadableStream<Uint8Array> }> {
    await validateHttpUrlForNetworkAccess(cleanBaseUrl, {
      allowLocalhost: true,
      allowPrivateNetwork: true
    });

    const response = await fetch(`${cleanBaseUrl}/api/chat`, init).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new ProviderUnavailableError(
          `Ollama is unavailable at ${cleanBaseUrl}. ${message}`
        );
      }
    );

    if (!response.ok || !response.body) {
      throw new ProviderUnavailableError(
        `Ollama request failed with HTTP ${response.status}.`
      );
    }

    return response as Response & { body: ReadableStream<Uint8Array> };
  }

  private readThinking(record: JsonRecord, message: JsonRecord): string {
    return readThinkingText(message, record);
  }

  private readProviderToolCall(value: unknown): RawToolCall | null {
    const call = asJsonRecord(value);
    const fn = asJsonRecord(call.function);
    const name = readString(fn.name) || readString(call.name);

    if (!name) return null;

    const args = parseToolArguments(fn.arguments || call.arguments);
    return args ? { name, arguments: args } : { name };
  }
}
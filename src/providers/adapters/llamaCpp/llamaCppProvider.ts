import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ModelOption } from "@shared/types";
import type {
  LlmProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent
} from "@providers/interfaces/provider";
import { ProviderUnavailableError } from "@providers/shared/providerErrors";
import {
  applyOpenAiToolCallDelta,
  createOpenAiToolNameMapper,
  flushOpenAiToolCalls,
  readArray,
  readString,
  toInternalToolCall,
  toOpenAiCompatibleMessages,
  toOpenAiCompatibleTools,
  type OpenAiToolNameMapper,
  type PendingOpenAiToolCall
} from "@providers/shared/openAiCompatible";
import { parseSseJson } from "@providers/streaming/streamReaders";
import { TextToolCallParser } from "@providers/streaming/textToolCallParser";
import { readThinkingText } from "@providers/streaming/thinkingParser";
import { validateHttpUrlForNetworkAccess } from "@security/networkPolicy";

interface LlamaCppProviderConfig {
  baseUrl: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MAX_TOKENS = 2048;
const MODEL_LOADING_RETRY_LIMIT = 24;
const MODEL_LOADING_RETRY_DELAY_MS = 5000;

const trimTrailingSlashes = (value: string): string => {
  let next = value.trim();

  while (next.endsWith("/") && next.length > 0) {
    next = next.slice(0, -1);
  }

  return next;
};

const normalizeLlamaCppBaseUrl = (value: string): string => {
  const raw = trimTrailingSlashes(value || DEFAULT_BASE_URL);
  if (raw.endsWith("/v1")) return raw;
  return `${raw}/v1`;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
  });

const llamaCppToolInstruction = (): ProviderMessage => ({
  role: "system",
  content: [
    "llama.cpp local tool-call instruction:",
    "- When a tool is needed, output exactly one tool call and no other visible content.",
    "- Use this exact syntax: <|tool_call>call:tool_name{\"arg\":\"value\"}<tool_call|>",
    "- For no-argument tools, use: <|tool_call>call:tool_name{}<tool_call|>",
    "- Do not wrap tool calls in markdown.",
    "- After the runtime returns a tool result, answer normally in plain text.",
    "- Never invent tool results; use only the returned tool result summary."
  ].join("\n")
});

const addLlamaCppToolInstruction = (
  messages: ProviderMessage[],
  hasTools: boolean
): ProviderMessage[] => {
  if (!hasTools) {
    return messages;
  }

  const [first, ...rest] = messages;

  if (first?.role === "system") {
    return [first, llamaCppToolInstruction(), ...rest];
  }

  return [llamaCppToolInstruction(), ...messages];
};

export class LlamaCppProvider implements LlmProvider {
  readonly name = "llamaCpp" as const;

  constructor(private readonly config: LlamaCppProviderConfig) {}

  listModels(): ModelOption[] {
    return [];
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const baseUrl = normalizeLlamaCppBaseUrl(this.config.baseUrl);
    const toolNameMapper = createOpenAiToolNameMapper(request.tools);
    const response = await this.fetchResponse(
      baseUrl,
      request,
      toolNameMapper,
      signal
    );
    const pendingToolCalls = new Map<number, PendingOpenAiToolCall>();
    const contentToolParser = new TextToolCallParser();
    const thinkingToolParser = new TextToolCallParser();

    for await (const chunk of parseSseJson(response.body)) {
      const choices = readArray(chunk.choices);
      const firstChoice = asJsonRecord(choices[0]);
      const delta = asJsonRecord(firstChoice.delta);
      const providerError = this.readError(chunk);

      if (providerError) {
        yield { type: "error", error: providerError };
        continue;
      }

      const thinking = readThinkingText(delta, firstChoice, chunk);
      if (thinking.length > 0) {
        const parsed = thinkingToolParser.push(thinking);

        if (parsed.text.length > 0) {
          yield { type: "thinking", delta: parsed.text };
        }

        for (const call of parsed.toolCalls) {
          yield {
            type: "tool_call",
            call: toInternalToolCall(call, toolNameMapper)
          };
        }
      }

      const token = readString(delta.content);
      if (token.length > 0) {
        const parsed = contentToolParser.push(token);

        if (parsed.text.length > 0) {
          yield { type: "token", delta: parsed.text };
        }

        for (const call of parsed.toolCalls) {
          yield {
            type: "tool_call",
            call: toInternalToolCall(call, toolNameMapper)
          };
        }
      }

      readArray(delta.tool_calls).forEach((call, index) => {
        applyOpenAiToolCallDelta(pendingToolCalls, call, index);
      });

      const finishReason = readString(firstChoice.finish_reason);
      if (finishReason === "tool_calls") {
        for (const call of flushOpenAiToolCalls(pendingToolCalls, toolNameMapper)) {
          yield { type: "tool_call", call };
        }
      }
    }

    const remainingThinking = thinkingToolParser.flushText();
    if (remainingThinking.length > 0) {
      yield { type: "thinking", delta: remainingThinking };
    }

    const remainingText = contentToolParser.flushText();
    if (remainingText.length > 0) {
      yield { type: "token", delta: remainingText };
    }

    for (const call of flushOpenAiToolCalls(pendingToolCalls, toolNameMapper)) {
      yield { type: "tool_call", call };
    }

    yield { type: "done" };
  }

  private async fetchResponse(
    baseUrl: string,
    request: ProviderRequest,
    toolNameMapper: OpenAiToolNameMapper,
    signal?: AbortSignal
  ): Promise<Response & { body: ReadableStream<Uint8Array> }> {
    await validateHttpUrlForNetworkAccess(baseUrl, {
      allowLocalhost: true,
      allowPrivateNetwork: true
    });

    const tools = toOpenAiCompatibleTools(request.tools, toolNameMapper);
    const payload = {
      model: request.model.model,
      messages: toOpenAiCompatibleMessages(
        addLlamaCppToolInstruction(
          [
            ...(request.instructions?.trim()
              ? [{ role: "system" as const, content: request.instructions }]
              : []),
            ...request.messages
          ],
          tools.length > 0
        ),
        toolNameMapper
      ),
      stream: true,
      temperature: 0.2,
      max_tokens: DEFAULT_MAX_TOKENS,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {})
    };

    for (let attempt = 0; attempt <= MODEL_LOADING_RETRY_LIMIT; attempt += 1) {
      const response = await this.postChatCompletion(baseUrl, payload, signal);

      if (response.ok && response.body) {
        return response as Response & { body: ReadableStream<Uint8Array> };
      }

      const details = await response.text().catch(() => "");
      const suffix = details.trim() ? ` ${details.trim()}` : "";

      if (response.status !== 503 || attempt === MODEL_LOADING_RETRY_LIMIT) {
        throw new ProviderUnavailableError(
          `llama.cpp request failed with HTTP ${response.status}.${suffix}`
        );
      }

      await this.waitForModelReady(baseUrl, signal);
    }

    throw new ProviderUnavailableError(
      `llama.cpp is unavailable at ${baseUrl}. Model did not become ready.`
    );
  }

  private async postChatCompletion(
    baseUrl: string,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    };

    if (signal) init.signal = signal;

    return fetch(`${baseUrl}/chat/completions`, init).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ProviderUnavailableError(
        `llama.cpp is unavailable at ${baseUrl}. ${message}`
      );
    });
  }

  private async waitForModelReady(
    baseUrl: string,
    signal?: AbortSignal
  ): Promise<void> {
    for (let attempt = 0; attempt < MODEL_LOADING_RETRY_LIMIT; attempt += 1) {
      await sleep(MODEL_LOADING_RETRY_DELAY_MS, signal);

      const init: RequestInit = {
        headers: { Accept: "application/json" }
      };

      if (signal) init.signal = signal;

      const response = await fetch(`${baseUrl}/models`, init).catch(() => null);

      if (response?.ok) {
        return;
      }
    }
  }

  private readError(record: JsonRecord): string {
    const error = asJsonRecord(record.error);
    return readString(error.message) || readString(record.message);
  }
}

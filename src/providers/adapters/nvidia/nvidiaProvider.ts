import { asJsonRecord } from "@shared/json";
import type { JsonRecord } from "@shared/json";
import type { ModelOption } from "@shared/types";
import type {
  LlmProvider,
  ProviderRequest,
  ProviderStreamEvent
} from "@providers/interfaces/provider";
import { ProviderUnavailableError } from "@providers/shared/providerErrors";
import {
  applyOpenAiToolCallDelta,
  createOpenAiToolNameMapper,
  flushOpenAiToolCalls,
  openAiToolCallKey,
  readArray,
  readNumber,
  readOpenAiErrorMessage,
  readOpenAiFinishReason,
  readString,
  toOpenAiCompatibleMessages,
  toOpenAiCompatibleTools,
  type OpenAiToolNameMapper,
  type PendingOpenAiToolCall
} from "@providers/shared/openAiCompatible";
import { normalizeNvidiaBaseUrl } from "@providers/shared/providerUrls";
import { readSseData } from "@providers/streaming/streamReaders";
import { readThinkingText } from "@providers/streaming/thinkingParser";

interface NvidiaProviderConfig {
  apiKey: string;
  baseUrl: string;
}

const readThinking = (record: JsonRecord): string => readThinkingText(record);

const formatNvidiaHttpError = (
  status: number,
  statusText: string,
  body: string,
  model: string
): string => {
  const trimmed = body.trim();

  if (status === 410) {
    const detail = (() => {
      try {
        const payload = asJsonRecord(JSON.parse(trimmed));
        return (
          readString(asJsonRecord(payload.error).message) ||
          readString(payload.detail) ||
          readString(payload.message) ||
          trimmed
        );
      } catch {
        return trimmed;
      }
    })();

    const suffix = detail ? ` ${detail}` : "";
    return `NVIDIA NIM model "${model}" is no longer available.${suffix} Choose another NVIDIA model in Settings, then run Validate NVIDIA.`;
  }

  const statusLabel = statusText ? `${status} ${statusText}` : String(status);
  const suffix = trimmed ? ` ${trimmed}` : "";
  return `NVIDIA NIM request failed with HTTP ${statusLabel}.${suffix}`;
};

export class NvidiaProvider implements LlmProvider {
  readonly name = "nvidia" as const;

  constructor(private readonly config: NvidiaProviderConfig) {}

  listModels(): ModelOption[] {
    return [];
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const apiKey = this.config.apiKey.trim();

    if (!apiKey) {
      yield { type: "error", error: "NVIDIA NIM API key is not configured." };
      yield { type: "done" };
      return;
    }

    const pendingToolCalls = new Map<number, PendingOpenAiToolCall>();
    const seenToolCalls = new Set<string>();
    const toolNameMapper = createOpenAiToolNameMapper(request.tools);
    const init = this.buildRequest(request, apiKey, toolNameMapper, signal);
    const response = await this.fetchResponse(init, request.model.model);

    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") break;

      let payload: JsonRecord;

      try {
        payload = asJsonRecord(JSON.parse(data));
      } catch {
        yield { type: "error", error: "NVIDIA NIM returned invalid SSE JSON." };
        continue;
      }

      const providerError = readOpenAiErrorMessage(payload);

      if (providerError) {
        yield { type: "error", error: providerError };
        continue;
      }

      for (const rawChoice of readArray(payload.choices)) {
        const choice = asJsonRecord(rawChoice);
        const delta = asJsonRecord(choice.delta);
        const message = asJsonRecord(choice.message);
        const source = Object.keys(delta).length > 0 ? delta : message;

        const thinking = readThinking(source);
        if (thinking.length > 0) {
          yield { type: "thinking", delta: thinking };
        }

        const content = readString(source.content);
        if (content.length > 0) {
          yield { type: "token", delta: content };
        }

        readArray(source.tool_calls).forEach((rawCall, index) => {
          applyOpenAiToolCallDelta(pendingToolCalls, rawCall, index);
        });

        const finishReason = readOpenAiFinishReason(choice);

        if (finishReason === "tool_calls") {
          for (const call of flushOpenAiToolCalls(pendingToolCalls, toolNameMapper)) {
            const key = openAiToolCallKey(call);
            if (seenToolCalls.has(key)) continue;

            seenToolCalls.add(key);
            yield { type: "tool_call", call };
          }
        }
      }
    }

    for (const call of flushOpenAiToolCalls(pendingToolCalls, toolNameMapper)) {
      const key = openAiToolCallKey(call);
      if (seenToolCalls.has(key)) continue;

      seenToolCalls.add(key);
      yield { type: "tool_call", call };
    }

    yield { type: "done" };
  }

  private buildRequest(
    request: ProviderRequest,
    apiKey: string,
    toolNameMapper: OpenAiToolNameMapper,
    signal?: AbortSignal
  ): RequestInit {
    const tools = toOpenAiCompatibleTools(request.tools, toolNameMapper);
    const payload: Record<string, unknown> = {
      model: request.model.model,
      messages: toOpenAiCompatibleMessages([
        ...(request.instructions?.trim()
          ? [{ role: "system" as const, content: request.instructions }]
          : []),
        ...request.messages
      ], toolNameMapper),
      stream: true
    };

    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    const requestRecord = asJsonRecord(request);
    const temperature = readNumber(requestRecord.temperature);
    const maxTokens =
      readNumber(requestRecord.maxTokens) ||
      readNumber(requestRecord.max_tokens);

    if (temperature !== undefined) payload.temperature = temperature;
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;

    const init: RequestInit = {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    };

    if (signal) init.signal = signal;

    return init;
  }

  private async fetchResponse(
    init: RequestInit,
    model: string
  ): Promise<Response & { body: ReadableStream<Uint8Array> }> {
    const baseUrl = normalizeNvidiaBaseUrl(this.config.baseUrl);

    const response = await fetch(`${baseUrl}/chat/completions`, init).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new ProviderUnavailableError(
          `NVIDIA NIM is unavailable at ${baseUrl}. ${message}`
        );
      }
    );

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => response.statusText);

      throw new ProviderUnavailableError(
        formatNvidiaHttpError(
          response.status,
          response.statusText,
          body,
          model
        )
      );
    }

    return response as Response & { body: ReadableStream<Uint8Array> };
  }
}

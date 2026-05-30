import { defaultAppSettings } from "@shared/defaultSettings";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type {
  AppSettings,
  ModelOption,
  ProviderName,
  ProviderValidationResult
} from "@shared/types";
import {
  normalizeGroqBaseUrl,
  normalizeNvidiaBaseUrl
} from "@providers/shared/providerUrls";
import nvidiaValidatedModelData from "./data/nvidiaValidatedModels.json";
import { withResolvedModelMetadata } from "@providers/modelMetadata";
import { activeProviderModels, isRetiredProviderModel } from "@providers/retiredModels";


interface FetchJsonResult {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  payload: unknown;
}

interface NvidiaProbeResult {
  valid: boolean;
  rateLimited: boolean;
  retryable: boolean;
  message: string;
}

interface NvidiaCachedValidation {
  models: ModelOption[];
  updatedAt: number;
  message: string;
}

interface ProviderValidationOptions {
  onBackgroundModels?: (
    provider: ProviderName,
    models: ModelOption[],
    message: string
  ) => void;
  onLog?: (message: string) => void;
}

const NVIDIA_INITIAL_PROBE_LIMIT = 5;
const NVIDIA_RATE_LIMIT_DELAY_MS = 60000;
const NVIDIA_RETRYABLE_FAILURE_LIMIT = 3;
const NVIDIA_REQUEST_TIMEOUT_MS = 25000;

const nvidiaValidationCache = new Map<string, NvidiaCachedValidation>();
const nvidiaValidationJobs = new Map<string, AbortController>();

const asRecord = (value: unknown): JsonRecord => toJsonRecord(value);

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const trimTrailingSlashes = (value: string): string => {
  let next = value.trim();

  while (next.endsWith("/") && next.length > 0) {
    next = next.slice(0, -1);
  }

  return next;
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });

const safeJsonParse = (text: string): unknown => {
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const makeResult = (
  provider: ProviderName,
  ok: boolean,
  message: string,
  models: ModelOption[],
  warning?: string
): ProviderValidationResult => ({
  provider,
  ok,
  message,
  ...(warning ? { warning } : {}),
  models
});

const supportsThinkingFromModelRecord = (record: JsonRecord): boolean => {
  const direct = record.supportsThinking ?? record.supports_thinking;
  if (typeof direct === "boolean") return direct;

  const capabilities = asRecord(record.capabilities);
  const capability = capabilities.reasoning ?? capabilities.thinking;
  if (typeof capability === "boolean") return capability;

  const model = readString(record.id).toLowerCase();
  return (
    model.includes("reason") ||
    model.includes("thinking") ||
    model.includes("qwen3") ||
    model.includes("gpt-oss") ||
    model.includes("deepseek-r1") ||
    model.includes("nemotron") ||
    model.includes("gemma-4")
  );
};

const metadataRecordsFromModelRecord = (record: JsonRecord): JsonRecord[] => [
  record,
  asRecord(record.meta),
  asRecord(record.metadata),
  asRecord(record.details),
  asRecord(record.capabilities),
  asRecord(record.model_info),
  asRecord(record.modelInfo),
  asRecord(record.config)
];

const firstPositiveNumberField = (
  records: JsonRecord[],
  fields: string[]
): number | undefined => {
  for (const record of records) {
    for (const field of fields) {
      const value = readNumber(record[field]);

      if (value && value > 0) {
        return Math.floor(value);
      }
    }
  }

  return undefined;
};

const contextWindowFromModelRecord = (record: JsonRecord): number | undefined =>
  firstPositiveNumberField(metadataRecordsFromModelRecord(record), [
    "contextWindow",
    "context_window",
    "contextLength",
    "context_length",
    "maxContextLength",
    "max_context_length",
    "maxModelLen",
    "max_model_len",
    "maxPositionEmbeddings",
    "max_position_embeddings",
    "maxSequenceLength",
    "max_sequence_length",
    "inputTokenLimit",
    "input_token_limit",
    "inputTokens",
    "input_tokens",
    "n_ctx",
    "n_ctx_train",
    "num_ctx"
  ]);

const maxOutputTokensFromModelRecord = (
  record: JsonRecord
): number | undefined =>
  firstPositiveNumberField(metadataRecordsFromModelRecord(record), [
    "maxOutputTokens",
    "max_output_tokens",
    "maxCompletionTokens",
    "max_completion_tokens",
    "outputTokenLimit",
    "output_token_limit",
    "completionTokenLimit",
    "completion_token_limit"
  ]);

const makeModel = (
  provider: ProviderName,
  model: string,
  sourceRecord: JsonRecord = {}
): ModelOption => {
  const record = {
    ...sourceRecord,
    id: sourceRecord.id ?? model
  };
  const contextWindow = contextWindowFromModelRecord(record);
  const maxOutputTokens = maxOutputTokensFromModelRecord(record);

  return withResolvedModelMetadata({
    provider,
    model,
    label: model,
    supportsThinking: supportsThinkingFromModelRecord(record),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {})
  });
};

const uniqueSortedModels = (
  provider: ProviderName,
  modelRecords: Array<{ id: string; record: JsonRecord }>
): ModelOption[] => {
  const map = new Map<string, JsonRecord>();

  for (const item of modelRecords) {
    const id = item.id.trim();
    if (id.length > 0) map.set(id, item.record);
  }

  return activeProviderModels(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, record]) => makeModel(provider, model, record))
  );
};

const manualNvidiaModelOptions = (listedModels: ModelOption[]): ModelOption[] => {
  const data = asRecord(nvidiaValidatedModelData);
  const rawModels = readArray(data.models);
  const listedIds = new Set(listedModels.map((model) => model.model));
  const modelRecords: Array<{ id: string; record: JsonRecord }> = [];

  for (const item of rawModels) {
    const record = asRecord(item);
    const id = readString(record.model) || readString(record.id);

    if (
      !id ||
      isRetiredProviderModel("nvidia", id) ||
      (listedIds.size > 0 && !listedIds.has(id))
    ) {
      continue;
    }

    modelRecords.push({
      id,
      record: {
        ...record,
        id
      }
    });
  }

  return uniqueSortedModels("nvidia", modelRecords);
};

const errorMessageFromPayload = (
  result: FetchJsonResult,
  fallback: string
): string => {
  const payload = asRecord(result.payload);
  const error = asRecord(payload.error);

  return (
    readString(error.message) ||
    readString(payload.message) ||
    result.text ||
    result.statusText ||
    fallback
  );
};

const fetchJson = async (
  url: string,
  init: RequestInit,
  timeoutMs = NVIDIA_REQUEST_TIMEOUT_MS,
  parentSignal?: AbortSignal
): Promise<FetchJsonResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = (): void => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      payload: safeJsonParse(text)
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onAbort);
  }
};

const openAiModelsFromPayload = (
  provider: ProviderName,
  payload: unknown
): ModelOption[] => {
  const record = asRecord(payload);
  const data = readArray(record.data);
  const modelRecords: Array<{ id: string; record: JsonRecord }> = [];

  for (const item of data) {
    const model = asRecord(item);
    const id = readString(model.id);

    if (id && !isRetiredProviderModel(provider, id)) {
      modelRecords.push({ id, record: model });
    }
  }

  return uniqueSortedModels(provider, modelRecords);
};

const llamaCppModelsFromPayload = (payload: unknown): ModelOption[] =>
  openAiModelsFromPayload("llamaCpp", payload).map((model) => ({
    ...model,
    supportsThinking: model.supportsThinking || model.model.includes("gemma-4")
  }));

const ollamaModelsFromPayload = (payload: unknown): ModelOption[] => {
  const record = asRecord(payload);
  const data = readArray(record.models);
  const modelRecords: Array<{ id: string; record: JsonRecord }> = [];

  for (const item of data) {
    const model = asRecord(item);
    const name = readString(model.name) || readString(model.model);

    if (name) {
      modelRecords.push({ id: name, record: model });
    }
  }

  return uniqueSortedModels("ollama", modelRecords);
};

const cacheFingerprint = (apiKey: string, baseUrl: string): string => {
  let hash = 2166136261;
  const input = `${baseUrl}\n${apiKey}`;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `nvidia:${baseUrl}:${(hash >>> 0).toString(16)}`;
};

const validateGroq = async (
  settings: AppSettings
): Promise<ProviderValidationResult> => {
  const apiKey = settings.groqApiKey.trim();

  if (!apiKey) {
    return makeResult("groq", false, "Groq API key is required.", []);
  }

  let baseUrl: string;

  try {
    baseUrl = normalizeGroqBaseUrl(settings.groqBaseUrl);
  } catch {
    baseUrl = defaultAppSettings.groqBaseUrl;
  }

  try {
    const result = await fetchJson(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!result.ok) {
      return makeResult(
        "groq",
        false,
        `Groq validation failed: ${errorMessageFromPayload(
          result,
          "request failed"
        )}`,
        []
      );
    }

    const models = openAiModelsFromPayload("groq", result.payload);

    if (models.length === 0) {
      return makeResult(
        "groq",
        false,
        "Groq validation succeeded but returned no models.",
        []
      );
    }

    return makeResult(
      "groq",
      true,
      `Groq validated. Found ${models.length} model${
        models.length === 1 ? "" : "s"
      }.` ,
      models
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return makeResult("groq", false, `Groq validation failed: ${message}`, []);
  }
};

const normalizeLlamaCppBaseUrl = (value: string): string => {
  const raw = trimTrailingSlashes(
    value || defaultAppSettings.llamaCppBaseUrl
  );

  if (raw.endsWith("/v1")) return raw;
  return `${raw}/v1`;
};

const validateLlamaCpp = async (
  settings: AppSettings
): Promise<ProviderValidationResult> => {
  const baseUrl = normalizeLlamaCppBaseUrl(settings.llamaCppBaseUrl);

  try {
    const result = await fetchJson(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!result.ok) {
      return makeResult(
        "llamaCpp",
        false,
        `llama.cpp validation failed: ${errorMessageFromPayload(
          result,
          "request failed"
        )}`,
        []
      );
    }

    const models = llamaCppModelsFromPayload(result.payload);

    if (models.length === 0) {
      return makeResult(
        "llamaCpp",
        false,
        "llama.cpp responded but returned no OpenAI-compatible models.",
        []
      );
    }

    return makeResult(
      "llamaCpp",
      true,
      `llama.cpp validated. Found ${models.length} model${
        models.length === 1 ? "" : "s"
      }. Thinking streams from reasoning_content when the model emits it.`,
      models
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return makeResult(
      "llamaCpp",
      false,
      `llama.cpp validation failed: ${message}`,
      []
    );
  }
};

const validateOllama = async (
  settings: AppSettings
): Promise<ProviderValidationResult> => {
  const baseUrl = trimTrailingSlashes(
    settings.ollamaBaseUrl || defaultAppSettings.ollamaBaseUrl
  );

  try {
    const result = await fetchJson(`${baseUrl}/api/tags`, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!result.ok) {
      return makeResult(
        "ollama",
        false,
        `Ollama validation failed: ${errorMessageFromPayload(
          result,
          "request failed"
        )}`,
        []
      );
    }

    const models = ollamaModelsFromPayload(result.payload);

    if (models.length === 0) {
      return makeResult(
        "ollama",
        false,
        "Ollama responded but returned no local models.",
        []
      );
    }

    return makeResult(
      "ollama",
      true,
      `Ollama validated. Found ${models.length} model${
        models.length === 1 ? "" : "s"
      }.` ,
      models
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return makeResult(
      "ollama",
      false,
      `Ollama validation failed: ${message}`,
      []
    );
  }
};

const probeNvidiaChatModel = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<NvidiaProbeResult> => {
  try {
    const result = await fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "ok"
          }
        ],
        max_tokens: 1,
        temperature: 0,
        stream: false
      })
    }, NVIDIA_REQUEST_TIMEOUT_MS, signal);

    if (result.status === 429) {
      return {
        valid: false,
        rateLimited: true,
        retryable: true,
        message: errorMessageFromPayload(result, "rate limited")
      };
    }

    if (result.status >= 500) {
      return {
        valid: false,
        rateLimited: false,
        retryable: true,
        message: errorMessageFromPayload(result, "server error")
      };
    }

    if (!result.ok) {
      return {
        valid: false,
        rateLimited: false,
        retryable: false,
        message: errorMessageFromPayload(result, "request failed")
      };
    }

    const payload = asRecord(result.payload);
    const choices = readArray(payload.choices);

    if (choices.length === 0) {
      return {
        valid: false,
        rateLimited: false,
        retryable: false,
        message: "chat completion response had no choices"
      };
    }

    return {
      valid: true,
      rateLimited: false,
      retryable: false,
      message: "ok"
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      valid: false,
      rateLimited: false,
      retryable: true,
      message
    };
  }
};

const retryNvidiaProbeAfterDelay = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<NvidiaProbeResult> => {
  await sleep(NVIDIA_RATE_LIMIT_DELAY_MS, signal);
  return probeNvidiaChatModel(baseUrl, apiKey, model, signal);
};

const logNvidiaValidation = (
  options: ProviderValidationOptions | undefined,
  message: string
): void => {
  options?.onLog?.(`[nvidia] ${message}`);
};

const emitNvidiaBackgroundModels = (
  options: ProviderValidationOptions | undefined,
  validModelIds: string[],
  message: string
): void => {
  const models = uniqueSortedModels(
    "nvidia",
    validModelIds.map((id) => ({ id, record: {} }))
  );

  options?.onBackgroundModels?.("nvidia", models, message);
  logNvidiaValidation(options, message);
};

const collectInitialNvidiaModels = async (
  baseUrl: string,
  apiKey: string,
  listedModels: ModelOption[],
  signal?: AbortSignal
): Promise<ModelOption[]> => {
  const validModelIds: string[] = [];

  for (const listedModel of listedModels.slice(0, NVIDIA_INITIAL_PROBE_LIMIT)) {
    const probe = await probeNvidiaChatModel(
      baseUrl,
      apiKey,
      listedModel.model,
      signal
    );

    if (probe.valid) {
      validModelIds.push(listedModel.model);
    }
  }

  return uniqueSortedModels(
    "nvidia",
    validModelIds.map((id) => ({ id, record: {} }))
  );
};

const cancelStaleNvidiaValidationJobs = (activeCacheKey: string): void => {
  for (const [cacheKey, controller] of nvidiaValidationJobs.entries()) {
    if (cacheKey === activeCacheKey) continue;
    controller.abort();
    if (nvidiaValidationJobs.get(cacheKey) === controller) {
      nvidiaValidationJobs.delete(cacheKey);
    }
  }
};

const startNvidiaBackgroundValidation = (
  cacheKey: string,
  baseUrl: string,
  apiKey: string,
  listedModels: ModelOption[],
  options?: ProviderValidationOptions
): void => {
  if (nvidiaValidationJobs.has(cacheKey)) return;

  const controller = new AbortController();
  nvidiaValidationJobs.set(cacheKey, controller);

  void (async () => {
    const validModelIds: string[] = [];
    let retryableFailureCount = 0;
    let firstFailure = "";

    logNvidiaValidation(
      options,
      `background validation started for ${listedModels.length} listed models`
    );

    for (const listedModel of listedModels) {
      let probe = await probeNvidiaChatModel(
        baseUrl,
        apiKey,
        listedModel.model,
        controller.signal
      );

      if (probe.valid) {
        validModelIds.push(listedModel.model);
        retryableFailureCount = 0;
        emitNvidiaBackgroundModels(
          options,
          validModelIds,
          `${listedModel.model} passed chat probe. ${validModelIds.length} validated so far.`
        );
        continue;
      }

      if (!firstFailure) {
        firstFailure = `${listedModel.model}: ${probe.message}`;
      }

      if (probe.rateLimited) {
        logNvidiaValidation(
          options,
          `rate limit while probing ${listedModel.model}; waiting 60 seconds`
        );

        probe = await retryNvidiaProbeAfterDelay(
          baseUrl,
          apiKey,
          listedModel.model,
          controller.signal
        );

        if (probe.valid) {
          validModelIds.push(listedModel.model);
          retryableFailureCount = 0;
          emitNvidiaBackgroundModels(
            options,
            validModelIds,
            `${listedModel.model} passed chat probe after rate-limit retry. ${validModelIds.length} validated so far.`
          );
          continue;
        }
      }

      if (probe.retryable) {
        retryableFailureCount += 1;

        if (retryableFailureCount >= NVIDIA_RETRYABLE_FAILURE_LIMIT) {
          logNvidiaValidation(
            options,
            `${retryableFailureCount} retryable failures reached; waiting 60 seconds`
          );

          await sleep(NVIDIA_RATE_LIMIT_DELAY_MS, controller.signal);
          retryableFailureCount = 0;
        }
      } else {
        retryableFailureCount = 0;
      }

      logNvidiaValidation(
        options,
        `${listedModel.model} failed chat probe: ${probe.message}`
      );
    }

    const models = uniqueSortedModels(
      "nvidia",
      validModelIds.map((id) => ({ id, record: {} }))
    );

    const message =
      models.length === 0
        ? `NVIDIA NIM background validation found no usable chat models. First failure: ${
            firstFailure || "unknown"
          }`
        : `NVIDIA NIM background validation finished. ${models.length} of ${listedModels.length} listed models passed chat probe.`;

    nvidiaValidationCache.set(cacheKey, {
      models,
      updatedAt: Date.now(),
      message
    });

    emitNvidiaBackgroundModels(options, validModelIds, message);
    if (nvidiaValidationJobs.get(cacheKey) === controller) {
      nvidiaValidationJobs.delete(cacheKey);
    }
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = controller.signal.aborted
      ? "background validation cancelled"
      : `background validation failed unexpectedly: ${message}`;
    logNvidiaValidation(options, status);
    if (nvidiaValidationJobs.get(cacheKey) === controller) {
      nvidiaValidationJobs.delete(cacheKey);
    }
  });
};

const validateNvidia = async (
  settings: AppSettings,
  options?: ProviderValidationOptions
): Promise<ProviderValidationResult> => {
  const apiKey = settings.nvidiaApiKey.trim();

  if (!apiKey) {
    return makeResult("nvidia", false, "NVIDIA NIM API key is required.", []);
  }

  const baseUrl = normalizeNvidiaBaseUrl(settings.nvidiaBaseUrl);
  const cacheKey = cacheFingerprint(apiKey, baseUrl);
  cancelStaleNvidiaValidationJobs(cacheKey);
  const cached = nvidiaValidationCache.get(cacheKey);

  if (cached && cached.models.length > 0) {
    return makeResult(
      "nvidia",
      true,
      `${cached.message} Using cached NVIDIA model validation.`,
      cached.models
    );
  }

  try {
    const listResult = await fetchJson(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!listResult.ok) {
      return makeResult(
        "nvidia",
        false,
        `NVIDIA NIM validation failed: ${errorMessageFromPayload(
          listResult,
          "request failed"
        )}`,
        []
      );
    }

    const listedModels = openAiModelsFromPayload("nvidia", listResult.payload);

    if (listedModels.length === 0) {
      return makeResult(
        "nvidia",
        false,
        "NVIDIA NIM validation reached /models but no models were returned.",
        []
      );
    }

    const manualModels = manualNvidiaModelOptions(listedModels);

    if (manualModels.length > 0) {
      const message = `NVIDIA NIM key reached /models. Loaded ${manualModels.length} manually validated chat model${
        manualModels.length === 1 ? "" : "s"
      } from static validator data.`;

      nvidiaValidationCache.set(cacheKey, {
        models: manualModels,
        updatedAt: Date.now(),
        message
      });

      options?.onBackgroundModels?.("nvidia", manualModels, message);

      return makeResult("nvidia", true, message, manualModels);
    }

    startNvidiaBackgroundValidation(
      cacheKey,
      baseUrl,
      apiKey,
      listedModels,
      options
    );

    const initialModels = await collectInitialNvidiaModels(
      baseUrl,
      apiKey,
      listedModels
    );

    const message =
      initialModels.length > 0
        ? `NVIDIA NIM key reached /models. ${initialModels.length} chat model${
            initialModels.length === 1 ? "" : "s"
          } passed the initial probe. Background probes are continuing for ${
            listedModels.length
          } listed model${listedModels.length === 1 ? "" : "s"}.`
        : `NVIDIA NIM key reached /models. No listed model passed the initial chat probe yet; background probes are continuing for ${
            listedModels.length
          } listed model${listedModels.length === 1 ? "" : "s"}.`;

    const warning =
      initialModels.length === 0
        ? "No usable NVIDIA chat model has passed validation yet. Background probes are still running."
        : undefined;

    return makeResult(
      "nvidia",
      initialModels.length > 0,
      warning ? `${message} Warning: ${warning}` : message,
      initialModels,
      warning
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return makeResult(
      "nvidia",
      false,
      `NVIDIA NIM validation failed: ${message}`,
      []
    );
  }
};

export const validateAndDiscoverProvider = async (
  provider: ProviderName,
  settings: AppSettings,
  options?: ProviderValidationOptions
): Promise<ProviderValidationResult> => {
  if (provider === "groq") return validateGroq(settings);
  if (provider === "nvidia") return validateNvidia(settings, options);
  if (provider === "ollama") return validateOllama(settings);
  if (provider === "llamaCpp") return validateLlamaCpp(settings);

  return makeResult(provider, true, "Local test provider is available.", [
    {
      provider,
      model: "stub",
      label: "Local test provider",
      supportsThinking: false
    }
  ]);
};

export const validateProviderConfig = validateAndDiscoverProvider;

export const discoverProviderModels = async (
  provider: ProviderName,
  settings: AppSettings
): Promise<ModelOption[]> => {
  const result = await validateAndDiscoverProvider(provider, settings);
  return result.models;
};
import { defaultAppSettings } from "@shared/defaultSettings";
import type {
  AppSettings,
  ProviderHealthResult,
  ProviderName
} from "@shared/types";
import type { JsonRecord } from "@shared/json";
import {
  normalizeGroqBaseUrl,
  normalizeNvidiaBaseUrl
} from "@providers/shared/providerUrls";

interface FetchHealthResult {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
  text: string;
}

type HeaderMap = Record<string, string>;

const HEALTH_TIMEOUT_MS = 5000;

const trimTrailingSlashes = (value: string): string => {
  let next = value.trim();

  while (next.endsWith("/") && next.length > 0) {
    next = next.slice(0, -1);
  }

  return next;
};

const normalizeOpenAiBaseUrl = (value: string, fallback: string): string => {
  const raw = trimTrailingSlashes(value || fallback);
  if (raw.endsWith("/v1")) return raw;
  return `${raw}/v1`;
};

const normalizeOllamaBaseUrl = (value: string): string =>
  trimTrailingSlashes(value || defaultAppSettings.ollamaBaseUrl);

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const safeJsonParse = (text: string): unknown => {
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const errorMessageFromPayload = (result: FetchHealthResult): string => {
  const payload = asRecord(result.payload);
  const error = asRecord(payload.error);

  return (
    readString(error.message) ||
    readString(payload.message) ||
    result.text ||
    result.statusText ||
    `HTTP ${result.status}`
  );
};

const fetchHealthJson = async (
  url: string,
  headers: HeaderMap = {}
): Promise<FetchHealthResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...headers
      },
      signal: controller.signal
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      payload: safeJsonParse(text),
      text
    };
  } finally {
    clearTimeout(timeout);
  }
};

const onlineResult = (
  provider: ProviderName,
  endpoint: string,
  message: string,
  details: JsonRecord = {}
): ProviderHealthResult => ({
  provider,
  status: "online",
  endpoint,
  message,
  details
});

const loadingResult = (
  provider: ProviderName,
  endpoint: string,
  message: string,
  details: JsonRecord = {}
): ProviderHealthResult => ({
  provider,
  status: "loading",
  endpoint,
  message,
  details
});

const offlineResult = (
  provider: ProviderName,
  endpoint: string,
  message: string,
  details: JsonRecord = {}
): ProviderHealthResult => ({
  provider,
  status: "offline",
  endpoint,
  message,
  details
});

const unknownResult = (
  provider: ProviderName,
  endpoint: string,
  message: string,
  details: JsonRecord = {}
): ProviderHealthResult => ({
  provider,
  status: "unknown",
  endpoint,
  message,
  details
});

const modelCountFromOpenAiPayload = (payload: unknown): number =>
  readArray(asRecord(payload).data).length;

const modelCountFromOllamaPayload = (payload: unknown): number =>
  readArray(asRecord(payload).models).length;

const llamaCppContextWindow = (payload: unknown): number | undefined => {
  const data = readArray(asRecord(payload).data);
  const first = asRecord(data[0]);
  const meta = asRecord(first.meta);
  const context = meta.n_ctx;

  return typeof context === "number" && Number.isFinite(context)
    ? context
    : undefined;
};

const checkLlamaCppHealth = async (
  settings: AppSettings
): Promise<ProviderHealthResult> => {
  const endpoint = normalizeOpenAiBaseUrl(
    settings.llamaCppBaseUrl,
    defaultAppSettings.llamaCppBaseUrl
  );

  try {
    const result = await fetchHealthJson(`${endpoint}/models`);

    if (result.ok) {
      const modelCount = modelCountFromOpenAiPayload(result.payload);
      const contextWindow = llamaCppContextWindow(result.payload);
      const contextText = contextWindow ? ` Context: ${contextWindow}.` : "";

      return onlineResult(
        "llamaCpp",
        endpoint,
        `llama.cpp is online. Found ${modelCount} model${
          modelCount === 1 ? "" : "s"
        }.${contextText}`,
        contextWindow ? { modelCount, contextWindow } : { modelCount }
      );
    }

    if (result.status === 503) {
      return loadingResult(
        "llamaCpp",
        endpoint,
        `llama.cpp is reachable but the model is still loading. ${errorMessageFromPayload(
          result
        )}`,
        { status: result.status }
      );
    }

    return offlineResult(
      "llamaCpp",
      endpoint,
      `llama.cpp health check failed: ${errorMessageFromPayload(result)}`,
      { status: result.status }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return offlineResult("llamaCpp", endpoint, `llama.cpp is unreachable. ${message}`);
  }
};

const checkOllamaHealth = async (
  settings: AppSettings
): Promise<ProviderHealthResult> => {
  const endpoint = normalizeOllamaBaseUrl(settings.ollamaBaseUrl);

  try {
    const result = await fetchHealthJson(`${endpoint}/api/tags`);

    if (!result.ok) {
      return offlineResult(
        "ollama",
        endpoint,
        `Ollama health check failed: ${errorMessageFromPayload(result)}`,
        { status: result.status }
      );
    }

    const modelCount = modelCountFromOllamaPayload(result.payload);
    return onlineResult(
      "ollama",
      endpoint,
      `Ollama is online. Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`,
      { modelCount }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return offlineResult("ollama", endpoint, `Ollama is unreachable. ${message}`);
  }
};

const checkGroqHealth = async (
  settings: AppSettings
): Promise<ProviderHealthResult> => {
  const endpoint = normalizeGroqBaseUrl(settings.groqBaseUrl);
  const apiKey = settings.groqApiKey.trim();

  if (!apiKey) {
    return unknownResult("groq", endpoint, "Groq API key is not configured.");
  }

  try {
    const result = await fetchHealthJson(`${endpoint}/models`, {
      Authorization: `Bearer ${apiKey}`
    });

    if (!result.ok) {
      return offlineResult(
        "groq",
        endpoint,
        `Groq health check failed: ${errorMessageFromPayload(result)}`,
        { status: result.status }
      );
    }

    const modelCount = modelCountFromOpenAiPayload(result.payload);
    return onlineResult(
      "groq",
      endpoint,
      `Groq is online. Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`,
      { modelCount }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return offlineResult("groq", endpoint, `Groq is unreachable. ${message}`);
  }
};

const checkNvidiaHealth = async (
  settings: AppSettings
): Promise<ProviderHealthResult> => {
  const endpoint = normalizeNvidiaBaseUrl(settings.nvidiaBaseUrl);
  const apiKey = settings.nvidiaApiKey.trim();

  if (!apiKey) {
    return unknownResult("nvidia", endpoint, "NVIDIA API key is not configured.");
  }

  try {
    const result = await fetchHealthJson(`${endpoint}/models`, {
      Authorization: `Bearer ${apiKey}`
    });

    if (!result.ok) {
      return offlineResult(
        "nvidia",
        endpoint,
        `NVIDIA health check failed: ${errorMessageFromPayload(result)}`,
        { status: result.status }
      );
    }

    const modelCount = modelCountFromOpenAiPayload(result.payload);
    return onlineResult(
      "nvidia",
      endpoint,
      `NVIDIA endpoint is online. Found ${modelCount} listed model${
        modelCount === 1 ? "" : "s"
      }.` ,
      { modelCount }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return offlineResult("nvidia", endpoint, `NVIDIA endpoint is unreachable. ${message}`);
  }
};

export const checkProviderHealth = async (
  provider: ProviderName,
  settings: AppSettings
): Promise<ProviderHealthResult> => {
  if (provider === "llamaCpp") return checkLlamaCppHealth(settings);
  if (provider === "ollama") return checkOllamaHealth(settings);
  if (provider === "groq") return checkGroqHealth(settings);
  if (provider === "nvidia") return checkNvidiaHealth(settings);

  return onlineResult("stub", "local", "Local test provider is available.");
};

import {
  GROQ_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL
} from "@shared/defaultSettings";

const trimTrailingSlashes = (value: string): string => {
  let next = value.trim();

  while (next.endsWith("/") && next.length > 0) {
    next = next.slice(0, -1);
  }

  return next;
};

export const GROQ_BASE_URL = GROQ_DEFAULT_BASE_URL;
export const NVIDIA_BASE_URL = NVIDIA_DEFAULT_BASE_URL;
export const OLLAMA_BASE_URL = OLLAMA_DEFAULT_BASE_URL;

export const normalizeGroqBaseUrl = (value: string): string => {
  const raw = value.trim() || GROQ_DEFAULT_BASE_URL;
  const parsed = new URL(raw);
  const pathname = parsed.pathname.replace(/\/+$/, "");

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "api.groq.com" ||
    pathname !== "/openai/v1" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Groq base URL must be https://api.groq.com/openai/v1. Use a separate custom provider for other OpenAI-compatible endpoints."
    );
  }

  return GROQ_DEFAULT_BASE_URL;
};

export const normalizeNvidiaBaseUrl = (value: string): string => {
  const raw = value.trim() || NVIDIA_DEFAULT_BASE_URL;
  const parsed = new URL(raw);
  const pathname = parsed.pathname.replace(/\/+$/, "");

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "integrate.api.nvidia.com" ||
    pathname !== "/v1" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "NVIDIA NIM base URL must be https://integrate.api.nvidia.com/v1."
    );
  }

  return NVIDIA_DEFAULT_BASE_URL;
};

export const normalizeOllamaBaseUrl = (value: string): string => {
  const raw = value.trim() || OLLAMA_DEFAULT_BASE_URL;
  const trimmed = trimTrailingSlashes(raw);
  const parsed = new URL(trimmed);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama base URL must use http or https.");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Ollama base URL cannot include credentials, query, or hash.");
  }

  return trimTrailingSlashes(parsed.toString());
};
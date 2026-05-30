import type { ModelOption, ProviderName } from "@shared/types";

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const SAFETY_MARGIN_TOKENS = 512;
const DEFAULT_ASSUMED_CONTEXT_WINDOW = 32768;
const COMPACT_THRESHOLD_RATIO = 0.85;

/**
 * Conservative fallback used only when the provider does not expose an
 * official token-count endpoint. Hosted NVIDIA and Groq returned 404 for
 * the tokenization/count endpoints we tested, so prompt compaction must not
 * depend on unavailable network calls.
 */
const FALLBACK_CHARS_PER_TOKEN = 3;

export interface ContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
  compactAtTokens: number;
}

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.floor(value);
};

export const resolveContextWindow = (
  _provider: ProviderName,
  model?: ModelOption
): number => positiveInteger(model?.contextWindow) ?? DEFAULT_ASSUMED_CONTEXT_WINDOW;

export const resolveMaxOutputTokens = (model?: ModelOption): number =>
  positiveInteger(model?.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS;

export const buildContextBudget = (
  provider: ProviderName,
  model?: ModelOption
): ContextBudget => {
  const contextWindow = resolveContextWindow(provider, model);
  const maxOutputTokens = resolveMaxOutputTokens(model);
  const usableInputTokens = Math.max(
    256,
    contextWindow - maxOutputTokens - SAFETY_MARGIN_TOKENS
  );

  return {
    contextWindow,
    maxOutputTokens,
    safetyMarginTokens: SAFETY_MARGIN_TOKENS,
    usableInputTokens,
    compactAtTokens: Math.max(
      128,
      Math.floor(usableInputTokens * COMPACT_THRESHOLD_RATIO)
    )
  };
};

export const estimateTokens = (text: string): number => {
  const normalizedLength = text.trim().length;

  if (normalizedLength === 0) {
    return 0;
  }

  return Math.ceil(normalizedLength / FALLBACK_CHARS_PER_TOKEN);
};
import type { ModelOption } from "@shared/types";

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
};

export const withResolvedModelMetadata = (model: ModelOption): ModelOption => {
  const contextWindow = positiveInteger(model.contextWindow);
  const maxOutputTokens = positiveInteger(model.maxOutputTokens);

  return {
    provider: model.provider,
    model: model.model,
    label: model.label,
    supportsThinking: model.supportsThinking,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
  };
};
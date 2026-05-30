import type { ModelOption, ProviderName } from "@shared/types";

const retiredModelsByProvider: Partial<Record<ProviderName, ReadonlySet<string>>> = {
  nvidia: new Set([
    "qwen/qwen3-next-80b-a3b-thinking",
    "qwen/qwen3-next-80b-a3b-instruct"
  ])
};

export const isRetiredProviderModel = (
  provider: ProviderName,
  model: string
): boolean => retiredModelsByProvider[provider]?.has(model) ?? false;

export const isRetiredModelOption = (model: ModelOption): boolean =>
  isRetiredProviderModel(model.provider, model.model);

export const activeProviderModels = (models: ModelOption[]): ModelOption[] =>
  models.filter((model) => !isRetiredModelOption(model));

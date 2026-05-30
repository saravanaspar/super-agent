import type { ModelOption, ProviderName } from "@shared/types";
import type { LlmService } from "@providers/providerService";
import type { ProviderModelRepository } from "@persistence/providerModelRepository";
import { activeProviderModels } from "@providers/retiredModels";

const uniqueModels = (models: ModelOption[]): ModelOption[] => {
  const seen = new Set<string>();
  const result: ModelOption[] = [];

  for (const model of models) {
    const key = `${model.provider}:${model.model}`;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(model);
  }

  return result;
};

export class ModelService {
  constructor(
    private readonly llm: LlmService,
    private readonly providerModels: ProviderModelRepository
  ) {}

  list(): ModelOption[] {
    return activeProviderModels(
      uniqueModels([
        ...this.providerModels.list(),
        ...this.llm.listModels()
      ])
    );
  }

  replaceProviderModels(provider: ProviderName, models: ModelOption[]): void {
    this.providerModels.replaceProvider(provider, activeProviderModels(models));
  }
}
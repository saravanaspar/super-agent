import type { ModelOption, ProviderName } from "@shared/types";
import type { LlmProvider, ProviderRequest, ProviderStreamEvent } from "@providers/interfaces/provider";

export class LlmService {
  private readonly providers = new Map<ProviderName, LlmProvider>();

  register(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
  }

  listModels(): ModelOption[] {
    return [...this.providers.values()].flatMap((provider) => provider.listModels());
  }

  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const provider = this.providers.get(request.model.provider);
    if (!provider) throw new Error(`No provider registered for ${request.model.provider}.`);
    return provider.stream(request, signal);
  }
}

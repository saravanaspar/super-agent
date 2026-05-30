import type { LlmService } from "@providers/providerService";
import type { LlmProvider } from "@providers/interfaces/provider";

export const registerProviders = (
  llm: LlmService,
  providers: LlmProvider[]
): void => {
  for (const provider of providers) {
    llm.register(provider);
  }
};

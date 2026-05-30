import type { AppSettings } from "@shared/types";
import type { LlmProvider } from "@providers/interfaces/provider";
import { GroqProvider } from "@providers/adapters/groq/groqProvider";
import { NvidiaProvider } from "@providers/adapters/nvidia/nvidiaProvider";
import { OllamaProvider } from "@providers/adapters/ollama/ollamaProvider";
import { LlamaCppProvider } from "@providers/adapters/llamaCpp/llamaCppProvider";
import { StubProvider } from "@providers/adapters/stub/stubProvider";

export interface ProviderRegistryOptions {
  testProviderEnabled: boolean;
}

export const createProviders = (
  settings: AppSettings,
  options: ProviderRegistryOptions
): LlmProvider[] => {
  const providers: LlmProvider[] = [
    new GroqProvider({
      apiKey: settings.groqApiKey,
      baseUrl: settings.groqBaseUrl
    }),
    new NvidiaProvider({
      apiKey: settings.nvidiaApiKey,
      baseUrl: settings.nvidiaBaseUrl
    }),
    new OllamaProvider(settings.ollamaBaseUrl),
    new LlamaCppProvider({ baseUrl: settings.llamaCppBaseUrl })
  ];

  if (options.testProviderEnabled) {
    providers.push(new StubProvider());
  }

  return providers;
};

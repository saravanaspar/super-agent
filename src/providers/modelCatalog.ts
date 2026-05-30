import type { ModelOption } from "@shared/types";

export const stubModels: ModelOption[] = [
  {
    provider: "stub",
    model: "deterministic-stub",
    label: "Deterministic test provider",
    supportsThinking: true
  }
];

export const groqModels: ModelOption[] = [];

export const ollamaModels: ModelOption[] = [];
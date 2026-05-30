import type { AppSettings } from "./types";

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const LLAMA_CPP_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export const defaultAppSettings: AppSettings = {
  theme: "system",
  defaultProvider: "groq",
  defaultModel: "",
  groqApiKey: "",
  groqBaseUrl: GROQ_DEFAULT_BASE_URL,
  nvidiaApiKey: "",
  nvidiaBaseUrl: NVIDIA_DEFAULT_BASE_URL,
  ollamaBaseUrl: OLLAMA_DEFAULT_BASE_URL,
  llamaCppBaseUrl: LLAMA_CPP_DEFAULT_BASE_URL,
  agentOutsideWorkspaceAccess: false,
  agentPrivateNetworkAccess: false,
  agentShellSandboxEnabled: false,
  agentStreamingEnabled: true
};
import type {
  AppBootstrapState,
  AppSettings,
  AttachmentMetadata,
  ChatSession,
  ModelOption,
  ProviderName,
  SkillRecord,
} from "@shared/types";
import { defaultAppSettings } from "@shared/defaultSettings";

export const initialSettings: AppSettings = defaultAppSettings;

export const initialBootstrap: AppBootstrapState = {
  sessions: [],
  models: [],
  library: {
    plugins: {
      key: "plugins",
      title: "Plugins",
      status: "partial",
      description: "",
      items: [],
    },
    skills: {
      key: "skills",
      title: "Skills",
      status: "complete",
      description: "",
      items: [],
    },
    mcp: {
      key: "mcp",
      title: "MCP",
      status: "partial",
      description: "",
      items: [],
    },
    artifacts: {
      key: "artifacts",
      title: "Artifacts",
      status: "complete",
      description: "",
      items: [],
    },
    tools: {
      key: "tools",
      title: "Tools",
      status: "complete",
      description: "",
      items: [],
    },
    prompts: {
      key: "prompts",
      title: "Prompts",
      status: "complete",
      description: "",
      items: [],
    },
    models: {
      key: "models",
      title: "Models",
      status: "complete",
      description: "",
      items: [],
    },
  },
  workspaceStatus: "idle",
  workspaceUrl: "about:blank",
  workspaceDirectory: "",
  workspaceLogs: [],
  workspaceSnapshot: null,
  settings: initialSettings,
  testProviderEnabled: false,
};

export const sortSessions = (sessions: ChatSession[]): ChatSession[] =>
  [...sessions].sort((a, b) => {
    if (a.pinnedAt && !b.pinnedAt) return -1;
    if (!a.pinnedAt && b.pinnedAt) return 1;

    const firstDate = a.pinnedAt ?? a.updatedAt;
    const secondDate = b.pinnedAt ?? b.updatedAt;
    return secondDate.localeCompare(firstDate);
  });

export const modelsForProvider = (
  models: ModelOption[],
  provider: ProviderName,
): ModelOption[] =>
  models
    .filter((model) => model.provider === provider)
    .sort((a, b) => a.label.localeCompare(b.label));

export const replaceModelsForProvider = (
  models: ModelOption[],
  provider: ProviderName,
  providerModels: ModelOption[],
): ModelOption[] =>
  [
    ...models.filter((model) => model.provider !== provider),
    ...providerModels,
  ].sort((a, b) => a.label.localeCompare(b.label));

export const findModel = (
  models: ModelOption[],
  value: string,
): ModelOption | null => {
  const [provider, ...modelParts] = value.split(":");
  const model = modelParts.join(":");

  return (
    models.find((item) => item.provider === provider && item.model === model) ??
    null
  );
};

export const defaultModelFromSettings = (
  models: ModelOption[],
  settings: AppSettings,
): ModelOption | null => {
  const providerModels = modelsForProvider(models, settings.defaultProvider);

  return (
    providerModels.find((model) => model.model === settings.defaultModel) ??
    providerModels[0] ??
    null
  );
};

export const readAttachment = async (file: File): Promise<AttachmentMetadata> => {
  const canReadText =
    file.type.startsWith("text/") ||
    Boolean(file.name.match(/\.(ts|tsx|js|jsx|json|md|txt|css|html)$/i));

  const text = canReadText
    ? await file
        .text()
        .then((value) => value.slice(0, 120000))
        .catch(() => "")
    : "";

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    textPreview: text,
  };
};

export const directoryLabel = (directory: string | null): string => {
  if (!directory) return "No project selected";
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? directory;
};

export const isWorkspaceTool = (toolName: string): boolean =>
  toolName.startsWith("browser.") || toolName === "workspace.status";

export const sortSkillsByName = (skills: SkillRecord[]): SkillRecord[] =>
  [...skills].sort((a, b) => a.name.localeCompare(b.name));

export const upsertSkillRecord = (skills: SkillRecord[], saved: SkillRecord): SkillRecord[] =>
  sortSkillsByName([
    ...skills.filter((item) => item.id !== saved.id),
    saved,
  ]);

export const removeSkillRecord = (skills: SkillRecord[], skillId: string): SkillRecord[] =>
  skills.filter((item) => item.id !== skillId);

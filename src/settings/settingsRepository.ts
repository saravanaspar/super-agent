import { defaultAppSettings } from "@shared/defaultSettings";
import {
  normalizeGroqBaseUrl,
  normalizeNvidiaBaseUrl
} from "@providers/shared/providerUrls";
import type { AppSettings, ProviderName, ThemeMode } from "@shared/types";
import type { LocalDatabase } from "@persistence/localDatabase";

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

const SECRET_PREFIX = "enc:v1:";
const secretSettingKeys = new Set(["groqApiKey", "nvidiaApiKey"]);

const validTheme = (value: string): ThemeMode => {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
};

const validProvider = (value: string): ProviderName => {
  if (
    value === "groq" ||
    value === "nvidia" ||
    value === "ollama" ||
    value === "llamaCpp" ||
    value === "stub"
  ) {
    return value;
  }

  return "groq";
};

const trimTrailingSlashes = (value: string): string => {
  let next = value.trim();

  while (next.endsWith("/") && next.length > 0) {
    next = next.slice(0, -1);
  }

  return next;
};

const safeGroqBaseUrl = (value: string): string => {
  try {
    return normalizeGroqBaseUrl(value);
  } catch {
    return defaultAppSettings.groqBaseUrl;
  }
};

const safeBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
};

const safeHttpBaseUrl = (value: string, fallback: string): string => {
  const raw = value.trim() || fallback;
  const trimmed = trimTrailingSlashes(raw);

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }

    return trimTrailingSlashes(parsed.toString());
  } catch {
    return fallback;
  }
};

const safeNvidiaBaseUrl = (value: string): string => {
  try {
    return normalizeNvidiaBaseUrl(value || defaultAppSettings.nvidiaBaseUrl);
  } catch {
    return defaultAppSettings.nvidiaBaseUrl;
  }
};

const safeOllamaBaseUrl = (value: string): string =>
  safeHttpBaseUrl(value, defaultAppSettings.ollamaBaseUrl);

const safeLlamaCppBaseUrl = (value: string): string =>
  safeHttpBaseUrl(value, defaultAppSettings.llamaCppBaseUrl);

const settingsEntries = (settings: AppSettings): Array<[string, string]> => [
  ["theme", settings.theme],
  ["defaultProvider", settings.defaultProvider],
  ["defaultModel", settings.defaultModel],
  ["groqApiKey", settings.groqApiKey],
  ["groqBaseUrl", settings.groqBaseUrl],
  ["nvidiaApiKey", settings.nvidiaApiKey],
  ["nvidiaBaseUrl", settings.nvidiaBaseUrl],
  ["ollamaBaseUrl", settings.ollamaBaseUrl],
  ["llamaCppBaseUrl", settings.llamaCppBaseUrl],
  ["agentOutsideWorkspaceAccess", String(settings.agentOutsideWorkspaceAccess)],
  ["agentPrivateNetworkAccess", String(settings.agentPrivateNetworkAccess)],
  ["agentShellSandboxEnabled", String(settings.agentShellSandboxEnabled)],
  ["agentStreamingEnabled", String(settings.agentStreamingEnabled)]
];

export class SettingsRepository {
  constructor(
    private readonly database: LocalDatabase,
    private readonly secretCodec: SecretCodec | null = null
  ) {
    this.database.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  get(): AppSettings {
    const rows = this.database.select(
      "SELECT key, value FROM settings",
      [],
      (row) => ({
        key: String(row.key ?? ""),
        value: String(row.value ?? "")
      })
    );

    const values = new Map(rows.map((row) => [row.key, row.value]));

    return {
      theme: validTheme(values.get("theme") ?? defaultAppSettings.theme),
      defaultProvider: validProvider(
        values.get("defaultProvider") ?? defaultAppSettings.defaultProvider
      ),
      defaultModel: values.get("defaultModel") ?? defaultAppSettings.defaultModel,
      groqApiKey: this.decodeSetting(
        "groqApiKey",
        values.get("groqApiKey") ?? defaultAppSettings.groqApiKey
      ),
      groqBaseUrl: safeGroqBaseUrl(
        values.get("groqBaseUrl") ?? defaultAppSettings.groqBaseUrl
      ),
      nvidiaApiKey: this.decodeSetting(
        "nvidiaApiKey",
        values.get("nvidiaApiKey") ?? defaultAppSettings.nvidiaApiKey
      ),
      nvidiaBaseUrl: safeNvidiaBaseUrl(
        values.get("nvidiaBaseUrl") ?? defaultAppSettings.nvidiaBaseUrl
      ),
      ollamaBaseUrl: safeOllamaBaseUrl(
        values.get("ollamaBaseUrl") ?? defaultAppSettings.ollamaBaseUrl
      ),
      llamaCppBaseUrl: safeLlamaCppBaseUrl(
        values.get("llamaCppBaseUrl") ?? defaultAppSettings.llamaCppBaseUrl
      ),
      agentOutsideWorkspaceAccess: safeBoolean(
        values.get("agentOutsideWorkspaceAccess"),
        defaultAppSettings.agentOutsideWorkspaceAccess
      ),
      agentPrivateNetworkAccess: safeBoolean(
        values.get("agentPrivateNetworkAccess"),
        defaultAppSettings.agentPrivateNetworkAccess
      ),
      agentShellSandboxEnabled: safeBoolean(
        values.get("agentShellSandboxEnabled"),
        defaultAppSettings.agentShellSandboxEnabled
      ),
      agentStreamingEnabled: safeBoolean(
        values.get("agentStreamingEnabled"),
        defaultAppSettings.agentStreamingEnabled
      )
    };
  }

  save(settings: AppSettings): AppSettings {
    const next: AppSettings = {
      theme: validTheme(settings.theme),
      defaultProvider: validProvider(settings.defaultProvider),
      defaultModel: String(settings.defaultModel || ""),
      groqApiKey: String(settings.groqApiKey || ""),
      groqBaseUrl: normalizeGroqBaseUrl(
        String(settings.groqBaseUrl || defaultAppSettings.groqBaseUrl)
      ),
      nvidiaApiKey: String(settings.nvidiaApiKey || ""),
      nvidiaBaseUrl: normalizeNvidiaBaseUrl(
        String(settings.nvidiaBaseUrl || defaultAppSettings.nvidiaBaseUrl)
      ),
      ollamaBaseUrl: safeOllamaBaseUrl(
        String(settings.ollamaBaseUrl || defaultAppSettings.ollamaBaseUrl)
      ),
      llamaCppBaseUrl: safeLlamaCppBaseUrl(
        String(settings.llamaCppBaseUrl || defaultAppSettings.llamaCppBaseUrl)
      ),
      agentOutsideWorkspaceAccess: settings.agentOutsideWorkspaceAccess === true,
      agentPrivateNetworkAccess: settings.agentPrivateNetworkAccess === true,
      agentShellSandboxEnabled: settings.agentShellSandboxEnabled === true,
      agentStreamingEnabled: settings.agentStreamingEnabled !== false
    };

    this.assertSecretsCanBeStored(next);

    for (const [key, value] of settingsEntries(next)) {
      this.database.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [key, this.encodeSetting(key, value)]
      );
    }

    return next;
  }

  private encodeSetting(key: string, value: string): string {
    if (!secretSettingKeys.has(key) || !value) return value;
    if (!this.secretCodec) {
      throw new Error(
        "Provider API keys can only be saved when safeStorage encryption is available."
      );
    }
    return `${SECRET_PREFIX}${this.secretCodec.encrypt(value)}`;
  }

  private decodeSetting(key: string, value: string): string {
    if (!secretSettingKeys.has(key)) return value;
    if (!value) return "";
    if (!value.startsWith(SECRET_PREFIX)) {
      return this.secretCodec ? value : "";
    }
    if (!this.secretCodec) return "";

    try {
      return this.secretCodec.decrypt(value.slice(SECRET_PREFIX.length));
    } catch {
      return "";
    }
  }

  private assertSecretsCanBeStored(settings: AppSettings): void {
    if (this.secretCodec) return;

    if (settings.groqApiKey || settings.nvidiaApiKey) {
      throw new Error(
        "Provider API keys can only be saved when safeStorage encryption is available."
      );
    }
  }
}

import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  ModelOption,
  ProviderName,
  ProviderValidationResult,
  ThemeMode
} from "@shared/types";

interface SettingsPanelProps {
  settings: AppSettings;
  models: ModelOption[];
  testProviderEnabled: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
  onValidate: (
    provider: ProviderName,
    settings: AppSettings
  ) => Promise<ProviderValidationResult>;
}

type SaveState = "idle" | "saving" | "saved" | "failed";
type SettingsView = "providers" | "agents" | "appearance";

const providerOptions: Array<{ value: ProviderName; label: string }> = [
  { value: "groq", label: "Groq" },
  { value: "nvidia", label: "NVIDIA NIM" },
  { value: "ollama", label: "Ollama" },
  { value: "llamaCpp", label: "llama.cpp" },
  { value: "stub", label: "Local test provider" }
];

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

const providerDisplayName = (provider: ProviderName): string => {
  if (provider === "groq") return "Groq";
  if (provider === "nvidia") return "NVIDIA NIM";
  if (provider === "ollama") return "Ollama";
  if (provider === "llamaCpp") return "llama.cpp";
  return "Local test provider";
};

const mergeModels = (
  existingModels: ModelOption[],
  discoveredModels: ModelOption[]
): ModelOption[] => {
  const map = new Map<string, ModelOption>();

  for (const model of existingModels) {
    map.set(`${model.provider}:${model.model}`, model);
  }

  for (const model of discoveredModels) {
    map.set(`${model.provider}:${model.model}`, model);
  }

  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
};

const modelsForProvider = (
  models: ModelOption[],
  provider: ProviderName
): ModelOption[] =>
  models
    .filter((model) => model.provider === provider)
    .sort((a, b) => a.label.localeCompare(b.label));

export function SettingsPanel(props: SettingsPanelProps) {
  const [activeView, setActiveView] = useState<SettingsView>("providers");
  const [draft, setDraft] = useState<AppSettings>(props.settings);
  const [localModels, setLocalModels] = useState<ModelOption[]>(props.models);
  const [validatingProvider, setValidatingProvider] =
    useState<ProviderName | null>(null);
  const [validationMap, setValidationMap] = useState<
    Partial<Record<ProviderName, ProviderValidationResult>>
  >({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  useEffect(() => {
    setLocalModels((current) => mergeModels(current, props.models));
  }, [props.models]);

  const defaultModels = useMemo(
    () => modelsForProvider(localModels, draft.defaultProvider),
    [draft.defaultProvider, localModels]
  );

  const availableProviderOptions = useMemo(
    () =>
      providerOptions.filter(
        (provider) => provider.value !== "stub" || props.testProviderEnabled
      ),
    [props.testProviderEnabled]
  );

  const validateProvider = async (provider: ProviderName) => {
    setValidatingProvider(provider);

    try {
      const result = await props.onValidate(provider, draft);

      setValidationMap((current) => ({
        ...current,
        [provider]: result
      }));

      if (result.ok) {
        setLocalModels((current) => mergeModels(current, result.models));

        const preferredModel = result.models[0];

        if (
          preferredModel &&
          (draft.defaultProvider !== provider || !draft.defaultModel)
        ) {
          setDraft((current) => ({
            ...current,
            defaultProvider: provider,
            defaultModel: preferredModel.model
          }));
        }
      }
    } finally {
      setValidatingProvider(null);
    }
  };

  const saveSettings = async () => {
    setSaveState("saving");
    setSaveError("");

    try {
      await props.onSave(draft);
      setSaveState("saved");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Settings could not be saved."
      );
      setSaveState("failed");
    }
  };

  const providerNotice = (provider: ProviderName) => validationMap[provider];

  return (
    <main className="settings-panel">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Provider access, model selection, and appearance.</p>
        </div>
        <button className="button secondary" onClick={props.onClose}>
          Close
        </button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <button
            className={
              activeView === "providers"
                ? "settings-nav-item active"
                : "settings-nav-item"
            }
            onClick={() => setActiveView("providers")}
          >
            Providers
          </button>
          <button
            className={
              activeView === "appearance"
                ? "settings-nav-item active"
                : "settings-nav-item"
            }
            onClick={() => setActiveView("appearance")}
          >
            Appearance
          </button>
          <button
            className={
              activeView === "agents"
                ? "settings-nav-item active"
                : "settings-nav-item"
            }
            onClick={() => setActiveView("agents")}
          >
            Agents
          </button>
        </nav>

        <div className="settings-stack">
          {activeView === "providers" ? (
            <>
              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <h2>Providers</h2>
                    <p>Configure provider credentials and fetch live model lists.</p>
                  </div>
                </div>

                <div className="provider-stack">
                  <article className="provider-card">
                    <div className="provider-card-header">
                      <div>
                        <h3>Groq</h3>
                        <p>Cloud inference provider. Requires an API key.</p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={validatingProvider !== null}
                        onClick={() => void validateProvider("groq")}
                      >
                        {validatingProvider === "groq"
                          ? "Validating"
                          : "Validate Groq"}
                      </button>
                    </div>

                    <div className="form-grid">
                      <label htmlFor="groq-key">API key</label>
                      <input
                        id="groq-key"
                        type="password"
                        value={draft.groqApiKey}
                        placeholder="Enter API key"
                        autoComplete="off"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            groqApiKey: event.target.value
                          }))
                        }
                      />

                      <label htmlFor="groq-url">Base URL</label>
                      <input
                        id="groq-url"
                        value={draft.groqBaseUrl}
                        placeholder="https://api.groq.com/openai/v1"
                        readOnly
                      />
                    </div>

                    {providerNotice("groq") ? (
                      <div
                        className={
                          providerNotice("groq")?.ok
                            ? "notice success"
                            : "notice error"
                        }
                        role="status"
                      >
                        {providerNotice("groq")?.message}
                      </div>
                    ) : null}
                  </article>

                  <article className="provider-card">
                    <div className="provider-card-header">
                      <div>
                        <h3>NVIDIA NIM</h3>
                        <p>
                          OpenAI-compatible NVIDIA inference endpoint. Validation
                          only adds models after they pass a chat probe;
                          background probes update this list as they finish.
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={validatingProvider !== null}
                        onClick={() => void validateProvider("nvidia")}
                      >
                        {validatingProvider === "nvidia"
                          ? "Validating"
                          : "Validate NVIDIA"}
                      </button>
                    </div>

                    <div className="form-grid">
                      <label htmlFor="nvidia-key">API key</label>
                      <input
                        id="nvidia-key"
                        type="password"
                        value={draft.nvidiaApiKey}
                        placeholder="Enter NVIDIA API key"
                        autoComplete="off"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            nvidiaApiKey: event.target.value
                          }))
                        }
                      />

                      <label htmlFor="nvidia-url">Base URL</label>
                      <input
                        id="nvidia-url"
                        value={draft.nvidiaBaseUrl}
                        placeholder="https://integrate.api.nvidia.com/v1"
                        readOnly
                      />
                    </div>

                    {providerNotice("nvidia") ? (
                      <div
                        className={
                          providerNotice("nvidia")?.ok
                            ? "notice success"
                            : "notice error"
                        }
                        role="status"
                      >
                        {providerNotice("nvidia")?.message}
                      </div>
                    ) : null}
                  </article>

                  <article className="provider-card">
                    <div className="provider-card-header">
                      <div>
                        <h3>Ollama</h3>
                        <p>
                          Local or network-hosted inference server. Set any reachable
                          base URL.
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={validatingProvider !== null}
                        onClick={() => void validateProvider("ollama")}
                      >
                        {validatingProvider === "ollama"
                          ? "Validating"
                          : "Validate Ollama"}
                      </button>
                    </div>

                    <div className="form-grid">
                      <label htmlFor="ollama-url">Base URL</label>
                      <input
                        id="ollama-url"
                        value={draft.ollamaBaseUrl}
                        placeholder="http://127.0.0.1:11434 or http://192.168.1.20:11434"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            ollamaBaseUrl: event.target.value
                          }))
                        }
                      />
                    </div>

                    {providerNotice("ollama") ? (
                      <div
                        className={
                          providerNotice("ollama")?.ok
                            ? "notice success"
                            : "notice error"
                        }
                        role="status"
                      >
                        {providerNotice("ollama")?.message}
                      </div>
                    ) : null}
                  </article>

                  <article className="provider-card">
                    <div className="provider-card-header">
                      <div>
                        <h3>llama.cpp</h3>
                        <p>
                          OpenAI-compatible local server. Use this for the Jetson
                          raw llama.cpp service and reasoning_content streaming.
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={validatingProvider !== null}
                        onClick={() => void validateProvider("llamaCpp")}
                      >
                        {validatingProvider === "llamaCpp"
                          ? "Validating"
                          : "Validate llama.cpp"}
                      </button>
                    </div>

                    <div className="form-grid">
                      <label htmlFor="llama-cpp-url">Base URL</label>
                      <input
                        id="llama-cpp-url"
                        value={draft.llamaCppBaseUrl}
                        placeholder="http://192.168.1.50:11434/v1"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            llamaCppBaseUrl: event.target.value
                          }))
                        }
                      />
                    </div>

                    {providerNotice("llamaCpp") ? (
                      <div
                        className={
                          providerNotice("llamaCpp")?.ok
                            ? "notice success"
                            : "notice error"
                        }
                        role="status"
                      >
                        {providerNotice("llamaCpp")?.message}
                      </div>
                    ) : null}
                  </article>
                </div>
              </section>

              <section className="settings-section">
                <div className="section-heading">
                  <div>
                    <h2>Defaults</h2>
                    <p>
                      Applied to new chats. Existing chats keep their current model.
                    </p>
                  </div>
                </div>

                <div className="form-grid">
                  <label htmlFor="default-provider">Default provider</label>
                  <select
                    id="default-provider"
                    value={draft.defaultProvider}
                    onChange={(event) => {
                      const nextProvider = event.target.value as ProviderName;
                      const nextModel = modelsForProvider(
                        localModels,
                        nextProvider
                      )[0];

                      setDraft((current) => ({
                        ...current,
                        defaultProvider: nextProvider,
                        defaultModel: nextModel?.model ?? ""
                      }));
                    }}
                  >
                    {availableProviderOptions.map((provider) => (
                      <option key={provider.value} value={provider.value}>
                        {provider.label}
                      </option>
                    ))}
                  </select>

                  <label htmlFor="default-model">Default model</label>
                  <select
                    id="default-model"
                    value={draft.defaultModel}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        defaultModel: event.target.value
                      }))
                    }
                  >
                    <option value="">
                      {defaultModels.length === 0
                        ? `Validate ${providerDisplayName(
                            draft.defaultProvider
                          )} to fetch models`
                        : "Select model"}
                    </option>
                    {defaultModels.map((model) => (
                      <option
                        key={`${model.provider}:${model.model}`}
                        value={model.model}
                      >
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            </>
          ) : activeView === "agents" ? (
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Agent behavior</h2>
                  <p>Limits for agent-controlled tools and browser actions.</p>
                </div>
              </div>

              <div className="settings-check-list">
                <label className="settings-check-row" htmlFor="agent-outside-workspace">
                  <input
                    id="agent-outside-workspace"
                    type="checkbox"
                    checked={draft.agentOutsideWorkspaceAccess}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agentOutsideWorkspaceAccess: event.target.checked
                      }))
                    }
                  />
                  <span>
                    <strong>Allow outside-workspace file access</strong>
                    <span>
                      When off, read, list, search, edit, create, and remove tools stay inside the selected workspace, even in full access mode.
                    </span>
                  </span>
                </label>

                <label className="settings-check-row" htmlFor="agent-private-network">
                  <input
                    id="agent-private-network"
                    type="checkbox"
                    checked={draft.agentPrivateNetworkAccess}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agentPrivateNetworkAccess: event.target.checked
                      }))
                    }
                  />
                  <span>
                    <strong>Allow browser access to localhost and private networks</strong>
                    <span>
                      When off, browser actions block localhost, loopback, private, and reserved network targets.
                    </span>
                  </span>
                </label>

                <label className="settings-check-row" htmlFor="agent-shell-sandbox">
                  <input
                    id="agent-shell-sandbox"
                    type="checkbox"
                    checked={draft.agentShellSandboxEnabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agentShellSandboxEnabled: event.target.checked
                      }))
                    }
                  />
                  <span>
                    <strong>Run shell commands in an isolated sandbox</strong>
                    <span>
                      When off, shell commands run in the selected workspace using your normal local environment. Enable this only when you want bubblewrap/sandbox-exec/container isolation.
                    </span>
                  </span>
                </label>

                <label className="settings-check-row" htmlFor="agent-streaming">
                  <input
                    id="agent-streaming"
                    type="checkbox"
                    checked={draft.agentStreamingEnabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        agentStreamingEnabled: event.target.checked
                      }))
                    }
                  />
                  <span>
                    <strong>Stream responses while the model is writing</strong>
                    <span>
                      When off, the chat waits and renders assistant text in larger completed chunks instead of live token updates.
                    </span>
                  </span>
                </label>
              </div>
            </section>
          ) : (
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h2>Appearance</h2>
                  <p>Choose how Super Agent looks on this device.</p>
                </div>
              </div>

              <div className="form-grid">
                <label htmlFor="theme">Theme</label>
                <select
                  id="theme"
                  value={draft.theme}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      theme: event.target.value as ThemeMode
                    }))
                  }
                >
                  {themeOptions.map((theme) => (
                    <option key={theme.value} value={theme.value}>
                      {theme.label}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          )}
        </div>
      </div>

      <footer className="page-footer">
        <div className="footer-status-group">
          {saveState === "saved" ? (
            <span className="footer-status">Settings saved.</span>
          ) : null}
          {saveState === "failed" ? (
            <span className="footer-status error">
              {saveError || "Settings could not be saved."}
            </span>
          ) : null}
        </div>
        <button
          className="button primary"
          disabled={saveState === "saving"}
          onClick={() => void saveSettings()}
        >
          {saveState === "saving" ? "Saving" : "Save settings"}
        </button>
      </footer>
    </main>
  );
}

import type {
  AttachmentMetadata,
  ChatMessage,
  ModelOption,
  PermissionMode,
  ProviderHealthResult,
  SkillRecord
} from "@shared/types";
import { ChatInput } from "./ChatInput";
import { MessageList } from "./MessageList";

interface ChatAreaProps {
  messages: ChatMessage[];
  prompt: string;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  permissionMode: PermissionMode;
  attachments: AttachmentMetadata[];
  streaming: boolean;
  workspaceOpen: boolean;
  sidebarCollapsed: boolean;
  providerHealth: ProviderHealthResult | null;
  canRegenerate: boolean;
  workspaceLabel: string;
  skills: SkillRecord[];
  selectedSkillIds: string[];
  onPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onPermissionChange: (value: PermissionMode) => void;
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
  onSelectWorkspace: () => void;
  onSelectedSkillIdsChange: (ids: string[]) => void;
  onSubmit: () => void;
  onStop: () => void;
  onRegenerate: () => void;
  onToggleWorkspace: () => void;
  onToggleSidebar: () => void;
}

function providerHealthLabel(health: ProviderHealthResult | null): string {
  if (!health) return "Provider status unknown";

  if (health.status === "online") return "Provider online";
  if (health.status === "loading") return "Provider loading";
  if (health.status === "offline") return "Provider offline";
  return "Provider status unknown";
}

function healthContextWindow(
  health: ProviderHealthResult | null,
  model: ModelOption | null
): string | null {
  const value = health?.details.contextWindow ?? model?.contextWindow;

  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }

  return null;
}

function ProviderHealthBadge({
  health,
  model
}: {
  health: ProviderHealthResult | null;
  model: ModelOption | null;
}) {
  const contextWindow = healthContextWindow(health, model);

  return (
    <div
      className={`provider-health ${health?.status ?? "unknown"}`}
      title={health?.message ?? "Provider health has not been checked yet."}
      aria-label={providerHealthLabel(health)}
    >
      <span className="provider-health-dot" aria-hidden="true" />
      <span>{health?.status ?? "unknown"}</span>
      {contextWindow ? (
        <span className="provider-health-context">ctx {contextWindow}</span>
      ) : null}
    </div>
  );
}

function LayoutIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3.5"
        y="5"
        width="17"
        height="14"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d={side === "left" ? "M9 5v14" : "M15 5v14"}
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

export function ChatArea(props: ChatAreaProps) {
  return (
    <main className="chat-area">
      <header className="page-header chat-header">
        <div className="toolbar-left">
          <button
            className="icon-button"
            aria-label={props.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={props.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={props.onToggleSidebar}
          >
            <LayoutIcon side="left" />
          </button>
          <div>
            <h1>Super Agent</h1>
            <p>Chat with a workspace the agent can control when needed.</p>
          </div>
        </div>

        <div className="toolbar-right">
          <ProviderHealthBadge
            health={props.providerHealth}
            model={props.selectedModel}
          />

          <button
            className={props.workspaceOpen ? "icon-button active" : "icon-button"}
            aria-label={props.workspaceOpen ? "Hide workspace" : "Show workspace"}
            title={props.workspaceOpen ? "Hide workspace" : "Show workspace"}
            onClick={props.onToggleWorkspace}
          >
            <LayoutIcon side="right" />
          </button>
        </div>
      </header>

      <MessageList
        messages={props.messages}
        streaming={props.streaming}
        canRegenerate={props.canRegenerate}
        onRegenerate={props.onRegenerate}
      />

      <ChatInput
        value={props.prompt}
        models={props.models}
        selectedModel={props.selectedModel}
        permissionMode={props.permissionMode}
        attachments={props.attachments}
        streaming={props.streaming}
        workspaceLabel={props.workspaceLabel}
        skills={props.skills}
        selectedSkillIds={props.selectedSkillIds}
        onValueChange={props.onPromptChange}
        onModelChange={props.onModelChange}
        onPermissionChange={props.onPermissionChange}
        onAttach={props.onAttach}
        onRemoveAttachment={props.onRemoveAttachment}
        onSelectWorkspace={props.onSelectWorkspace}
        onSelectedSkillIdsChange={props.onSelectedSkillIdsChange}
        onSubmit={props.onSubmit}
        onStop={props.onStop}
      />
    </main>
  );
}
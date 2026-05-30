import type { AgentKind } from "@shared/types";
import {
  BROWSER_AGENT_SYSTEM,
  CODING_AGENT_SYSTEM,
  DESKTOP_AGENT_SYSTEM,
  GENERAL_AGENT_SYSTEM,
  INTENT_ROUTER_SYSTEM,
  PERMISSION_POLICY_SYSTEM,
  REVIEW_SUBAGENT_INSTRUCTION,
  STABLE_AGENT_RUNTIME,
  SUPER_AGENT_BASE_SYSTEM,
  TODO_PLANNING_INSTRUCTION,
  TOOL_SELECTION_INSTRUCTION,
  VISIBLE_PROGRESS_INSTRUCTION
} from "./fragments";

type PromptKind = "system" | "system_fragment" | "user_prompt";
type PromptContext = Record<string, unknown>;

export interface PromptDefinition {
  kind: PromptKind;
  usedBy: string;
  purpose: string;
  rationale: string;
  template: (context?: PromptContext) => string;
}

const asText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return jsonString(value);
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => asText(item)).filter(Boolean) : [];

const jsonString = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify("[unserializable]");
  }
};

const joinNonEmpty = (parts: string[], separator = "\n"): string =>
  parts.filter((part) => part.trim().length > 0).join(separator);

export const PROMPT_DEFINITIONS: Record<string, PromptDefinition> = {
  "super-agent.autonomous.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Primary autonomous desktop/coding/browser agent policy for Super Agent runtime.",
    rationale:
      "Matches Codex-style base instruction architecture: prompts live in prompt fragments and are assembled as base instructions before being sent to providers.",
    template: () => SUPER_AGENT_BASE_SYSTEM,
  },

  "super-agent.visible_progress.instruction": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Controls model-owned progress summaries for long agent work.",
    rationale:
      "The model decides when progress or planning is useful; the renderer does not infer thinking from words.",
    template: () => VISIBLE_PROGRESS_INSTRUCTION,
  },

  "super-agent.todo_planning.instruction": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Guides compact todo/progress emission during substantial autonomous work.",
    rationale: "Keeps simple requests fast while giving longer coding tasks a compact progress structure.",
    template: () => TODO_PLANNING_INSTRUCTION,
  },

  "super-agent.tool_selection.instruction": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Precise tool selection rules to prevent wrong-tool choices across agent tasks.",
    rationale:
      "The model owns tool choice, but dedicated tool-priority instructions prevent shell/find misuse when safer structured tools exist.",
    template: () => TOOL_SELECTION_INSTRUCTION,
  },

  "super-agent.stable_agent_runtime.instruction": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Stable autonomous-agent execution policy.",
    rationale:
      "Prevents fake tool calls, unnecessary polishing turns, raw internal output, and source edits without explicit user intent.",
    template: () => STABLE_AGENT_RUNTIME,
  },

  "super-agent.review.instruction": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Review-mode rubric used when the backend intent router or /review command selects review behavior.",
    rationale: "Keeps review behavior focused on evidence-backed findings instead of whole-project file counting.",
    template: () => REVIEW_SUBAGENT_INSTRUCTION,
  },

  "enabled.skills": {
    kind: "system_fragment",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Adds enabled skill instructions to the base instruction text.",
    rationale: "Matches the Codex-style instruction assembly path: optional instructions are merged into base instructions before provider submission.",
    template: (context = {}) => asText(context.enabledSkillInstructions),
  },

  "super-agent.general.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "General agent mode prompt.",
    rationale: "Defines concise, tool-aware general behavior.",
    template: () => GENERAL_AGENT_SYSTEM,
  },

  "super-agent.browser.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Browser workspace agent prompt.",
    rationale: "Keeps browser tasks grounded in real workspace observations.",
    template: () => BROWSER_AGENT_SYSTEM,
  },

  "super-agent.desktop.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Desktop agent prompt.",
    rationale: "Makes current desktop limitations explicit while keeping extension path open.",
    template: () => DESKTOP_AGENT_SYSTEM,
  },

  "super-agent.coding.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Coding agent prompt.",
    rationale: "Keeps coding changes targeted and verified.",
    template: () => CODING_AGENT_SYSTEM,
  },

  "super-agent.permission_policy.system": {
    kind: "system",
    usedBy: "src/prompts/promptLoader.ts::buildSystemPrompt()",
    purpose: "Permission policy prompt.",
    rationale: "Aligns model behavior with runtime permission gates.",
    template: () => PERMISSION_POLICY_SYSTEM,
  },

  "super-agent.intent_router.system": {
    kind: "system",
    usedBy: "future router/runtime classification",
    purpose: "Semantic task-complexity classifier prompt.",
    rationale: "Avoid local phrase matching and keep task routing model-owned if a router is introduced later.",
    template: () => INTENT_ROUTER_SYSTEM,
  },

  "super-agent.intent_router.user": {
    kind: "user_prompt",
    usedBy: "future router/runtime classification",
    purpose: "Packs current desktop state into the classifier request.",
    rationale: "Keeps classifier context structured and editable in one file.",
    template: (context = {}) => [
      `User request: ${jsonString(asText(context.text))}`,
      "",
      `Workspace: ${asText(context.workspace)}`,
      `Provider: ${asText(context.provider)}`,
      `Model: ${asText(context.model)}`,
      `Active skills: ${asStringArray(context.activeSkills).join(", ") || "none"}`,
      "",
      "Classify this request and return the JSON schema exactly.",
    ].join("\n"),
  },
};

export type PromptKey = string;

export const renderPrompt = (
  key: PromptKey,
  context: PromptContext = {}
): string => {
  const definition = PROMPT_DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown prompt key: ${key}`);
  return definition.template(context);
};

export const renderSystemPrompt = (
  keys: PromptKey[],
  context: PromptContext = {}
): string => joinNonEmpty(keys.map((key) => renderPrompt(key, context)), "\n\n");

export const agentPromptKey = (agentKind: AgentKind): PromptKey => {
  if (agentKind === "browser") return "super-agent.browser.system";
  if (agentKind === "desktop") return "super-agent.desktop.system";
  if (agentKind === "coding") return "super-agent.coding.system";
  return "super-agent.general.system";
};

export const listPromptMetadata = (): Array<{
  id: string;
  kind: PromptKind;
  usedBy: string;
  purpose: string;
  rationale: string;
}> =>
  Object.entries(PROMPT_DEFINITIONS).map(([id, definition]) => ({
    id,
    kind: definition.kind,
    usedBy: definition.usedBy,
    purpose: definition.purpose,
    rationale: definition.rationale,
  }));

import type { ActivePermissionMode, ModelOption, SkillRecord } from "@shared/types";
import type { AgentCommandDefinition } from "../../../../commands";
import { listAgentCommands } from "../../../../commands";

export interface SkillTokenRange {
  start: number;
  end: number;
  query: string;
}

export const modelValue = (model: ModelOption): string =>
  `${model.provider}:${model.model}`;

export const selectedModelValue = (model: ModelOption | null): string =>
  model ? modelValue(model) : "";

export const permissionLabels: Record<ActivePermissionMode, string> = {
  ask_every_time: "Ask every time",
  allow_safe_tools: "Safe tools",
  manual_approval: "Manual approval",
  full_access: "Full access mode",
  deny_tools: "Deny tools"
};

export const availableCommands = listAgentCommands();

export const readableSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const estimateTokens = (value: string): number =>
  Math.max(1, Math.ceil(value.length / 4));

export const modelContextWindow = (model: ModelOption | null): number | null =>
  model?.contextWindow && Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : null;

export const skillInstructionText = (skill: SkillRecord): string =>
  [skill.name, skill.description, skill.instructions].join("\n");

export const skillSupportTokens = (skill: SkillRecord): number =>
  skill.files
    .filter((file) => file.path !== "SKILL.md")
    .reduce((total, file) => total + estimateTokens(file.content), 0);

export const normalizeWords = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);

export const scoreSkillForPrompt = (skill: SkillRecord, prompt: string) => {
  const promptLower = prompt.toLowerCase();
  const promptWords = new Set(normalizeWords(prompt));
  const searchableWords = Array.from(new Set(normalizeWords(`${skill.name} ${skill.description}`)));
  const matchedTerms: string[] = [];
  let score = 0;

  if (promptLower.includes(skill.name.toLowerCase())) {
    score += 10;
    matchedTerms.push(skill.name);
  }

  if (promptLower.includes(skill.id.toLowerCase()) && skill.id !== skill.name) {
    score += 8;
    matchedTerms.push(skill.id);
  }

  for (const word of searchableWords) {
    if (promptWords.has(word)) {
      score += 1;
      if (!matchedTerms.includes(word)) matchedTerms.push(word);
    }
  }

  return { skill, score, matchedTerms };
};

export const modelWidth = (model: ModelOption | null): string => {
  const labelLength = model?.label.length ?? 20;
  const width = Math.min(Math.max(labelLength + 5, 22), 44);

  return `${width}ch`;
};

export const trimmedCommandInput = (value: string): string => value.trimStart();

export const isSlashInput = (value: string): boolean =>
  trimmedCommandInput(value).startsWith("/");

export const shouldShowCommandMenu = (value: string): boolean => {
  const trimmed = trimmedCommandInput(value);

  return trimmed === "/" || /^\/[\w-]*$/.test(trimmed);
};

export const commandQuery = (value: string): string => {
  const trimmed = trimmedCommandInput(value);

  if (!trimmed.startsWith("/")) return "";

  return trimmed.slice(1).toLowerCase();
};

export const matchingCommands = (value: string): AgentCommandDefinition[] => {
  const query = commandQuery(value);

  return availableCommands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(query) ||
      command.label.toLowerCase().includes(query)
  );
};

export const selectedCommandDefinition = (
  name: string | undefined
): AgentCommandDefinition | null => {
  if (!name) return null;

  return availableCommands.find((command) => command.name === name) ?? null;
};

export const findSkillToken = (
  value: string,
  cursorPosition: number
): SkillTokenRange | null => {
  const safeCursor = Math.min(Math.max(cursorPosition, 0), value.length);
  const start = value.lastIndexOf("$", Math.max(0, safeCursor - 1));

  if (start < 0) return null;

  const token = value.slice(start + 1, safeCursor);
  if (!/^[a-zA-Z0-9_-]*$/.test(token)) return null;

  return {
    start,
    end: safeCursor,
    query: token.toLowerCase()
  };
};

export const matchingSkills = (
  skills: SkillRecord[],
  token: SkillTokenRange | null
): SkillRecord[] => {
  if (!token) return [];

  return skills
    .filter((skill) => {
      if (!skill.enabled || skill.lifecycleState === "archived") return false;
      if (!token.query) return true;

      const searchable = [skill.name, skill.id, skill.description]
        .join(" ")
        .toLowerCase();

      return searchable.includes(token.query);
    })
    .slice(0, 12);
};

export const shouldIgnoreComposerPointer = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;

  return Boolean(
    target.closest(
      "button, select, input, textarea, [role='combobox'], [role='listbox'], [role='option']"
    )
  );
};

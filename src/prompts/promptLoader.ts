import type { AgentKind } from "@shared/types";
import { agentPromptKey, renderSystemPrompt } from "./promptRegistry";

const basePromptKeys = (agentKind: AgentKind): string[] => [
  "super-agent.autonomous.system",
  "super-agent.stable_agent_runtime.instruction",
  "super-agent.visible_progress.instruction",
  "super-agent.todo_planning.instruction",
  "super-agent.tool_selection.instruction",
  "super-agent.permission_policy.system",
  "super-agent.review.instruction",
  agentPromptKey(agentKind),
];

export const buildSystemPrompt = (
  agentKind: AgentKind,
  enabledSkillInstructions = ""
): string =>
  renderSystemPrompt([
    ...basePromptKeys(agentKind),
    ...(enabledSkillInstructions.trim().length > 0 ? ["enabled.skills"] : []),
  ], {
    enabledSkillInstructions,
  });

export const loadPrompts = (
  agentKind: AgentKind,
  enabledSkillInstructions = ""
): { agent: string } => ({
  agent: buildSystemPrompt(agentKind, enabledSkillInstructions)
});

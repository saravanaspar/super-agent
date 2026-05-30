import type { AgentCommandInvocation } from "@shared/types";
import type { AgentCommandDefinition, ParsedAgentCommandInput } from "./types";

const goalCommand: AgentCommandDefinition = {
  name: "goal",
  label: "/goal",
  usage: "/goal <task and acceptance criteria>",
  description:
    "Run a multi-step task until acceptance checks pass, the work is blocked, or approval is needed.",
  placeholder: "Describe the finished outcome and acceptance criteria",
  execution: {
    extendedRun: true,
    maxDuplicateToolCalls: 2
  }
};

const reviewCommand: AgentCommandDefinition = {
  name: "review",
  label: "/review",
  usage: "/review <files, folder, project, or review criteria>",
  description:
    "Review code, files, or a project folder with source-coverage checks before final findings.",
  placeholder: "Describe what to review and what kind of issues to look for",
  execution: {
    extendedRun: true,
    maxDuplicateToolCalls: 2
  }
};

export const agentCommands = [goalCommand, reviewCommand] as const;

export const listAgentCommands = (): AgentCommandDefinition[] => [
  ...agentCommands
];

export const getAgentCommand = (
  name: AgentCommandInvocation["name"]
): AgentCommandDefinition => {
  const command = agentCommands.find((item) => item.name === name);

  if (!command) {
    throw new Error(`Unknown agent command: ${name}`);
  }

  return command;
};

const commandPattern = /^\/(\w+)(?:\s+([\s\S]*))?$/;

export const parseAgentCommandInput = (
  value: string
): ParsedAgentCommandInput => {
  const trimmed = value.trimStart();
  const match = commandPattern.exec(trimmed);

  if (!match) {
    return {
      command: null,
      prompt: value
    };
  }

  const rawName = match[1] ?? "";
  const command = agentCommands.find((item) => item.name === rawName);

  if (!command) {
    return {
      command: null,
      prompt: value
    };
  }

  const prompt = (match[2] ?? "").trim();

  return {
    command: {
      name: command.name,
      raw: trimmed,
      input: prompt,
      goal: prompt,
      ...(command.name === "review" ? { reviewTarget: prompt } : {})
    },
    prompt
  };
};
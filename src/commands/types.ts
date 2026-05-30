import type { AgentCommandInvocation } from "@shared/types";

export interface AgentCommandExecutionLimits {
  extendedRun: boolean;
  maxDuplicateToolCalls: number;
}

export interface AgentCommandDefinition {
  name: AgentCommandInvocation["name"];
  label: string;
  usage: string;
  description: string;
  placeholder: string;
  execution: AgentCommandExecutionLimits;
}

export interface ParsedAgentCommandInput {
  command: AgentCommandInvocation | null;
  prompt: string;
}
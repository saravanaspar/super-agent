import type { z } from "zod";
import type { ArtifactRepository } from "@persistence/artifactRepository";
import type { WorkspaceLogRepository } from "@persistence/workspaceLogRepository";
import type { JsonRecord, JsonValue } from "@shared/json";
import type { SkillRegistry } from "@skills-system/skillRegistry";
import type { McpRegistry } from "@mcp/mcpRegistry";
import type {
  AgentBehaviorSettings,
  ToolCallRecord,
  ToolResultRecord,
  ToolRisk
} from "@shared/types";
import type { BrowserWorkspaceController } from "@workspace/browserWorkspaceController";

export interface ToolExecutionContext {
  workspaceDir: string;
  browserWorkspace: BrowserWorkspaceController;
  artifacts: ArtifactRepository;
  workspaceLogs: WorkspaceLogRepository;
  skills?: SkillRegistry;
  mcp?: McpRegistry;
  agentSettings: AgentBehaviorSettings;
}

export interface ToolDefinition<Input extends object = Record<string, unknown>> {
  name: string;
  description: string;
  category: "general" | "windows" | "linux" | "macos";
  risk: ToolRisk;
  inputSchema: z.ZodType<Input>;
  parameters: JsonRecord;
  execute(input: Input, context: ToolExecutionContext): Promise<Omit<ToolResultRecord, "toolCallId" | "toolName" | "risk">>;
}

export interface ToolRegistryEntry {
  name: string;
  description: string;
  category: ToolDefinition["category"];
  risk: ToolRisk;
  parameters: JsonRecord;
}

export const failureResult = (message: string, data: JsonValue = null, blocked = false) => ({
  ok: false,
  blocked,
  message,
  data
});

export const successResult = (message: string, data: JsonValue = null) => ({
  ok: true,
  blocked: false,
  message,
  data
});

export const toBlockedToolResult = (
  call: ToolCallRecord,
  message: string,
  data: JsonValue = null
): ToolResultRecord => ({
  toolCallId: call.id,
  toolName: call.name,
  ok: false,
  blocked: true,
  risk: call.risk,
  message,
  data
});

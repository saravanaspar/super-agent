import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import { toJsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";

const mcpStatusInput = z.object({});
const mcpListToolsInput = z.object({
  serverId: z.string().min(1).optional()
});
const mcpCallToolInput = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional()
});
const mcpRestartServerInput = z.object({
  serverId: z.string().min(1)
});

type McpStatusInput = z.infer<typeof mcpStatusInput>;
type McpListToolsInput = z.infer<typeof mcpListToolsInput>;
type McpCallToolInput = z.infer<typeof mcpCallToolInput>;
type McpRestartServerInput = z.infer<typeof mcpRestartServerInput>;

const parameters = (
  properties: JsonRecord,
  required: string[] = []
): JsonRecord => ({ type: "object", properties, required });

const missingMcp = () => failureResult("MCP runtime is not configured.", null, true);

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const mcpTools: ToolDefinition[] = [
  {
    name: "mcp.status",
    description: "List configured MCP servers and their runtime status from config.yaml.",
    category: "general",
    risk: "safe",
    inputSchema: mcpStatusInput,
    parameters: parameters({}),
    execute(_input: McpStatusInput, context) {
      if (!context.mcp) return Promise.resolve(missingMcp());
      return Promise.resolve(successResult("MCP status loaded.", context.mcp.status()));
    }
  },
  {
    name: "mcp.list_tools",
    description: "Start configured MCP servers as needed and list their advertised tools.",
    category: "general",
    risk: "medium",
    inputSchema: mcpListToolsInput,
    parameters: parameters({ serverId: { type: "string" } }),
    async execute(input: McpListToolsInput, context) {
      if (!context.mcp) return missingMcp();
      try {
        return successResult("MCP tools listed.", await context.mcp.listTools(input.serverId));
      } catch (error) {
        return failureResult(formatErrorMessage(error));
      }
    }
  },
  {
    name: "mcp.call_tool",
    description: "Call a tool exposed by a configured MCP server. Use mcp.list_tools first when the server or input schema is unknown.",
    category: "general",
    risk: "high",
    inputSchema: mcpCallToolInput,
    parameters: parameters(
      {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" }
      },
      ["serverId", "toolName"]
    ),
    async execute(input: McpCallToolInput, context) {
      if (!context.mcp) return missingMcp();
      try {
        const result = await context.mcp.callTool(
          input.serverId,
          input.toolName,
          toJsonRecord(input.arguments ?? {})
        );
        return successResult("MCP tool completed.", toJsonRecord(result));
      } catch (error) {
        return failureResult(formatErrorMessage(error));
      }
    }
  },
  {
    name: "mcp.restart_server",
    description: "Restart a configured MCP server process after config or server failures.",
    category: "general",
    risk: "high",
    inputSchema: mcpRestartServerInput,
    parameters: parameters({ serverId: { type: "string" } }, ["serverId"]),
    async execute(input: McpRestartServerInput, context) {
      if (!context.mcp) return missingMcp();
      try {
        return successResult("MCP server restarted.", await context.mcp.restartServer(input.serverId));
      } catch (error) {
        return failureResult(formatErrorMessage(error));
      }
    }
  }
];

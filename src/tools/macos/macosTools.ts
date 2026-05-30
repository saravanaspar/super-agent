import { z } from "zod";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";
import { shellSandboxBackendStatus } from "./shellSandboxBackend";

const emptyInput = z.object({});

const macosSandboxStatusTool: ToolDefinition<z.infer<typeof emptyInput>> = {
  name: "macos.shell_sandbox_status",
  description: "Return macOS shell sandbox backend status for sandbox-exec.",
  category: "macos",
  risk: "safe",
  inputSchema: emptyInput,
  parameters: { type: "object", properties: {} },
  execute(_input, context) {
    return Promise.resolve(successResult("macOS sandbox status returned.", shellSandboxBackendStatus(context.workspaceDir) as unknown as Record<string, string | boolean>));
  }
};

export const macosTools: ToolDefinition[] = [macosSandboxStatusTool];

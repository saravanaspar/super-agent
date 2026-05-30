import { z } from "zod";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";
import { shellSandboxBackendStatus } from "./shellSandboxBackend";

const emptyInput = z.object({});

const windowsSandboxStatusTool: ToolDefinition<z.infer<typeof emptyInput>> = {
  name: "windows.shell_sandbox_status",
  description: "Return Windows shell sandbox backend status for Docker/Podman container mode.",
  category: "windows",
  risk: "safe",
  inputSchema: emptyInput,
  parameters: { type: "object", properties: {} },
  execute(_input, context) {
    return Promise.resolve(successResult("Windows sandbox status returned.", shellSandboxBackendStatus(context.workspaceDir) as unknown as Record<string, string | boolean>));
  }
};

export const windowsTools: ToolDefinition[] = [windowsSandboxStatusTool];

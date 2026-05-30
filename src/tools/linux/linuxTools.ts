import { z } from "zod";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";
import { shellSandboxBackendStatus } from "./shellSandboxBackend";

const emptyInput = z.object({});

const linuxSandboxStatusTool: ToolDefinition<z.infer<typeof emptyInput>> = {
  name: "linux.shell_sandbox_status",
  description: "Return Linux shell sandbox backend status for bubblewrap.",
  category: "linux",
  risk: "safe",
  inputSchema: emptyInput,
  parameters: { type: "object", properties: {} },
  execute(_input, context) {
    return Promise.resolve(successResult("Linux sandbox status returned.", shellSandboxBackendStatus(context.workspaceDir) as unknown as Record<string, string | boolean>));
  }
};

export const linuxTools: ToolDefinition[] = [linuxSandboxStatusTool];

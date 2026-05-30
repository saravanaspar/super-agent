import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";

const workspacePathInput = z.object({});

type WorkspacePathInput = z.infer<typeof workspacePathInput>;

const parameters = (
  properties: JsonRecord,
  required: string[] = []
): JsonRecord => ({
  type: "object",
  properties,
  required
});

const workspacePathTool: ToolDefinition<WorkspacePathInput> = {
  name: "workspace.path",
  description:
    "Return the active workspace directory absolute path. Use this for current directory, project path, or workspace root questions instead of shell pwd.",
  category: "general",
  risk: "safe",
  inputSchema: workspacePathInput,
  parameters: parameters({}),
  execute(_input, context) {
    return Promise.resolve(
      successResult("Workspace path returned.", {
        workspaceDirectory: context.workspaceDir,
        cwd: context.workspaceDir,
        path: context.workspaceDir
      })
    );
  }
};

export const workspaceInfoTools: ToolDefinition[] = [workspacePathTool];
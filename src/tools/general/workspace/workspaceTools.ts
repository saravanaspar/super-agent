import { z } from "zod";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";

const emptyInput = z.object({});
const artifactInput = z.object({
  title: z.string().min(1),
  kind: z.enum(["text", "code"]),
  content: z.string(),
  contentType: z.string().optional(),
  sessionId: z.string().nullable().optional()
});

type EmptyInput = z.infer<typeof emptyInput>;
type ArtifactInput = z.infer<typeof artifactInput>;

const workspaceStatusTool: ToolDefinition<EmptyInput> = {
  name: "workspace.status",
  description: "Return current workspace status and URL.",
  category: "general",
  risk: "safe",
  inputSchema: emptyInput,
  parameters: { type: "object", properties: {} },
  execute(_input, context) {
    return Promise.resolve(successResult("Workspace status returned.", { ...context.browserWorkspace.getStatus() }));
  }
};

const artifactCreateTool: ToolDefinition<ArtifactInput> = {
  name: "artifact.create",
  description: "Create a persisted text or code artifact record.",
  category: "general",
  risk: "safe",
  inputSchema: artifactInput,
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, kind: { type: "string", enum: ["text", "code"] }, content: { type: "string" }, contentType: { type: "string" } },
    required: ["title", "kind", "content"]
  },
  execute(input, context) {
    const artifact = context.artifacts.createArtifact({
      title: input.title,
      kind: input.kind,
      content: input.content,
      contentType: input.contentType ?? "text/plain",
      sessionId: input.sessionId ?? null
    });
    return Promise.resolve(successResult("Artifact created.", { ...artifact }));
  }
};

export const workspaceTools: ToolDefinition[] = [workspaceStatusTool, artifactCreateTool];

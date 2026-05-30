import type { JsonRecord } from "@shared/json";
import type { LibraryData, ModelOption } from "@shared/types";
import type { ArtifactService } from "@artifacts/artifactService";
import type { SkillRegistry } from "@skills-system/skillRegistry";
import type { PluginRegistry } from "@plugins/pluginRegistry";
import type { McpRegistry } from "@mcp/mcpRegistry";
import type { ToolRegistry } from "@tool-registry/toolRegistry";
import { listPromptMetadata } from "@prompts/promptRegistry";
import type { ModelService } from "@providers/modelService";

const promptItems = (): JsonRecord[] =>
  listPromptMetadata().map((prompt) => ({
    id: prompt.id,
    kind: prompt.kind,
    usedBy: prompt.usedBy,
    purpose: prompt.purpose,
    status: "complete"
  }));

export class LibraryService {
  constructor(
    private readonly plugins: PluginRegistry,
    private readonly skills: SkillRegistry,
    private readonly mcp: McpRegistry,
    private readonly artifacts: ArtifactService,
    private readonly tools: ToolRegistry,
    private readonly models: ModelService
  ) {}

  getLibrary(): LibraryData {
    const modelItems: ModelOption[] = this.models.list();
    return {
      plugins: {
        key: "plugins",
        title: "Plugins",
        status: "partial",
        description: "Local registry metadata for future plugin execution.",
        items: this.plugins.list()
      },
      skills: {
        key: "skills",
        title: "Skills",
        status: "complete",
        description: "Installed skills available to the agent context.",
        items: this.skills.list()
      },
      mcp: {
        key: "mcp",
        title: "MCP",
        status: "complete",
        description: "Configured MCP stdio servers and advertised tool metadata.",
        items: this.mcp.list()
      },
      artifacts: {
        key: "artifacts",
        title: "Artifacts",
        status: "complete",
        description: "Persisted text and code artifacts created by assistant tools.",
        items: this.artifacts.list()
      },
      tools: {
        key: "tools",
        title: "Tools",
        status: "complete",
        description: "Registered typed tools with risk levels.",
        items: this.tools.list().map((tool) => ({ ...tool }))
      },
      prompts: {
        key: "prompts",
        title: "Prompts",
        status: "complete",
        description: "Centralized prompt registry entries.",
        items: promptItems()
      },
      models: {
        key: "models",
        title: "Models",
        status: "complete",
        description: "Configured local and hosted provider models.",
        items: modelItems
      }
    };
  }
}

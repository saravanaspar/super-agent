import type { JsonRecord, JsonValue } from "@shared/json";
import { toJsonRecord, toJsonValue } from "@shared/json";
import { redactSensitiveJson, redactSensitiveText } from "@shared/redaction";
import { McpStdioClient, type McpServerRuntimeStatus, type McpToolMetadata } from "./mcpClient";
import { McpHttpClient } from "./mcpHttpClient";
import type { McpConfig, McpServerConfig } from "./mcpConfig";
import { emptyMcpConfig } from "./mcpConfig";

export interface McpCallResult {
  serverId: string;
  toolName: string;
  result: JsonValue;
  permissions: JsonRecord;
}

type McpRuntimeClient = {
  status(): McpServerRuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  listTools(): Promise<McpToolMetadata[]>;
  callTool(toolName: string, args: JsonRecord): Promise<JsonValue>;
};

export class McpRegistry {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly clients = new Map<string, McpRuntimeClient>();

  constructor(
    private readonly config: McpConfig = emptyMcpConfig(),
    private readonly workspaceDir = process.cwd()
  ) {
    for (const server of config.servers) {
      this.servers.set(server.id, server);
    }
  }

  list(): JsonRecord[] {
    if (!this.config.enabled) {
      return [
        {
          id: "mcp-disabled",
          name: "MCP disabled",
          status: "disabled",
          description: "MCP is disabled or config.yaml does not contain an enabled mcp section.",
          configPath: this.config.configPath ?? ""
        }
      ];
    }

    const serverItems = [...this.servers.values()].map((server) => {
      const status = this.clientFor(server).status();
      return {
        id: server.id,
        name: server.id,
        status: server.enabled ? (status.running ? "running" : "stopped") : "disabled",
        description: this.describeServer(server),
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: redactSensitiveText(server.url),
        autoStart: server.autoStart,
        permissions: toJsonRecord(server.permissions),
        toolCount: status.toolCount,
        lastError: redactSensitiveText(status.lastError ?? ""),
        stderrPreview: redactSensitiveText(status.stderrPreview)
      };
    });

    return [
      ...serverItems,
      ...this.config.diagnostics.map((diagnostic, index) => ({
        id: `mcp-diagnostic-${index}`,
        name: "MCP config diagnostic",
        status: "warning",
        description: diagnostic
      }))
    ];
  }

  async startAutoServers(): Promise<void> {
    if (!this.config.enabled) return;

    const startJobs = [...this.servers.values()]
      .filter((server) => server.enabled && server.autoStart)
      .map(async (server) => this.clientFor(server).start());

    await Promise.allSettled(startJobs);
  }

  status(): JsonRecord {
    return {
      enabled: this.config.enabled,
      configPath: this.config.configPath ?? "",
      serverCount: this.servers.size,
      diagnostics: this.config.diagnostics,
      servers: this.list()
    };
  }

  async listTools(serverId?: string): Promise<JsonRecord> {
    if (!this.config.enabled) {
      throw new Error("MCP is disabled in config.yaml.");
    }

    const servers = serverId ? [this.requireServer(serverId)] : [...this.servers.values()].filter((server) => server.enabled);
    const results: JsonRecord[] = [];

    for (const server of servers) {
      const tools = await this.clientFor(server).listTools();
      results.push({
        serverId: server.id,
        permissions: toJsonRecord(server.permissions),
        tools: tools.map((tool) => this.toolToJson(tool))
      });
    }

    return { servers: results };
  }

  async callTool(serverId: string, toolName: string, args: JsonRecord): Promise<McpCallResult> {
    const server = this.requireServer(serverId);
    const result = await this.clientFor(server).callTool(toolName, args);

    return {
      serverId,
      toolName,
      result: redactSensitiveJson(toJsonValue(result)),
      permissions: toJsonRecord(server.permissions)
    };
  }

  async restartServer(serverId: string): Promise<JsonRecord> {
    const server = this.requireServer(serverId);
    const client = this.clientFor(server);
    await client.stop();
    await client.start();
    return toJsonRecord(client.status());
  }

  async testServer(server: McpServerConfig): Promise<McpToolMetadata[]> {
    const client = this.createClient(server);
    try {
      return await client.listTools();
    } finally {
      await client.stop();
    }
  }

  async upsertServer(server: McpServerConfig): Promise<void> {
    const existing = this.clients.get(server.id);
    if (existing) {
      await existing.stop();
      this.clients.delete(server.id);
    }
    this.config.enabled = true;
    this.config.servers = [
      ...this.config.servers.filter((item) => item.id !== server.id),
      server
    ];
    this.servers.set(server.id, server);
  }

  configuredServers(): McpServerConfig[] {
    return [...this.servers.values()];
  }

  configPath(): string | null {
    return this.config.configPath;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map(async (client) => client.stop()));
  }

  private requireServer(serverId: string): McpServerConfig {
    if (!this.config.enabled) {
      throw new Error("MCP is disabled in config.yaml.");
    }

    const server = this.servers.get(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    if (!server.enabled) throw new Error(`MCP server is disabled: ${serverId}`);
    return server;
  }

  private clientFor(server: McpServerConfig): McpRuntimeClient {
    const existing = this.clients.get(server.id);
    if (existing) return existing;

    const client = this.createClient(server);
    this.clients.set(server.id, client);
    return client;
  }

  private createClient(server: McpServerConfig): McpRuntimeClient {
    return server.transport === "https"
      ? new McpHttpClient(server)
      : new McpStdioClient(server, this.workspaceDir);
  }

  private describeServer(server: McpServerConfig): string {
    if (server.transport === "https") return redactSensitiveText(server.url);
    return `${server.command} ${server.args.join(" ")}`.trim();
  }

  private toolToJson(tool: McpToolMetadata): JsonRecord {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    };
  }
}

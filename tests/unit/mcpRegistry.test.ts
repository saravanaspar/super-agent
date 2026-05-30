import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpRegistry } from "@mcp/mcpRegistry";
import type { McpConfig } from "@mcp/mcpConfig";

const tempDirs: string[] = [];
const registries: McpRegistry[] = [];
const httpServers: Server[] = [];

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-mcp-registry-test-"));
  tempDirs.push(dir);
  return dir;
};

const createMockMcpServer = (dir: string): string => {
  const serverPath = join(dir, "mock-mcp-server.cjs");
  writeFileSync(
    serverPath,
    `let buffer = "";
let serverRequestAnswered = false;
process.stdin.setEncoding("utf8");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) return;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === "server-request-1" && message.error) {
      serverRequestAnswered = true;
      continue;
    }
    if (!message.id) continue;
    if (message.method === "initialize") {
      send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", method: "roots/list", params: {} }) + "\\n");
    } else if (message.method === "tools/list") {
      send(message.id, { tools: [{ name: "echo", description: serverRequestAnswered ? "server request answered" : "server request pending", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      send(message.id, { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] });
    } else {
      send(message.id, {});
    }
  }
});
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  return serverPath;
};

const createRegistry = (dir: string, serverPath: string): McpRegistry => {
  const config: McpConfig = {
    enabled: true,
    configPath: join(dir, "config.yaml"),
    diagnostics: [],
    servers: [
      {
        id: "mock",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        url: "",
        headers: {},
        env: {},
        autoStart: false,
        enabled: true,
        timeoutMs: 3_000,
        permissions: { network: false, filesystem: false }
      }
    ]
  };
  const registry = new McpRegistry(config, dir);
  registries.push(registry);
  return registry;
};


const createHttpMcpServer = async (): Promise<string> => {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }

      const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: unknown } };
      response.setHeader("Mcp-Session-Id", "test-session");

      if (message.method === "initialize") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }));
        return;
      }

      if (!message.id) {
        response.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        response.setHeader("Content-Type", "text/event-stream");
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
        setTimeout(() => {
          response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "remote_echo", description: "Remote echo", inputSchema: { type: "object" } }] } })}\n\n`);
        }, 5);
        return;
      }

      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }] } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  httpServers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("HTTP MCP test server did not bind.");
  return `http://127.0.0.1:${address.port}/mcp`;
};

const createHttpRegistry = (dir: string, url: string): McpRegistry => {
  const config: McpConfig = {
    enabled: true,
    configPath: join(dir, "config.yaml"),
    diagnostics: [],
    servers: [
      {
        id: "remote",
        transport: "https",
        command: "",
        args: [],
        url,
        headers: {},
        env: {},
        autoStart: false,
        enabled: true,
        timeoutMs: 3_000,
        permissions: { network: true, filesystem: false }
      }
    ]
  };
  const registry = new McpRegistry(config, dir);
  registries.push(registry);
  return registry;
};

afterEach(async () => {
  for (const registry of registries) {
    await registry.stopAll();
  }
  registries.length = 0;
  for (const server of httpServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  httpServers.length = 0;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("MCP registry", () => {
  it("lists tools and calls a stdio MCP server tool", async () => {
    const dir = createTempDir();
    const serverPath = createMockMcpServer(dir);
    const registry = createRegistry(dir, serverPath);

    const listed = await registry.listTools("mock");
    expect(JSON.stringify(listed)).toContain("echo");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const listedAfterServerRequest = await registry.listTools("mock");
    expect(JSON.stringify(listedAfterServerRequest)).toContain("server request answered");

    const result = await registry.callTool("mock", "echo", { text: "hello" });
    expect(result).toMatchObject({
      serverId: "mock",
      toolName: "echo",
      permissions: { network: false, filesystem: false }
    });
    expect(JSON.stringify(result.result)).toContain("hello");
  });

  it("lists tools and calls a streamable HTTP MCP server tool", async () => {
    const dir = createTempDir();
    const url = await createHttpMcpServer();
    const registry = createHttpRegistry(dir, url);

    const listed = await registry.listTools("remote");
    expect(JSON.stringify(listed)).toContain("remote_echo");

    const result = await registry.callTool("remote", "remote_echo", { text: "hello over http" });
    expect(result).toMatchObject({
      serverId: "remote",
      toolName: "remote_echo",
      permissions: { network: true, filesystem: false }
    });
    expect(JSON.stringify(result.result)).toContain("hello over http");
  });

  it("reports disabled MCP before starting any server", async () => {
    const registry = new McpRegistry({ enabled: false, configPath: null, servers: [], diagnostics: [] });
    registries.push(registry);

    await expect(registry.listTools()).rejects.toThrow("MCP is disabled");
    expect(registry.status().enabled).toBe(false);
  });
});

it("tests and installs a remote MCP server without adding it before validation", async () => {
  const dir = createTempDir();
  const url = await createHttpMcpServer();
  const registry = new McpRegistry({ enabled: false, configPath: join(dir, "config.yaml"), diagnostics: [], servers: [] }, dir);
  registries.push(registry);
  const server = {
    id: "validated-remote",
    transport: "https" as const,
    command: "",
    args: [],
    url,
    headers: {},
    env: {},
    autoStart: true,
    enabled: true,
    timeoutMs: 3_000,
    permissions: { network: true, filesystem: false }
  };

  expect(registry.status().serverCount).toBe(0);
  const tools = await registry.testServer(server);
  expect(tools.map((tool) => tool.name)).toContain("remote_echo");
  expect(registry.status().serverCount).toBe(0);

  await registry.upsertServer(server);
  expect(registry.status().enabled).toBe(true);
  expect(registry.status().serverCount).toBe(1);
});

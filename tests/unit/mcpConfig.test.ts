import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteMcpServerConfig, loadMcpConfig, saveMcpServerConfig } from "@mcp/mcpConfig";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-mcp-config-test-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("MCP config loader", () => {
  it("loads stdio MCP servers from config.yaml", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    echo:",
        "      command: node",
        "      args:",
        "        - server.js",
        "        - \"${SUPER_AGENT_WORKSPACE_DIR}\"",
        "      env:",
        "        EXAMPLE_TOKEN: configured",
        "      auto_start: false",
        "      timeout_ms: 2000",
        "      permissions:",
        "        network: false",
        "        filesystem: true"
      ].join("\n"),
      "utf8"
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.enabled).toBe(true);
    expect(config.diagnostics.join("\n")).not.toContain("schema validation failed");
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({
      id: "echo",
      transport: "stdio",
      command: "node",
      args: ["server.js", dir],
      url: "",
      headers: {},
      env: { EXAMPLE_TOKEN: "configured" },
      autoStart: false,
      timeoutMs: 2000,
      permissions: { network: false, filesystem: true }
    });
  });

  it("loads HTTPS MCP servers from config.yaml", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    remote:",
        "      transport: https",
        "      url: https://mcp.example.test/mcp",
        "      headers:",
        "        Authorization: Bearer direct-test-token",
        "      timeout_ms: 5000",
        "      permissions:",
        "        filesystem: false"
      ].join("\n"),
      "utf8"
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.diagnostics.join("\n")).not.toContain("schema validation failed");
    expect(config.servers[0]).toMatchObject({
      id: "remote",
      transport: "https",
      command: "",
      args: [],
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer direct-test-token" },
      permissions: { network: true, filesystem: false }
    });
  });

  it("rejects remote HTTP MCP URLs", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    insecure:",
        "      transport: https",
        "      url: http://example.test/mcp"
      ].join("\n"),
      "utf8"
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.servers).toEqual([]);
    expect(config.diagnostics.join("\n")).toContain("requires an https URL");
  });

  it("ignores malformed server entries without disabling the rest of MCP", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    broken:",
        "      args:",
        "        - missing-command",
        "    ok:",
        "      command: node",
        "      args: []"
      ].join("\n"),
      "utf8"
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.enabled).toBe(true);
    expect(config.servers.map((server) => server.id)).toEqual(["ok"]);
    expect(config.diagnostics.join("\n")).toContain("command is missing");
  });

  it("returns diagnostics for invalid YAML instead of throwing", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, ["mcp:", "  servers:", "    - invalid-list-entry"].join("\n"), "utf8");

    const config = loadMcpConfig(configPath, dir);

    expect(config.enabled).toBe(true);
    expect(config.servers).toEqual([]);
    expect(config.diagnostics.join("\n")).toContain("mcp.servers must be a mapping");
  });

  it("schema-validates MCP server IDs and argument limits", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    invalid space:",
        "      command: node",
        "    too_many_args:",
        "      command: node",
        "      args:",
        ...Array.from({ length: 130 }, (_, index) => `        - arg${index}`),
      ].join("\n"),
      "utf8",
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.servers).toEqual([]);
    expect(config.diagnostics.join("\n")).toContain("invalid id");
    expect(config.diagnostics.join("\n")).toContain("schema validation failed");
  });

  it("restricts sensitive config file permissions on POSIX", () => {
    if (process.platform === "win32") return;
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "mcp:",
        "  enabled: true",
        "  servers:",
        "    remote:",
        "      transport: https",
        "      url: https://mcp.example.test/mcp",
        "      headers:",
        "        Authorization: Bearer direct-test-token",
      ].join("\n"),
      { encoding: "utf8", mode: 0o644 },
    );

    const config = loadMcpConfig(configPath, dir);

    expect(config.diagnostics.join("\n")).toContain("Restricted MCP config file permissions");
  });
});


describe("MCP connector config persistence", () => {
  it("writes a validated remote connector to config.yaml with restricted permissions", () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, ["theme: dark", "", "mcp:", "  enabled: false", "  servers: {}"].join("\n"), "utf8");

    const server = createRemoteMcpServerConfig(
      {
        name: "Figma Connector",
        url: "https://mcp.example.test/mcp",
        bearerToken: "test-token",
        autoStart: true,
      },
      dir,
    );
    saveMcpServerConfig(configPath, [], server);

    const source = readFileSync(configPath, "utf8");
    expect(source).toContain("theme: dark");
    expect(source).toContain("figma-connector:");
    expect(source).toContain('Authorization: "Bearer test-token"');

    const loaded = loadMcpConfig(configPath, dir);
    expect(loaded.enabled).toBe(true);
    expect(loaded.servers[0]).toMatchObject({
      id: "figma-connector",
      transport: "https",
      headers: { Authorization: "Bearer test-token" },
      autoStart: true,
    });
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o077).toBe(0);
    }
  });
});

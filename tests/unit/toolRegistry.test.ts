import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "@tool-registry/toolRegistry";
import { registerAvailableTools } from "@tool-registry/registerTools";
import { shellTools } from "@tools/general/shellTools";
import { checkShellGuard } from "@tools/general/shellGuard";

const shellWorkspaces: string[] = [];

const createShellWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-shell-test-"));
  shellWorkspaces.push(dir);
  return dir;
};

afterEach(() => {
  for (const workspace of shellWorkspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
  shellWorkspaces.length = 0;
});

describe("tool registry", () => {
  it("registers typed general tools", () => {
    const registry = new ToolRegistry();
    registerAvailableTools(registry);
    expect(registry.get("browser.navigate")?.risk).toBe("high");
    expect(registry.get("write_file")?.risk).toBe("high");
    expect(registry.get("file.write")).toBeNull();
    expect(registry.get("file.read")).toBeNull();
    expect(registry.get("batch_read_files")).toBeNull();
    expect(
      registry
        .toProviderTools()
        .some((tool) => tool.name === "workspace.status"),
    ).toBe(true);
  });

  it("returns structured validation failure", async () => {
    const registry = new ToolRegistry();
    registerAvailableTools(registry);
    const result = await registry.execute(
      { id: "x", name: "read_file", risk: "safe", input: {} },
      {} as never,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("validation");
  });

  it("coerces common numeric and boolean string tool inputs before validation and normalizes offset 0", async () => {
    const registry = new ToolRegistry();
    registerAvailableTools(registry);
    const workspaceDir = createShellWorkspace();
    const filePath = join(workspaceDir, "example.txt");
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(filePath, "hello\nworld\n", "utf8"));

    const result = await registry.execute(
      {
        id: "read",
        name: "read_file",
        risk: "safe",
        input: { path: "example.txt", offset: "0", limit: "1", allow_large: "false" },
      },
      {
        workspaceDir,
        browserWorkspace: null,
        artifacts: null,
        workspaceLogs: null,
        agentSettings: {
          allowOutsideWorkspaceAccess: false,
          allowPrivateNetworkAccess: false,
          useShellSandbox: false,
        },
      } as never,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ offset: 1, limit: 1 });

    const repeated = await registry.execute(
      {
        id: "read-again",
        name: "read_file",
        risk: "safe",
        input: { path: "example.txt", offset: "0", limit: "1" },
      },
      {
        workspaceDir,
        browserWorkspace: null,
        artifacts: null,
        workspaceLogs: null,
        agentSettings: {
          allowOutsideWorkspaceAccess: false,
          allowPrivateNetworkAccess: false,
          useShellSandbox: false,
        },
      } as never,
    );

    expect(repeated.ok).toBe(true);
    expect(repeated.blocked).toBe(false);
    expect(repeated.data).toMatchObject({
      unchanged_since_last_read: true,
      content_returned: false,
      previous_result_still_valid: true,
    });
    expect(JSON.stringify(repeated.data)).not.toContain('"content"');
  });

  it("keeps skipped dependency folders out of safe read tools", async () => {
    const registry = new ToolRegistry();
    registerAvailableTools(registry);
    const workspaceDir = createShellWorkspace();
    const dependencyDir = join(workspaceDir, "node_modules", "pkg");
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(join(dependencyDir, "index.js"), "const junk = true;\n", "utf8");

    const context = {
      workspaceDir,
      browserWorkspace: null,
      artifacts: null,
      workspaceLogs: null,
      agentSettings: {
        allowOutsideWorkspaceAccess: false,
        allowPrivateNetworkAccess: false,
        useShellSandbox: false,
      },
    } as never;

    const rootList = await registry.execute(
      { id: "ls-root", name: "ls", risk: "safe", input: { path: ".", show_hidden: true } },
      context,
    );
    const entries = (rootList.data as { entries?: Array<{ name: string }> }).entries ?? [];

    expect(entries.some((entry) => entry.name === "node_modules")).toBe(false);
    expect(entries.some((entry) => entry.name === "out")).toBe(false);

    const directRead = await registry.execute(
      {
        id: "read-junk",
        name: "read_file",
        risk: "safe",
        input: { path: "node_modules/pkg/index.js" },
      },
      context,
    );

    expect(directRead.ok).toBe(false);
    expect(directRead.blocked).toBe(true);
    expect(directRead.message).toContain("skipped workspace directory");

    const directGrep = await registry.execute(
      {
        id: "grep-junk",
        name: "grep",
        risk: "safe",
        input: { pattern: "junk", path: "node_modules" },
      },
      context,
    );

    expect(directGrep.ok).toBe(false);
    expect(directGrep.blocked).toBe(true);

    const outRead = await registry.execute(
      {
        id: "read-out",
        name: "read_file",
        risk: "safe",
        input: { path: "out/generated.js" },
      },
      context,
    );

    expect(outRead.ok).toBe(false);
    expect(outRead.blocked).toBe(true);

    const blockedWrite = await registry.execute(
      {
        id: "write-junk",
        name: "write_file",
        risk: "high",
        input: { path: "node_modules/pkg/index.js", content: "mutated\n" },
      },
      context,
    );

    expect(blockedWrite.ok).toBe(false);
    expect(blockedWrite.blocked).toBe(true);

    const blockedRemove = await registry.execute(
      {
        id: "rm-junk",
        name: "rm",
        risk: "high",
        input: { path: "node_modules/pkg", recursive: true },
      },
      context,
    );

    expect(blockedRemove.ok).toBe(false);
    expect(blockedRemove.blocked).toBe(true);
  });
});

describe("shell execution policy", () => {
  it("blocks shell file-read aliases so they cannot bypass read_file policy", () => {
    const workspaceDir = createShellWorkspace();

    for (const command of ["cat package.json", "head package.json", "tail package.json", "sed package.json", "awk '{print}' package.json"]) {
      const decision = checkShellGuard({ command, cwd: workspaceDir, workspaceDir });
      expect(decision.allowed, command).toBe(false);
      expect(decision.reason).toContain("read_file");
    }
  });

  it("blocks exact sensitive shell paths as well as descendants", () => {
    const workspaceDir = createShellWorkspace();

    for (const command of ["ls /etc", "grep host /etc", "ls ~/.ssh", "ls ~/.ssh/"]) {
      const decision = checkShellGuard({ command, cwd: workspaceDir, workspaceDir });
      expect(decision.allowed, command).toBe(false);
    }
  });

  it("uses the local workspace shell by default instead of sandboxing", async () => {
    const workspaceDir = createShellWorkspace();
    const bash = shellTools.find((tool) => tool.name === "bash");
    if (!bash) throw new Error("bash tool not registered");

    const result = await bash.execute({ command: "printf ok", cwd: "." }, {
      workspaceDir,
      browserWorkspace: null,
      artifacts: null,
      workspaceLogs: null,
      agentSettings: {
        allowOutsideWorkspaceAccess: false,
        allowPrivateNetworkAccess: false,
        useShellSandbox: false,
      },
    } as never);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      stdout: "ok",
      sandbox: false,
      execution_mode: "direct",
    });
  });

  it("raises unrealistically tiny shell timeouts to a useful minimum", async () => {
    const workspaceDir = createShellWorkspace();
    const bash = shellTools.find((tool) => tool.name === "bash");
    if (!bash) throw new Error("bash tool not registered");

    const result = await bash.execute(
      { command: "printf ok", cwd: ".", timeout: 1 },
      {
        workspaceDir,
        browserWorkspace: null,
        artifacts: null,
        workspaceLogs: null,
        agentSettings: {
          allowOutsideWorkspaceAccess: false,
          allowPrivateNetworkAccess: false,
          useShellSandbox: false,
        },
      } as never,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      stdout: "ok",
      resource_limits: { timeoutMs: 1000 },
    });
  });
});

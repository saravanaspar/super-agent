import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalConfigPath = process.env.SUPER_AGENT_CONFIG_PATH;

const createTempDir = (): string => {
  const dir = join(
    tmpdir(),
    `super-agent-runtime-config-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
};

const writeConfig = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "mcp:\n  enabled: true\n", "utf8");
};

const loadResolver = async () => {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: {
      getPath: () => "",
      getAppPath: () => ""
    }
  }));
  const envModule = await import("@settings/env");
  return envModule.resolveDefaultConfigPath;
};

const configPathOptions = (root: string) => ({
  userDataDir: join(root, "user-data"),
  appPath: join(root, "app"),
  homeDir: join(root, "home")
});

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.SUPER_AGENT_CONFIG_PATH;
  } else {
    process.env.SUPER_AGENT_CONFIG_PATH = originalConfigPath;
  }
  vi.doUnmock("electron");
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("runtime config path resolution", () => {
  it("uses the explicit MCP config path when configured", async () => {
    const root = createTempDir();
    process.env.SUPER_AGENT_CONFIG_PATH = "custom/config.yaml";
    const resolveDefaultConfigPath = await loadResolver();

    expect(resolveDefaultConfigPath(configPathOptions(root))).toBe(
      resolve(process.cwd(), "custom", "config.yaml")
    );
  });

  it("prefers ~/.super-agent/config.yaml over app data config files", async () => {
    const root = createTempDir();
    const homeConfig = join(root, "home", ".super-agent", "config.yaml");
    const userDataConfig = join(root, "user-data", "config.yaml");
    writeConfig(homeConfig);
    writeConfig(userDataConfig);
    const resolveDefaultConfigPath = await loadResolver();

    expect(resolveDefaultConfigPath(configPathOptions(root))).toBe(homeConfig);
  });

  it("falls back to app userData config.yaml before packaged app config files", async () => {
    const root = createTempDir();
    const userDataConfig = join(root, "user-data", "config.yaml");
    const appConfig = join(root, "app", "config.yaml");
    writeConfig(userDataConfig);
    writeConfig(appConfig);
    const resolveDefaultConfigPath = await loadResolver();

    expect(resolveDefaultConfigPath(configPathOptions(root))).toBe(userDataConfig);
  });

  it("returns the user config path when no config file exists yet", async () => {
    const root = createTempDir();
    const resolveDefaultConfigPath = await loadResolver();

    expect(resolveDefaultConfigPath(configPathOptions(root))).toBe(
      join(root, "home", ".super-agent", "config.yaml")
    );
  });
});

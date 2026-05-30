import { app } from "electron";
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadMcpConfig, type McpConfig } from "@mcp/mcpConfig";

config();

const rootDir = process.cwd();

const resolveFromRoot = (value: string): string => {
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return value;
  return resolve(rootDir, value);
};

const readRuntimePath = (name: string, fallback: string): string => {
  const value = process.env[name];
  return resolveFromRoot(value || fallback);
};

export interface RuntimeConfig {
  databasePath: string;
  workspaceDir: string;
  testProviderEnabled: boolean;
  mcp: McpConfig;
}

export interface RuntimeConfigPathOptions {
  userDataDir: string;
  appPath?: string;
  homeDir?: string;
}

const userConfigPath = (homeDir = homedir()): string => resolve(homeDir, ".super-agent", "config.yaml");

const installedAppConfigPath = (appPath?: string): string | null => {
  if (!appPath) return null;
  const basePath = appPath.endsWith("app.asar") ? dirname(appPath) : appPath;
  return resolve(basePath, "config.yaml");
};

export const resolveDefaultConfigPath = ({
  userDataDir,
  appPath,
  homeDir
}: RuntimeConfigPathOptions): string | null => {
  const explicit = process.env.SUPER_AGENT_CONFIG_PATH;
  if (explicit) return resolveFromRoot(explicit);

  const candidates = [
    userConfigPath(homeDir),
    resolve(userDataDir, "config.yaml"),
    installedAppConfigPath(appPath)
  ];

  return candidates.find((candidate) => candidate !== null && existsSync(candidate)) ?? candidates[0]!;
};

export const loadRuntimeConfig = (): RuntimeConfig => {
  const userData = app?.getPath
    ? app.getPath("userData")
    : resolve(rootDir, "super-agent-data");
  const appPath = app?.getAppPath ? app.getAppPath() : rootDir;
  const workspaceDir = readRuntimePath(
    "SUPER_AGENT_WORKSPACE_DIR",
    resolve(userData, "workspace")
  );

  return {
    databasePath: readRuntimePath(
      "SUPER_AGENT_DB_PATH",
      resolve(userData, "super-agent.sqlite")
    ),
    workspaceDir,
    testProviderEnabled: process.env.SUPER_AGENT_TEST_PROVIDER === "stub",
    mcp: loadMcpConfig(resolveDefaultConfigPath({ userDataDir: userData, appPath }), workspaceDir)
  };
};

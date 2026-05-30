import { mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellSandboxBackendStatus {
  platform: string;
  backend: string;
  available: boolean;
  workspace: string;
}

const executable = (name: string): string => {
  try {
    const result = spawnSync("where", [name], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    return String(result.stdout || "").split(/\r?\n/)[0]?.trim() ?? "";
  } catch {
    return "";
  }
};

const insideDirectory = (root: string, candidate: string): boolean => {
  const relation = relative(root, candidate);
  return relation === "" || (!!relation && !relation.startsWith("..") && !isAbsolute(relation));
};

const resolveWriteRoots = (workspacePath: string, writeRoots: string[]): string[] => {
  const workspace = resolve(workspacePath);
  const roots = writeRoots.length ? writeRoots : ["."];
  return [...new Set(roots.map((root) => resolve(workspace, root)))].filter((root) => {
    if (!insideDirectory(workspace, root)) return false;
    mkdirSync(root, { recursive: true });
    return true;
  });
};

const containerPathForHostPath = (workspacePath: string, hostPath: string): string => {
  const containerWorkspace = "C:\\workspace";
  const relation = relative(workspacePath, hostPath).replace(/\\/g, "/");
  if (!relation || relation === ".") return containerWorkspace;
  return `${containerWorkspace}\\${relation.replace(/\//g, "\\")}`;
};

export const windowsContainerShellArgs = (workspacePath: string, cwd: string, command: string, allowNetwork: boolean): { file: string; args: string[] } | null => {
  const runtime = executable("docker") || executable("podman");
  if (!runtime) return null;
  const image = process.env.SUPER_AGENT_WINDOWS_SANDBOX_IMAGE || "mcr.microsoft.com/powershell:lts-nanoserver-ltsc2022";
  const containerCwd = containerPathForHostPath(workspacePath, cwd);
  const networkArgs = allowNetwork ? [] : ["--network", "none"];
  return { file: runtime, args: ["run", "--rm", ...networkArgs, "-v", `${workspacePath}:C:\\workspace`, "-w", containerCwd, image, "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
};

export const windowsSkillScriptSandboxArgs = ({
  workspacePath,
  cwd,
  file,
  commandArgs,
  allowNetwork,
  writeRoots,
}: {
  workspacePath: string;
  cwd: string;
  file: string;
  commandArgs: string[];
  allowNetwork: boolean;
  writeRoots: string[];
}): { file: string; args: string[] } | null => {
  const runtime = executable("docker") || executable("podman");
  if (!runtime) return null;
  const image = process.env.SUPER_AGENT_WINDOWS_SANDBOX_IMAGE || "mcr.microsoft.com/powershell:lts-nanoserver-ltsc2022";
  const networkArgs = allowNetwork ? [] : ["--network", "none"];
  const writeRootArgs = resolveWriteRoots(workspacePath, writeRoots).flatMap((root) => [
    "-v",
    `${root}:${containerPathForHostPath(workspacePath, root)}`,
  ]);
  const workspace = resolve(workspacePath);
  const toContainerArg = (arg: string): string => {
    if (!isAbsolute(arg)) return arg;
    const resolved = resolve(arg);
    return insideDirectory(workspace, resolved) ? containerPathForHostPath(workspace, resolved) : arg;
  };
  const psQuote = (arg: string): string => `"${arg.replace(/"/g, '`"')}"`;
  const containerCwd = containerPathForHostPath(workspacePath, cwd);
  const command = [file, ...commandArgs]
    .map(toContainerArg)
    .map(psQuote)
    .join(" ");

  return {
    file: runtime,
    args: [
      "run",
      "--rm",
      ...networkArgs,
      "-v",
      `${workspacePath}:C:\\workspace:ro`,
      ...writeRootArgs,
      "-w",
      containerCwd,
      image,
      "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ],
  };
};

export const shellSandboxBackendStatus = (workspacePath = process.cwd()): ShellSandboxBackendStatus => ({
  platform: "win32",
  backend: "windows-container",
  available: Boolean(executable("docker") || executable("podman")),
  workspace: workspacePath
});

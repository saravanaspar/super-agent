import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellSandboxBackendStatus {
  platform: string;
  backend: string;
  available: boolean;
  workspace: string;
}

const executable = (name: string): string => {
  try {
    const result = spawnSync("sh", ["-lc", "command -v \"$1\"", "sh", name], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    return String(result.stdout || "").split(/\r?\n/)[0]?.trim() ?? "";
  } catch {
    return "";
  }
};

const buildMacSeatbeltProfile = (allowNetwork: boolean): string => String.raw`(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data
  (literal "/") (literal "/var") (literal "/etc") (literal "/tmp") (literal "/private")
  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt")
  (subpath "/System") (subpath "/Library")
  (subpath "/private/etc") (subpath "/private/tmp") (subpath "/dev")
  (subpath (param "WORKSPACE")))
(allow file-write*
  (subpath (param "WORKSPACE"))
  (subpath "/private/tmp") (subpath "/tmp")
  (literal "/dev/null") (literal "/dev/tty"))
${allowNetwork ? "(allow network*)" : "(deny network*)"}`;

const buildMacSkillSeatbeltProfile = (allowNetwork: boolean, writeRoots: string[]): string => {
  const writeRootRules = writeRoots
    .map((_, index) => `  (subpath (param "WRITE_ROOT_${index}"))`)
    .join("\n");

  return String.raw`(version 1)
(deny default)
(allow process-exec*)
(allow process-fork)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data
  (literal "/") (literal "/var") (literal "/etc") (literal "/tmp") (literal "/private")
  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt")
  (subpath "/System") (subpath "/Library")
  (subpath "/private/etc") (subpath "/private/tmp") (subpath "/dev")
  (subpath (param "WORKSPACE")))
(allow file-write*
${writeRootRules}
  (subpath "/private/tmp") (subpath "/tmp")
  (literal "/dev/null") (literal "/dev/tty"))
${allowNetwork ? "(allow network*)" : "(deny network*)"}`;
};

const shellQuote = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";

const sandboxProfilePath = (workspacePath: string, allowNetwork: boolean): string => {
  const dir = join(workspacePath, ".super-agent", "sandbox");
  mkdirSync(dir, { recursive: true });
  const profilePath = join(dir, allowNetwork ? "shell-network.sb" : "shell.sb");
  writeFileSync(profilePath, buildMacSeatbeltProfile(allowNetwork), { encoding: "utf8", mode: 0o600 });
  return profilePath;
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

const skillSandboxProfilePath = (
  workspacePath: string,
  allowNetwork: boolean,
  writeRoots: string[],
): string => {
  const dir = join(workspacePath, ".super-agent", "sandbox");
  mkdirSync(dir, { recursive: true });
  const suffix = allowNetwork ? "network" : "offline";
  const profilePath = join(dir, `skill-${suffix}-${writeRoots.length}.sb`);
  writeFileSync(profilePath, buildMacSkillSeatbeltProfile(allowNetwork, writeRoots), { encoding: "utf8", mode: 0o600 });
  return profilePath;
};

export const macosShellSandboxArgs = (
  workspacePath: string,
  cwd: string,
  command: string,
  allowNetwork = false
): { file: string; args: string[] } | null => {
  const sandboxExec = executable("sandbox-exec");
  if (!sandboxExec) return null;
  const profile = sandboxProfilePath(workspacePath, allowNetwork);
  const commandWithCwd = `cd ${shellQuote(cwd)} && ${command}`;
  return {
    file: sandboxExec,
    args: [
      "-f",
      profile,
      "-D",
      `WORKSPACE=${workspacePath}`,
      "/bin/sh",
      "-c",
      commandWithCwd
    ]
  };
};

export const macosSkillScriptSandboxArgs = ({
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
  const sandboxExec = executable("sandbox-exec");
  if (!sandboxExec) return null;
  const resolvedWriteRoots = resolveWriteRoots(workspacePath, writeRoots);
  const profile = skillSandboxProfilePath(workspacePath, allowNetwork, resolvedWriteRoots);
  const command = `cd ${shellQuote(cwd)} && ${[file, ...commandArgs].map(shellQuote).join(" ")}`;
  const defines = resolvedWriteRoots.flatMap((root, index) => ["-D", `WRITE_ROOT_${index}=${root}`]);

  return {
    file: sandboxExec,
    args: [
      "-f",
      profile,
      "-D",
      `WORKSPACE=${workspacePath}`,
      ...defines,
      "/bin/sh",
      "-c",
      command,
    ],
  };
};

export const shellSandboxBackendStatus = (workspacePath = process.cwd()): ShellSandboxBackendStatus => ({
  platform: "darwin",
  backend: "macos-seatbelt",
  available: Boolean(executable("sandbox-exec")),
  workspace: workspacePath
});

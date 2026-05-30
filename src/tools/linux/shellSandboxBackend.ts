import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

const existingBinds = (paths: string[]): string[] => paths.filter((item) => existsSync(item));

const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

const pathParents = (target: string): string[] => {
  const normalized = resolve(target);
  const parents: string[] = [];
  let current = dirname(normalized);

  while (current && current !== "/" && current !== dirname(current)) {
    parents.push(current);
    current = dirname(current);
  }

  return parents.reverse();
};

const addParentDirs = (args: string[], target: string): void => {
  for (const parent of pathParents(target)) {
    args.push("--dir", parent);
  }
};

const nodeRuntimeRoots = (): string[] => {
  const roots: string[] = [];

  for (const executablePath of unique([
    process.execPath,
    executable("node"),
    executable("npm"),
    executable("npx"),
    executable("pnpm"),
    executable("yarn"),
  ])) {
    if (!executablePath || !existsSync(executablePath)) continue;
    const binDir = dirname(executablePath);
    const runtimeRoot = dirname(binDir);

    if (
      runtimeRoot &&
      runtimeRoot !== "/" &&
      runtimeRoot !== "/usr" &&
      !runtimeRoot.startsWith("/usr/") &&
      runtimeRoot !== "/opt" &&
      !runtimeRoot.startsWith("/opt/")
    ) {
      roots.push(runtimeRoot);
    }
  }

  return unique(roots).filter((root) => existsSync(root));
};

const addRuntimeBinds = (args: string[]): void => {
  for (const root of nodeRuntimeRoots()) {
    addParentDirs(args, root);
    args.push("--ro-bind", root, root);
  }
};

const shellQuote = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";

const commandLine = (file: string, commandArgs: string[]): string =>
  [file, ...commandArgs].map(shellQuote).join(" ");

const insideDirectory = (root: string, candidate: string): boolean => {
  const relation = relative(root, candidate);
  return relation === "" || (!!relation && !relation.startsWith("..") && !isAbsolute(relation));
};

const resolveWriteRoots = (workspacePath: string, writeRoots: string[]): string[] => {
  const workspace = resolve(workspacePath);
  const roots = writeRoots.length ? writeRoots : ["."];
  return unique(roots.map((root) => resolve(workspace, root))).filter((root) => {
    if (!insideDirectory(workspace, root)) return false;
    mkdirSync(root, { recursive: true });
    return true;
  });
};


const bubblewrapBaseArgs = (allowNetwork: boolean): string[] => [
  "--die-with-parent",
  "--new-session",
  "--unshare-user",
  "--unshare-ipc",
  "--unshare-pid",
  "--unshare-uts",
  ...(allowNetwork ? [] : ["--unshare-net"]),
];

const addCommonBubblewrapArgs = (
  args: string[],
  allowNetwork: boolean,
): void => {
  for (const dir of existingBinds(["/bin", "/usr", "/lib", "/lib64", "/sbin", "/opt"])) args.push("--ro-bind", dir, dir);
  addRuntimeBinds(args);
  for (const file of existingBinds(["/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/hosts"])) args.push("--ro-bind", file, file);
  if (allowNetwork) for (const file of existingBinds(["/etc/resolv.conf"])) args.push("--ro-bind", file, file);
};

export const linuxShellSandboxArgs = (workspacePath: string, cwd: string, command: string, allowNetwork: boolean): { file: string; args: string[] } | null => {
  const bwrap = executable("bwrap");
  if (!bwrap) return null;
  const args = [...bubblewrapBaseArgs(allowNetwork), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", workspacePath, workspacePath];
  addCommonBubblewrapArgs(args, allowNetwork);
  args.push("--chdir", cwd, "/bin/sh", "-c", command);
  return { file: bwrap, args };
};

export const linuxSkillScriptSandboxArgs = ({
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
  const bwrap = executable("bwrap");
  if (!bwrap) return null;
  const workspace = resolve(workspacePath);
  const args = [...bubblewrapBaseArgs(allowNetwork), "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", workspace, workspace];
  for (const root of resolveWriteRoots(workspace, writeRoots)) args.push("--bind", root, root);
  addCommonBubblewrapArgs(args, allowNetwork);
  args.push("--chdir", cwd, "/bin/sh", "-c", commandLine(file, commandArgs));
  return { file: bwrap, args };
};

export const shellSandboxBackendStatus = (workspacePath = process.cwd()): ShellSandboxBackendStatus => ({
  platform: "linux",
  backend: "linux-bubblewrap",
  available: Boolean(executable("bwrap")),
  workspace: workspacePath
});

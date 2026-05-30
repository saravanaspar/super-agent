import { realpathSync } from "node:fs";
import { assertInsideWorkspace, workspaceRealPath } from "./pathSafety";

export interface ShellGuardInput {
  command: string;
  cwd: string;
  workspaceDir: string;
}

export interface ShellGuardDecision {
  allowed: boolean;
  reason?: string;
}

const systemPathPattern =
  /(^|[\s"'`;&|])\/(etc|bin|sbin|usr|lib|lib64|boot|dev|proc|sys|root)(?=$|[\s"'`;&|/])/;

const sshPathPattern = /(^|[\s"'`;&|])~\/\.ssh(?=$|[\s"'`;&|/])/;

export const checkShellGuard = ({
  command,
  cwd,
  workspaceDir
}: ShellGuardInput): ShellGuardDecision => {
  const cmd = String(command || "").trim();
  if (!cmd) return { allowed: false, reason: "empty shell command" };

  try {
    const realCwd = realpathSync.native(cwd);
    assertInsideWorkspace(realCwd, workspaceRealPath(workspaceDir), cwd);
  } catch {
    return { allowed: false, reason: "cwd is outside workspace" };
  }

  const blocked: Array<{ re: RegExp; reason: string }> = [
    { re: /(^|[;&|]\s*)(cat|head|tail|less|more|sed|awk)\b/i, reason: "shell file-reading commands are blocked; use read_file" },
    { re: /(^|[;&|]\s*)(env|printenv|export\s+-p|set)(\s|$)/, reason: "environment dumping is blocked" },
    { re: /\b(cat|grep|rg|sed|awk|less|more|head|tail)\b[\s\S]*(\.env|id_rsa|id_ed25519|authorized_keys|credentials|secrets|\.npmrc|\.pypirc)/i, reason: "reading likely secret files is blocked" },
    { re: /(?:^|[\s;&|])(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh|python|python3|node)\b/, reason: "remote code piped into an interpreter is blocked" },
    { re: /(?:>|>>|2>|&>)\s*(["']?)(\/|~|\.\.\/)/, reason: "redirecting output outside workspace is blocked" },
    { re: /\btee\b\s+(-a\s+)?(["']?)(\/|~|\.\.\/)/, reason: "tee writes outside workspace are blocked" },
    { re: systemPathPattern, reason: "system path access is blocked" },
    { re: sshPathPattern, reason: "ssh key path access is blocked" },
    { re: /\b(systemctl|service)\b/, reason: "service manager commands are blocked" },
    { re: /\b(kill|pkill|killall)\b/, reason: "process kill commands are blocked in sandbox mode" },
    { re: /\b(chmod|chown)\b\s+-?R\b/, reason: "recursive permission/ownership changes are blocked" },
    { re: /\b(npm|yarn|pnpm|pip|pip3)\b[\s\S]*\b(publish|login|token)\b/, reason: "package registry credential/publish operations are blocked" }
  ];

  for (const item of blocked) {
    if (item.re.test(cmd)) return { allowed: false, reason: item.reason };
  }

  return { allowed: true };
};

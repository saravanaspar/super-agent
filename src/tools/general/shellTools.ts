import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { z } from "zod";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import {
  DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  DEFAULT_SHELL_TIMEOUT_MS,
  DETACHED_COMMAND_PATTERNS,
  PACKAGE_INSTALL_PATTERN,
  SHELL_HEAVY_COMMAND_PATTERNS,
} from "./constants";
import {
  listManagedProcesses,
  startManagedProcess,
  stopManagedProcess,
} from "./processManager";
import { appendBoundedOutput } from "./shellOutput";
import { resolveExistingPath } from "./pathSafety";
import { checkShellGuard } from "./shellGuard";
import {
  linuxShellSandboxArgs,
  shellSandboxBackendStatus as linuxSandboxStatus,
} from "../linux/shellSandboxBackend";
import {
  macosShellSandboxArgs,
  shellSandboxBackendStatus as macosSandboxStatus,
} from "../macos/shellSandboxBackend";
import {
  shellSandboxBackendStatus as windowsSandboxStatus,
  windowsContainerShellArgs,
} from "../windows/shellSandboxBackend";

const bashInput = z.object({
  command: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  keep_running: z.boolean().optional(),
});

const listProcessesInput = z.object({ include_exited: z.boolean().optional() });
const stopProcessInput = z.object({
  id: z.string().min(1),
  signal: z.string().optional(),
});

type BashInput = z.infer<typeof bashInput>;
type ListProcessesInput = z.infer<typeof listProcessesInput>;
type StopProcessInput = z.infer<typeof stopProcessInput>;

const parameters = (
  properties: JsonRecord,
  required: string[] = [],
): JsonRecord => ({ type: "object", properties, required });

interface SandboxCommand {
  file: string;
  args: string[];
}

const backendStatus = (workspaceDir: string): JsonRecord => {
  if (process.platform === "darwin") {
    return toJsonRecord(macosSandboxStatus(workspaceDir));
  }
  if (process.platform === "win32") {
    return toJsonRecord(windowsSandboxStatus(workspaceDir));
  }
  return toJsonRecord(linuxSandboxStatus(workspaceDir));
};

const shellSandboxCommand = (
  workspaceDir: string,
  cwd: string,
  command: string,
  allowNetwork: boolean,
): SandboxCommand | null => {
  if (process.platform === "darwin") {
    return macosShellSandboxArgs(workspaceDir, cwd, command, allowNetwork);
  }

  if (process.platform === "win32") {
    return windowsContainerShellArgs(workspaceDir, cwd, command, allowNetwork);
  }

  return linuxShellSandboxArgs(workspaceDir, cwd, command, allowNetwork);
};

const describeResourceUse = (command: string): JsonRecord => {
  for (const pattern of SHELL_HEAVY_COMMAND_PATTERNS) {
    if (pattern.re.test(command)) {
      return {
        heavy: true,
        label: pattern.label,
        message: `Likely memory/CPU-heavy command detected: ${pattern.label}. Configured shell limits apply only to this agent command.`,
      };
    }
  }
  return { heavy: false, label: "", message: "" };
};

const checkDetachedProcessUse = (
  command: string,
  keepRunning: boolean,
): { allowed: boolean; reason: string } => {
  const detached = DETACHED_COMMAND_PATTERNS.some((pattern) =>
    pattern.test(command),
  );
  if (!detached) return { allowed: true, reason: "" };
  if (keepRunning) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason:
      "detached process patterns require keep_running=true and explicit approval",
  };
};

const shellToolEnv = ({
  home,
  pwd,
  command,
}: {
  home: string;
  pwd: string;
  command: string;
}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  LANG: process.env.LANG || "C.UTF-8",
  LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
  TERM: process.env.TERM || "xterm-256color",
  TMPDIR: process.env.TMPDIR || "/tmp",
  HOME: home,
  PWD: pwd,
  npm_config_cache: `${home}/.super-agent/npm-cache`,
  ELECTRON_CACHE: `${home}/.super-agent/electron-cache`,
  ELECTRON_BUILDER_CACHE: `${home}/.super-agent/electron-builder-cache`,
  SUPER_AGENT_USER_COMMAND: command,
  SUPER_AGENT_SHELL_RESTRICTED_ENV: "1",
});

const sandboxShellEnv = (
  workspaceDir: string,
  command: string,
): NodeJS.ProcessEnv =>
  shellToolEnv({ home: workspaceDir, pwd: workspaceDir, command });

const directShellEnv = (
  workspaceDir: string,
  cwd: string,
  command: string,
): NodeJS.ProcessEnv => shellToolEnv({ home: workspaceDir, pwd: cwd, command });



const VERIFICATION_COMMAND_PATTERN =
  /\b(npm|yarn|pnpm)\s+run\s+(typecheck|lint|test|verify|build|e2e|test:[A-Za-z0-9_-]+)\b|\b(cargo|go|pytest|python3?\s+-m\s+pytest)\b/i;

const minimumShellTimeoutMs = (command: string): number => {
  if (VERIFICATION_COMMAND_PATTERN.test(command)) return 30_000;
  return 1_000;
};

const normalizeShellTimeout = (command: string, requested?: number): number => {
  const minimum = minimumShellTimeoutMs(command);
  const wanted = requested ?? DEFAULT_SHELL_TIMEOUT_MS;
  return Math.max(minimum, Math.min(wanted, DEFAULT_SHELL_TIMEOUT_MS));
};

const directShellCommand = (command: string): SandboxCommand => {
  if (process.platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }

  return { file: "/bin/sh", args: ["-c", command] };
};

const normalizedCommand = (command: string): string =>
  command.trim().replace(/\s+/g, " ");

const shellExecutionMetadata = (
  workspaceDir: string,
  sandbox: boolean,
  timeoutMs: number | null,
  maxOutputBytes = DEFAULT_SHELL_MAX_OUTPUT_BYTES,
): JsonRecord => ({
  timeoutMs,
  maxOutputBytes,
  sandbox,
  executionMode: sandbox ? "sandbox" : "direct",
  backend: backendStatus(workspaceDir),
});

const directSafeShellOutput = ({
  command,
  cwd,
  timeout,
  workspaceDir,
}: {
  command: string;
  cwd: string;
  timeout: number;
  workspaceDir: string;
}): JsonRecord | null => {
  const normalized = normalizedCommand(command);
  let stdout: string | null = null;

  if (normalized === "pwd") {
    stdout = `${cwd}\n`;
  } else if (normalized === "whoami") {
    stdout = `${userInfo().username}\n`;
  } else if (normalized === "date") {
    stdout = `${new Date().toString()}\n`;
  } else if (normalized === "node -v" || normalized === "node --version") {
    stdout = `${process.version}\n`;
  }

  if (stdout === null) return null;

  return {
    command,
    exit_code: 0,
    signal: null,
    stdout,
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    truncated: false,
    timed_out: false,
    aborted: false,
    cancelled: false,
    sandbox: false,
    execution_mode: "direct",
    direct_safe_builtin: true,
    resource_limits: shellExecutionMetadata(workspaceDir, false, timeout),
  };
};

const runShellCommand = ({
  command,
  cwd,
  timeout,
  signal,
  workspaceDir,
  useSandbox,
}: {
  command: string;
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  workspaceDir: string;
  useSandbox: boolean;
}): Promise<JsonRecord> =>
  new Promise((resolve) => {
    const allowNetwork = PACKAGE_INSTALL_PATTERN.test(command);
    const prepared = useSandbox
      ? shellSandboxCommand(workspaceDir, cwd, command, allowNetwork)
      : directShellCommand(command);

    if (!prepared) {
      resolve({
        command,
        exit_code: null,
        signal: null,
        stdout: "",
        stderr:
          "Shell sandbox is enabled, but no sandbox backend is available. Disable shell sandboxing in Agent settings to use the local workspace shell, or install the sandbox backend.",
        stdout_truncated: false,
        stderr_truncated: false,
        truncated: false,
        timed_out: false,
        aborted: false,
        cancelled: false,
        sandbox: false,
        execution_mode: "sandbox-unavailable",
        resource_limits: shellExecutionMetadata(workspaceDir, true, timeout),
      });
      return;
    }

    const child = spawn(prepared.file, prepared.args, {
      cwd: useSandbox ? workspaceDir : cwd,
      env: useSandbox
        ? sandboxShellEnv(workspaceDir, command)
        : directShellEnv(workspaceDir, cwd, command),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    const maxOutputBytes = DEFAULT_SHELL_MAX_OUTPUT_BYTES;

    const kill = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };

    const timer = setTimeout(() => kill("timeout"), timeout);
    timer.unref?.();

    const onAbort = (): void => kill("abort");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(stdout, chunk, maxOutputBytes);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBoundedOutput(stderr, chunk, maxOutputBytes);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });

    child.on("error", (error) => {
      stderr = `${stderr}\n${error.message}`.trim();
    });

    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        exit_code: code,
        signal: closeSignal ?? null,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        truncated: stdoutTruncated || stderrTruncated,
        timed_out: timedOut,
        aborted,
        cancelled: aborted,
        sandbox: useSandbox,
        execution_mode: useSandbox ? "sandbox" : "direct",
        resource_limits: shellExecutionMetadata(
          workspaceDir,
          useSandbox,
          timeout,
          maxOutputBytes,
        ),
      });
    });
  });

const startManagedShellCommand = ({
  command,
  cwd,
  workspaceDir,
  useSandbox,
}: {
  command: string;
  cwd: string;
  workspaceDir: string;
  useSandbox: boolean;
}): JsonRecord => {
  const allowNetwork = PACKAGE_INSTALL_PATTERN.test(command);
  const prepared = useSandbox
    ? shellSandboxCommand(workspaceDir, cwd, command, allowNetwork)
    : directShellCommand(command);

  if (!prepared) {
    return {
      command,
      pid: null,
      status: "failed",
      stdout: "",
      stderr:
        "Shell sandbox is enabled, but no sandbox backend is available. Disable shell sandboxing in Agent settings to use the local workspace shell, or install the sandbox backend.",
      sandbox: false,
      execution_mode: "sandbox-unavailable",
      cleanup_on_turn_end: true,
      resource_limits: shellExecutionMetadata(workspaceDir, true, null),
    };
  }

  const snapshot = startManagedProcess({
    command,
    cwd,
    workspaceDir,
    file: prepared.file,
    args: prepared.args,
    env: useSandbox
      ? sandboxShellEnv(workspaceDir, command)
      : directShellEnv(workspaceDir, cwd, command),
    maxOutputBytes: DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  });

  return {
    ...snapshot,
    sandbox: useSandbox,
    execution_mode: useSandbox ? "sandbox" : "direct",
    resource_limits: shellExecutionMetadata(workspaceDir, useSandbox, null),
  };
};

const normalizeStopSignal = (signal?: string): NodeJS.Signals | null => {
  if (!signal) return "SIGTERM";
  if (signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT") {
    return signal;
  }

  return null;
};

const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "Execute a shell command. Stdout/stderr are captured and returned. Use keep_running only for temporary local servers or watchers needed during the current turn, then call stop_process when the process is no longer needed. Managed processes are also stopped automatically when the response ends.",
  category: "general",
  risk: "high",
  inputSchema: bashInput,
  parameters: parameters(
    {
      command: { type: "string" },
      timeout: { type: "number" },
      cwd: { type: "string" },
      keep_running: { type: "boolean" },
    },
    ["command"],
  ),
  async execute(input, context) {
    const useSandbox = context.agentSettings.useShellSandbox === true;
    const cwd = resolveExistingPath(context.workspaceDir, input.cwd ?? ".");
    const detached = checkDetachedProcessUse(
      input.command,
      input.keep_running === true,
    );
    if (!detached.allowed)
      return failureResult(
        `[shell] blocked: ${detached.reason}`,
        { command: input.command },
        true,
      );
    const guard = checkShellGuard({
      command: input.command,
      cwd,
      workspaceDir: context.workspaceDir,
    });
    if (!guard.allowed)
      return failureResult(
        `[shell] blocked: ${guard.reason ?? "blocked"}`,
        { command: input.command },
        true,
      );
    const resourceWarning = describeResourceUse(input.command);
    const timeout = normalizeShellTimeout(input.command, input.timeout);
    const directOutput = directSafeShellOutput({
      command: input.command,
      cwd,
      timeout,
      workspaceDir: context.workspaceDir,
    });

    if (directOutput) {
      directOutput.resource_warning = resourceWarning;
      return successResult("Shell command completed.", directOutput);
    }

    if (input.keep_running === true) {
      const output = startManagedShellCommand({
        command: input.command,
        cwd,
        workspaceDir: context.workspaceDir,
        useSandbox,
      });
      output.resource_warning = resourceWarning;
      if (output.execution_mode === "sandbox-unavailable")
        return failureResult(output.stderr as string, output, true);
      return successResult("Managed shell process started.", output);
    }

    const output = await runShellCommand({
      command: input.command,
      cwd,
      timeout,
      workspaceDir: context.workspaceDir,
      useSandbox,
    });
    output.resource_warning = resourceWarning;
    if (PACKAGE_INSTALL_PATTERN.test(input.command))
      output.package_install_warning =
        "Package install command detected; ensure this was explicitly requested.";
    if (output.execution_mode === "sandbox-unavailable")
      return failureResult(output.stderr as string, output, true);
    return successResult("Shell command completed.", output);
  },
};

const listProcessesTool: ToolDefinition<ListProcessesInput> = {
  name: "list_processes",
  description:
    "List managed shell processes started by Super Agent during the active app session.",
  category: "general",
  risk: "safe",
  inputSchema: listProcessesInput,
  parameters: parameters({ include_exited: { type: "boolean" } }),
  execute(input, context) {
    const records = listManagedProcesses(
      context.workspaceDir,
      input.include_exited === true,
    );
    return Promise.resolve(
      successResult("Managed processes listed.", {
        count: records.length,
        processes: records,
      }),
    );
  },
};

const stopProcessTool: ToolDefinition<StopProcessInput> = {
  name: "stop_process",
  description:
    "Stop a managed shell process previously started by Super Agent.",
  category: "general",
  risk: "safe",
  inputSchema: stopProcessInput,
  parameters: parameters(
    { id: { type: "string" }, signal: { type: "string" } },
    ["id"],
  ),
  async execute(input, context) {
    const signal = normalizeStopSignal(input.signal);
    if (!signal) {
      return failureResult("Unsupported stop signal.", {
        signal: input.signal ?? null,
      });
    }

    const processSnapshot = await stopManagedProcess(
      context.workspaceDir,
      input.id,
      signal,
    );

    if (!processSnapshot) {
      return failureResult("Managed process not found.", { id: input.id });
    }

    return successResult("Managed process stopped.", processSnapshot);
  },
};

export const shellTools: ToolDefinition[] = [
  bashTool,
  listProcessesTool,
  stopProcessTool,
];

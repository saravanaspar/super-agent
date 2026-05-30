import { spawn, type ChildProcess } from "node:child_process";
import type { JsonRecord } from "@shared/json";
import { DEFAULT_SHELL_MAX_OUTPUT_BYTES } from "./constants";
import { appendBoundedOutput } from "./shellOutput";

const STOP_GRACE_MS = 1500;
const FORCE_STOP_GRACE_MS = 500;
const MAX_RETAINED_RECORDS = 100;

type ManagedProcessStatus = "running" | "exited" | "stopped" | "failed";

export interface ManagedProcessSnapshot {
  id: string;
  pid: number | null;
  command: string;
  cwd: string;
  workspace_dir: string;
  started_at: string;
  stopped_at?: string;
  status: ManagedProcessStatus;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  cleanup_on_turn_end: boolean;
}

interface ManagedProcessEntry {
  child: ChildProcess;
  snapshot: ManagedProcessSnapshot;
}

export interface ManagedProcessStartOptions {
  command: string;
  cwd: string;
  workspaceDir: string;
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

const managedProcesses = new Map<string, ManagedProcessEntry>();

const toJsonRecord = (snapshot: ManagedProcessSnapshot): JsonRecord => ({
  id: snapshot.id,
  pid: snapshot.pid,
  command: snapshot.command,
  cwd: snapshot.cwd,
  workspace_dir: snapshot.workspace_dir,
  started_at: snapshot.started_at,
  stopped_at: snapshot.stopped_at ?? null,
  status: snapshot.status,
  exit_code: snapshot.exit_code,
  signal: snapshot.signal,
  stdout: snapshot.stdout,
  stderr: snapshot.stderr,
  stdout_truncated: snapshot.stdout_truncated,
  stderr_truncated: snapshot.stderr_truncated,
  cleanup_on_turn_end: snapshot.cleanup_on_turn_end,
});

const killProcess = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }

    child.kill(signal);
  } catch {
    child.kill(signal);
  }
};

const waitForProcessExit = (
  entry: ManagedProcessEntry,
  graceMs: number,
): Promise<void> =>
  new Promise((resolve) => {
    if (entry.snapshot.status !== "running") {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, graceMs);
    timer.unref?.();
    entry.child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const pruneOldRecords = (): void => {
  const records = [...managedProcesses.values()];
  const inactive = records.filter(
    (entry) => entry.snapshot.status !== "running",
  );
  const excess = inactive.length - MAX_RETAINED_RECORDS;

  if (excess <= 0) return;

  for (const entry of inactive.slice(0, excess)) {
    managedProcesses.delete(entry.snapshot.id);
  }
};

export const startManagedProcess = (
  options: ManagedProcessStartOptions,
): ManagedProcessSnapshot => {
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const snapshot: ManagedProcessSnapshot = {
    id: crypto.randomUUID(),
    pid: child.pid ?? null,
    command: options.command,
    cwd: options.cwd,
    workspace_dir: options.workspaceDir,
    started_at: new Date().toISOString(),
    status: "running",
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    cleanup_on_turn_end: true,
  };

  const entry: ManagedProcessEntry = { child, snapshot };
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_SHELL_MAX_OUTPUT_BYTES;
  managedProcesses.set(snapshot.id, entry);
  pruneOldRecords();

  child.stdout?.on("data", (chunk: Buffer) => {
    const next = appendBoundedOutput(snapshot.stdout, chunk, maxOutputBytes);
    snapshot.stdout = next.text;
    snapshot.stdout_truncated ||= next.truncated;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const next = appendBoundedOutput(snapshot.stderr, chunk, maxOutputBytes);
    snapshot.stderr = next.text;
    snapshot.stderr_truncated ||= next.truncated;
  });

  child.on("error", (error) => {
    snapshot.status = "failed";
    snapshot.stopped_at = new Date().toISOString();
    snapshot.stderr = `${snapshot.stderr}\n${error.message}`.trim();
  });

  child.on("close", (code, signal) => {
    if (snapshot.status === "running") {
      snapshot.status = "exited";
    }

    snapshot.exit_code = code;
    snapshot.signal = signal ?? null;
    snapshot.stopped_at = new Date().toISOString();
  });

  return { ...snapshot };
};

export const listManagedProcesses = (
  workspaceDir: string,
  includeExited: boolean,
): JsonRecord[] =>
  [...managedProcesses.values()]
    .map((entry) => entry.snapshot)
    .filter(
      (snapshot) =>
        snapshot.workspace_dir === workspaceDir &&
        (includeExited || snapshot.status === "running"),
    )
    .map(toJsonRecord);

export const stopManagedProcess = async (
  workspaceDir: string,
  id: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<JsonRecord | null> => {
  const entry = managedProcesses.get(id);
  if (!entry || entry.snapshot.workspace_dir !== workspaceDir) return null;

  if (entry.snapshot.status === "running") {
    killProcess(entry.child, signal);
    await waitForProcessExit(entry, STOP_GRACE_MS);

    if (entry.snapshot.status === "running") {
      killProcess(entry.child, "SIGKILL");
      await waitForProcessExit(entry, FORCE_STOP_GRACE_MS);
    }

    if (entry.snapshot.status === "running") {
      entry.snapshot.status = "failed";
    } else if (entry.snapshot.status === "exited") {
      entry.snapshot.status = "stopped";
    }

    entry.snapshot.stopped_at =
      entry.snapshot.stopped_at ?? new Date().toISOString();
  }

  return toJsonRecord(entry.snapshot);
};

export const stopManagedProcessesForWorkspace = async (
  workspaceDir: string,
): Promise<JsonRecord[]> => {
  const entries = [...managedProcesses.values()].filter(
    (entry) =>
      entry.snapshot.workspace_dir === workspaceDir &&
      entry.snapshot.status === "running",
  );
  const stopped: JsonRecord[] = [];

  for (const entry of entries) {
    const snapshot = await stopManagedProcess(workspaceDir, entry.snapshot.id);
    if (snapshot) stopped.push(snapshot);
  }

  return stopped;
};

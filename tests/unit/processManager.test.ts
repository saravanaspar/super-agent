import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listManagedProcesses,
  startManagedProcess,
  stopManagedProcess,
  stopManagedProcessesForWorkspace,
} from "@tools/general/processManager";

const workspaces: string[] = [];

const createWorkspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "super-agent-process-test-"));
  workspaces.push(dir);
  return dir;
};

afterEach(async () => {
  for (const workspace of workspaces) {
    await stopManagedProcessesForWorkspace(workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("managed shell process lifecycle", () => {
  it("lists and stops a managed process", async () => {
    const workspaceDir = createWorkspace();
    const started = startManagedProcess({
      command: "node long-running-test",
      cwd: workspaceDir,
      workspaceDir,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: process.env,
    });

    expect(started.status).toBe("running");
    expect(listManagedProcesses(workspaceDir, false)).toHaveLength(1);

    const stopped = await stopManagedProcess(workspaceDir, started.id);

    expect(stopped?.status).toBe("stopped");
    expect(listManagedProcesses(workspaceDir, false)).toHaveLength(0);
    expect(listManagedProcesses(workspaceDir, true)).toHaveLength(1);
  });

  it("cleans up every running process in a workspace", async () => {
    const workspaceDir = createWorkspace();
    startManagedProcess({
      command: "node cleanup-test-a",
      cwd: workspaceDir,
      workspaceDir,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: process.env,
    });
    startManagedProcess({
      command: "node cleanup-test-b",
      cwd: workspaceDir,
      workspaceDir,
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: process.env,
    });

    expect(listManagedProcesses(workspaceDir, false)).toHaveLength(2);

    const stopped = await stopManagedProcessesForWorkspace(workspaceDir);

    expect(stopped).toHaveLength(2);
    expect(listManagedProcesses(workspaceDir, false)).toHaveLength(0);
  });
});

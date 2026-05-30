import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGoalRuntimeState,
  updateGoalStateFromToolResult,
  verifyGoalAcceptance
} from "../../src/commands/goalRuntime";
import type { AgentCommandInvocation, ToolResultRecord } from "@shared/types";

const goalCommand = (goal: string): AgentCommandInvocation => ({
  name: "goal",
  raw: `/goal ${goal}`,
  input: goal,
  goal
});

const toolResult = (
  overrides: Partial<ToolResultRecord> & Pick<ToolResultRecord, "toolName">
): ToolResultRecord => ({
  toolCallId: "tool-call",
  toolName: overrides.toolName,
  ok: overrides.ok ?? true,
  risk: overrides.risk ?? "safe",
  blocked: overrides.blocked ?? false,
  message: overrides.message ?? "ok",
  data: overrides.data ?? null
});

const situationScanResult = (): ToolResultRecord =>
  toolResult({
    toolName: "situation_scan",
    data: {
      verificationPlan: {
        commands: [{ command: "npm run typecheck" }]
      }
    },
    message: "situation scanned"
  });

describe("goal runtime evidence", () => {
  it("requires successful verification evidence for code goals", () => {
    const state = buildGoalRuntimeState(goalCommand("fix the React app"));
    expect(state).not.toBeNull();
    if (!state) return;

    expect(verifyGoalAcceptance(state, process.cwd())?.summary).toContain("incomplete");

    updateGoalStateFromToolResult(state, situationScanResult());

    updateGoalStateFromToolResult(
      state,
      toolResult({
        toolName: "write_file",
        data: { path: "src/App.tsx" },
        message: "file updated"
      })
    );

    expect(verifyGoalAcceptance(state, process.cwd())?.complete).toBe(false);

    updateGoalStateFromToolResult(
      state,
      toolResult({
        toolName: "bash",
        data: { command: "npm run typecheck", exit_code: 0 },
        message: "typecheck passed"
      })
    );

    const verification = verifyGoalAcceptance(state, process.cwd());
    expect(verification?.complete).toBe(true);
    expect(verification?.summary).toContain("Goal acceptance passed");
  });

  it("does not accept a failing verification command", () => {
    const state = buildGoalRuntimeState(goalCommand("fix the TypeScript bug"));
    expect(state).not.toBeNull();
    if (!state) return;

    updateGoalStateFromToolResult(state, situationScanResult());

    updateGoalStateFromToolResult(
      state,
      toolResult({
        toolName: "bash",
        ok: true,
        data: { command: "npm run typecheck", exit_code: 1 },
        message: "tests failed"
      })
    );

    expect(verifyGoalAcceptance(state, process.cwd())?.complete).toBe(false);
  });


  it("does not accept unrelated echo output as planned verification", () => {
    const state = buildGoalRuntimeState(goalCommand("fix the React app"));
    expect(state).not.toBeNull();
    if (!state) return;

    updateGoalStateFromToolResult(state, situationScanResult());
    updateGoalStateFromToolResult(
      state,
      toolResult({
        toolName: "write_file",
        data: { path: "src/App.tsx" },
        message: "file updated"
      })
    );
    updateGoalStateFromToolResult(
      state,
      toolResult({
        toolName: "bash",
        data: { command: "echo npm run typecheck", exit_code: 0 },
        message: "printed command"
      })
    );

    expect(verifyGoalAcceptance(state, process.cwd())?.complete).toBe(false);
  });

  it("detects exact test-count goals", () => {
    const state = buildGoalRuntimeState(goalCommand("write exactly 5 tests"));
    expect(state?.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "exact_count", subject: "test", expected: 5 })
      ])
    );
  });

  it("does not auto-select ignored dependency files as text targets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "goal-ignore-"));
    const ignoredDir = join(workspace, "node_modules", "pkg");
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(join(ignoredDir, "essay.txt"), "one two three four five six", "utf8");

    const state = buildGoalRuntimeState(goalCommand("write at least 5 words"));
    expect(state).not.toBeNull();
    if (!state) return;

    const verification = verifyGoalAcceptance(state, workspace);
    expect(verification?.complete).toBe(false);
    expect(verification?.criteria[0]?.reason).toContain("could not be resolved");
  });

});

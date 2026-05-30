import { describe, expect, it } from "vitest";
import {
  ConsecutiveToolCallGuard,
  PostEditVerificationTracker,
  RepeatedReadToolGuard,
  getGatedFinalAnswerRepair,
  toolInputLooksMalformed
} from "@agent/agentGraph";
import type { JsonRecord, JsonValue } from "@shared/json";
import type { ToolCallRecord, ToolResultRecord, ToolRisk } from "@shared/types";

const toolCall = (name: string, input: JsonRecord): ToolCallRecord => ({
  id: `${name}-${Math.random()}`,
  name,
  input,
  risk: "safe"
});

const toolResult = (
  toolName: string,
  ok: boolean,
  blocked: boolean,
  data: JsonValue,
  risk: ToolRisk = "safe"
): ToolResultRecord => ({
  toolCallId: `${toolName}-result`,
  toolName,
  ok,
  risk,
  blocked,
  message: ok ? "ok" : "blocked",
  data
});

describe("RepeatedReadToolGuard", () => {
  it("soft-skips covered reads without tripping a read-spree hard stop", () => {
    const guard = new RepeatedReadToolGuard();

    guard.recordResult(toolResult("read_file", true, false, {
      path: "server.js",
      offset: 1,
      total_lines: 100,
      returned_lines: 100
    }));

    const first = guard.check(toolCall("read_file", { path: "server.js", offset: 20, limit: 10 }));
    expect(first.allowed).toBe(false);
    expect(first.kind).toBe("covered_read");
    expect(first.reason).toContain("skipped");
    expect(guard.shouldStopReadSpree()).toBe(false);

    const second = guard.check(toolCall("read_file", { path: "server.js", offset: 40, limit: 10 }));
    expect(second.allowed).toBe(false);
    expect(second.kind).toBe("covered_read");
    expect(second.reason).toContain("skipped");
    expect(guard.shouldStopReadSpree()).toBe(false);
  });

  it("clears read coverage and warning state after a successful mutation", () => {
    const guard = new RepeatedReadToolGuard();

    guard.recordResult(toolResult("read_file", true, false, {
      path: "server.js",
      offset: 1,
      total_lines: 10,
      returned_lines: 10
    }));

    guard.check(toolCall("read_file", { path: "server.js", offset: 1, limit: 5 }));
    guard.check(toolCall("read_file", { path: "server.js", offset: 6, limit: 5 }));
    expect(guard.shouldStopReadSpree()).toBe(false);

    guard.recordResult(toolResult("edit_file", true, false, { path: "server.js" }));

    expect(guard.shouldStopReadSpree()).toBe(false);
    expect(guard.check(toolCall("read_file", { path: "server.js", offset: 1, limit: 5 })).allowed).toBe(true);
  });
});


describe("tool input malformed guard", () => {
  it("allows large source-code replacement payloads", () => {
    const replacement = [
      "const express = require('express');",
      "const app = express();",
      "function spawnWorld() {",
      "  return Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }));",
      "}"
    ].join("\n").repeat(300);

    expect(toolInputLooksMalformed({ path: "server.js", replacement })).toBe(false);
    expect(toolInputLooksMalformed({ path: "server.js", content: replacement })).toBe(false);
  });

  it("allows raw-looking tool markup inside source-code payload fields", () => {
    const content = [
      "const template = `<tool_call>{\"name\":\"noop\"}</tool_call>`;",
      "module.exports = template;"
    ].join("\n");

    expect(toolInputLooksMalformed({ path: "server.js", content })).toBe(false);
    expect(toolInputLooksMalformed({ path: "server.js", replacement: content })).toBe(false);
  });

  it("still rejects raw assistant tool markup in control fields", () => {
    expect(toolInputLooksMalformed({ path: "server.js", note: "<tool_call>{}</tool_call>" })).toBe(true);
  });
});

describe("ConsecutiveToolCallGuard", () => {
  it("allows repeated calls by default and appends guidance after repeated failures", () => {
    const guard = new ConsecutiveToolCallGuard(2);
    const call = toolCall("edit_range", {
      path: "server.js",
      start_line: 1,
      end_line: 1,
      replacement: "const x = 1;"
    });

    expect(guard.check(call).allowed).toBe(true);
    expect(guard.check(call).allowed).toBe(true);
    expect(guard.check(call).allowed).toBe(true);

    const failed = toolResult("edit_range", false, true, { path: "server.js" });
    expect(guard.recordResult(call, failed).message).not.toContain("Repeated failure guidance");
    expect(guard.recordResult(call, failed).message).not.toContain("Repeated failure guidance");

    const guided = guard.recordResult(call, failed);
    expect(guided.message).toContain("Repeated failure guidance");
    expect(guided.data).toMatchObject({
      tool_loop_guidance: {
        kind: "exact_repeated_failure",
        count: 3
      }
    });
  });

  it("appends guidance then soft-skips repeated idempotent no-progress calls", () => {
    const guard = new ConsecutiveToolCallGuard(2);
    const call = toolCall("grep", { pattern: "UNIT_COST", path: "server.js" });
    const result = toolResult("grep", true, false, {
      pattern: "UNIT_COST",
      count: 1,
      matches: [{ path: "server.js", line: 13, text: "const UNIT_COST = {" }]
    });

    expect(guard.check(call).allowed).toBe(true);
    expect(guard.recordResult(call, result).message).not.toContain("No-progress guidance");

    expect(guard.check(call).allowed).toBe(true);
    const guided = guard.recordResult(call, result);
    expect(guided.message).toContain("No-progress guidance");
    expect(guided.data).toMatchObject({
      tool_loop_guidance: {
        kind: "idempotent_no_progress",
        count: 2
      }
    });

    const skipped = guard.check(call);
    expect(skipped.allowed).toBe(false);
    expect(skipped.kind).toBe("idempotent_no_progress");
    expect(skipped.reason).toContain("Repeated no-progress tool call skipped");
  });

  it("tracks idempotent no-progress by exact input and resets after mutation", () => {
    const guard = new ConsecutiveToolCallGuard(2);
    const firstSearch = toolCall("grep", { pattern: "resources", path: "server.js" });
    const secondSearch = toolCall("grep", { pattern: "let resources", path: "server.js" });
    const firstResult = toolResult("grep", true, false, { pattern: "resources", count: 5 });
    const secondResult = toolResult("grep", true, false, { pattern: "let resources", count: 0 });

    guard.recordResult(firstSearch, firstResult);
    guard.recordResult(secondSearch, secondResult);
    guard.recordResult(firstSearch, firstResult);
    guard.recordResult(secondSearch, secondResult);

    expect(guard.check(firstSearch).kind).toBe("idempotent_no_progress");
    expect(guard.check(secondSearch).kind).toBe("idempotent_no_progress");

    guard.recordResult(
      toolCall("edit_range", {
        path: "server.js",
        start_line: 1,
        end_line: 1,
        replacement: "const fixed = true;"
      }),
      toolResult("edit_range", true, false, { path: "server.js" })
    );

    expect(guard.check(firstSearch).allowed).toBe(true);
  });

  it("soft-skips exact repeated failures instead of hard-blocking retries", () => {
    const guard = new ConsecutiveToolCallGuard(2);
    const call = toolCall("edit_range", {
      path: "server.js",
      start_line: 10,
      end_line: 20,
      replacement: "const fixed = true;"
    });
    const failed = toolResult("edit_range", false, false, {
      path: "server.js",
      error: "expected_old does not match selected range."
    });

    expect(guard.check(call).allowed).toBe(true);
    guard.recordResult(call, failed);
    expect(guard.check(call).allowed).toBe(true);
    guard.recordResult(call, failed);

    const skipped = guard.check(call);
    expect(skipped.allowed).toBe(false);
    expect(skipped.kind).toBe("repeated_failure");
    expect(skipped.reason).toContain("previous failure is still valid");
  });
});

describe("review final answer guardrails", () => {
  it("rejects conceptual verification claims when no command actually ran", () => {
    const verifications: Parameters<typeof getGatedFinalAnswerRepair>[0] = [
      {
        kind: "review",
        complete: true,
        summary: "Review evidence is complete.",
        nextAction: "Produce final review findings.",
        progressMessage: "Review evidence is ready.",
        continuationMessage: "Produce final review findings.",
        metadata: { safeCheckRan: false }
      }
    ];

    const repair = getGatedFinalAnswerRepair(
      verifications,
      [
        "Verdict: concerns.",
        "Scope reviewed: package.json and server.js.",
        "Verification commands considered/run: npm start was executed conceptually.",
        "Findings: server.js has bugs."
      ].join("\n")
    );

    expect(repair?.reason).toContain("no tool result proved");
    expect(repair?.continuationMessage).toContain("not run/skipped");
  });

  it("rejects passed claims when review verification failed", () => {
    const verifications: Parameters<typeof getGatedFinalAnswerRepair>[0] = [
      {
        kind: "review",
        complete: true,
        summary: "Review evidence is complete.",
        nextAction: "Produce final review findings.",
        progressMessage: "Review evidence is ready.",
        continuationMessage: "Produce final review findings.",
        metadata: {
          safeCheckRan: true,
          safeCheckFailed: true,
          successfulVerificationCommands: []
        }
      }
    ];

    const repair = getGatedFinalAnswerRepair(
      verifications,
      [
        "Verdict: concerns.",
        "Scope reviewed: package.json and server.js.",
        "Verification: npm run lint passed successfully.",
        "Findings: server.js has bugs."
      ].join("\n")
    );

    expect(repair?.reason).toContain("no tool result proved");
  });

  it("requires undefined-symbol findings discovered by review search evidence", () => {
    const verifications: Parameters<typeof getGatedFinalAnswerRepair>[0] = [
      {
        kind: "review",
        complete: true,
        summary: "Review evidence is complete.",
        nextAction: "Produce final review findings.",
        progressMessage: "Review evidence is ready.",
        continuationMessage: "Produce final review findings.",
        metadata: {
          undefinedSymbolRisks: ["missingThing"]
        }
      }
    ];

    const repair = getGatedFinalAnswerRepair(
      verifications,
      [
        "Verdict: concerns.",
        "Scope reviewed: server.js.",
        "Verification: not run.",
        "Findings: missing validation.",
        "Concrete fixes: add validation."
      ].join("\n")
    );

    expect(repair?.reason).toContain("undefined-symbol");
    expect(repair?.continuationMessage).toContain("missingThing");
  });
});

describe("post-edit verification tracker", () => {
  it("requires inspecting changed code before final success claims", () => {
    const tracker = new PostEditVerificationTracker();
    const edit = toolCall("edit_range", {
      path: "server.js",
      start_line: 1,
      end_line: 5,
      replacement: "const fixed = true;"
    });

    tracker.record(edit, toolResult("edit_range", true, false, { path: "server.js" }));

    const repair = tracker.getFinalAnswerRepair("Fixed server.js and it starts now.");
    expect(repair?.reason).toContain("not inspected");
    expect(repair?.continuationMessage).toContain("read_file");
  });

  it("requires verification after inspecting changed code", () => {
    const tracker = new PostEditVerificationTracker();
    const edit = toolCall("edit_range", {
      path: "server.js",
      start_line: 1,
      end_line: 5,
      replacement: "const fixed = true;"
    });

    tracker.record(edit, toolResult("edit_range", true, false, { path: "server.js" }));
    tracker.record(
      toolCall("read_file", { path: "server.js", offset: 1, limit: 20 }),
      toolResult("read_file", true, false, {
        path: "server.js",
        offset: 1,
        total_lines: 20,
        returned_lines: 20
      })
    );

    const repair = tracker.getFinalAnswerRepair("Fixed server.js.");
    expect(repair?.reason).toContain("not verified");
    expect(repair?.continuationMessage).toContain("node --check server.js");
  });

  it("allows final reports after post-edit inspection and verification", () => {
    const tracker = new PostEditVerificationTracker();
    const edit = toolCall("edit_range", {
      path: "server.js",
      start_line: 1,
      end_line: 5,
      replacement: "const fixed = true;"
    });

    tracker.record(edit, toolResult("edit_range", true, false, { path: "server.js" }));
    tracker.record(
      toolCall("read_file", { path: "server.js", offset: 1, limit: 20 }),
      toolResult("read_file", true, false, {
        path: "server.js",
        offset: 1,
        total_lines: 20,
        returned_lines: 20
      })
    );
    tracker.record(
      toolCall("bash", { command: "node --check server.js" }),
      toolResult("bash", true, false, {
        command: "node --check server.js",
        stdout: "",
        stderr: "",
        exit_code: 0
      })
    );

    expect(tracker.getFinalAnswerRepair("Fixed server.js; node --check passed.")).toBeNull();
  });

  it("rejects success claims after failed post-edit verification", () => {
    const tracker = new PostEditVerificationTracker();
    const edit = toolCall("edit_range", {
      path: "server.js",
      start_line: 1,
      end_line: 5,
      replacement: "const fixed = true;"
    });

    tracker.record(edit, toolResult("edit_range", true, false, { path: "server.js" }));
    tracker.record(
      toolCall("read_file", { path: "server.js", offset: 1, limit: 20 }),
      toolResult("read_file", true, false, {
        path: "server.js",
        offset: 1,
        total_lines: 20,
        returned_lines: 20
      })
    );
    tracker.record(
      toolCall("bash", { command: "node --check server.js" }),
      toolResult("bash", true, false, {
        command: "node --check server.js",
        stdout: "",
        stderr: "SyntaxError: Unexpected token",
        exit_code: 1
      })
    );

    const repair = tracker.getFinalAnswerRepair("Fixed server.js.");
    expect(repair?.reason).toContain("without successful verification");
    expect(tracker.getFinalAnswerRepair("Updated server.js; node --check failed with exit code 1.")).toBeNull();
  });
});

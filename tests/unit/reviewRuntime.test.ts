import { describe, expect, it } from "vitest";
import {
  buildReviewRuntimeState,
  updateReviewStateFromToolResult,
  verifyReviewProgress
} from "../../src/commands/reviewRuntime";
import type { ToolResultRecord } from "@shared/types";

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

const reviewCommand = (input = ""): NonNullable<Parameters<typeof buildReviewRuntimeState>[0]> => ({
  name: "review",
  raw: `/review ${input}`.trim(),
  input,
  goal: input || "review",
  reviewTarget: input
});

describe("review runtime blocked reads", () => {
  it("treats a denied continuation read as terminal evidence instead of looping forever", () => {
    const state = buildReviewRuntimeState(reviewCommand("README.md"), "/review README.md");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "ls",
        data: { entries: [{ name: "README.md", type: "file" }] }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/workspace/README.md",
          offset: 1,
          returned_lines: 80,
          total_lines: 86
        }
      })
    );

    expect(verifyReviewProgress(state)?.complete).toBe(false);

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        ok: false,
        blocked: true,
        message: "Tool approval was denied or timed out.",
        data: { path: "/workspace/README.md", offset: 81 }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.summary).toContain("blocked");
    expect(verification?.nextAction).toContain("Do not retry");
  });
});

describe("review runtime activation", () => {
  it("does not activate from an implicit review-like prompt", () => {
    expect(buildReviewRuntimeState(null, "review this code for bugs")).toBeNull();
  });
});

describe("review runtime source coverage", () => {
  it("tracks full relative paths and skips generated dependency folders", () => {
    const state = buildReviewRuntimeState(
      {
        name: "review",
        raw: "/review src",
        input: "src",
        goal: "src",
        reviewTarget: "src"
      },
      "src"
    );
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: {
          files: [
            { path: "src/index.ts" },
            { path: "src/pages/index.ts" },
            { path: "node_modules/pkg/index.ts" },
            { path: ".next/server/app.js" }
          ]
        }
      })
    );

    expect(state.files).toEqual(["src/index.ts", "src/pages/index.ts"]);

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/repo/src/index.ts",
          offset: 1,
          returned_lines: 2,
          total_lines: 2
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/repo/src/pages/index.ts",
          offset: 1,
          returned_lines: 3,
          total_lines: 3
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.summary).toContain("2 source files");
  });

  it("does not treat unknown total line reads as complete", () => {
    const state = buildReviewRuntimeState(reviewCommand("TypeScript project"), "/review TypeScript project");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: { files: [{ path: "src/main.ts" }] }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/workspace/src/main.ts",
          offset: 1,
          returned_lines: 80
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(false);
    expect(verification?.nextAction).toContain("Continue reading");
  });

  it("does not satisfy source coverage by suffix collision", () => {
    const state = buildReviewRuntimeState(reviewCommand("monorepo"), "/review monorepo");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: {
          files: [
            { path: "src/index.ts" },
            { path: "packages/app/src/index.ts" }
          ]
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/repo/packages/app/src/index.ts",
          offset: 1,
          returned_lines: 2,
          total_lines: 2
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(false);
    expect(verification?.nextAction).toContain("src/index.ts");
  });
});
  it("allows final review after an unavailable npm verification command and records the limitation", () => {
    const state = buildReviewRuntimeState(
      {
        name: "review",
        raw: "/review",
        input: "",
        goal: "review"
      },
      "/review"
    );
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: { files: [{ path: "package.json" }] }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/workspace/package.json",
          offset: 1,
          returned_lines: 18,
          total_lines: 18
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "bash",
        data: {
          command: "npm run lint",
          exit_code: 127,
          stderr: "/bin/sh: 1: npm: not found"
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.safeCheckFailed).toBe(true);
    expect(verification?.safeCheckIssue).toContain("npm is not installed");
    expect(verification?.nextAction).toContain("verification limitation");
  });


  it("does not let an unrelated blocked shell command skip inferred verification", () => {
    const state = buildReviewRuntimeState(reviewCommand(), "/review");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: { files: [{ path: "package.json" }] }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/workspace/package.json",
          offset: 1,
          returned_lines: 8,
          total_lines: 8,
          content: JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } })
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "bash",
        ok: false,
        blocked: true,
        message: "Blocked because sudo commands are not allowed.",
        data: { command: "sudo true" }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(false);
    expect(verification?.safeCheckBlocked).toBe(false);
    expect(verification?.nextAction).toContain("npm run typecheck");
  });

describe("review runtime harness controller", () => {
  it("finishes with a clear limitation when a scanned workspace has no reviewable files", () => {
    const state = buildReviewRuntimeState(reviewCommand(), "/review");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "ls",
        data: {
          relative: ".",
          entries: [
            { name: "artifacts", type: "dir" },
            { name: "essay.txt", type: "file" }
          ]
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.summary).toContain("No reviewable");
    expect(verification?.nextAction).toContain("select the intended project");
    expect(verification?.unscannedDirectories).toEqual([]);
  });

  it("requires scanning discovered directories before final review", () => {
    const state = buildReviewRuntimeState(
      {
        name: "review",
        raw: "/review",
        input: "",
        goal: "review"
      },
      "/review"
    );
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "ls",
        data: {
          relative: ".",
          entries: [
            { name: "server.js", type: "file" },
            { name: "public", type: "dir" },
            { name: "node_modules", type: "dir" }
          ]
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: { path: "/repo/server.js", offset: 1, returned_lines: 10, total_lines: 10 }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(false);
    expect(verification?.unscannedDirectories).toEqual(["public"]);
    expect(verification?.nextAction).toContain("public");
  });

  it("uses situation_scan evidence and does not invent npm commands", () => {
    const state = buildReviewRuntimeState(
      {
        name: "review",
        raw: "/review",
        input: "",
        goal: "review"
      },
      "/review"
    );
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "situation_scan",
        data: {
          sourceFiles: ["server.js"],
          configFiles: ["package.json"],
          testFiles: [],
          docFiles: [],
          packageManagers: ["npm"],
          packageScripts: {
            test: "echo \"Error: no test specified\" && exit 1",
            start: "node server.js"
          },
          verificationPlan: {
            languages: ["javascript"],
            packageManagers: ["npm"],
            commands: [],
            skipped: [{ id: "js-test", reason: "No real test script was defined." }],
            notes: ["No deterministic verification command was inferred."]
          }
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: { path: "/repo/server.js", offset: 1, returned_lines: 10, total_lines: 10 }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: { path: "/repo/package.json", offset: 1, returned_lines: 18, total_lines: 18 }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.verificationPlan.commands).toEqual([]);
    expect(verification?.nextAction).toContain("no deterministic verification command");
    expect(verification?.nextAction).toContain("executed conceptually");
    expect(verification?.nextAction).toContain("undefined-symbol");
  });

  it("records used symbols with zero declaration-search matches as required findings", () => {
    const state = buildReviewRuntimeState(reviewCommand("server.js"), "/review server.js");
    expect(state).not.toBeNull();
    if (!state) return;

    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "project_index",
        data: { files: [{ path: "server.js" }] }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "read_file",
        data: {
          path: "/workspace/server.js",
          offset: 1,
          returned_lines: 40,
          total_lines: 40
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "grep",
        data: {
          pattern: "missingThing",
          count: 1,
          matches: [{ path: "server.js", line: 12, text: "missingThing();" }]
        }
      })
    );
    updateReviewStateFromToolResult(
      state,
      toolResult({
        toolName: "grep",
        data: {
          pattern: "const missingThing",
          count: 0,
          matches: []
        }
      })
    );

    const verification = verifyReviewProgress(state);
    expect(verification?.complete).toBe(true);
    expect(verification?.undefinedSymbolRisks).toEqual(["missingThing"]);
    expect(verification?.nextAction).toContain("missingThing");
  });
});

it("records blocked shell commands as not-run limitations without marking them successful", () => {
  const state = buildReviewRuntimeState(reviewCommand("BugWar"), "/review BugWar");
  expect(state).not.toBeNull();
  if (!state) return;

  updateReviewStateFromToolResult(
    state,
    toolResult({
      toolName: "situation_scan",
      data: {
        sourceFiles: ["server.js"],
        configFiles: ["package.json"],
        testFiles: [],
        docFiles: [],
        packageManagers: ["npm"],
        packageScripts: {
          test: "echo \"Error: no test specified\" && exit 1",
          start: "node server.js"
        },
        verificationPlan: {
          languages: ["javascript"],
          packageManagers: ["npm"],
          commands: [],
          skipped: [{ id: "js-test", reason: "No real test script was defined." }],
          notes: ["No deterministic verification command was inferred."]
        }
      }
    })
  );
  updateReviewStateFromToolResult(
    state,
    toolResult({
      toolName: "read_file",
      data: { path: "/repo/server.js", offset: 1, returned_lines: 10, total_lines: 10 }
    })
  );
  updateReviewStateFromToolResult(
    state,
    toolResult({
      toolName: "read_file",
      data: { path: "/repo/package.json", offset: 1, returned_lines: 18, total_lines: 18 }
    })
  );
  updateReviewStateFromToolResult(
    state,
    toolResult({
      toolName: "bash",
      ok: false,
      blocked: true,
      message: "process kill commands are blocked in sandbox mode",
      data: { command: "node server.js & sleep 2; pkill -f \"node server.js\"" }
    })
  );

  const verification = verifyReviewProgress(state);
  expect(verification?.complete).toBe(true);
  expect(verification?.safeCheckRan).toBe(false);
  expect(verification?.blockedShellIssues[0]).toContain("did not run");
  expect(verification?.nextAction).toContain("do not claim blocked commands ran");
});

import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "@providers/context/historyCompactor";
import type { ToolResultRecord } from "@shared/types";

const toolResult = (overrides: Partial<ToolResultRecord>): ToolResultRecord => ({
  toolCallId: "tool-1",
  toolName: "grep",
  ok: true,
  risk: "safe",
  blocked: false,
  message: "Grep completed.",
  data: { count: 0, matches: [] },
  ...overrides
});

describe("history compactor", () => {
  it("preserves loop-guidance metadata in compact tool summaries", () => {
    const summary = summarizeToolResult(
      toolResult({
        data: {
          count: 0,
          matches: [],
          tool_loop_guidance: {
            kind: "idempotent_no_progress",
            count: 2,
            allowed_next_actions: ["final"]
          }
        }
      })
    );

    expect(summary).toContain("grep");
    expect(summary).toContain("tool_loop_guidance");
    expect(summary).toContain("idempotent_no_progress");
  });
});

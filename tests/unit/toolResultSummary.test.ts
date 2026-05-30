import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "../../src/providers/context/historyCompactor";
import type { ToolResultRecord } from "@shared/types";

const toolResult = (
  overrides: Partial<ToolResultRecord> & Pick<ToolResultRecord, "toolName">
): ToolResultRecord => ({
  toolCallId: "tool-call",
  toolName: overrides.toolName,
  ok: overrides.ok ?? true,
  risk: overrides.risk ?? "safe",
  blocked: overrides.blocked ?? false,
  message: overrides.message ?? "File read completed.",
  data: overrides.data ?? null
});

describe("tool result summaries", () => {
  it("keeps read_file content visible to the model instead of replacing it with a short object preview", () => {
    const content = `${"a".repeat(1200)}\nTAIL_MARKER`;
    const summary = summarizeToolResult(
      toolResult({
        toolName: "read_file",
        data: {
          path: "/repo/server.js",
          offset: 1,
          returned_lines: 2,
          total_lines: 2,
          content
        }
      })
    );

    expect(summary).toContain("Path: /repo/server.js");
    expect(summary).toContain("Lines: 1-2 of 2");
    expect(summary).toContain("TAIL_MARKER");
  });
});

import { resolve } from "node:path";
import { z } from "zod";
import type { JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import { scanSituation, scanToJson } from "./situationScanner";
import { validatePath } from "../tools/general/pathSafety";

const situationScanInput = z.object({
  path: z.string().optional(),
  max_files: z.number().int().positive().optional(),
  max_depth: z.number().int().positive().optional(),
  deadline_ms: z.number().int().positive().optional()
});

type SituationScanInput = z.infer<typeof situationScanInput>;

const parameters = (properties: JsonRecord, required: string[] = []): JsonRecord => ({ type: "object", properties, required });

const situationScanTool: ToolDefinition<SituationScanInput> = {
  name: "situation_scan",
  description: [
    "Mandatory first tool for /review, /goal, and coding tasks.",
    "Scans the selected workspace across common language stacks, classifies source/config/test/doc files, skips generated junk, detects package managers/languages, and returns a verification plan inferred from actual repo files/scripts."
  ].join(" "),
  category: "general",
  risk: "safe",
  inputSchema: situationScanInput,
  parameters: parameters({
    path: { type: "string", default: "." },
    max_files: { type: "number" },
    max_depth: { type: "number" },
    deadline_ms: { type: "number" }
  }),
  execute(input, context) {
    try {
      const root = input.path
        ? validatePath(context.workspaceDir, input.path, { allowOutsideWorkspace: context.agentSettings?.allowOutsideWorkspaceAccess === true })
        : resolve(context.workspaceDir);
      const snapshot = scanSituation({
        root,
        ...(input.max_files ? { maxFiles: input.max_files } : {}),
        ...(input.max_depth ? { maxDepth: input.max_depth } : {}),
        ...(input.deadline_ms ? { deadlineMs: input.deadline_ms } : {})
      });
      return Promise.resolve(successResult("Situation scanned.", scanToJson(snapshot)));
    } catch (error) {
      return Promise.resolve(failureResult(error instanceof Error ? error.message : "Situation scan failed."));
    }
  }
};

export const harnessTools: ToolDefinition[] = [situationScanTool];

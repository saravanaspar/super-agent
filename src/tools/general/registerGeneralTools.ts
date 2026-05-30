import type { ToolDefinition } from "@tool-registry/types";
import { browserTools } from "./browser/browserTools";
import { workspaceTools } from "./workspace/workspaceTools";
import { workspaceInfoTools } from "./workspaceInfoTools";
import { fileTools } from "./fileTools";
import { searchTools } from "./searchTools";
import { shellTools } from "./shellTools";
import { webTools } from "./webTools";
import { contextTools } from "./contextTools";
import { profileTools } from "./profileTools";
import { harnessTools } from "../../harness/harnessTools";
import { skillTools } from "./skillTools";
import { mcpTools } from "./mcpTools";

export const registerGeneralTools = (): ToolDefinition[] => [
  ...workspaceInfoTools,
  ...contextTools,
  ...profileTools,
  ...fileTools,
  ...searchTools,
  ...shellTools,
  ...webTools,
  ...browserTools,
  ...workspaceTools,
  ...harnessTools,
  ...skillTools,
  ...mcpTools
];
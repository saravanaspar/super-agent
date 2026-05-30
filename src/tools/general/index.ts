import type { ToolDefinition } from "@tool-registry/types";
import { registerGeneralTools } from "./registerGeneralTools";

export const generalTools: ToolDefinition[] = registerGeneralTools();

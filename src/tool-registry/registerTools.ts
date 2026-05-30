import { generalTools } from "@tools/general";
import { linuxTools } from "@tools/linux/linuxTools";
import { macosTools } from "@tools/macos/macosTools";
import { windowsTools } from "@tools/windows/windowsTools";
import type { ToolRegistry } from "./toolRegistry";
import type { ToolDefinition } from "./types";

const currentPlatformTools = (): ToolDefinition[] => {
  if (process.platform === "linux") {
    return linuxTools;
  }

  if (process.platform === "darwin") {
    return macosTools;
  }

  if (process.platform === "win32") {
    return windowsTools;
  }

  return [];
};

export const registerAvailableTools = (registry: ToolRegistry): void => {
  for (const tool of [...generalTools, ...currentPlatformTools()]) {
    registry.register(tool);
  }
};
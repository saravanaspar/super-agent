import { z } from "zod";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";

const navigateInput = z.object({ url: z.string().min(1) });
const clickInput = z.object({ selector: z.string().min(1) });
const typeInput = z.object({ selector: z.string().min(1), text: z.string() });
const snapshotInput = z.object({ includeScreenshot: z.boolean().optional() });

type NavigateInput = z.infer<typeof navigateInput>;
type ClickInput = z.infer<typeof clickInput>;
type TypeInput = z.infer<typeof typeInput>;
type SnapshotInput = z.infer<typeof snapshotInput>;


const navigateTool: ToolDefinition<NavigateInput> = {
  name: "browser.navigate",
  description: "Navigate the workspace browser to a URL.",
  category: "general",
  risk: "high",
  inputSchema: navigateInput,
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  execute: async (input, context) => {
    try {
      const snapshot = await context.browserWorkspace.navigate(input.url);
      return successResult("Browser navigated.", { ...snapshot });
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : "Browser navigation failed.");
    }
  }
};

const clickTool: ToolDefinition<ClickInput> = {
  name: "browser.click",
  description: "Click a CSS selector in the workspace browser.",
  category: "general",
  risk: "medium",
  inputSchema: clickInput,
  parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
  execute: async (input, context) => {
    try {
      const snapshot = await context.browserWorkspace.click(input.selector);
      return successResult("Browser click completed.", { ...snapshot });
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : "Browser click failed.");
    }
  }
};

const typeTool: ToolDefinition<TypeInput> = {
  name: "browser.type",
  description: "Fill a CSS selector in the workspace browser.",
  category: "general",
  risk: "medium",
  inputSchema: typeInput,
  parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] },
  execute: async (input, context) => {
    try {
      const snapshot = await context.browserWorkspace.type(input.selector, input.text);
      return successResult("Browser text entry completed.", { ...snapshot });
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : "Browser text entry failed.");
    }
  }
};

const snapshotTool: ToolDefinition<SnapshotInput> = {
  name: "browser.snapshot",
  description: "Return a page snapshot and optional screenshot from the workspace browser.",
  category: "general",
  risk: "safe",
  inputSchema: snapshotInput,
  parameters: { type: "object", properties: { includeScreenshot: { type: "boolean" } } },
  execute: async (input, context) => {
    try {
      const snapshot = await context.browserWorkspace.snapshot(input.includeScreenshot ?? false);
      return successResult("Browser snapshot captured.", { ...snapshot });
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : "Browser snapshot failed.");
    }
  }
};

export const browserTools: ToolDefinition[] = [navigateTool, clickTool, typeTool, snapshotTool];

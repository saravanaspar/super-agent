import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type { ToolDefinition } from "@tool-registry/types";
import { successResult } from "@tool-registry/types";


const updateProfileConfigInput = z.object({
  user_display_name: z.string().optional(),
  assistant_display_name: z.string().optional(),
  custom_instructions: z.string().optional(),
  preference: z.string().optional()
});


type UpdateProfileConfigInput = z.infer<typeof updateProfileConfigInput>;

const parameters = (properties: JsonRecord, required: string[] = []): JsonRecord => ({ type: "object", properties, required });

const profilePath = (workspaceDir: string): string => join(workspaceDir, ".super-agent", "profile.json");

const readProfile = (workspaceDir: string): JsonRecord => {
  const filePath = profilePath(workspaceDir);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return toJsonRecord(parsed);
  } catch {
    return {};
  }
};

const writeProfile = (workspaceDir: string, profile: JsonRecord): void => {
  const filePath = profilePath(workspaceDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf8");
};

const updateProfileConfigTool: ToolDefinition<UpdateProfileConfigInput> = {
  name: "update_profile_config",
  description: "Persist assistant/user display names and stable personalization/custom instructions inside the selected workspace.",
  category: "general",
  risk: "medium",
  inputSchema: updateProfileConfigInput,
  parameters: parameters({ user_display_name: { type: "string" }, assistant_display_name: { type: "string" }, custom_instructions: { type: "string" }, preference: { type: "string" } }),
  execute(input, context) {
    const profile = readProfile(context.workspaceDir);
    const next: JsonRecord = { ...profile, updatedAt: new Date().toISOString() };
    if (input.user_display_name) next.user_display_name = input.user_display_name;
    if (input.assistant_display_name) next.assistant_display_name = input.assistant_display_name;
    if (input.custom_instructions) next.custom_instructions = input.custom_instructions;
    if (input.preference) {
      const preferences = Array.isArray(next.preferences) ? next.preferences : [];
      next.preferences = [...preferences, input.preference];
    }
    writeProfile(context.workspaceDir, next);
    return Promise.resolve(successResult("Profile configuration updated.", { path: profilePath(context.workspaceDir), profile: next }));
  }
};


export const profileTools: ToolDefinition[] = [updateProfileConfigTool];

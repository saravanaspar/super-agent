import { z } from "zod";

export const MAX_CHAT_SKILL_FILE_CHARS = 120_000;
export const MAX_CHAT_SKILL_FILES = 40;
export const MAX_SKILL_SCRIPT_ARGS = 50;
export const MAX_SKILL_SCRIPT_ARG_CHARS = 4096;
export const MAX_SKILL_SCRIPT_TIMEOUT_MS = 300_000;
export const SCRIPT_NETWORK_TOKENS = ["fetch", "axios", "curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "rsync", "http.request", "https.request", "http://", "https://"] as const;

export const skillFileInput = z.object({
  path: z.string().min(1).max(240),
  content: z.string().max(MAX_CHAT_SKILL_FILE_CHARS),
  encoding: z.enum(["base64"]).optional(),
});

export const installSkillInput = z
  .object({
    name: z.string().min(1).max(64).optional(),
    description: z.string().min(1).max(1024).optional(),
    instructions: z.string().min(1).max(MAX_CHAT_SKILL_FILE_CHARS).optional(),
    skillMarkdown: z.string().min(1).max(MAX_CHAT_SKILL_FILE_CHARS).optional(),
    files: z.array(skillFileInput).max(MAX_CHAT_SKILL_FILES).optional(),
    referenceUrls: z.array(z.string().min(1).max(2048)).max(20).optional(),
    referenceNotes: z.string().max(16_000).optional(),
    version: z.string().max(80).optional(),
    enabled: z.boolean().optional(),
    autoRouting: z.boolean().optional(),
    installMode: z.enum(["replace", "copy"]).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.skillMarkdown ||
        (value.name && value.description && value.instructions),
      ),
    {
      message:
        "Provide either skillMarkdown or name, description, and instructions.",
    },
  );

export type InstallSkillInput = z.infer<typeof installSkillInput>;

export const runSkillScriptInput = z.object({
  skillId: z.string().min(1).max(128),
  scriptPath: z.string().min(1).max(240),
  args: z
    .array(z.string().max(MAX_SKILL_SCRIPT_ARG_CHARS))
    .max(MAX_SKILL_SCRIPT_ARGS)
    .optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_SKILL_SCRIPT_TIMEOUT_MS).optional(),
});

export type RunSkillScriptInput = z.infer<typeof runSkillScriptInput>;

export const viewSkillFileInput = z.object({
  skillId: z.string().min(1).max(128),
  path: z.string().min(1).max(240).optional(),
});

export const preflightSkillInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const scriptHistoryInput = z.object({
  skillId: z.string().min(1).max(128),
  limit: z.number().int().positive().max(100).optional(),
});

export const auditLogInput = z.object({
  skillId: z.string().min(1).max(128).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const proposalInput = z.object({
  skillId: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(2000),
  source: z.enum(["agent", "user", "tool"]).optional(),
  operation: z.enum(["create", "update", "delete"]).optional(),
  files: z.array(skillFileInput).min(1).max(MAX_CHAT_SKILL_FILES),
});

export const patchOperationInput = z.object({
  op: z.enum(["create", "update", "delete", "rename"]),
  path: z.string().min(1).max(240),
  content: z.string().max(MAX_CHAT_SKILL_FILE_CHARS).optional(),
  toPath: z.string().min(1).max(240).optional(),
});

export const patchProposalInput = z.object({
  skillId: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(2000),
  source: z.enum(["agent", "user", "tool"]).optional(),
  operations: z.array(patchOperationInput).min(1).max(MAX_CHAT_SKILL_FILES),
});

export const proposalActionInput = z.object({
  proposalId: z.string().min(1).max(200),
  acceptedPaths: z.array(z.string().min(1).max(260)).optional(),
});

export const listProposalInput = z.object({
  skillId: z.string().min(1).max(128).optional(),
});

export const snapshotInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const restoreSnapshotInput = z.object({
  snapshotId: z.string().min(1).max(200),
});

export const evalOutputInput = z.object({
  id: z.string().min(1).max(200),
  output: z.string().max(200000),
});

export const runEvalsInput = z.object({
  skillId: z.string().min(1).max(128),
  outputs: z.array(evalOutputInput).max(100).optional(),
  baselineRunId: z.string().min(1).max(200).optional(),
});

export const listEvalRunsInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const lifecycleInput = z.object({
  skillId: z.string().min(1).max(128),
  action: z.enum(["pin", "unpin", "archive", "restore"]),
});

export const githubInstallInput = z.object({
  url: z.string().url().max(2000),
  installMode: z.enum(["replace", "copy"]).optional(),
  skillPath: z.string().min(1).max(500).optional(),
});

export const registrySearchInput = z.object({
  registryUrl: z.string().url().max(2000),
  query: z.string().max(200).optional(),
});

export const registryInstallInput = z.object({
  registryUrl: z.string().url().max(2000),
  entryId: z.string().min(1).max(300),
  installMode: z.enum(["replace", "copy"]).optional(),
});

export const verifySkillInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const adapterInput = z.object({
  layout: z.enum(["claude", "codex", "openclaw", "hermes", "auto"]),
  files: z.array(skillFileInput).min(1).max(MAX_CHAT_SKILL_FILES),
});

export const skillPolicyInput = z.object({
  agentId: z.string().min(1).max(128).optional(),
});

export const skillCompareInput = z.object({
  leftSkillId: z.string().min(1).max(128),
  rightSkillId: z.string().min(1).max(128),
});

export const skillBulkInput = z.object({
  skillIds: z.array(z.string().min(1).max(128)).min(1).max(200),
  action: z.enum(["enable", "disable", "pin", "unpin", "archive", "restore", "verify"]),
});

export const skillCredentialInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const skillSetupPlanInput = z.object({
  skillId: z.string().min(1).max(128),
});

export const skillMarketplaceReadinessInput = z.object({
  skillId: z.string().min(1).max(128),
});

import { z } from "zod";
import { toJsonRecord, type JsonRecord } from "@shared/json";
import type { SkillPatchRequest, SkillProposalCreateRequest, SkillRecord } from "@shared/types";
import type { ToolDefinition } from "@tool-registry/types";
import { failureResult, successResult } from "@tool-registry/types";
import {
  adapterInput,
  auditLogInput,
  githubInstallInput,
  installSkillInput,
  lifecycleInput,
  listEvalRunsInput,
  listProposalInput,
  preflightSkillInput,
  proposalActionInput,
  proposalInput,
  registryInstallInput,
  registrySearchInput,
  restoreSnapshotInput,
  runEvalsInput,
  runSkillScriptInput,
  scriptHistoryInput,
  snapshotInput,
  verifySkillInput,
  viewSkillFileInput,
  patchProposalInput,
  skillBulkInput,
  skillCompareInput,
  skillCredentialInput,
  skillMarketplaceReadinessInput,
  skillPolicyInput,
  skillSetupPlanInput,
} from "./skillToolSchemas";
import {
  availableSkillScripts,
  evalRunToJson,
  installSkill,
  manifestItemToJson,
  parameters,
  proposalToJson,
  runSkillScript,
  scanFindingToJson,
  skillPermissionsToJson,
} from "./skillToolRuntime";

export const skillTools: ToolDefinition[] = [
  {
    name: "skill.install",
    description: [
      "Create or update a local skill directly from chat and install it into the skill library.",
      "Use this instead of telling the user to create SKILL.md files or upload packages.",
      "When the user gives documentation links, fetch or summarize them with available web tools when useful, then include the content as references/*.md or include the URLs in referenceUrls.",
      "Before calling this tool, review the generated package yourself at least twice: first for package structure and allowed frontmatter, then for workflow depth, references, scripts, evals, and likely failure modes.",
      "Do not use this tool as a draft checker. It performs upload-compatibility validation and installs structurally valid skills; content-quality issues are returned as review warnings instead of blocking install.",
      "Provide skillMarkdown for a complete SKILL.md, or provide name, description, and instructions.",
    ].join(" "),
    category: "general",
    risk: "safe",
    inputSchema: installSkillInput,
    parameters: parameters({
      name: {
        type: "string",
        description:
          "Kebab-case skill name. Required unless skillMarkdown is provided.",
      },
      description: {
        type: "string",
        description:
          "Trigger-focused description, maximum 1024 characters. Required unless skillMarkdown is provided.",
      },
      instructions: {
        type: "string",
        description:
          "Markdown instruction body for SKILL.md, without YAML frontmatter. Required unless skillMarkdown is provided.",
      },
      skillMarkdown: {
        type: "string",
        description:
          "Complete SKILL.md content with YAML frontmatter. Optional alternative to name/description/instructions.",
      },
      files: {
        type: "array",
        description:
          "Bundled resource files. Use references/*.md for docs, source summaries, schemas, and domain rules; scripts/* for executable helpers; assets/* for templates/static files. Review the package before install so every bundled file is referenced from SKILL.md with when/how to use it.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      referenceUrls: {
        type: "array",
        description:
          "Documentation/source URLs to save in references/links.md when full content is not bundled.",
        items: { type: "string" },
      },
      referenceNotes: {
        type: "string",
        description:
          "Optional notes or summarized documentation to save beside referenceUrls.",
      },
      version: { type: "string" },
      enabled: {
        type: "boolean",
        description:
          "Whether the skill is enabled after install. Defaults to true.",
      },
      autoRouting: {
        type: "boolean",
        description:
          "Whether the router can auto-select this skill. Defaults to true for chat-created skills.",
      },
      installMode: {
        type: "string",
        enum: ["replace", "copy"],
        description:
          "replace updates a matching local skill; copy installs with a unique copied id.",
      },
    }),
    async execute(input, context) {
      await Promise.resolve();
      try {
        const { saved, quality } = installSkill(input, context);
        return successResult(
          saved.trustLevel === "quarantined"
            ? `Installed skill '${saved.name}' in quarantine.`
            : quality.valid
              ? `Installed skill '${saved.name}'.`
              : `Installed skill '${saved.name}' with review warnings.`,
          {
            id: saved.id,
            name: saved.name,
            description: saved.description,
            enabled: saved.enabled,
            autoRouting: saved.autoRouting,
            fileCount: saved.files.length,
            packageSize: saved.packageSize,
            source: saved.source,
            trustLevel: saved.trustLevel,
            quarantineReason: saved.quarantineReason,
            scanFindings: saved.scanFindings.map(scanFindingToJson),
            dependencyMetadata: {
              requiredBins: saved.dependencyMetadata.requiredBins,
              requiredEnv: saved.dependencyMetadata.requiredEnv,
              requiredFiles: saved.dependencyMetadata.requiredFiles,
              packages: saved.dependencyMetadata.packages.map((item) =>
                item.version
                  ? { manager: item.manager, name: item.name, version: item.version }
                  : { manager: item.manager, name: item.name },
              ),
              platforms: saved.dependencyMetadata.platforms,
              permissions: skillPermissionsToJson(saved),
            },
            qualityReview: {
              passed: quality.valid,
              message: quality.message,
            },
          },
        );
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : "Skill install failed.",
        );
      }
    },
  },
  {
    name: "skill.view",
    description: [
      "Read one installed skill file by skill id and package-relative path.",
      "Use this for progressive disclosure: inspect SKILL.md first, then read only references, templates, assets, or scripts needed for the current task.",
      "The response includes the full resource manifest so callers can choose follow-up files without bulk-loading the package.",
    ].join(" "),
    category: "general",
    risk: "safe",
    inputSchema: viewSkillFileInput,
    parameters: parameters({
      skillId: { type: "string", description: "Installed skill id." },
      path: {
        type: "string",
        description: "Package-relative file path. Defaults to SKILL.md.",
      },
    }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsedInput = viewSkillFileInput.parse(input);
      try {
        if (!context.skills) {
          throw new Error("Skill registry is not available in this runtime.");
        }
        const file = context.skills.readSkillFile(
          parsedInput.skillId,
          parsedInput.path ?? "SKILL.md",
        );
        const manifest = context.skills.getResourceManifest(parsedInput.skillId);
        return successResult(`Loaded skill file '${file.path}'.`, {
          skillId: parsedInput.skillId,
          path: file.path,
          content: file.content,
          manifest: manifest.map(manifestItemToJson),
        });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : "Skill file read failed.",
        );
      }
    },
  },
  {
    name: "skill.preflight",
    description: [
      "Check an installed skill's declared runtime dependencies before running scripts or workflows.",
      "Reports missing CLI binaries, environment variables, credential files declared by the skill, packages, and incompatible platform declarations.",
    ].join(" "),
    category: "general",
    risk: "safe",
    inputSchema: preflightSkillInput,
    parameters: parameters({
      skillId: { type: "string", description: "Installed skill id." },
    }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsedInput = preflightSkillInput.parse(input);
      try {
        if (!context.skills) {
          throw new Error("Skill registry is not available in this runtime.");
        }
        const result = context.skills.preflight(parsedInput.skillId, context.workspaceDir);
        return successResult(
          result.ok
            ? `Skill '${parsedInput.skillId}' preflight passed.`
            : `Skill '${parsedInput.skillId}' preflight has missing requirements.`,
          {
            ok: result.ok,
            missingBins: result.missingBins,
            missingEnv: result.missingEnv,
            missingFiles: result.missingFiles,
            packages: result.packages.map((item) => item.version ? { manager: item.manager, name: item.name, version: item.version } : { manager: item.manager, name: item.name }),
            incompatiblePlatforms: result.incompatiblePlatforms,
            permissions: context.skills.get(parsedInput.skillId) ? skillPermissionsToJson(context.skills.get(parsedInput.skillId) as SkillRecord) : null,
          },
        );
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : "Skill preflight failed.",
        );
      }
    },
  },
  {
    name: "skill.script_history",
    description: "List recent script runs for one installed skill with redacted stdout/stderr, exit status, duration, cwd, args, package hash, and env key summary.",
    category: "general",
    risk: "safe",
    inputSchema: scriptHistoryInput,
    parameters: parameters({
      skillId: { type: "string", description: "Installed skill id." },
      limit: { type: "number", description: "Maximum number of runs to return, capped at 100." },
    }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsedInput = scriptHistoryInput.parse(input);
      try {
        if (!context.skills) {
          throw new Error("Skill registry is not available in this runtime.");
        }
        const runs = context.skills.listScriptRuns(parsedInput.skillId, parsedInput.limit);
        return successResult(`Loaded ${runs.length} script run record(s).`, {
          skillId: parsedInput.skillId,
          runs: runs.map((run): JsonRecord => ({
            id: run.id,
            skillId: run.skillId,
            skillName: run.skillName,
            scriptPath: run.scriptPath,
            args: run.args,
            cwd: run.cwd,
            command: run.command,
            status: run.status,
            exitCode: run.exitCode,
            signal: run.signal,
            timedOut: run.timedOut,
            stdout: run.stdout,
            stderr: run.stderr,
            stdoutTruncated: run.stdoutTruncated,
            stderrTruncated: run.stderrTruncated,
            durationMs: run.durationMs,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            actor: run.actor,
            packageHash: run.packageHash,
            scriptHash: run.scriptHash,
            envKeys: run.envKeys,
          })),
        });
      } catch (error) {
        return failureResult(
          error instanceof Error ? error.message : "Skill script history failed.",
        );
      }
    },
  },


  {
    name: "skill.propose",
    description: "Create a pending skill proposal from a complete file set. Use this instead of direct install when the user has not explicitly asked for immediate installation.",
    category: "general",
    risk: "medium",
    inputSchema: proposalInput,
    parameters: parameters({
      skillId: { type: "string", description: "Optional target skill id." },
      title: { type: "string", description: "Short proposal title." },
      reason: { type: "string", description: "Why this skill change is proposed." },
      source: { type: "string", enum: ["agent", "user", "tool"] },
      operation: { type: "string", enum: ["create", "update", "delete"] },
      files: { type: "array", items: { type: "object" }, description: "Complete proposed skill package files." },
    }, ["title", "reason", "files"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed: SkillProposalCreateRequest = proposalInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const proposal = context.skills.createProposal(parsed);
        return successResult(
          proposal.status === "quarantined" ? "Created quarantined skill proposal." : "Created pending skill proposal.",
          proposalToJson(proposal),
        );
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill proposal failed.");
      }
    },
  },
  {
    name: "skill.patch",
    description: "Create a file-level skill patch proposal with create/update/delete/rename operations. The proposal must be applied by the user or an explicit apply call.",
    category: "general",
    risk: "medium",
    inputSchema: patchProposalInput,
    parameters: parameters({
      skillId: { type: "string", description: "Target skill id." },
      title: { type: "string", description: "Short patch title." },
      reason: { type: "string", description: "Why this patch is needed." },
      source: { type: "string", enum: ["agent", "user", "tool"] },
      operations: { type: "array", items: { type: "object" }, description: "File operations to propose." },
    }, ["skillId", "title", "reason", "operations"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed: SkillPatchRequest = patchProposalInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const proposal = context.skills.createPatchProposal(parsed);
        return successResult(
          proposal.status === "quarantined" ? "Created quarantined skill patch proposal." : "Created pending skill patch proposal.",
          proposalToJson(proposal),
        );
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill patch proposal failed.");
      }
    },
  },
  {
    name: "skill.proposals",
    description: "List pending/applied/rejected/quarantined skill proposals with diffs and structured review results.",
    category: "general",
    risk: "safe",
    inputSchema: listProposalInput,
    parameters: parameters({ skillId: { type: "string", description: "Optional skill id filter." } }),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = listProposalInput.parse(input);
      if (!context.skills) return failureResult("Skill registry is not available in this runtime.");
      const proposals = context.skills.listProposals(parsed.skillId);
      return successResult(`Loaded ${proposals.length} skill proposal(s).`, { proposals: proposals.map(proposalToJson) });
    },
  },
  {
    name: "skill.apply_proposal",
    description: "Apply a pending skill proposal after review. Creates a rollback snapshot before changing an existing skill.",
    category: "general",
    risk: "high",
    inputSchema: proposalActionInput,
    parameters: parameters({
      proposalId: { type: "string", description: "Proposal id to apply." },
      acceptedPaths: { type: "array", description: "Optional list of changed file paths to accept; omitted applies all changes." },
    }, ["proposalId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = proposalActionInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const saved = context.skills.applyProposal(parsed.proposalId, parsed.acceptedPaths);
        return successResult(`Applied proposal for '${saved.name}'.`, { id: saved.id, name: saved.name, packageHash: saved.packageHash ?? null });
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill proposal apply failed.");
      }
    },
  },
  {
    name: "skill.reject_proposal",
    description: "Reject a pending skill proposal without changing skill files.",
    category: "general",
    risk: "safe",
    inputSchema: proposalActionInput,
    parameters: parameters({ proposalId: { type: "string", description: "Proposal id to reject." } }, ["proposalId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = proposalActionInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const proposal = context.skills.rejectProposal(parsed.proposalId);
        return successResult("Rejected skill proposal.", proposalToJson(proposal));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill proposal reject failed.");
      }
    },
  },
  {
    name: "skill.snapshots",
    description: "List rollback snapshots for a skill.",
    category: "general",
    risk: "safe",
    inputSchema: snapshotInput,
    parameters: parameters({ skillId: { type: "string", description: "Skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = snapshotInput.parse(input);
      if (!context.skills) return failureResult("Skill registry is not available in this runtime.");
      const snapshots = context.skills.listSnapshots(parsed.skillId);
      return successResult(`Loaded ${snapshots.length} rollback snapshot(s).`, { snapshots: snapshots.map((snapshot) => ({ id: snapshot.id, skillId: snapshot.skillId, skillName: snapshot.skillName, createdAt: snapshot.createdAt, reason: snapshot.reason, packageHash: snapshot.packageHash, fileCount: snapshot.files.length })) });
    },
  },
  {
    name: "skill.restore_snapshot",
    description: "Restore a skill from a rollback snapshot and create a new rollback snapshot of the current package first.",
    category: "general",
    risk: "high",
    inputSchema: restoreSnapshotInput,
    parameters: parameters({ snapshotId: { type: "string", description: "Snapshot id." } }, ["snapshotId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = restoreSnapshotInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const saved = context.skills.restoreSnapshot(parsed.snapshotId);
        return successResult(`Restored '${saved.name}' from snapshot.`, { id: saved.id, name: saved.name, packageHash: saved.packageHash ?? null });
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill snapshot restore failed.");
      }
    },
  },

  {
    name: "skill.run_evals",
    description: "Run evals/evals.json for an installed skill, optionally grade supplied actual outputs, compare with the previous benchmark run, and persist eval history.",
    category: "general",
    risk: "safe",
    inputSchema: runEvalsInput,
    parameters: parameters({
      skillId: { type: "string", description: "Installed skill id." },
      outputs: { type: "array", description: "Optional actual outputs keyed by eval id to grade model behavior.", items: { type: "object" } },
      baselineRunId: { type: "string", description: "Optional prior eval run id to compare against." },
    }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = runEvalsInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const run = context.skills.runEvals(parsed);
        return successResult(`Skill evals ${run.status}: ${run.score}/100.`, evalRunToJson(run));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill eval run failed.");
      }
    },
  },
  {
    name: "skill.eval_history",
    description: "List persisted eval benchmark runs for one installed skill.",
    category: "general",
    risk: "safe",
    inputSchema: listEvalRunsInput,
    parameters: parameters({ skillId: { type: "string", description: "Installed skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = listEvalRunsInput.parse(input);
      if (!context.skills) return failureResult("Skill registry is not available in this runtime.");
      const runs = context.skills.listEvalRuns(parsed.skillId);
      return successResult(`Loaded ${runs.length} eval run(s).`, { runs: runs.map(evalRunToJson) });
    },
  },
  {
    name: "skill.lifecycle",
    description: "Pin, unpin, archive, or restore an installed skill. Archived skills are excluded from auto-routing and manual selection but remain recoverable.",
    category: "general",
    risk: "medium",
    inputSchema: lifecycleInput,
    parameters: parameters({
      skillId: { type: "string", description: "Installed skill id." },
      action: { type: "string", enum: ["pin", "unpin", "archive", "restore"], description: "Lifecycle action." },
    }, ["skillId", "action"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = lifecycleInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const skill = context.skills.updateLifecycle(parsed.skillId, parsed.action);
        return successResult(`Updated '${skill.name}' lifecycle.`, { id: skill.id, name: skill.name, lifecycleState: skill.lifecycleState ?? "active", pinned: Boolean(skill.pinned), archivedAt: skill.archivedAt ?? null });
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill lifecycle update failed.");
      }
    },
  },

  {
    name: "skill.install_github",
    description: "Fetch a GitHub repository or skill folder URL, validate/scan it, track origin metadata, and install the skill package.",
    category: "general",
    risk: "high",
    inputSchema: githubInstallInput,
    parameters: parameters({
      url: { type: "string", description: "https://github.com/org/repo or /tree/ref/path URL." },
      installMode: { type: "string", enum: ["replace", "copy"], description: "Duplicate handling mode." },
      skillPath: { type: "string", description: "Optional repo-relative skill folder path." },
    }, ["url"]),
    async execute(input, context) {
      const parsed = githubInstallInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const skill = await context.skills.installFromGitHub(parsed);
        return successResult(`Installed '${skill.name}' from GitHub.`, { id: skill.id, name: skill.name, originUrl: skill.originUrl ?? null, packageHash: skill.packageHash ?? null });
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "GitHub skill install failed.");
      }
    },
  },
  {
    name: "skill.registry_search",
    description: "Search a trusted JSON skill registry index and return installable entries with publisher/hash/signature metadata.",
    category: "general",
    risk: "medium",
    inputSchema: registrySearchInput,
    parameters: parameters({
      registryUrl: { type: "string", description: "HTTPS JSON registry index URL." },
      query: { type: "string", description: "Optional search query." },
    }, ["registryUrl"]),
    async execute(input, context) {
      const parsed = registrySearchInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const entries = await context.skills.searchRegistry(parsed);
        return successResult(`Found ${entries.length} registry entr${entries.length === 1 ? "y" : "ies"}.`, toJsonRecord({ entries }));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Registry search failed.");
      }
    },
  },
  {
    name: "skill.registry_install",
    description: "Install a skill from a trusted JSON registry entry with validation, security scan, origin tracking, and duplicate handling.",
    category: "general",
    risk: "high",
    inputSchema: registryInstallInput,
    parameters: parameters({
      registryUrl: { type: "string", description: "HTTPS JSON registry index URL." },
      entryId: { type: "string", description: "Registry entry id." },
      installMode: { type: "string", enum: ["replace", "copy"], description: "Duplicate handling mode." },
    }, ["registryUrl", "entryId"]),
    async execute(input, context) {
      const parsed = registryInstallInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const skill = await context.skills.installFromRegistry(parsed);
        return successResult(`Installed '${skill.name}' from registry.`, { id: skill.id, name: skill.name, originUrl: skill.originUrl ?? null, publisher: skill.publisher ?? null });
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Registry install failed.");
      }
    },
  },
  {
    name: "skill.verify",
    description: "Verify one installed skill by recomputing package hash, validating structure, scanning security findings, and checking signature metadata when available.",
    category: "general",
    risk: "safe",
    inputSchema: verifySkillInput,
    parameters: parameters({ skillId: { type: "string", description: "Installed skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = verifySkillInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Skill verification complete.", toJsonRecord(context.skills.verifySkill(parsed.skillId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill verification failed.");
      }
    },
  },
  {
    name: "skill.verify_all",
    description: "Verify every non-shadowed installed skill and update verification status metadata.",
    category: "general",
    risk: "safe",
    inputSchema: z.object({}).strict(),
    parameters: parameters({}, []),
    async execute(_input, context) {
      await Promise.resolve();
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const results = context.skills.verifyAllSkills();
        return successResult(`Verified ${results.length} skill(s).`, toJsonRecord({ results }));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Bulk verification failed.");
      }
    },
  },
  {
    name: "skill.update_all",
    description: "Check origin-tracked skills for remote hash changes and create update proposals instead of mutating packages directly.",
    category: "general",
    risk: "high",
    inputSchema: z.object({}).strict(),
    parameters: parameters({}, []),
    async execute(_input, context) {
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const result = await context.skills.updateAllSkills(true);
        return successResult(`Checked ${result.checked.length} skill(s); created ${result.proposalsCreated.length} update proposal(s).`, toJsonRecord(result));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill update check failed.");
      }
    },
  },
  {
    name: "skill.import_adapter",
    description: "Convert Claude, Codex, OpenClaw, or Hermes skill layouts into Super Agent package candidates without installing them.",
    category: "general",
    risk: "safe",
    inputSchema: adapterInput,
    parameters: parameters({
      layout: { type: "string", enum: ["claude", "codex", "openclaw", "hermes", "auto"], description: "Source layout." },
      files: { type: "array", description: "Source files with path/content." },
    }, ["layout", "files"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = adapterInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const result = context.skills.adaptImport(parsed);
        return successResult(`Detected ${result.layout} layout with ${result.packages.length} package(s).`, toJsonRecord(result));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill import adapter failed.");
      }
    },
  },

  {
    name: "skill.audit_log",
    description: "List append-only skill audit events such as install, update, delete, lifecycle changes, and script runs.",
    category: "general",
    risk: "safe",
    inputSchema: auditLogInput,
    parameters: parameters({
      skillId: { type: "string", description: "Optional skill id to filter audit events." },
      limit: { type: "number", description: "Maximum events to return, capped at 500." },
    }),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = auditLogInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const events = context.skills.listAuditLogs(parsed.skillId, parsed.limit);
        return successResult(`Loaded ${events.length} skill audit event(s).`, toJsonRecord({ events }));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill audit log failed.");
      }
    },
  },

  {
    name: "skill.policy_report",
    description: "Inspect skill project/admin policy decisions, including per-agent allowlists and blocked skills.",
    category: "general",
    risk: "safe",
    inputSchema: skillPolicyInput,
    parameters: parameters({ agentId: { type: "string", description: "Optional agent id/kind to evaluate allowlists for." } }),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillPolicyInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Loaded skill policy report.", toJsonRecord(context.skills.skillPolicyReport(parsed.agentId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill policy report failed.");
      }
    },
  },
  {
    name: "skill.bundles",
    description: "List skill bundles/groups from project bundle config and related_skills metadata.",
    category: "general",
    risk: "safe",
    inputSchema: z.object({}),
    parameters: parameters({}),
    async execute(_input, context) {
      await Promise.resolve();
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        const bundles = context.skills.listBundles();
        return successResult(`Loaded ${bundles.length} skill bundle(s).`, toJsonRecord({ bundles }));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill bundle listing failed.");
      }
    },
  },
  {
    name: "skill.compare",
    description: "Compare two installed skills by metadata, package hash, and file-level differences.",
    category: "general",
    risk: "safe",
    inputSchema: skillCompareInput,
    parameters: parameters({
      leftSkillId: { type: "string", description: "First skill id." },
      rightSkillId: { type: "string", description: "Second skill id." },
    }, ["leftSkillId", "rightSkillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillCompareInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Compared skills.", toJsonRecord(context.skills.compareSkills(parsed.leftSkillId, parsed.rightSkillId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill compare failed.");
      }
    },
  },
  {
    name: "skill.bulk",
    description: "Apply a bulk skill operation: enable, disable, pin, unpin, archive, restore, or verify.",
    category: "general",
    risk: "medium",
    inputSchema: skillBulkInput,
    parameters: parameters({
      skillIds: { type: "array", items: { type: "string" }, description: "Skill ids to update." },
      action: { type: "string", enum: ["enable", "disable", "pin", "unpin", "archive", "restore", "verify"] },
    }, ["skillIds", "action"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillBulkInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Bulk skill operation completed.", toJsonRecord(context.skills.bulkAction(parsed.skillIds, parsed.action)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill bulk operation failed.");
      }
    },
  },
  {
    name: "skill.credentials",
    description: "Show declared skill credential requirements without exposing secret values to the model.",
    category: "general",
    risk: "safe",
    inputSchema: skillCredentialInput,
    parameters: parameters({ skillId: { type: "string", description: "Installed skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillCredentialInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Loaded skill credential report.", toJsonRecord(context.skills.credentialReport(parsed.skillId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill credential report failed.");
      }
    },
  },
  {
    name: "skill.setup_plan",
    description: "Create a dry-run setup plan for a skill's declared package, CLI, env, and credential-file dependencies. Does not execute commands.",
    category: "general",
    risk: "safe",
    inputSchema: skillSetupPlanInput,
    parameters: parameters({ skillId: { type: "string", description: "Installed skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillSetupPlanInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Created dry-run skill setup plan.", toJsonRecord(context.skills.setupPlan(parsed.skillId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill setup plan failed.");
      }
    },
  },
  {
    name: "skill.marketplace_readiness",
    description: "Check whether a skill has enough metadata, provenance, and scan status to be published to a marketplace or team registry.",
    category: "general",
    risk: "safe",
    inputSchema: skillMarketplaceReadinessInput,
    parameters: parameters({ skillId: { type: "string", description: "Installed skill id." } }, ["skillId"]),
    async execute(input, context) {
      await Promise.resolve();
      const parsed = skillMarketplaceReadinessInput.parse(input);
      try {
        if (!context.skills) throw new Error("Skill registry is not available in this runtime.");
        return successResult("Checked marketplace readiness.", toJsonRecord(context.skills.marketplaceReadiness(parsed.skillId)));
      } catch (error) {
        return failureResult(error instanceof Error ? error.message : "Skill marketplace readiness check failed.");
      }
    },
  },
  {
    name: "skill.run_script",
    description: [
      "Execute a script bundled under scripts/ for an installed skill when that active skill's SKILL.md workflow calls for it.",
      "Do not run every script in a skill. Use this only for the specific validation, conversion, generation, test, or packaging script required by the current task.",
      "The full skill package is staged under the workspace, SKILL_ROOT is provided, stdout/stderr are captured, and the script runs with a restricted environment.",
    ].join(" "),
    category: "general",
    risk: "high",
    inputSchema: runSkillScriptInput,
    parameters: parameters(
      {
        skillId: {
          type: "string",
          description: "Installed skill id containing the script.",
        },
        scriptPath: {
          type: "string",
          description: "Path to the bundled script, for example scripts/validate.py.",
        },
        args: {
          type: "array",
          description: "Arguments passed to the script without shell interpolation.",
          items: { type: "string" },
        },
        cwd: {
          type: "string",
          description: "Workspace-relative working directory. Defaults to the current workspace root.",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum execution time in milliseconds. Defaults to the normal shell timeout and is capped.",
        },
      },
      ["skillId", "scriptPath"],
    ),
    async execute(input, context) {
      const parsedInput = runSkillScriptInput.parse(input);
      try {
        const result = await runSkillScript(parsedInput, context);
        const exitCode =
          typeof result.exit_code === "number" ? result.exit_code : null;
        return successResult(
          exitCode === 0
            ? `Skill script '${parsedInput.scriptPath}' completed.`
            : `Skill script '${parsedInput.scriptPath}' exited with code ${String(exitCode)}.`,
          result,
        );
      } catch (error) {
        const skill = context.skills?.get(parsedInput.skillId);
        return failureResult(
          error instanceof Error ? error.message : "Skill script failed.",
          skill
            ? {
                skillId: skill.id,
                availableScripts: availableSkillScripts(skill),
              }
            : { skillId: parsedInput.skillId },
        );
      }
    },
  },
];

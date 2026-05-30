import type { ToolCallRecord, ToolResultRecord } from "@shared/types";
import { toJsonRecord as normalizeJsonRecord, type JsonRecord } from "@shared/json";
import { codeLikeFilePattern, fileEditToolNames, normalizeReadCoveragePath, readCoveragePathMatches } from "./toolLoopGuards";
import type { RuntimeGateKind, RuntimeGateVerification } from "./runtimeGates";

const MAX_FINAL_ANSWER_REPAIRS = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toJsonRecord = (value: unknown): JsonRecord => normalizeJsonRecord(value);

const truncate = (value: string, limit: number): string => {
  const text = value.trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit).trimEnd()} ... [truncated]`;
};

interface PostEditFinalAnswerRepair {
  reason: string;
  continuationMessage: string;
}

interface PostEditCommandEvidence {
  command: string;
  ok: boolean;
  blocked: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

const jsonRecordString = (record: JsonRecord, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
};

const toolCallPath = (call: ToolCallRecord): string =>
  normalizeReadCoveragePath(jsonRecordString(call.input, ["path", "file", "filePath", "relativePath"]));

const toolResultPath = (result: ToolResultRecord): string =>
  isRecord(result.data)
    ? normalizeReadCoveragePath(jsonRecordString(result.data, ["path", "file", "filePath", "relativePath"]))
    : "";

const shellCommandFromResult = (call: ToolCallRecord | null, result: ToolResultRecord): string => {
  const fromInput = call ? jsonRecordString(call.input, ["command"]) : "";
  if (fromInput) return fromInput;

  return isRecord(result.data) ? jsonRecordString(result.data, ["command"]) : "";
};

const commandLooksLikeVerification = (command: string): boolean =>
  /\b(node\s+--check|npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check))|npx\s+(?:tsc|vitest|eslint)|pnpm\s+(?:test|run\s+(?:test|build|lint|typecheck|check))|yarn\s+(?:test|build|lint|typecheck|check)|pytest|python\s+-m\s+pytest|cargo\s+(?:test|check)|go\s+test|swift\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check|verify))\b/i.test(command);

const finalAnswerClaimsPostEditSuccess = (value: string): boolean =>
  /\b(fixed|completed|done|works|runs|starts|passes|passed|successfully|without throwing|no syntax errors|server ready)\b/i.test(value);

const commandSuggestionForEditedPath = (path: string): string => {
  if (/\.(?:cjs|mjs|js|jsx)$/i.test(path)) return `bash command: node --check ${path}`;
  if (/\.(?:ts|tsx)$/i.test(path)) return "bash command: npm run typecheck, npx tsc --noEmit, or the repository's actual typecheck command";
  if (/\.py$/i.test(path)) return `bash command: python -m py_compile ${path}`;
  if (/\.rs$/i.test(path)) return "bash command: cargo check or cargo test";
  if (/\.go$/i.test(path)) return "bash command: go test ./...";

  return "the repository's cheapest syntax, typecheck, test, or build command";
};

const evidenceOutputText = (result: ToolResultRecord): string => {
  const data = toJsonRecord(result.data);
  const parts = [
    result.message,
    jsonRecordString(data, ["command"]),
    jsonRecordString(data, ["stdout"]),
    jsonRecordString(data, ["stderr"])
  ];

  try {
    parts.push(JSON.stringify(data));
  } catch {
    // Ignore unserializable data from custom tools.
  }

  return parts.filter(Boolean).join("\n").slice(0, 12000);
};

const commandEvidenceFromResult = (
  call: ToolCallRecord | null,
  result: ToolResultRecord
): PostEditCommandEvidence | null => {
  const command = shellCommandFromResult(call, result);
  if (!command) return null;

  const data = toJsonRecord(result.data);
  const exitCode = typeof data.exit_code === "number" ? data.exit_code : null;
  const timedOut = data.timed_out === true || data.cancelled === true || data.aborted === true;

  return {
    command,
    ok: result.ok,
    blocked: result.blocked,
    exitCode,
    timedOut,
    output: evidenceOutputText(result)
  };
};

const commandEvidenceSucceeded = (evidence: PostEditCommandEvidence): boolean =>
  evidence.ok && !evidence.blocked && evidence.exitCode === 0 && !evidence.timedOut;

const commandEvidenceText = (evidence: readonly PostEditCommandEvidence[]): string =>
  evidence
    .filter(commandEvidenceSucceeded)
    .map((item) => `${item.command}
${item.output}`)
    .join("\n")
    .toLowerCase();

const commandLooksRuntimeLike = (command: string): boolean =>
  /\b(curl|wget|fetch|http\.get|http\.request|localhost|127\.0\.0\.1|npm\s+(?:start|run\s+dev)|pnpm\s+(?:start|run\s+dev)|yarn\s+(?:start|dev)|node\s+(?!--check\b).+\.js|playwright|cypress|supertest)\b/i.test(command);

const finalAnswerClaimsBroadRuntimeSuccess = (value: string): boolean =>
  /\b(all (?:new |added )?(?:features|endpoints) (?:work|worked|pass|passed|are working|work as intended)|runtime tests? (?:passed|succeeded|worked)|manual tests? (?:passed|succeeded|worked)|server (?:runs|starts|started) (?:successfully|without errors)|ready for use|works as intended)\b/i.test(value);

interface RuntimeClaimRequirement {
  label: string;
  claim: RegExp;
  evidence: RegExp;
}

const runtimeClaimRequirements: readonly RuntimeClaimRequirement[] = [
  {
    label: "rate limit",
    claim: /\b(rate[- ]?limit|429|too many requests)\b/i,
    evidence: /\b(rate[- ]?limit|429|too many requests|maxrequestsperwindow)\b/i
  },
  {
    label: "persistence/restart",
    claim: /\b(persist(?:ed|ence)?|survives? restart|after restart|restart)\b/i,
    evidence: /\b(persist(?:ed|ence)?|visits\.json|restart|stop_process|started_at)\b/i
  },
  {
    label: "POST /visit",
    claim: /\b(post\s+\/visit|\/visit)\b/i,
    evidence: /\b(post\s+\/visit|\/visit|recorded)\b/i
  },
  {
    label: "/health endpoint",
    claim: /\b\/health\b/i,
    evidence: /\b\/health\b/i
  },
  {
    label: "/metrics endpoint",
    claim: /\b\/metrics\b/i,
    evidence: /\b\/metrics|total_visits|server_uptime_seconds\b/i
  },
  {
    label: "/reset endpoint",
    claim: /\b\/reset\b/i,
    evidence: /\b\/reset|reset\b/i
  },
  {
    label: "/stats endpoint",
    claim: /\b\/stats\b/i,
    evidence: /\b\/stats|uniqueurls|recent\b/i
  }
];

const finalAnswerClaimsObservedOutcome = (value: string): boolean =>
  /\b(observed|returned|tested|test results?|runtime test|manual test|works|worked|work as intended|passed|enforced|cleared|displayed|correct|200\s+ok|json response|ready for use)\b/i.test(value);

export class PostEditVerificationTracker {
  private readonly editedPaths = new Set<string>();
  private readonly inspectedAfterEdit = new Set<string>();
  private readonly commandEvidence: PostEditCommandEvidence[] = [];
  private verificationAttemptedAfterEdit = false;
  private verificationSucceededAfterEdit = false;
  private latestVerificationSummary = "";

  record(call: ToolCallRecord | null, result: ToolResultRecord): void {
    if (fileEditToolNames.has(result.toolName) && result.ok) {
      const path = call ? toolCallPath(call) : toolResultPath(result);
      if (path) {
        this.editedPaths.add(path);
        this.inspectedAfterEdit.delete(path);
      }
      this.verificationAttemptedAfterEdit = false;
      this.verificationSucceededAfterEdit = false;
      this.latestVerificationSummary = "";
      return;
    }

    if (result.toolName === "read_file" && result.ok) {
      const path = toolResultPath(result) || (call ? toolCallPath(call) : "");
      if (path && this.matchesEditedPath(path)) {
        this.inspectedAfterEdit.add(path);
      }
      return;
    }

    if (result.toolName === "bash") {
      const evidence = commandEvidenceFromResult(call, result);
      if (evidence) this.commandEvidence.push(evidence);

      const command = evidence?.command ?? shellCommandFromResult(call, result);
      if (commandLooksLikeVerification(command)) {
        this.verificationAttemptedAfterEdit = true;
        this.verificationSucceededAfterEdit = evidence ? commandEvidenceSucceeded(evidence) : false;
        this.latestVerificationSummary = this.verificationSucceededAfterEdit
          ? `Verification command ran: ${command}`
          : `Verification command failed or was blocked: ${command}`;
      }
    }
  }

  getFinalAnswerRepair(assistantText: string): PostEditFinalAnswerRepair | null {
    if (this.editedPaths.size === 0) return null;

    const edited = [...this.editedPaths];
    const codeLikeEdited = edited.filter(path => codeLikeFilePattern.test(path));
    const pathsNeedingInspection = edited.filter(path => !this.pathWasInspected(path));

    if (pathsNeedingInspection.length > 0) {
      return {
        reason: "edited files were not inspected after modification",
        continuationMessage: [
          "A source-edit tool completed, but the changed file/range has not been inspected after the edit.",
          `Changed files needing inspection: ${pathsNeedingInspection.join(", ")}.`,
          "Call read_file for the changed file or changed range now. Do not claim the edit is fixed, working, or complete yet."
        ].join("\n")
      };
    }

    if (codeLikeEdited.length > 0 && !this.verificationAttemptedAfterEdit) {
      const unsupportedClaim = this.unsupportedRuntimeClaim(assistantText);
      if (unsupportedClaim) return unsupportedClaim;

      const first = codeLikeEdited[0] ?? edited[0] ?? "the changed file";
      return {
        reason: "edited code was not verified after modification",
        continuationMessage: [
          "A code edit was applied and inspected, but no verification command has run after the edit.",
          `Run a cheap verification now; suggested ${commandSuggestionForEditedPath(first)}.`,
          "If verification is impossible or blocked, call the command anyway and report the returned failure/blocker. Do not claim the code starts, runs, passes, or is fixed without tool evidence."
        ].join("\n")
      };
    }

    const unsupportedClaim = this.unsupportedRuntimeClaim(assistantText);
    if (unsupportedClaim) return unsupportedClaim;

    if (
      finalAnswerClaimsPostEditSuccess(assistantText) &&
      codeLikeEdited.length > 0 &&
      !this.verificationSucceededAfterEdit
    ) {
      return {
        reason: "draft claimed post-edit success without successful verification evidence",
        continuationMessage: [
          "The draft answer claimed the edited code works or is fixed, but no successful post-edit verification command result proves that.",
          `Run verification first; suggested ${commandSuggestionForEditedPath(codeLikeEdited[0] ?? edited[0] ?? "the changed file")}.`,
          "If verification already failed or was blocked, report that failure/blocker instead of claiming success."
        ].join("\n")
      };
    }

    return null;
  }

  private unsupportedRuntimeClaim(assistantText: string): PostEditFinalAnswerRepair | null {
    const text = normalizeFinalAnswerText(assistantText);
    if (!text || !finalAnswerClaimsObservedOutcome(text)) return null;

    const successfulEvidence = this.commandEvidence.filter(commandEvidenceSucceeded);
    const evidenceText = commandEvidenceText(successfulEvidence);
    const hasRuntimeEvidence = successfulEvidence.some((item) =>
      commandLooksRuntimeLike(item.command) || commandLooksRuntimeLike(item.output)
    );

    if (finalAnswerClaimsBroadRuntimeSuccess(text) && !hasRuntimeEvidence) {
      return {
        reason: "draft claimed runtime/manual success without runtime command evidence",
        continuationMessage: [
          "The draft claimed runtime behavior or endpoint checks worked, but the recorded post-edit command evidence only supports static verification or no runtime check.",
          "Either run the relevant runtime/integration checks now, or revise the final answer to say those runtime/manual checks were not run.",
          "Only claim checks listed in actual tool output; do not infer endpoint behavior from syntax checks."
        ].join("\n")
      };
    }

    const unsupported = runtimeClaimRequirements.find((requirement) =>
      requirement.claim.test(text) && !requirement.evidence.test(evidenceText)
    );

    if (!unsupported) return null;

    return {
      reason: `draft claimed ${unsupported.label} results without matching command evidence`,
      continuationMessage: [
        `The draft claimed ${unsupported.label} runtime/test results, but no successful post-edit command output proves that claim.`,
        "Run a command that exercises that behavior, or report it as not run/skipped.",
        "Do not include observed/returned/passed/enforced wording for checks absent from tool output."
      ].join("\n")
    };
  }

  private matchesEditedPath(path: string): boolean {
    return [...this.editedPaths].some(edited => readCoveragePathMatches(edited, path));
  }

  private pathWasInspected(path: string): boolean {
    return [...this.inspectedAfterEdit].some(inspected => readCoveragePathMatches(inspected, path));
  }

  summary(): string {
    const edited = [...this.editedPaths];
    if (edited.length === 0) return "No source edits recorded.";

    return [
      `Edited files: ${edited.join(", ")}.`,
      `Inspected after edit: ${[...this.inspectedAfterEdit].join(", ") || "none"}.`,
      this.latestVerificationSummary || "No post-edit verification command has run.",
      `Successful command evidence: ${this.commandEvidence.filter(commandEvidenceSucceeded).map((item) => item.command).join("; ") || "none"}.`
    ].join(" ");
  }
}

interface FinalAnswerRepair {
  kind: RuntimeGateKind;
  reason: string;
  continuationMessage: string;
}

const normalizeFinalAnswerText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const finalAnswerLooksLikePlanOnly = (value: string): boolean => {
  const normalized = normalizeFinalAnswerText(value).toLowerCase();

  if (!normalized) return true;
  if (/^(plan|next step|next action|i will|i'll|first,|first step|to review|to complete)\b/.test(normalized)) return true;
  if (/\b(search for|look for|inspect|read|run|check)\b/.test(normalized) && !/\b(verdict|finding|findings|completed|complete|blocked|verification|scope reviewed)\b/.test(normalized)) return true;

  return false;
};

const reviewFinalAnswerLooksComplete = (value: string): boolean => {
  const normalized = normalizeFinalAnswerText(value).toLowerCase();

  if (finalAnswerLooksLikePlanOnly(normalized)) return false;

  const hasVerdict = /\b(verdict|assessment|overall)\b/.test(normalized);
  const hasScope = /\b(scope reviewed|checked scope|files reviewed|reviewed files|files checked|scope)\b/.test(normalized);
  const hasVerification = /\b(verification|commands? (considered|run|executed)|tests?|lint|build|typecheck|not run|skipped)\b/.test(normalized);
  const hasFindings = /\b(findings?|issues?|risks?|bugs?|security|fixes?|recommendations?)\b/.test(normalized);
  const hasBlockerReport = /\b(blocked|partial review|unable to complete)\b/.test(normalized) && /\b(evidence|reason|because|limitation)\b/.test(normalized);

  return hasBlockerReport || (hasVerdict && hasScope && hasVerification && hasFindings);
};

const goalFinalAnswerLooksComplete = (value: string): boolean => {
  const normalized = normalizeFinalAnswerText(value).toLowerCase();

  if (finalAnswerLooksLikePlanOnly(normalized)) return false;

  const hasOutcome = /\b(completed|complete|done|implemented|fixed|blocked|unable to complete)\b/.test(normalized);
  const hasEvidence = /\b(acceptance|verification|evidence|commands? run|tests?|build|lint|typecheck|files changed|changed files)\b/.test(normalized);

  return hasOutcome && hasEvidence;
};

const reviewBlockedShellIssues = (
  verifications: readonly RuntimeGateVerification[]
): string[] =>
  verifications
    .filter((verification) => verification.kind === "review")
    .flatMap((verification) => {
      const issues = verification.metadata.blockedShellIssues;
      return Array.isArray(issues)
        ? issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
        : [];
    });

const finalAnswerContradictsBlockedShell = (
  value: string,
  blockedShellIssues: readonly string[]
): boolean => {
  if (blockedShellIssues.length === 0) return false;

  const normalized = normalizeFinalAnswerText(value).toLowerCase();

  if (!/\b(blocked|not run|did not run|skipped|unable to run|could not run)\b/.test(normalized)) {
    return true;
  }

  return /\b(executed successfully|ran successfully|run\s*[–—-]\s*executed|started briefly|no runtime errors observed|passed successfully)\b/.test(normalized);
};

const reviewCommandWasActuallyRun = (
  verifications: readonly RuntimeGateVerification[]
): boolean =>
  verifications.some((verification) =>
    verification.kind === "review" &&
    verification.metadata.safeCheckRan === true &&
    verification.metadata.safeCheckFailed !== true &&
    verification.metadata.safeCheckBlocked !== true
  );

const reviewSuccessfulCommands = (
  verifications: readonly RuntimeGateVerification[]
): string[] =>
  verifications
    .filter((verification) => verification.kind === "review")
    .flatMap((verification) => {
      const commands = verification.metadata.successfulVerificationCommands;
      return Array.isArray(commands)
        ? commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
        : [];
    });

const commandEvidenceMatches = (
  commands: readonly string[],
  pattern: RegExp
): boolean => commands.some(command => pattern.test(command));

const finalAnswerInventsVerification = (
  value: string,
  verifications: readonly RuntimeGateVerification[]
): boolean => {
  const normalized = normalizeFinalAnswerText(value).toLowerCase();
  const successfulCommands = reviewSuccessfulCommands(verifications);
  const hasSuccessfulVerification = reviewCommandWasActuallyRun(verifications);

  if (/\b(executed conceptually|conceptually executed|ran conceptually)\b/.test(normalized)) {
    return true;
  }

  if (/\b(builds and runs|builds successfully)\b/.test(normalized)) {
    return !commandEvidenceMatches(successfulCommands, /\b(build|tsc|typecheck)\b/i);
  }

  if (/\b(runs successfully|started successfully|server started|no runtime errors observed)\b/.test(normalized)) {
    return !commandEvidenceMatches(successfulCommands, /\b(start|dev|serve|node\s+.+\.js)\b/i);
  }

  if (/\b(passed successfully|all tests passed|tests passed)\b/.test(normalized)) {
    return !commandEvidenceMatches(successfulCommands, /\b(test|vitest|jest|pytest|playwright|cypress)\b/i);
  }

  if (/\b(passed|pass)\b/.test(normalized)) {
    return !hasSuccessfulVerification;
  }

  return false;
};

const reviewUndefinedSymbolRisks = (
  verifications: readonly RuntimeGateVerification[]
): string[] =>
  verifications
    .filter((verification) => verification.kind === "review")
    .flatMap((verification) => {
      const risks = verification.metadata.undefinedSymbolRisks;
      return Array.isArray(risks)
        ? risks.filter((risk): risk is string => typeof risk === "string" && risk.trim().length > 0)
        : [];
    });

const finalAnswerOmitsUndefinedSymbolRisks = (
  value: string,
  risks: readonly string[]
): boolean => {
  if (risks.length === 0) return false;

  const normalized = normalizeFinalAnswerText(value).toLowerCase();
  if (!/\b(undefined|not defined|missing declaration|declaration search)\b/.test(normalized)) {
    return true;
  }

  return risks.some((risk) => !normalized.includes(risk.toLowerCase()));
};

const gatedFinalAnswerRepairInstruction = (
  kind: RuntimeGateKind,
  reason: string,
  assistantText: string
): string => {
  const draft = truncate(normalizeFinalAnswerText(assistantText), 800);

  if (kind === "review") {
    return [
      `The review runtime gates are complete, but the draft answer was withheld because ${reason}.`,
      draft ? `Withheld draft: ${draft}` : "The withheld draft was empty.",
      "Do not output a plan as the final answer.",
      "If another tool is truly required, call that tool now with clean parameters. Otherwise produce the final review report now.",
      "The final review report must include: Verdict, Scope reviewed, Verification commands considered/run/skipped, Findings by severity, Concrete fixes, and Remaining risks or limitations."
    ].join("\n");
  }

  if (kind === "goal") {
    return [
      `The goal runtime gates are complete, but the draft answer was withheld because ${reason}.`,
      draft ? `Withheld draft: ${draft}` : "The withheld draft was empty.",
      "Do not output a plan as the final answer.",
      "If another tool is truly required, call that tool now with clean parameters. Otherwise produce the final completion report now.",
      "The final completion report must include: outcome, acceptance criteria status, files changed or inspected, verification commands run/skipped, and any remaining risks."
    ].join("\n");
  }

  return [
    `The runtime gate is complete, but the draft answer was withheld because ${reason}.`,
    draft ? `Withheld draft: ${draft}` : "The withheld draft was empty.",
    "Either call the next required tool now or provide a final answer grounded in the completed evidence."
  ].join("\n");
};

export const getGatedFinalAnswerRepair = (
  verifications: readonly RuntimeGateVerification[],
  assistantText: string
): FinalAnswerRepair | null => {
  const completeKinds = new Set(
    verifications
      .filter((verification) => verification.complete)
      .map((verification) => verification.kind)
  );
  const text = normalizeFinalAnswerText(assistantText);
  const blockedShellIssues = reviewBlockedShellIssues(verifications);

  if (completeKinds.has("review") && finalAnswerContradictsBlockedShell(text, blockedShellIssues)) {
    const reason = "it omitted or contradicted blocked shell-command evidence";

    return {
      kind: "review",
      reason,
      continuationMessage: [
        `The review runtime gates are complete, but the draft answer was withheld because ${reason}.`,
        `Blocked shell-command evidence that must be reported: ${blockedShellIssues.join(" | ")}`,
        "Do not claim a blocked command ran, passed, started successfully, or observed no runtime errors.",
        "Produce the final review report now and mark those commands as blocked/not run."
      ].join("\n")
    };
  }

  if (completeKinds.has("review") && finalAnswerInventsVerification(text, verifications)) {
    const reason = "it claimed verification or runtime success that no tool result proved";

    return {
      kind: "review",
      reason,
      continuationMessage: [
        `The review runtime gates are complete, but the draft answer was withheld because ${reason}.`,
        "Do not say code builds, runs, starts, passes, or was executed conceptually unless an actual command result proves it.",
        "Produce the final review report now and mark unavailable or unrun verification as not run/skipped."
      ].join("\n")
    };
  }

  const undefinedRisks = reviewUndefinedSymbolRisks(verifications);
  if (completeKinds.has("review") && finalAnswerOmitsUndefinedSymbolRisks(text, undefinedRisks)) {
    const reason = "it omitted undefined-symbol evidence from search results";

    return {
      kind: "review",
      reason,
      continuationMessage: [
        `The review runtime gates are complete, but the draft answer was withheld because ${reason}.`,
        `Undefined-symbol evidence that must be reported: ${undefinedRisks.join(", ")}`,
        "Produce the final review report now and include each undefined symbol as a runtime-risk finding."
      ].join("\n")
    };
  }

  if (completeKinds.has("review") && !reviewFinalAnswerLooksComplete(text)) {
    const reason = !text
      ? "it was empty"
      : finalAnswerLooksLikePlanOnly(text)
        ? "it was only a plan or next step, not a final review report"
        : "it did not contain the required review report sections";

    return {
      kind: "review",
      reason,
      continuationMessage: gatedFinalAnswerRepairInstruction("review", reason, assistantText)
    };
  }

  if (completeKinds.has("goal") && !goalFinalAnswerLooksComplete(text)) {
    const reason = !text
      ? "it was empty"
      : finalAnswerLooksLikePlanOnly(text)
        ? "it was only a plan or next step, not a final completion report"
        : "it did not contain the required goal completion report sections";

    return {
      kind: "goal",
      reason,
      continuationMessage: gatedFinalAnswerRepairInstruction("goal", reason, assistantText)
    };
  }

  if (verifications.length > 0 && finalAnswerLooksLikePlanOnly(text)) {
    const kind = verifications[0]?.kind ?? "evidence";
    const reason = !text ? "it was empty" : "it was only a plan or next step";

    return {
      kind,
      reason,
      continuationMessage: gatedFinalAnswerRepairInstruction(kind, reason, assistantText)
    };
  }

  return null;
};

const finalAnswerRepairKey = (repair: FinalAnswerRepair): string =>
  `${repair.kind}:${repair.reason}`;

export const shouldStopFinalAnswerRepair = (
  counts: Map<string, number>,
  repair: FinalAnswerRepair
): boolean => {
  const key = finalAnswerRepairKey(repair);
  const count = (counts.get(key) ?? 0) + 1;

  counts.set(key, count);

  return count > MAX_FINAL_ANSWER_REPAIRS;
};

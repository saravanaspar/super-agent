import type { SkillEvalCaseResult, SkillRecord } from "@shared/types";
import { mergedFiles } from "./skillContext";

export interface ParsedSkillEval {
  id: string;
  prompt: string;
  expectedOutput: string;
  expectations: string[];
  staticOutput: string | null;
}

export const tokenizeForEval = (value: string): string[] =>
  Array.from(new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4)));

export const parseSkillEvals = (skill: SkillRecord): ParsedSkillEval[] => {
  const evalFile = mergedFiles(skill).find((file) => file.path === "evals/evals.json");
  if (!evalFile) throw new Error("Skill has no evals/evals.json file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(evalFile.content);
  } catch (error) {
    throw new Error(`evals/evals.json is invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { evals?: unknown }).evals)) {
    throw new Error("evals/evals.json must be an object with an evals array.");
  }
  return (parsed as { evals: unknown[] }).evals.map((item, index): ParsedSkillEval => {
    if (typeof item !== "object" || item === null) throw new Error(`Eval ${index + 1} must be an object.`);
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `eval-${index + 1}`;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    const expectedOutput = typeof record.expected_output === "string" ? record.expected_output.trim() : "";
    const expectations = Array.isArray(record.expectations)
      ? record.expectations.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [];
    const staticOutput = typeof record.actual_output === "string" && record.actual_output.trim()
      ? record.actual_output.trim()
      : typeof record.output === "string" && record.output.trim()
        ? record.output.trim()
        : null;
    if (!prompt) throw new Error(`Eval ${id} is missing prompt.`);
    if (!expectedOutput) throw new Error(`Eval ${id} is missing expected_output.`);
    return { id, prompt, expectedOutput, expectations, staticOutput };
  });
};

export const gradeSkillEvalCase = (evalCase: ParsedSkillEval, output: string | undefined): SkillEvalCaseResult => {
  const findings: SkillEvalCaseResult["findings"] = [];
  let score = 100;
  if (evalCase.prompt.length < 12) {
    score -= 15;
    findings.push({ severity: "warn", code: "weak-prompt", message: "Eval prompt is too short to exercise realistic routing.", path: "evals/evals.json" });
  }
  if (evalCase.expectedOutput.length < 12) {
    score -= 20;
    findings.push({ severity: "critical", code: "weak-expected-output", message: "Expected output is too short to grade behavior.", path: "evals/evals.json" });
  }
  if (!output) {
    score -= 35;
    findings.push({ severity: "warn", code: "missing-actual-output", message: "No actual output was supplied; this run validates eval shape but cannot grade model behavior.", path: "evals/evals.json" });
  } else {
    const expectedTokens = tokenizeForEval([evalCase.expectedOutput, ...evalCase.expectations].join(" "));
    const outputTokens = new Set(tokenizeForEval(output));
    const covered = expectedTokens.filter((token) => outputTokens.has(token)).length;
    const coverage = expectedTokens.length ? covered / expectedTokens.length : 1;
    if (coverage < 0.35) {
      score -= 45;
      findings.push({ severity: "critical", code: "low-output-coverage", message: "Actual output covers too few expected terms or expectations.", path: "evals/evals.json" });
    } else if (coverage < 0.65) {
      score -= 20;
      findings.push({ severity: "warn", code: "partial-output-coverage", message: "Actual output covers only part of expected output or expectations.", path: "evals/evals.json" });
    }
  }
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const hasCritical = findings.some((finding) => finding.severity === "critical");
  const hasWarn = findings.some((finding) => finding.severity === "warn");
  return {
    id: evalCase.id,
    prompt: evalCase.prompt,
    status: hasCritical ? "failed" : hasWarn ? "warning" : "passed",
    score: clamped,
    findings,
  };
};

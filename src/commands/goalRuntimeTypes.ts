import type { JsonRecord } from "@shared/json";

export interface MeasuredItem {
  index: number;
  title: string;
  startLine: number;
  endLine: number;
  metrics: JsonRecord;
}

export type MetricName =
  | "words"
  | "characters"
  | "lines"
  | "unknown";

export type GoalCriterion =
  | {
      type: "exact_count";
      subject: string;
      expected: number;
      actual: number | null;
      targetPath: string | null;
      complete: boolean;
      reason: string;
    }
  | {
      type: "minimum_total";
      metric: MetricName;
      metricLabel: string;
      minimum: number;
      actual: number | null;
      targetPath: string | null;
      complete: boolean;
      reason: string;
    }
  | {
      type: "minimum_per_item";
      itemName: string;
      metric: MetricName;
      metricLabel: string;
      minimumPerItem: number;
      expectedItemCount: number | null;
      targetPath: string | null;
      items: MeasuredItem[];
      complete: boolean;
      reason: string;
    }
  | {
      type: "acceptance";
      description: string;
      evidence: string | null;
      complete: boolean;
      reason: string;
    };

export interface GoalEvidenceRecord {
  kind: "situation_scan" | "file_change" | "verification" | "read" | "blocked";
  toolName: string;
  summary: string;
  path: string | null;
  command: string | null;
  ok: boolean;
  rawData?: unknown;
}

export interface GoalRuntimeState {
  active: boolean;
  target: string;
  criteria: GoalCriterion[];
  evidence: GoalEvidenceRecord[];
  situationScanRequired: boolean;
  maxObservedEvidence: number;
}

export interface GoalVerificationResult {
  complete: boolean;
  partial: boolean;
  summary: string;
  nextAction: string;
  criteria: GoalCriterion[];
}

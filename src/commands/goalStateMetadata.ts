import type { JsonRecord } from "@shared/json";
import type { GoalCriterion, GoalVerificationResult, MeasuredItem } from "./goalRuntimeTypes";

const measuredItemToJson = (item: MeasuredItem): JsonRecord => ({
  index: item.index,
  title: item.title,
  startLine: item.startLine,
  endLine: item.endLine,
  metrics: item.metrics
});

const criterionToJson = (criterion: GoalCriterion): JsonRecord => {
  if (criterion.type === "exact_count") {
    return {
      type: criterion.type,
      subject: criterion.subject,
      expected: criterion.expected,
      actual: criterion.actual,
      targetPath: criterion.targetPath,
      complete: criterion.complete,
      reason: criterion.reason
    };
  }

  if (criterion.type === "minimum_total") {
    return {
      type: criterion.type,
      metric: criterion.metric,
      metricLabel: criterion.metricLabel,
      minimum: criterion.minimum,
      actual: criterion.actual,
      targetPath: criterion.targetPath,
      complete: criterion.complete,
      reason: criterion.reason
    };
  }

  if (criterion.type === "minimum_per_item") {
    return {
      type: criterion.type,
      itemName: criterion.itemName,
      metric: criterion.metric,
      metricLabel: criterion.metricLabel,
      minimumPerItem: criterion.minimumPerItem,
      expectedItemCount: criterion.expectedItemCount,
      targetPath: criterion.targetPath,
      items: criterion.items.map(measuredItemToJson),
      complete: criterion.complete,
      reason: criterion.reason
    };
  }

  return {
    type: criterion.type,
    description: criterion.description,
    evidence: criterion.evidence,
    complete: criterion.complete,
    reason: criterion.reason
  };
};

export const goalStateMetadata = (
  verification: GoalVerificationResult
): JsonRecord => ({
  complete: verification.complete,
  partial: verification.partial,
  summary: verification.summary,
  nextAction: verification.nextAction,
  criteria: verification.criteria.map(criterionToJson)
});
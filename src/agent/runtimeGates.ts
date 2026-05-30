import type {
  ChatMessage,
  RoutedChatSubmitRequest,
  ToolResultRecord
} from "@shared/types";
import type { JsonRecord } from "@shared/json";
import {
  buildGoalRuntimeState,
  goalContinuationMessage,
  goalProgressMessage,
  goalStateMetadata,
  updateGoalStateFromToolResult,
  verifyGoalAcceptance,
  type GoalRuntimeState,
  type GoalVerificationResult
} from "../commands/goalRuntime";
import {
  buildReviewRuntimeState,
  reviewContinuationMessage,
  reviewProgressMessage,
  reviewStateMetadata,
  updateReviewStateFromToolResult,
  verifyReviewProgress,
  type ReviewRuntimeState,
  type ReviewVerificationResult
} from "../commands/reviewRuntime";
import {
  buildEvidenceRuntimeState,
  evidenceContinuationMessage,
  evidenceProgressMessage,
  evidenceStateMetadata,
  updateEvidenceStateFromToolResult,
  verifyEvidenceRequirement,
  type EvidenceRuntimeState,
  type EvidenceVerificationResult
} from "./evidenceRuntime";

export type RuntimeGateKind = "goal" | "evidence" | "review";

export interface RuntimeGateVerification {
  kind: RuntimeGateKind;
  complete: boolean;
  summary: string;
  nextAction: string;
  progressMessage: string;
  continuationMessage: string;
  metadata: JsonRecord;
}

export interface RuntimeGate {
  kind: RuntimeGateKind;
  updateFromToolResult(result: ToolResultRecord): void;
  verify(): RuntimeGateVerification | null;
}

interface RuntimeGateFactoryInput {
  request: RoutedChatSubmitRequest;
  messages: ChatMessage[];
  workspaceDir: string;
}

const withInternalMetadata = (
  metadata: JsonRecord,
  timelineKind: string,
  label: string
): JsonRecord => ({
  ...metadata,
  visibility: "internal",
  timelineKind,
  label
});

const goalVerificationToRuntime = (
  verification: GoalVerificationResult
): RuntimeGateVerification => ({
  kind: "goal",
  complete: verification.complete,
  summary: verification.summary,
  nextAction: verification.nextAction,
  progressMessage: goalProgressMessage(verification),
  continuationMessage: goalContinuationMessage(verification),
  metadata: withInternalMetadata(
    goalStateMetadata(verification),
    "goal_state",
    "Goal state"
  )
});

const evidenceVerificationToRuntime = (
  verification: EvidenceVerificationResult
): RuntimeGateVerification => ({
  kind: "evidence",
  complete: verification.complete,
  summary: verification.summary,
  nextAction: verification.nextAction,
  progressMessage: evidenceProgressMessage(verification),
  continuationMessage: evidenceContinuationMessage(verification),
  metadata: evidenceStateMetadata(verification)
});

const reviewVerificationToRuntime = (
  verification: ReviewVerificationResult
): RuntimeGateVerification => ({
  kind: "review",
  complete: verification.complete,
  summary: verification.summary,
  nextAction: verification.nextAction,
  progressMessage: reviewProgressMessage(verification),
  continuationMessage: reviewContinuationMessage(verification),
  metadata: withInternalMetadata(
    reviewStateMetadata(verification),
    "review_state",
    "Review state"
  )
});

const createGoalGate = (
  state: GoalRuntimeState,
  workspaceDir: string
): RuntimeGate => ({
  kind: "goal",
  updateFromToolResult(result) {
    updateGoalStateFromToolResult(state, result);
  },
  verify() {
    const verification = verifyGoalAcceptance(state, workspaceDir);

    return verification ? goalVerificationToRuntime(verification) : null;
  }
});

const createEvidenceGate = (
  state: EvidenceRuntimeState
): RuntimeGate => ({
  kind: "evidence",
  updateFromToolResult(result) {
    updateEvidenceStateFromToolResult(state, result);
  },
  verify() {
    const verification = verifyEvidenceRequirement(state);

    return verification ? evidenceVerificationToRuntime(verification) : null;
  }
});

const createReviewGate = (
  state: ReviewRuntimeState
): RuntimeGate => ({
  kind: "review",
  updateFromToolResult(result) {
    updateReviewStateFromToolResult(state, result);
  },
  verify() {
    const verification = verifyReviewProgress(state);

    return verification ? reviewVerificationToRuntime(verification) : null;
  }
});

export const buildRuntimeGates = (
  input: RuntimeGateFactoryInput
): RuntimeGate[] => {
  const explicitCommandName = input.request.command?.name ?? null;
  const goalState = buildGoalRuntimeState(
    input.request.command,
    input.messages
  );
  const evidenceState = explicitCommandName === "goal" || explicitCommandName === "review"
    ? null
    : buildEvidenceRuntimeState(
        input.request.prompt,
        input.messages
      );
  const reviewState = buildReviewRuntimeState(
    input.request.command,
    input.request.prompt
  );

  const gates: RuntimeGate[] = [];

  if (goalState) {
    gates.push(createGoalGate(goalState, input.workspaceDir));
  }

  if (evidenceState) {
    gates.push(createEvidenceGate(evidenceState));
  }

  if (reviewState) {
    gates.push(createReviewGate(reviewState));
  }

  return gates;
};

export const runtimeGateKinds = (
  gates: RuntimeGate[]
): RuntimeGateKind[] =>
  gates.map(gate => gate.kind);

export const updateRuntimeGatesFromToolResult = (
  gates: RuntimeGate[],
  result: ToolResultRecord
): void => {
  for (const gate of gates) {
    gate.updateFromToolResult(result);
  }
};

export const verifyRuntimeGates = (
  gates: RuntimeGate[]
): RuntimeGateVerification[] =>
  gates
    .map(gate => gate.verify())
    .filter(
      (verification): verification is RuntimeGateVerification =>
        verification !== null
    );

export const firstIncompleteRuntimeGate = (
  gates: RuntimeGate[]
): RuntimeGateVerification | null => {
  const verification = verifyRuntimeGates(gates).find(
    gateVerification => !gateVerification.complete
  );

  return verification ?? null;
};

export const hasRuntimeGate = (
  gates: RuntimeGate[],
  kind: RuntimeGateKind
): boolean =>
  gates.some(gate => gate.kind === kind);

export const runtimeGateProgressMemory = (
  verification: RuntimeGateVerification
): string =>
  `${verification.kind}: ${verification.progressMessage}`;
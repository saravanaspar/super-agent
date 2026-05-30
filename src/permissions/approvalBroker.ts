import type { ApprovalGrantScope } from "@shared/types";

export interface ApprovalOutcome {
  approved: boolean;
  grantScope: ApprovalGrantScope;
}

interface PendingApproval {
  ownerId: number | null;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly expectedOwners = new Map<string, number>();

  constructor(private readonly timeoutMs = 30000) {}

  expectOwner(toolCallId: string, ownerId: number): void {
    this.expectedOwners.set(toolCallId, ownerId);

    const pending = this.pending.get(toolCallId);
    if (pending) {
      pending.ownerId = ownerId;
    }
  }

  waitForApproval(toolCallId: string): Promise<ApprovalOutcome> {
    const existing = this.pending.get(toolCallId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(toolCallId);
      this.expectedOwners.delete(toolCallId);
      existing.resolve({ approved: false, grantScope: "once" });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        this.expectedOwners.delete(toolCallId);
        resolve({ approved: false, grantScope: "once" });
      }, this.timeoutMs);

      this.pending.set(toolCallId, {
        ownerId: this.expectedOwners.get(toolCallId) ?? null,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(toolCallId);
          this.expectedOwners.delete(toolCallId);
          resolve(outcome);
        },
        timer
      });
    });
  }

  resolve(
    toolCallId: string,
    approved: boolean,
    ownerId?: number,
    grantScope: ApprovalGrantScope = "once"
  ): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) return false;
    if (pending.ownerId !== null && ownerId !== pending.ownerId) return false;
    pending.resolve({ approved, grantScope });
    return true;
  }
}

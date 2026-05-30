import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";
import type { ApprovalGrantScope, ToolCallRecord } from "@shared/types";

interface ApprovalDialogProps {
  call: ToolCallRecord;
  reason: string;
  onRespond: (approved: boolean, grantScope?: ApprovalGrantScope) => void;
}

const formatApprovalInput = (input: Record<string, unknown>): string => {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "{}";
  }
};

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function ApprovalDialog({ call, reason, onRespond }: ApprovalDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const firstButton = dialogRef.current?.querySelector<HTMLButtonElement>(
      "button"
    );
    firstButton?.focus();

    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onRespond(false);
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []
    );

    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);

    if (!first || !last) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        onKeyDown={handleKeyDown}
      >
        <div className="approval-header">
          <div>
            <h2 id="approval-title">Approve agent action</h2>
            <p id="approval-description">{reason}</p>
          </div>
          <button
            className="icon-button approval-close"
            type="button"
            aria-label="Deny and close approval"
            onClick={() => onRespond(false)}
          >
            ×
          </button>
        </div>

        <dl className="approval-details">
          <div>
            <dt>Tool</dt>
            <dd>{call.name}</dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd>{call.risk}</dd>
          </div>
        </dl>

        <label className="approval-input-label" htmlFor="approval-input">
          Input
        </label>
        <pre id="approval-input" className="approval-input" tabIndex={0}>
          {formatApprovalInput(call.input)}
        </pre>

        <div className="approval-actions">
          <button type="button" className="secondary" onClick={() => onRespond(false)}>
            Deny
          </button>
          <button type="button" className="primary" onClick={() => onRespond(true, "once")}>
            Allow once
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onRespond(true, "session_tool")}
          >
            Allow always in this session
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onRespond(true, "session_exact_command")}
          >
            Allow exact command in this session
          </button>
        </div>
      </div>
    </div>
  );
}

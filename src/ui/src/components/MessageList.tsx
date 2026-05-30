import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@shared/types";
import { ToolActivity } from "./ToolActivity";
import { MarkdownContent } from "./MarkdownContent";
import {
  buildTurns,
  emptyAssistantFallback,
  formatDuration,
  hasRunActivity,
  labelByRole,
  latestTurnTime,
  parseTime,
  metadataString,
  countToolCalls,
  timelineEntries,
  type Turn,
} from "./chat/messageListModel";

interface MessageListProps {
  messages: ChatMessage[];
  streaming: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
}

interface RegenerateActionProps {
  disabled: boolean;
  onRegenerate: () => void;
}

function RunHeader({
  turn,
  active,
  now,
}: {
  turn: Turn;
  active: boolean;
  now: number;
}) {
  if (!hasRunActivity(turn)) return null;

  const start = parseTime(turn.user.createdAt);
  const end = active ? now : latestTurnTime(turn) || start;
  const label = active ? "Working for" : "Worked for";

  return (
    <div className="run-header">
      <span>
        {label} {formatDuration(end - start)}
      </span>
    </div>
  );
}

function ProgressItem({ message }: { message: ChatMessage }) {
  return (
    <div className="progress-line">
      <MarkdownContent content={message.content} />
    </div>
  );
}

function WaitingTimeline() {
  return (
    <div className="progress-line pending-response">
      Waiting for model output. If this stays here, stop the run and use a
      stronger tool-calling model or regenerate.
    </div>
  );
}

function ThinkingTimeline({
  messages,
  active,
}: {
  messages: ChatMessage[];
  active: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  if (!active && messages.length === 0) return null;

  const thinkingText = messages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const summary = active ? "Thinking" : "Thinking";
  const hasThinkingText = thinkingText.length > 0;

  return (
    <section className="thinking-timeline" aria-label="Model reasoning">
      <button
        className="tool-group-summary thinking-summary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className={open ? "tool-glyph open" : "tool-glyph"}
          aria-hidden="true"
        >
          ▻
        </span>
        <span>{summary}</span>
        <span className={open ? "chevron open" : "chevron"}>⌄</span>
      </button>
      {open ? (
        hasThinkingText ? (
          <pre className="thinking-raw-content">{thinkingText}</pre>
        ) : (
          <div className="thinking-hidden-note">
            No model reasoning text was received. Tool progress and the final
            answer remain visible.
          </div>
        )
      ) : null}
    </section>
  );
}

function ToolTimeline({
  messages,
  active,
  open,
  onOpenChange,
}: {
  messages: ChatMessage[];
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (messages.length === 0) return null;

  const commandCount = Math.max(
    countToolCalls(messages),
    Math.ceil(messages.length / 2),
  );
  const summary = active
    ? `Running ${commandCount} command${commandCount === 1 ? "" : "s"}`
    : `Ran ${commandCount} command${commandCount === 1 ? "" : "s"}`;

  return (
    <section className="tool-timeline">
      <button
        className="tool-group-summary"
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span
          className={open ? "tool-glyph open" : "tool-glyph"}
          aria-hidden="true"
        >
          ▻
        </span>
        <span>{summary}</span>
        <span className={open ? "chevron open" : "chevron"}>⌄</span>
      </button>
      {open ? <ToolActivity messages={messages} /> : null}
    </section>
  );
}

function RegenerateIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M15.2 7.4A5.8 5.8 0 1 0 16 10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path
        d="M15.3 3.7v3.8h-3.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function RegenerateAction({ disabled, onRegenerate }: RegenerateActionProps) {
  return (
    <button
      className="message-regenerate"
      type="button"
      aria-label="Regenerate response"
      title="Regenerate"
      disabled={disabled}
      onClick={onRegenerate}
    >
      <RegenerateIcon />
      <span className="message-regenerate-tooltip" role="tooltip">
        Regenerate
      </span>
    </button>
  );
}

interface SkillContextView {
  budgetTokens: number | null;
  usedTokens: number;
  deferredTokens: number;
  warnings: Array<{
    severity: string;
    code: string;
    message: string;
    path: string;
  }>;
  heatmap: Array<{
    skillName: string;
    path: string;
    type: string;
    tokenEstimate: number;
    injected: boolean;
  }>;
  references: Array<{
    id: string;
    name: string;
    mode: string;
    tokenEstimate: number;
    score: number;
    reason: string;
    injection: string;
    matchedTerms: string[];
  }>;
}

const safeString = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

const safeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const skillContextView = (message: ChatMessage): SkillContextView | null => {
  const raw = message.metadata.skillContext;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const references = Array.isArray(record.references) ? record.references : [];
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  const heatmap = Array.isArray(record.heatmap) ? record.heatmap : [];
  const parsedHeatmap = heatmap.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    return [{
      skillName: safeString(entry.skillName),
      path: safeString(entry.path),
      type: safeString(entry.type),
      tokenEstimate: safeNumber(entry.tokenEstimate),
      injected: entry.injected === true
    }];
  });

  return {
    budgetTokens: typeof record.budgetTokens === "number" ? record.budgetTokens : null,
    usedTokens: safeNumber(record.usedTokens),
    deferredTokens: parsedHeatmap.filter((item) => !item.injected).reduce((total, item) => total + item.tokenEstimate, 0),
    warnings: warnings.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const warning = item as Record<string, unknown>;
      return [{
        severity: safeString(warning.severity),
        code: safeString(warning.code),
        message: safeString(warning.message),
        path: safeString(warning.path)
      }];
    }),
    heatmap: parsedHeatmap
      .sort((left, right) => right.tokenEstimate - left.tokenEstimate)
      .slice(0, 12),
    references: references.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const ref = item as Record<string, unknown>;
      return [{
        id: safeString(ref.id),
        name: safeString(ref.name),
        mode: safeString(ref.mode),
        tokenEstimate: safeNumber(ref.tokenEstimate),
        score: safeNumber(ref.score),
        reason: safeString(ref.reason),
        injection: safeString(ref.injection),
        matchedTerms: Array.isArray(ref.matchedTerms)
          ? ref.matchedTerms.filter((term): term is string => typeof term === "string")
          : []
      }];
    })
  };
};

function MessageCard({
  message,
  showRegenerate = false,
  regenerateDisabled = false,
  onRegenerate,
}: {
  message: ChatMessage;
  showRegenerate?: boolean;
  regenerateDisabled?: boolean;
  onRegenerate?: () => void;
}) {
  const rawCommand = metadataString(message, "rawCommand");
  const content =
    message.role === "user" && rawCommand
      ? rawCommand
      : message.content ||
        (message.status === "streaming"
          ? "Working"
          : message.role === "assistant"
            ? emptyAssistantFallback
            : "");

  const shouldRenderMarkdown = message.role === "assistant";
  const skillContext = message.role === "user" ? skillContextView(message) : null;

  return (
    <article className={`message ${message.role} ${message.status}`}>
      <div className="message-label">
        {typeof message.metadata.label === "string"
          ? message.metadata.label
          : labelByRole[message.role]}
      </div>
      <div className="message-content">
        {shouldRenderMarkdown ? <MarkdownContent content={content} /> : content}
      </div>
      {skillContext && skillContext.references.length > 0 ? (
        <details className="message-skill-context">
          <summary>
            Skills injected: {skillContext.references.length} · {skillContext.usedTokens.toLocaleString()} est. tokens
            {skillContext.deferredTokens ? ` · ${skillContext.deferredTokens.toLocaleString()} deferred` : ""}
            {skillContext.warnings.length ? ` · ${skillContext.warnings.length} warning${skillContext.warnings.length === 1 ? "" : "s"}` : ""}

          </summary>
          <div>
            {skillContext.warnings.length > 0 ? (
              <section className="skill-context-warning-list">
                <strong>Context warnings</strong>
                {skillContext.warnings.map((warning) => (
                  <small key={`${warning.code}-${warning.path}`}>{warning.severity}: {warning.message}</small>
                ))}
              </section>
            ) : null}
            {skillContext.references.map((ref) => (
              <section key={`${ref.id}-${ref.mode}`}>
                <strong>{ref.name}</strong>
                <span>{ref.mode} · {ref.injection} · {ref.tokenEstimate.toLocaleString()} tokens</span>
                <p>{ref.reason}</p>
                {ref.matchedTerms.length > 0 ? <small>Matched: {ref.matchedTerms.join(", ")}</small> : null}
              </section>
            ))}
            {skillContext.heatmap.length > 0 ? (
              <section className="skill-context-heatmap">
                <strong>Context heatmap</strong>
                {skillContext.heatmap.map((item) => (
                  <span key={`${item.skillName}-${item.path}`}>
                    {item.injected ? "Injected" : "Deferred"} · {item.skillName} · {item.path} · {item.type} · {item.tokenEstimate.toLocaleString()} tokens
                  </span>
                ))}
              </section>
            ) : null}
          </div>
        </details>
      ) : null}
      {showRegenerate && onRegenerate ? (
        <RegenerateAction
          disabled={regenerateDisabled}
          onRegenerate={onRegenerate}
        />
      ) : null}
    </article>
  );
}

function TurnTimeline({
  turn,
  active,
  now,
  canRegenerate,
  onRegenerate,
  showRegenerateForTurn,
  toolOpen,
  onToolOpenChange,
}: {
  turn: Turn;
  active: boolean;
  now: number;
  canRegenerate: boolean;
  onRegenerate: () => void;
  showRegenerateForTurn: boolean;
  toolOpen: boolean;
  onToolOpenChange: (open: boolean) => void;
}) {
  const entries = timelineEntries(turn, active);
  const finalMessageIds = new Set(
    entries
      .filter(
        (entry): entry is { kind: "message"; message: ChatMessage } =>
          entry.kind === "message",
      )
      .map((entry) => entry.message.id),
  );
  const lastFinalMessageId = [...finalMessageIds].at(-1);

  return (
    <div className="run-timeline">
      <RunHeader turn={turn} active={active} now={now} />
      {entries.map((entry, index) => {
        if (entry.kind === "progress") {
          return (
            <ProgressItem message={entry.message} key={entry.message.id} />
          );
        }

        if (entry.kind === "waiting") {
          return <WaitingTimeline key={`waiting-${index}`} />;
        }

        if (entry.kind === "thinking") {
          return (
            <ThinkingTimeline
              messages={entry.messages}
              active={entry.active}
              key={`thinking-${index}`}
            />
          );
        }

        if (entry.kind === "tools") {
          return (
            <ToolTimeline
              messages={entry.messages}
              active={entry.active}
              open={toolOpen}
              onOpenChange={onToolOpenChange}
              key={`tools-${turn.user.id}`}
            />
          );
        }

        return (
          <MessageCard
            message={entry.message}
            key={entry.message.id}
            showRegenerate={
              showRegenerateForTurn &&
              entry.message.id === lastFinalMessageId &&
              entry.message.role === "assistant"
            }
            regenerateDisabled={active || !canRegenerate}
            onRegenerate={onRegenerate}
          />
        );
      })}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  canRegenerate,
  onRegenerate,
}: MessageListProps) {
  const { beforeTurns, turns } = buildTurns(messages);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [now, setNow] = useState(Date.now());
  const [openToolTurnIds, setOpenToolTurnIds] = useState<Set<string>>(
    () => new Set(),
  );
  const scrollSignature = useMemo(
    () =>
      messages
        .map((message) =>
          [message.id, message.status, message.content.length].join(":"),
        )
        .join("|"),
    [messages],
  );

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    if (!streaming) setOpenToolTurnIds(new Set());
  }, [streaming]);

  const setToolTimelineOpen = (turnId: string, open: boolean): void => {
    setOpenToolTurnIds((current) => {
      const next = new Set(current);
      if (open) next.add(turnId);
      else next.delete(turnId);
      return next;
    });
  };

  const updateStickToBottom = () => {
    const container = scrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 96;
  };

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !stickToBottomRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      const bottom = bottomRef.current;
      if (typeof bottom?.scrollIntoView === "function") {
        bottom.scrollIntoView({ block: "end" });
        return;
      }
      container.scrollTop = container.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [scrollSignature, streaming, now]);

  if (beforeTurns.length === 0 && turns.length === 0) {
    return (
      <div className="empty-chat">
        <div className="empty-chat-content">
          <h1>Ready when you are.</h1>
          <p>
            Send a request. The workspace stays blank until the agent needs a
            browser or visual surface.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="messages"
      aria-live="polite"
      ref={scrollRef}
      onScroll={updateStickToBottom}
    >
      {beforeTurns.map((message) => (
        <MessageCard key={message.id} message={message} />
      ))}

      {turns.map((turn, index) => {
        const active = streaming && index === turns.length - 1;
        return (
          <div className="turn" key={turn.user.id}>
            <MessageCard message={turn.user} />
            <TurnTimeline
              turn={turn}
              active={active}
              now={now}
              canRegenerate={canRegenerate}
              onRegenerate={onRegenerate}
              showRegenerateForTurn={!streaming && index === turns.length - 1}
              toolOpen={openToolTurnIds.has(turn.user.id)}
              onToolOpenChange={(open) =>
                setToolTimelineOpen(turn.user.id, open)
              }
            />
          </div>
        );
      })}

      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

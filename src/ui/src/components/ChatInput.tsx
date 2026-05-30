import type { ChangeEvent, KeyboardEvent, PointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AttachmentMetadata,
  ModelOption,
  PermissionMode,
  SkillRecord
} from "@shared/types";
import type { AgentCommandDefinition } from "../../../commands";
import { parseAgentCommandInput } from "../../../commands";
import {
  estimateTokens,
  matchingCommands,
  matchingSkills,
  modelContextWindow,
  modelValue,
  modelWidth,
  permissionLabels,
  readableSize,
  scoreSkillForPrompt,
  selectedCommandDefinition,
  selectedModelValue,
  shouldIgnoreComposerPointer,
  shouldShowCommandMenu,
  findSkillToken,
  isSlashInput,
  skillInstructionText,
  skillSupportTokens,
} from "./chat/chatInputUtils";

export interface ChatInputProps {
  value: string;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  permissionMode: PermissionMode;
  attachments: AttachmentMetadata[];
  streaming: boolean;
  workspaceLabel: string;
  skills: SkillRecord[];
  selectedSkillIds: string[];
  onValueChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onPermissionChange: (value: PermissionMode) => void;
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSelectWorkspace: () => void;
  onSelectedSkillIdsChange: (ids: string[]) => void;
  onSubmit: () => void;
  onStop: () => void;
}

export function ChatInput(props: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [caretPosition, setCaretPosition] = useState(0);
  const parsedCommand = parseAgentCommandInput(props.value);
  const exactCommand = selectedCommandDefinition(parsedCommand.command?.name);
  const commandMatches = useMemo(
    () => matchingCommands(props.value),
    [props.value]
  );
  const skillToken = useMemo(
    () => findSkillToken(props.value, caretPosition),
    [caretPosition, props.value]
  );
  const skillMatches = useMemo(
    () => matchingSkills(props.skills, skillToken),
    [props.skills, skillToken]
  );
  const selectedSkills = useMemo(
    () =>
      props.selectedSkillIds
        .map((id) =>
          props.skills.find(
            (skill) =>
              skill.id === id &&
              skill.enabled &&
              skill.lifecycleState !== "archived"
          ) ?? null
        )
        .filter((skill): skill is SkillRecord => skill !== null),
    [props.selectedSkillIds, props.skills]
  );

  const manualSkillTokens = useMemo(
    () => selectedSkills.reduce((total, skill) => total + estimateTokens(skillInstructionText(skill)), 0),
    [selectedSkills]
  );
  const manualDeferredTokens = useMemo(
    () => selectedSkills.reduce((total, skill) => total + skillSupportTokens(skill), 0),
    [selectedSkills]
  );
  const contextWindow = modelContextWindow(props.selectedModel);
  const skillContextWarning = Boolean(contextWindow && manualSkillTokens > Math.floor(contextWindow * 0.05));
  const autoRoutePreview = useMemo(
    () =>
      props.skills
        .filter(
          (skill) =>
            skill.enabled &&
            skill.autoRouting &&
            skill.lifecycleState !== "archived" &&
            !props.selectedSkillIds.includes(skill.id)
        )
        .map((skill) => scoreSkillForPrompt(skill, props.value))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
        .slice(0, 5),
    [props.selectedSkillIds, props.skills, props.value]
  );

  const autoInstructionTokens = autoRoutePreview.reduce((total, item) => total + estimateTokens(skillInstructionText(item.skill)), 0);
  const autoDeferredTokens = autoRoutePreview.reduce((total, item) => total + skillSupportTokens(item.skill), 0);

  const commandDraftActive = shouldShowCommandMenu(props.value);
  const showSkillMenu = skillMenuOpen && skillMatches.length > 0;
  const showCommandMenu =
    !showSkillMenu &&
    commandMenuOpen &&
    commandDraftActive &&
    commandMatches.length > 0;
  const commandListboxId = useRef(
    `command-menu-${crypto.randomUUID()}`
  ).current;
  const skillListboxId = useRef(`skill-menu-${crypto.randomUUID()}`).current;
  const activeCommandId = showCommandMenu
    ? `${commandListboxId}-${commandMatches[selectedCommandIndex]?.name ?? "none"}`
    : undefined;
  const activeSkillId = showSkillMenu
    ? `${skillListboxId}-${skillMatches[selectedSkillIndex]?.id ?? "none"}`
    : undefined;

  const commandHasBody =
    parsedCommand.command !== null && parsedCommand.prompt.trim().length > 0;

  const hasWorkspace =
    props.workspaceLabel.trim().length > 0 &&
    props.workspaceLabel !== "No project selected";
  const projectLabel = hasWorkspace
    ? props.workspaceLabel
    : "No project selected";

  const canSend =
    props.value.trim().length > 0 &&
    props.selectedModel !== null &&
    !props.streaming &&
    (!isSlashInput(props.value) || commandHasBody);

  const modelSelectStyle = useMemo(
    () => ({
      width: modelWidth(props.selectedModel)
    }),
    [props.selectedModel]
  );

  const focusTextarea = () => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const syncCaret = () => {
    setCaretPosition(textareaRef.current?.selectionStart ?? props.value.length);
  };

  useEffect(() => {
    if (selectedCommandIndex >= commandMatches.length) {
      setSelectedCommandIndex(0);
    }
  }, [commandMatches.length, selectedCommandIndex]);

  useEffect(() => {
    if (selectedSkillIndex >= skillMatches.length) {
      setSelectedSkillIndex(0);
    }
  }, [selectedSkillIndex, skillMatches.length]);

  useEffect(() => {
    focusTextarea();
  }, [props.streaming]);

  useEffect(() => {
    setSkillMenuOpen(skillToken !== null);
  }, [skillToken]);

  const selectCommand = (command: AgentCommandDefinition) => {
    props.onValueChange(`/${command.name} `);
    setCommandMenuOpen(false);
    setSelectedCommandIndex(0);
    focusTextarea();
  };

  const selectHighlightedCommand = () => {
    const command = commandMatches[selectedCommandIndex] ?? commandMatches[0];

    if (command) {
      selectCommand(command);
    }
  };

  const selectSkill = (skill: SkillRecord) => {
    const range = findSkillToken(
      props.value,
      textareaRef.current?.selectionStart ?? caretPosition
    );
    const start = range?.start ?? props.value.length;
    const end = range?.end ?? props.value.length;
    const label = `$${skill.name}`;
    const needsLeadingSpace = start > 0 && !/\s/.test(props.value[start - 1] ?? "");
    const prefix = needsLeadingSpace ? " " : "";
    const nextValue = `${props.value.slice(0, start)}${prefix}${label} ${props.value.slice(end)}`;
    const nextCursor = start + prefix.length + label.length + 1;

    if (!props.selectedSkillIds.includes(skill.id)) {
      props.onSelectedSkillIdsChange([...props.selectedSkillIds, skill.id]);
    }

    props.onValueChange(nextValue);
    setSkillMenuOpen(false);
    setSelectedSkillIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCaretPosition(nextCursor);
    });
  };

  const selectHighlightedSkill = () => {
    const skill = skillMatches[selectedSkillIndex] ?? skillMatches[0];

    if (skill) {
      selectSkill(skill);
    }
  };

  const removeSelectedSkill = (skillId: string) => {
    props.onSelectedSkillIdsChange(
      props.selectedSkillIds.filter((id) => id !== skillId)
    );
    focusTextarea();
  };

  const handleComposerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (shouldIgnoreComposerPointer(event.target)) {
      return;
    }

    focusTextarea();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSkillMenu) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillMenuOpen(false);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSkillIndex((current) =>
          skillMatches.length === 0 ? 0 : (current + 1) % skillMatches.length
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSkillIndex((current) =>
          skillMatches.length === 0
            ? 0
            : (current - 1 + skillMatches.length) % skillMatches.length
        );
        return;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        selectHighlightedSkill();
        return;
      }
    }

    if (showCommandMenu) {
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandMenuOpen(false);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommandIndex((current) =>
          commandMatches.length === 0
            ? 0
            : (current + 1) % commandMatches.length
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedCommandIndex((current) =>
          commandMatches.length === 0
            ? 0
            : (current - 1 + commandMatches.length) % commandMatches.length
        );
        return;
      }

      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        selectHighlightedCommand();
        return;
      }
    }

    if (commandDraftActive && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (commandMatches.length > 0) {
        selectHighlightedCommand();
      }

      return;
    }

    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();

    if (canSend) {
      props.onSubmit();
    }
  };

  const handleValueChange = (value: string, nextCaret: number) => {
    props.onValueChange(value);
    setCaretPosition(nextCaret);
    setSelectedCommandIndex(0);
    setSelectedSkillIndex(0);
    setCommandMenuOpen(shouldShowCommandMenu(value));
    setSkillMenuOpen(findSkillToken(value, nextCaret) !== null);
  };

  const handleAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;

    if (files && files.length > 0) {
      props.onAttach(files);
    }

    event.target.value = "";
    focusTextarea();
  };

  return (
    <div className="composer" aria-label="Chat composer">
      <div className="composer-box" onPointerDown={handleComposerPointerDown}>
        {props.attachments.length > 0 ? (
          <div className="attachments" aria-label="Attached files">
            {props.attachments.map((attachment) => (
              <button
                key={attachment.id}
                className="attachment-chip"
                type="button"
                title={`Remove ${attachment.name}`}
                aria-label={`Remove attachment ${attachment.name}`}
                onClick={() => props.onRemoveAttachment(attachment.id)}
              >
                {attachment.name}
                <span className="attachment-size">
                  {readableSize(attachment.size)}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {selectedSkills.length > 0 ? (
          <div className="selected-skill-row" aria-label="Selected skills">
            {selectedSkills.map((skill) => (
              <button
                key={skill.id}
                className="selected-skill-chip"
                type="button"
                title={`Remove ${skill.name}`}
                onClick={() => removeSelectedSkill(skill.id)}
              >
                <span>$</span>
                <strong>{skill.name}</strong>
              </button>
            ))}
          </div>
        ) : null}

        {(selectedSkills.length > 0 || autoRoutePreview.length > 0) ? (
          <div className="skill-context-meter" aria-label="Skill context estimate">
            {selectedSkills.length > 0 ? (
              <span>Manual skill context: {manualSkillTokens.toLocaleString()} est. tokens injected{manualDeferredTokens ? ` · ${manualDeferredTokens.toLocaleString()} available on demand` : ""}</span>
            ) : null}
            {autoRoutePreview.length > 0 ? (
              <span>Auto skill context: {autoInstructionTokens.toLocaleString()} est. tokens injected{autoDeferredTokens ? ` · ${autoDeferredTokens.toLocaleString()} available on demand` : ""}</span>
            ) : null}
            {skillContextWarning ? (
              <span>Selected skill instructions are large. Remove unused skill chips or let auto-routing pick the smallest relevant set.</span>
            ) : null}
            {autoRoutePreview.length > 0 ? (
              <span>Auto preview: {autoRoutePreview.map((item) => `${item.skill.name} ${item.score}`).join(", ")}</span>
            ) : null}
          </div>
        ) : null}

        <div className="composer-input-wrap">
          {showSkillMenu ? (
            <div
              id={skillListboxId}
              className="command-menu skill-menu"
              role="listbox"
              aria-label="Available skills"
            >
              {skillMatches.map((skill, index) => {
                const selected = props.selectedSkillIds.includes(skill.id);

                return (
                  <button
                    id={`${skillListboxId}-${skill.id}`}
                    key={skill.id}
                    className={
                      index === selectedSkillIndex
                        ? "command-menu-item active"
                        : "command-menu-item"
                    }
                    type="button"
                    role="option"
                    aria-selected={index === selectedSkillIndex}
                    onMouseEnter={() => setSelectedSkillIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSkill(skill)}
                  >
                    <span className="command-menu-label">
                      {skill.name}
                      {selected ? <em>Selected</em> : null}
                    </span>
                    <span className="command-menu-description">
                      {skill.description}
                    </span>
                    <span className="command-menu-usage">${skill.id}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {showCommandMenu ? (
            <div
              id={commandListboxId}
              className="command-menu"
              role="listbox"
              aria-label="Available commands"
            >
              {commandMatches.map((command, index) => (
                <button
                  id={`${commandListboxId}-${command.name}`}
                  key={command.name}
                  className={
                    index === selectedCommandIndex
                      ? "command-menu-item active"
                      : "command-menu-item"
                  }
                  type="button"
                  role="option"
                  aria-selected={index === selectedCommandIndex}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectCommand(command)}
                >
                  <span className="command-menu-label">{command.label}</span>
                  <span className="command-menu-description">
                    {command.description}
                  </span>
                  <span className="command-menu-usage">{command.usage}</span>
                </button>
              ))}
            </div>
          ) : null}

          <button
            className={
              hasWorkspace
                ? "composer-project-context"
                : "composer-project-context no-project"
            }
            type="button"
            title={projectLabel}
            aria-label={
              hasWorkspace
                ? `Selected project ${props.workspaceLabel}. Change project`
                : "Select project"
            }
            onClick={props.onSelectWorkspace}
          >
            <span>Project</span>
            <strong>{projectLabel}</strong>
          </button>

          {parsedCommand.command ? (
            <div className="active-command" aria-label="Selected command">
              <span>{parsedCommand.command.name}</span>
              <strong>{exactCommand?.description ?? "Command mode"}</strong>
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            role="combobox"
            aria-label="Message Super Agent"
            aria-autocomplete="list"
            aria-expanded={showCommandMenu || showSkillMenu}
            aria-haspopup="listbox"
            aria-controls={
              showSkillMenu
                ? skillListboxId
                : showCommandMenu
                  ? commandListboxId
                  : undefined
            }
            aria-activedescendant={activeSkillId ?? activeCommandId}
            placeholder={
              props.streaming
                ? "Type your next message while this response finishes"
                : parsedCommand.command
                  ? (exactCommand?.placeholder ?? "Describe the command input")
                  : "Message Super Agent"
            }
            value={props.value}
            onChange={(event) =>
              handleValueChange(event.target.value, event.target.selectionStart)
            }
            onClick={syncCaret}
            onKeyUp={syncCaret}
            onFocus={() => {
              syncCaret();
              setCommandMenuOpen(shouldShowCommandMenu(props.value));
              setSkillMenuOpen(
                findSkillToken(
                  props.value,
                  textareaRef.current?.selectionStart ?? props.value.length
                ) !== null
              );
            }}
            onKeyDown={handleKeyDown}
            rows={3}
          />
        </div>

        <div className="composer-controls">
          <div className="composer-controls-left">
            <select
              className="composer-select composer-model-select"
              aria-label="Model selector"
              value={selectedModelValue(props.selectedModel)}
              style={modelSelectStyle}
              onChange={(event) => props.onModelChange(event.target.value)}
              disabled={props.models.length === 0}
            >
              {props.models.length === 0 ? (
                <option value="">No models configured</option>
              ) : null}

              {props.models.map((model) => (
                <option key={modelValue(model)} value={modelValue(model)}>
                  {model.label}
                </option>
              ))}
            </select>

            <select
              className="composer-select composer-permission-select"
              aria-label="Permission mode"
              value={props.permissionMode}
              onChange={(event) =>
                props.onPermissionChange(event.target.value as PermissionMode)
              }
            >
              {Object.entries(permissionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <button
              className="button secondary attach-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              Attach
            </button>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={handleAttachmentChange}
            />
          </div>

          <div className="composer-controls-right">
            {props.streaming ? (
              <button
                className="button danger"
                type="button"
                onClick={props.onStop}
              >
                Stop
              </button>
            ) : (
              <button
                className="button primary"
                type="button"
                onClick={props.onSubmit}
                disabled={!canSend}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

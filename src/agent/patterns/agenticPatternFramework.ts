import type { AgentKind, AgenticPatternDecision, AgenticPatternKey, ChatMessage, ChatSubmitRequest } from "@shared/types";

interface DecisionRuleInput {
  request: ChatSubmitRequest;
  messages: ChatMessage[];
  lowerPrompt: string;
}

const includesAny = (text: string, terms: readonly string[]): boolean => terms.some((term) => text.includes(term));

const orderedTerms = ["step by step", "sequence", "first", "then", "after that", "workflow", "checklist"] as const;
const adaptiveTerms = ["explore", "research", "browse", "investigate", "debug", "unknown", "find out", "try", "observe"] as const;
const toolTerms = ["browser", "open", "navigate", "click", "type", "screenshot", "file", "read", "write", "shell", "terminal", "run", "workspace", "api", "database", "website", "url", "http"] as const;
const planningTerms = ["build", "implement", "refactor", "design", "plan", "architecture", "project", "tests", "exact framework", "framework"] as const;
const speedTerms = ["quick", "fast", "rough", "draft", "speed", "asap", "throughput"] as const;
const qualityTerms = ["exact", "accurate", "quality", "safe", "secure", "production", "regression", "test", "reliable", "verify"] as const;

export const patternLabels: Record<AgenticPatternKey, string> = {
  known_path: "Known Path (Deterministic)",
  unknown_path: "Unknown Path (Adaptive)",
  sequential_workflow: "Sequential Workflow",
  parallel_dynamic_flow: "Parallel / Dynamic Flow",
  tool_enabled_agent: "Tool-Enabled Agent",
  pure_llm_agent: "Pure LLM Agent",
  planning_pattern: "Planning Pattern",
  react_pattern: "ReAct Pattern",
  quality_first_pattern: "Quality-First Pattern",
  speed_first_pattern: "Speed-First Pattern",
  single_agent_pattern: "Single-Agent Pattern"
};

const agentNeedsTools = (agentKind: AgentKind | undefined): boolean =>
  ["browser", "desktop", "coding"].includes(agentKind ?? "general");

const choosePathPattern = (input: DecisionRuleInput): AgenticPatternDecision["path"] => {
  const known = includesAny(input.lowerPrompt, orderedTerms) || input.request.agentKind === "coding";
  const adaptive = includesAny(input.lowerPrompt, adaptiveTerms) || input.request.agentKind === "browser";
  const selected = known && !adaptive ? "known_path" : "unknown_path";
  return {
    question: "Are the steps to the solution known in advance?",
    answer: selected === "known_path" ? "yes" : "no",
    selected,
    rationale: selected === "known_path" ? "The request can be handled through a predictable sequence." : "The request may require observation, adaptation, or discovery."
  };
};

const chooseFlowPattern = (input: DecisionRuleInput): AgenticPatternDecision["flow"] => {
  const dynamic = input.request.agentKind === "browser" || includesAny(input.lowerPrompt, adaptiveTerms);
  const selected = dynamic && !includesAny(input.lowerPrompt, orderedTerms) ? "parallel_dynamic_flow" : "sequential_workflow";
  return {
    question: "Is the workflow mainly sequential?",
    answer: selected === "sequential_workflow" ? "yes" : "no",
    selected,
    rationale: selected === "sequential_workflow" ? "Actions should run in order, one after another." : "Steps may change based on observations or intermediate results."
  };
};

const chooseToolPattern = (input: DecisionRuleInput): AgenticPatternDecision["tooling"] => {
  const selected = agentNeedsTools(input.request.agentKind) || includesAny(input.lowerPrompt, toolTerms) || input.request.attachments.length > 0 ? "tool_enabled_agent" : "pure_llm_agent";
  return {
    question: "Do you need tools, data, or external systems?",
    answer: selected === "tool_enabled_agent" ? "yes" : "no",
    selected,
    rationale: selected === "tool_enabled_agent" ? "The task benefits from registered tools, files, browser state, or workspace data." : "The task can be answered directly from model context."
  };
};

const chooseExecutionPattern = (input: DecisionRuleInput): AgenticPatternDecision["execution"] => {
  const needsPlan = input.request.agentKind === "coding" || includesAny(input.lowerPrompt, planningTerms);
  const explores = input.request.agentKind === "browser" || includesAny(input.lowerPrompt, adaptiveTerms);
  const selected = needsPlan && !explores ? "planning_pattern" : "react_pattern";
  return {
    question: "Does the task require planning ahead or exploring as you go?",
    answer: selected === "planning_pattern" ? "plan" : "explore",
    selected,
    rationale: selected === "planning_pattern" ? "Create a plan first, then execute the steps." : "Explore, observe, adapt, and repeat."
  };
};

const choosePriorityPattern = (input: DecisionRuleInput): AgenticPatternDecision["priority"] => {
  const speedRequested = includesAny(input.lowerPrompt, speedTerms) && !includesAny(input.lowerPrompt, qualityTerms);
  const selected = speedRequested ? "speed_first_pattern" : "quality_first_pattern";
  return {
    question: "Is quality / accuracy more important than speed?",
    answer: selected === "quality_first_pattern" ? "yes" : "no",
    selected,
    rationale: selected === "quality_first_pattern" ? "Prioritize accuracy, reliability, and permission-safe execution." : "Prioritize speed and throughput while preserving safety."
  };
};

const singleAgentDecision = (): AgenticPatternDecision["agents"] => ({
  question: "Would multiple agents work together better than one?",
  answer: "no",
  selected: "single_agent_pattern",
  rationale: "Multi-agent orchestration is intentionally disabled for this MVP. One agent owns the task."
});

export const chooseAgenticPatterns = (request: ChatSubmitRequest, messages: ChatMessage[]): AgenticPatternDecision => {
  const lowerPrompt = request.prompt.toLowerCase();
  const input = { request, messages, lowerPrompt };
  const path = choosePathPattern(input);
  const flow = chooseFlowPattern(input);
  const tooling = chooseToolPattern(input);
  const execution = chooseExecutionPattern(input);
  const priority = choosePriorityPattern(input);
  const agents = singleAgentDecision();
  const selectedPatterns = [path.selected, flow.selected, tooling.selected, execution.selected, priority.selected, agents.selected];
  return { path, flow, tooling, execution, priority, agents, selectedPatterns };
};

export const formatPatternDecision = (decision: AgenticPatternDecision): string => {
  const items = [decision.path, decision.flow, decision.tooling, decision.execution, decision.priority, decision.agents];
  return items.map((item) => `${item.question} ${item.answer.toUpperCase()} -> ${patternLabels[item.selected]}`).join("\n");
};

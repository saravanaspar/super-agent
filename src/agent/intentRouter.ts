import type { AgentKind, ChatSubmitRequest } from "@shared/types";

const browserIntentPattern =
  /\b(browser|website|web page|navigate|screenshot|click|form|url|localhost)\b/i;
const codingIntentPattern =
  /\b(code|repo|repository|file|bug|fix|patch|edit|implement|test|build|npm|typescript|react|electron|function)\b/i;
const desktopIntentPattern =
  /\b(app|desktop|window|unity|unreal|visual verify|screen)\b/i;

export const routeAgentKind = (request: ChatSubmitRequest): AgentKind => {
  if (request.command?.name === "review") return "coding";

  if (browserIntentPattern.test(request.prompt)) return "browser";
  if (codingIntentPattern.test(request.prompt)) return "coding";
  if (desktopIntentPattern.test(request.prompt)) return "desktop";

  return "general";
};

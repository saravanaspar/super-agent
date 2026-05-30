const codeGoalPattern =
  /\b(code|app|repo|project|fix|bug|test|lint|typecheck|build|compile|typescript|javascript|react|electron|python|rust|go|java|api|server|client|database|security|scalab(?:le|ility)|enterprise)\b/i;

export const requiresVerificationCommand = (description: string): boolean =>
  codeGoalPattern.test(description);

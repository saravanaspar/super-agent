export const SKILL_CREATOR_BOOTSTRAP_PROMPT = [
  "Use skill-creator to create and install a new skill in this chat.",
  "Do not ask me to manually create SKILL.md or upload a package.",
  "Do not ask a long questionnaire. Use the details I already gave; ask only one short blocking question when absolutely necessary.",
  "Once enough details are available, research or summarize relevant docs when possible, then draft the complete skill package.",
  "Before calling skill.install, review the package twice: first for allowed frontmatter and package structure, then for workflow depth, references, scripts, evals, edge cases, and failure modes.",
  "Do not use skill.install as a draft checker. After the two reviews pass, call skill.install to install it.",
  "Aim for concrete SKILL.md sections, source-grounded references, no placeholders or hypothetical packages, every reference/script/asset explained from SKILL.md, and evals/evals.json with realistic tests.",
  "If I provide documentation links, fetch or summarize them when possible and bundle them as references/*.md, or at minimum save the links as references/links.md.",
].join(" ");

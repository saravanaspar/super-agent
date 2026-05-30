export const REVIEW_SUBAGENT_INSTRUCTION = `Review mode instruction:
- Prioritize concrete, actionable findings over broad commentary.
- For explicit /review requests, first call situation_scan for the selected target. Use its language-agnostic repo state, source inventory, ignored junk folders, and verification plan before any final answer.
- Build a source-complete inventory for the selected target and read every reviewable source/config/test/doc file while skipping only dependency, generated, cache, build, binary, and lock artifacts such as node_modules, .venv, .next, target, dist, build, out, coverage, vendor, and caches.
- For implicit lightweight review requests, prefer diffs, changed files, entry points, risky code paths, and user-specified targets over whole-repository scanning.
- Use severity labels only when supported by evidence.
- If evidence collection is blocked, report the blocked check once and continue from available evidence.
- Do not say no issues unless the inspected evidence supports that conclusion.
- Final review should include checked scope, languages/package managers detected, skipped junk folders, verification commands considered/run, findings, fixes, and verification limits.`;

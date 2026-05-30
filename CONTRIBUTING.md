# Contributing

## Setup

```bash
git clone https://github.com/saravanaspar/super-agent.git
cd super-agent
npm install
npm run dev
```

Platform sandbox backends (optional): `bubblewrap` (Linux), `sandbox-exec` (macOS, built-in), `docker`/`podman` (Windows).

## Conventions

- TypeScript 6 strict mode. No `any`. Prefer `import type` for compile-time-only imports.
- `camelCase` for variables/functions, `PascalCase` for types/interfaces/components, `kebab-case` for filenames.
- Use path aliases (`@agent/`, `@providers/`, `@ui/`, `@shared/`, etc.) — no relative imports.
- Validate all external inputs with Zod schemas.
- Keep trusted work in Electron main process, not the renderer.
- Keep the renderer behind `window.superAgent` (typed IPC bridge).
- Prefer files under 1000 lines. Split large modules.
- Make skill installation/update flows reviewable and rollbackable.

## Testing

```bash
npm run test:unit          # Unit + UI (Vitest + Testing Library)
npm run test:integration   # Chat graph integration
npm run test:regression    # Regression tests
npm run test:e2e           # Full Electron app (requires display)
npm test                   # All tests
```

- Place unit tests in `tests/unit/`, UI tests in `tests/ui/`, e2e in `tests/e2e/`.
- Use `SUPER_AGENT_TEST_PROVIDER=stub` for deterministic provider tests.
- Run full suite before submitting a PR.

## PR process

1. Open an issue to discuss the change.
2. Branch from `main`.
3. Implement, test, document.
4. Run typecheck, lint, and full test suite.
5. Submit PR with a clear description referencing the issue.

Commit format: `type: message` where type is `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`, `ci`.

## Code of Conduct

Be respectful and constructive. Harassment, trolling, and personal attacks are not tolerated. Report issues to maintainers.

## Getting help

- [GitHub Discussions](https://github.com/saravanaspar/super-agent/discussions) — questions and ideas.
- [GitHub Issues](https://github.com/saravanaspar/super-agent/issues) — bugs and features.

# Development

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start with hot reload |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (zero warnings) |
| `npm run test:unit` | Unit + UI tests |
| `npm run test:integration` | Integration tests |
| `npm run test:e2e` | E2E (Playwright, needs display) |
| `npm run test:regression` | Regression tests |
| `npm test` | All tests |
| `npm run verify` | Project structure check |

## Pre-commit

```bash
npm run typecheck -- --pretty false
npm run test:unit
git diff --check
```

For UI/Electron changes, also: `npm run test:e2e`

## Project structure

```
src/
├── agent/             LangGraph agent graph, chat service, runtime
├── commands/          /goal and /review runtimes
├── mcp/               MCP client and config
├── permissions/       Permission modes, approval broker
├── persistence/       SQLite repositories
├── plugins/           Plugin registry (metadata)
├── providers/         LLM adapters, streaming, validation
├── security/          Network policy
├── settings/          Runtime bootstrap, settings service
├── shared/            Types, IPC contracts, defaults, utilities
├── skills-system/     Skill registry, validation, evals, proposals
├── tool-registry/     Tool contracts and registration
├── tools/             File, shell, browser, web, OS tools
├── ui/                React 19 renderer
└── workspace/         Browser workspace controller
```

## Key entry points

| Task | File |
|---|---|
| App boot | `src/settings/appRuntime.ts` |
| IPC handlers | `electron/main/ipc.ts` |
| Agent graph | `src/agent/agentGraph.ts` |
| Provider adapter | `src/providers/adapters/{provider}/` |
| Tool registration | `src/tool-registry/registerTools.ts` |
| Skill registry | `src/skills-system/skillRegistry.ts` |
| Persistence schema | `src/persistence/localDatabase.ts` |
| Shared contracts | `src/shared/types.ts`, `src/shared/ipc.ts` |

## Conventions

- Trusted work in Electron main. Renderer has no Node.js access.
- Renderer communicates through `window.superAgent` (typed preload API).
- All external inputs validated with Zod schemas.
- Tools classified by risk: `safe`, `medium`, `high`.
- Files under 1000 lines unless there's a specific reason.
- Prefer user-visible errors over console-only failures.

## Known gaps

- Plugin execution not implemented (registry metadata only).
- Multi-agent orchestration intentionally disabled in MVP.
- OS-native desktop control limited to browser/workspace abstraction.
- Web search requires external `ddgr`.
- Shell sandbox depends on host platform.
- E2E reliability depends on Electron and browser availability.

## Test coverage

- `tests/unit/` — services, permissions, tools, skills, runtime (25+ files)
- `tests/ui/` — React component behavior
- `tests/integration/` — chat graph
- `tests/regression/` — previously fixed bugs
- `tests/e2e/` — full Electron app

## Environment variables

See [Configuration](configuration.md) for full reference. Key vars:

```
SUPER_AGENT_DB_PATH        # Override database path
SUPER_AGENT_WORKSPACE_DIR  # Override workspace
SUPER_AGENT_TEST_PROVIDER  # Set to "stub" for testing
```

# Super Agent

A private, local-first desktop AI agent. Runs entirely on your machine — browser workspace, file/shell tools, skill packages, MCP servers, all gated by a permission system. Built with Electron + React + LangGraph.

[GitHub](https://github.com/saravanaspar/super-agent) · [Quickstart](docs/quickstart.md) · [User Guide](docs/user-guide.md) · [Contributing](CONTRIBUTING.md)

---

## Quick start

```bash
npm install
npm run dev
```

Requirements: Node.js ≥ 20, npm ≥ 10. See [quickstart](docs/quickstart.md) for provider setup.

---

## Features

**Agent runtime** — LangGraph state machine, streaming responses, multi-provider LLM (Groq, Ollama, NVIDIA, llama.cpp), slash commands (`/goal`, `/review`), intent routing, tool loop guards.

**Tools** — File read/write/edit/search/glob, shell execution with permission gating and sandboxing (bubblewrap/sandbox-exec/Docker), browser workspace (Playwright: navigate, click, type, snapshot), web search & fetch, MCP tool routing (stdio + HTTPS Streamable HTTP).

**Skills** — Package install/verify/update/uninstall, security scanning & quarantine, proposal workflow with diffs, rollback snapshots, eval runs, context injection with token budgeting.

**Permissions** — Risk classification (safe/medium/high), modes (ask_every_time, allow_safe_tools, manual_approval, full_access, deny_tools), session grants, hard-blocked system paths, workspace confinement, secret masking.

**Persistence** — SQLite via sql.js: sessions, messages, settings, provider models, artifacts, skills, proposals, rollbacks, evals, workspace logs, memory entries.

**UI** — Chat with streaming, session management, library panel (skills/tools/models/prompts/artifacts/MCP), approval dialogs, workspace panel, settings panel, theme (system/light/dark).

---

## Architecture

```
React UI → window.superAgent (preload IPC bridge) → Electron main process
                                                          ↓
                                           AppRuntime (services)
                                           ChatService / AgentGraph / ToolRegistry
                                           SkillRegistry / ProviderService / Persistence
                                           PermissionService / MCP Registry
```

- **Renderer** has no Node.js access.
- **Preload** exposes a typed `window.superAgent` API.
- **Main process** owns all trusted work: file I/O, shell, network, persistence, provider calls.
- All IPC and tool inputs validated with Zod schemas.

---

## Project structure

```
src/
├── agent/           Agent graph, chat service, runtime gates
├── commands/        Slash commands (/goal, /review)
├── mcp/             MCP client and config
├── permissions/     Permission modes, approval broker
├── persistence/     SQLite database, repositories
├── plugins/         Plugin registry (metadata only)
├── providers/       LLM adapters (Groq, Ollama, NVIDIA, llama.cpp, stub)
├── security/        Network policy, URL checks
├── settings/        AppRuntime, settings service
├── shared/          Types, IPC contracts, defaults
├── skills-system/   Skill registry, validation, proposals, evals
├── tool-registry/   Tool contracts, registration
├── tools/           File, shell, browser, web, OS-specific tools
├── ui/              React 19 renderer
└── workspace/       Browser workspace controller (Playwright)
```

---

## Roadmap

| Phase | Focus |
|---|---|
| **v0.2** | Plugin system, multi-agent swarms, subagents |
| **v0.3** | Desktop control (mouse/keyboard/window), computer use (OCR/SOM), app testing |
| **v0.4** | Web app testing, CI/CD integration, test recording |
| **v0.5** | Unity, Unreal, Blender automation bridges |
| **v0.6** | Memory/RAG, knowledge graphs, vision, learning |
| **v1.0** | Plugin ecosystem, IDE integrations, collaboration, enterprise |

---

## Development

```bash
npm run typecheck -- --pretty false   # TypeScript check
npm run lint                          # ESLint (zero warnings)
npm run test:unit                     # Unit + UI tests
npm run test:e2e                      # E2E tests (requires display)
npm run build                         # Production build
npm run verify                        # Project structure check
```

**Pre-commit:** `npm run typecheck -- --pretty false && npm run test:unit && git diff --check`

---

## Security

- Renderer: no Node.js, no direct file/network access.
- Preload: typed IPC API only.
- Permission modes control tool access (safe/medium/high risk tiers).
- Workspace confinement on by default. Private network blocked by default. System paths hard-blocked.
- Provider API keys masked in renderer. Skill packages scanned and quarantinable.

See [SECURITY.md](SECURITY.md) for policy and vulnerability reporting.

---

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

# Changelog

## [0.1.0] — 2026-05-30

**Agent runtime:** LangGraph state machine with streaming, intent routing, tool loop guards, final answer repair, evidence runtime, runtime safety gates.

**Providers:** Groq, NVIDIA NIM, Ollama, llama.cpp, stub (test). Streaming, thinking tokens, tool call normalization, health checks, model discovery.

**Tools:** File (read/write/edit/append/delete/glob/search), shell (permission-gated, sandboxed, process-tracked), browser workspace (navigate/click/type/snapshot via Playwright), web search & fetch, MCP routing, platform-specific tools.

**Skills:** Install/verify/update/uninstall, security scanning, quarantine, proposals with diffs, rollback snapshots, evals, context injection, token budgeting, auto-routing, archive/restore.

**MCP:** stdio server launch, HTTPS Streamable HTTP, layered config loading, tool routing through permission flow.

**Permissions:** Risk classification (safe/medium/high), modes (ask_every_time/allow_safe_tools/manual_approval/full_access/deny_tools), session grants, hard-blocked paths, workspace confinement.

**Commands:** `/goal` (multi-step tasks with acceptance criteria), `/review` (code review with coverage analysis).

**UI:** Chat with streaming, session management, library panel, approval dialogs, workspace panel, settings panel, theme support.

**Persistence:** SQLite via sql.js — sessions, messages, settings, models, artifacts, skills, proposals, rollbacks, evals, workspace logs, memory.

**Security:** No Node.js in renderer, typed IPC bridge, Zod validation, secret masking, dangerous path blocking, skill quarantine.

**Testing:** 25+ unit tests, UI tests, integration tests, regression tests, e2e tests. 135 tests passing.

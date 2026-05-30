# User Guide

## Chat

The main interface is a chat UI with a sidebar, message list, and composer.

- **New session** — click "+" or use the sidebar.
- **Search sessions** — sidebar search input.
- **Pin / rename / delete** — right-click or session actions.
- **Attach files** — drag or use the attachment button.
- **Regenerate** — regenerate the last assistant response.
- **Select model** — pick a provider and model from the dropdown.
- **Commands** — type `/goal <task>` or `/review <files>` in the composer.

Sessions persist across restarts.

## Permission modes

Set the mode in the composer before sending:

| Mode | Behavior |
|---|---|
| `ask_every_time` | Confirm every tool call (default) |
| `allow_safe_tools` | Auto-allow safe tools, ask for medium/high |
| `manual_approval` | Agent proposes actions, you approve each |
| `full_access` | All tools auto-allowed (use with caution) |
| `deny_tools` | Agent reads only, no tool execution |

Approval grants can be set to "once", "for this session", or "for this exact command".

## Tools

### File tools
`read`, `write`, `append`, `edit`, `edit_range`, `list_dir`, `mkdir`, `remove`, `exists`, `glob`, `grep` — all scoped to workspace by default.

### Shell tool
`shell_execute` — run commands with permission gating. Supports sandboxed backends (bubblewrap on Linux, sandbox-exec on macOS, Docker/Podman on Windows). Process lifecycle tracked — list and stop managed processes.

### Browser workspace
`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot` — controlled Chromium browser. Private network blocked by default.

### Web tools
`search_web` — DuckDuckGo search via `ddgr` (install separately). `fetch_url` — bounded content fetch.

### Workspace tools
`workspace_info`, `workspace_status` — current workspace path and status.

### Profile tools
`profile_get`, `profile_set` — read and update agent profile configuration.

### MCP tools
Tools exposed by configured MCP servers (stdio or HTTPS). Routed through the normal permission flow.

### Skill tools
`skill_install`, `skill_verify`, `skill_uninstall`, `skill_list`, `skill_propose`, `skill_apply_proposal`, `skill_restore`, `skill_eval` — full skill lifecycle management.

## Skills

Skills are reusable instruction packages that extend the agent's capabilities.

### Install sources
- **Local file system** — import skill packages from disk.
- **GitHub** — install from a GitHub repository.
- **Registry** — search and install from the built-in registry.

### Lifecycle
1. **Install** — skill is loaded and validated.
2. **Verify** — integrity and security checks.
3. **Propose** — create a diff-based proposal for changes.
4. **Review** — review the proposal before applying.
5. **Apply/Reject** — accept or reject the proposal.
6. **Rollback** — restore a previous snapshot if needed.
7. **Eval** — run evaluation tests on the skill.

### Security
Skills are scanned for suspicious patterns. High-risk skills are quarantined automatically. Remote installs require provenance verification. Updates use proposals — never silent mutation.

## Browser workspace

The workspace is a controlled Chromium browser launched by Playwright.

- Navigate to URLs within allowed ranges.
- Click CSS selectors, type into fields, capture page snapshots.
- Screenshots can be included in snapshots.
- All actions are logged and persisted.
- Local/private network URLs are blocked unless explicitly enabled in settings.

## Commands

### `/goal`
Multi-step task execution with acceptance criteria:

```
/goal Refactor the login component to use hooks
AC:
- All login logic moved to useAuth hook
- Component renders correctly
- Tests pass
```

The agent works through the task step by step, checking acceptance criteria at each stage. It may ask for clarification or approval.

### `/review`
Code review with source coverage analysis:

```
/review src/auth/login.tsx
```

The agent reviews the file for issues, checks coverage of referenced sources, and returns findings with recommendations.

## Artifacts

Artifacts are persisted code/text outputs from the agent. Created via the `create_artifact` tool. Viewable in the Library panel.

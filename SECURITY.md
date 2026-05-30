# Security

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Email [INSERT EMAIL] or use the [GitHub Security Advisory](https://github.com/saravanaspar/super-agent/security/advisories) system.

You should receive a response within 48 hours. Include:
- Type of issue, affected files, reproduction steps
- Proof of concept if available
- Impact assessment

## Architecture

Super Agent uses defense in depth:

1. **Process isolation** — Renderer has no Node.js access. Preload exposes a typed API only.
2. **Input validation** — All IPC and tool inputs validated with Zod schemas.
3. **Permission system** — Every tool classified as safe/medium/high risk. Four permission modes.
4. **Workspace confinement** — Tools restricted to workspace directory by default.
5. **Dangerous path blocking** — System paths (`/etc`, `/sys`, `/proc`, etc.) hard-blocked.
6. **Network policy** — Private network blocked by default. URL allowlist/blocklist enforced.
7. **Secret masking** — Provider API keys never sent to renderer in plaintext.
8. **Skill security** — Static analysis, quarantine, provenance verification, proposal workflow, rollback.
9. **Process tracking** — All child processes tracked; cleanup on exit.

## Security checklist

Before deploying:
- [ ] Verify renderer has no Node.js access
- [ ] Permission mode is not `full_access` for untrusted use
- [ ] Workspace directory is configured and restricted
- [ ] Private network access is disabled unless required
- [ ] Shell sandbox is enabled if available
- [ ] Skill installation restricted to trusted sources

## Responsible disclosure

Report privately, allow time for a fix, do not exploit beyond proof of concept.

# Quickstart

## Prerequisites

- Node.js 20+ with npm
- Git

## Install

```bash
git clone https://github.com/saravanaspar/super-agent.git
cd super-agent
npm install
```

If Electron download fails: `npm run prepare:electron`

## Configure a provider

Open **Settings** from the sidebar and configure at least one provider:

| Provider | Setup |
|---|---|
| **Groq** | Set API key (get at [console.groq.com](https://console.groq.com)) |
| **NVIDIA** | Set API key |
| **Ollama** | Set base URL (default `http://127.0.0.1:11434`) |
| **llama.cpp** | Set base URL (default `http://127.0.0.1:11434/v1`) |

Provider settings persist locally. API keys are masked in the UI.

## Start

```bash
npm run dev
```

Launches the Electron app with hot reload.

## Send your first message

1. Select a provider and model from the chat composer dropdown.
2. Type a message and press Enter.
3. The agent streams its response — thinking, tool calls, and final answer in real time.

## Environment variables (optional)

| Variable | Purpose |
|---|---|
| `SUPER_AGENT_DB_PATH` | Override database path |
| `SUPER_AGENT_WORKSPACE_DIR` | Override default workspace |
| `SUPER_AGENT_TEST_PROVIDER=stub` | Enable deterministic test provider |

## Next

- [User Guide](user-guide.md) — tools, permissions, skills, commands
- [Configuration](configuration.md) — full settings reference

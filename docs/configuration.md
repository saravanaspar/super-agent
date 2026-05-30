# Configuration

## Settings UI

Open **Settings** from the sidebar.

### Appearance
- **Theme** — `system`, `light`, `dark`.

### Provider
- **Default provider** — `groq`, `nvidia`, `ollama`, `llamaCpp`.
- **Default model** — model ID string.

### Provider credentials

| Provider | API Key | Base URL |
|---|---|---|
| Groq | `groqApiKey` | `https://api.groq.com/openai/v1` |
| NVIDIA | `nvidiaApiKey` | `https://integrate.api.nvidia.com/v1` |
| Ollama | — | `http://127.0.0.1:11434` |
| llama.cpp | — | `http://127.0.0.1:11434/v1` |

### Behavior
- **Outside-workspace access** — allow tools to read/write outside workspace.
- **Private-network access** — allow browser workspace to access local/private IPs.
- **Shell sandbox** — enable sandboxed shell execution.
- **Streaming response** — toggle real-time token streaming.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SUPER_AGENT_DB_PATH` | `./super-agent-data/super-agent.sqlite` | Override database path |
| `SUPER_AGENT_WORKSPACE_DIR` | `./super-agent-data/workspace` | Override workspace directory |
| `SUPER_AGENT_TEST_PROVIDER` | — | Set to `stub` for deterministic test provider |
| `SUPER_AGENT_CONFIG_PATH` | — | Override MCP config path |

## Database

Local SQLite database via `sql.js` (WebAssembly). Stored at `SUPER_AGENT_DB_PATH`. No external database server needed.

## Shell sandbox backends

| Platform | Backend | Install |
|---|---|---|
| Linux | bubblewrap | `apt install bubblewrap` |
| macOS | sandbox-exec | Built-in |
| Windows | Docker / Podman | Install Docker Desktop or Podman |

Sandboxing is optional. Toggle in Settings.

## Web search dependency

`search_web` uses DuckDuckGo through `ddgr`:

```bash
# macOS
brew install ddgr

# Linux
sudo apt install ddgr    # or: pip install ddgr
```

## MCP config

MCP servers configured in `config.yaml` at project root, `~/.super-agent/config.yaml`, or Electron userData. Supports:

- **stdio** — local process-based MCP servers.
- **HTTPS Streamable HTTP** — remote MCP endpoints.

See `config.yaml` in the project root for examples.

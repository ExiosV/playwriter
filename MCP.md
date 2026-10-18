# MCP Setup

> **Note:** CLI is the recommended way to use Playwriter. See [quick start](./website/src/pages/docs/quick-start.mdx) for CLI usage.

Add to your MCP client settings:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"]
    }
  }
}
```

Or auto-configure:

```sh
npx -y @playwriter/install-mcp playwriter@latest
```

## Using the MCP

1. Enable the extension on at least one tab (click icon → turns green)
2. MCP automatically starts relay server and connects to enabled tabs
3. Use the `execute` tool to run Playwright code

The MCP exposes:

- `execute` tool - run Playwright code snippets
- `reset` tool - reconnect if connection issues occur

## Direct CDP

Direct CDP is the **default transport** in this fork: on startup the MCP server
scans every known Chromium browser's `DevToolsActivePort` file plus the default
CDP ports (`9222`, `9223`, ...) and connects to the first instance with debugging
enabled. Supported: Chrome, Chromium, Edge, Brave, Yandex, Vivaldi, Opera on
macOS, Windows and Linux. If nothing is found it falls back to the extension
transport automatically.

Enable debugging in the browser you want to drive:

- **Chrome / Edge / Brave** — open `chrome://inspect/#remote-debugging` and turn
  the toggle on, or launch with `--remote-debugging-port=9222`.
- **Yandex** — open `browser://inspect/#remote-debugging` and turn the toggle on,
  or launch Yandex with `--remote-debugging-port=9222 --user-data-dir=<dir>`
  (Yandex is Chromium 150+, so the Chrome 136+ default-profile restriction
  applies — a dedicated `--user-data-dir` is required with an explicit flag).

To force direct mode explicitly, set `PLAYWRITER_DIRECT`:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"],
      "env": {
        "PLAYWRITER_DIRECT": "1"
      }
    }
  }
}
```

You can also pass an explicit WebSocket endpoint: `PLAYWRITER_DIRECT=ws://127.0.0.1:9222/devtools/browser/abc`.

To force the extension transport instead, set `PLAYWRITER_EXTENSION=1`.

Chrome 136+ may show an approval dialog the first time a connection is made.

**Limitation:** screen recording is unavailable in direct mode.

## Remote Agents (Devcontainers, VMs, SSH)

Run agents in isolated environments while controlling Chrome on your host.

**On host (where Chrome runs):**

```bash
npx -y playwriter serve --token <secret>
```

**In container/VM (where agent runs):**

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest", "--host", "host.docker.internal", "--token", "<secret>"]
    }
  }
}
```

Or with environment variables:

```json
{
  "mcpServers": {
    "playwriter": {
      "command": "npx",
      "args": ["-y", "playwriter@latest"],
      "env": {
        "PLAYWRITER_HOST": "host.docker.internal",
        "PLAYWRITER_TOKEN": "<secret>"
      }
    }
  }
}
```

Use `host.docker.internal` for devcontainers, or your host's IP for VMs/SSH.

---
'playwriter': minor
---

Make direct CDP the default transport and discover every Chromium browser, including Yandex.

`session new` and the MCP server now try direct CDP first: they scan each known
browser's `DevToolsActivePort` file plus the default CDP ports (`9222`, `9223`,
...) and connect to the first instance with debugging enabled. Supported
browsers: Chrome, Chromium, Edge, Brave, Yandex, Vivaldi and Opera on macOS,
Windows and Linux. When nothing is found, the CLI falls back to the extension
transport automatically.

```sh
# direct CDP by default (auto-discovers Chrome / Edge / Brave / Yandex)
playwriter session new

# force the extension transport
playwriter session new --extension

# force direct with an explicit endpoint
playwriter session new --direct ws://127.0.0.1:9222
playwriter session new --direct host:port
```

Enable debugging first:

- Chrome / Edge / Brave — `chrome://inspect/#remote-debugging`
- Yandex — `browser://inspect/#remote-debugging`

For the MCP server, direct CDP is used automatically when a debug-enabled
browser is found. Set `PLAYWRITER_DIRECT` to force it or `PLAYWRITER_EXTENSION=1`
to force the extension transport.

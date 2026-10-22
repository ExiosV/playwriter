import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Prevent Buffers from dumping hex bytes in util.inspect output.
// Without this, returning a screenshot Buffer would log ~400+ chars of useless hex.
Buffer.prototype[util.inspect.custom] = function () {
  return `<Buffer ${this.length} bytes>`
}

import dedent from 'string-dedent'
import { LOG_FILE_PATH, VERSION, parseRelayHost } from './utils.js'
import { ensureRelayServer, RELAY_PORT } from './relay-client.js'
import { PlaywrightExecutor, CodeExecutionTimeoutError } from './executor.js'
import { discoverChromeInstances, resolveDirectInput, appendSessionToWsUrl } from './chrome-discovery.js'
import { flattenCloudTabs, formatCloudTabs, resolveCloudTabRef, type CloudTabsResult } from './cloud-tabs.js'
import { readYandexTabs, formatYandexTabs, resolveYandexTabRefs } from './yandex-tabs.js'
import crypto from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

// Single executor instance for MCP (created lazily)
let executor: PlaywrightExecutor | null = null
let executorPromise: Promise<PlaywrightExecutor> | null = null

interface RemoteConfig {
  host: string
  port: number
  token?: string
}

function getRemoteConfig(): RemoteConfig | null {
  const host = process.env.PLAYWRITER_HOST
  if (!host) {
    return null
  }
  return {
    host,
    port: RELAY_PORT,
    token: process.env.PLAYWRITER_TOKEN,
  }
}

function getLogServerUrl(): string {
  const remote = getRemoteConfig()
  if (remote) {
    const { httpBaseUrl } = parseRelayHost(remote.host, remote.port)
    return `${httpBaseUrl}/mcp-log`
  }
  return `http://127.0.0.1:${RELAY_PORT}/mcp-log`
}

async function sendLogToRelayServer(level: string, ...args: any[]) {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = process.env.PLAYWRITER_TOKEN
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    await fetch(getLogServerUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ level, args }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Silently fail if relay server is not available
  }
}

/**
 * Log to both console.error (for early startup) and relay server log file.
 * Fire-and-forget to avoid blocking.
 */
function mcpLog(...args: any[]) {
  console.error(...args)
  void sendLogToRelayServer('log', ...args)
}

/** MCP-specific logger for executor */
const mcpLogger = {
  log: (...args: any[]) => mcpLog(...args),
  error: (...args: any[]) => {
    console.error(...args)
    void sendLogToRelayServer('error', ...args)
  },
}

function getRelayHttpBase(): string {
  const remote = getRemoteConfig()
  if (remote) {
    return parseRelayHost(remote.host, remote.port).httpBaseUrl
  }
  return `http://127.0.0.1:${RELAY_PORT}`
}

function getRelayAuthHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) {
    headers['Content-Type'] = 'application/json'
  }
  const token = process.env.PLAYWRITER_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

async function ensureRelayServerForMcp(): Promise<void> {
  await ensureRelayServer({ logger: mcpLogger })
}

/**
 * Resolve direct CDP config from PLAYWRITER_DIRECT env var.
 * - "auto" / "1" / "true": auto-discover Chrome on default port 9222
 * - "ws://..." / "wss://...": use explicit WebSocket endpoint
 * - "host:port": resolve to ws:// URL via HTTP probe + DevToolsActivePort fallback
 */
async function getDirectCdpConfig(): Promise<{ directCdpUrl: string } | null> {
  const directEnv = process.env.PLAYWRITER_DIRECT
  if (!directEnv) {
    return null
  }

  // Auto-discover: check default CDP ports and known browsers' DevToolsActivePort
  if (directEnv === '1') {
    const instances = await discoverChromeInstances()
    if (instances.length === 0) {
      throw new Error(
        'PLAYWRITER_DIRECT is set but no browser with remote debugging was found. ' +
          'Enable debugging at chrome://inspect/#remote-debugging (Chrome/Edge/Brave), ' +
          'launch the browser with --remote-debugging-port=9222, or unset PLAYWRITER_DIRECT to use the extension transport.',
      )
    }
    const sessionId = crypto.randomUUID()
    const wsUrl = appendSessionToWsUrl(instances[0].wsUrl, sessionId)
    mcpLog(`Direct CDP: using ${instances[0].browser} on port ${instances[0].port}`)
    return { directCdpUrl: wsUrl }
  }

  // ws://, wss://, or host:port — resolveDirectInput handles all three
  const resolved = await resolveDirectInput(directEnv)
  const sessionId = crypto.randomUUID()
  const directCdpUrl = appendSessionToWsUrl(resolved, sessionId)
  mcpLog(`Direct CDP: resolved ${directEnv} → ${directCdpUrl}`)
  return { directCdpUrl }
}

async function getOrCreateExecutor(): Promise<PlaywrightExecutor> {
  if (executor) {
    return executor
  }
  if (executorPromise) {
    return executorPromise
  }

  executorPromise = (async () => {
    // Direct CDP mode takes priority over relay/remote
    const directConfig = await getDirectCdpConfig()
    if (directConfig) {
      return new PlaywrightExecutor({
        cdpConfig: directConfig,
        logger: mcpLogger,
        cwd: process.cwd(),
      })
    }

    const remote = getRemoteConfig()
    if (!remote) {
      await ensureRelayServerForMcp()
    }

    // Pass config instead of pre-generated URL so executor can generate unique URLs for each connection
    const cdpConfig = { ...(remote || { port: RELAY_PORT }), client: 'mcp' as const }
    return new PlaywrightExecutor({
      cdpConfig,
      logger: mcpLogger,
      cwd: process.cwd(),
    })
  })()

  try {
    executor = await executorPromise
    return executor
  } finally {
    executorPromise = null
  }
}

async function checkRemoteServer({ host, port, token }: RemoteConfig): Promise<void> {
  const { httpBaseUrl } = parseRelayHost(host, port)
  const versionUrl = `${httpBaseUrl}/version`
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const response = await fetch(versionUrl, { headers, signal: AbortSignal.timeout(3000) })
    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}`)
    }
  } catch (error: any) {
    const isConnectionError = error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError'
    if (isConnectionError) {
      throw new Error(
        `Cannot connect to remote relay server at ${host}. ` +
          `Make sure 'npx -y playwriter serve' is running on the host machine.`,
      )
    }
    throw new Error(`Failed to connect to remote relay server: ${error.message}`)
  }
}

const server = new McpServer({
  name: 'playwriter',
  title: 'The better playwright MCP: works as a browser extension. No context bloat. More capable.',
  version: VERSION,
})

const promptContent =
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'prompt.md'), 'utf-8') +
  `\n\nfor debugging internal playwriter errors, check playwriter relay server logs at: ${LOG_FILE_PATH}`

server.resource(
  'debugger-api',
  'https://playwriter.dev/resources/debugger-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'debugger-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/debugger-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'editor-api',
  'https://playwriter.dev/resources/editor-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'editor-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/editor-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

server.resource(
  'styles-api',
  'https://playwriter.dev/resources/styles-api.md',
  { mimeType: 'text/plain' },
  async () => {
    const packageJsonPath = require.resolve('playwriter/package.json')
    const packageDir = path.dirname(packageJsonPath)
    const content = fs.readFileSync(path.join(packageDir, 'dist', 'styles-api.md'), 'utf-8')
    return {
      contents: [{ uri: 'https://playwriter.dev/resources/styles-api.md', text: content, mimeType: 'text/plain' }],
    }
  },
)

const DEFAULT_EXEC_TIMEOUT = Number(process.env.PLAYWRITER_EXEC_TIMEOUT) || 10000

server.tool(
  'execute',
  promptContent,
  {
    code: z
      .string()
      .describe(
        'js playwright code, has {state, context} in scope. There is no `page` global: use `state.page = await context.newPage()` or pick an existing tab from `context.pages()`. Should be one line, using ; to execute multiple statements. you MUST call execute multiple times instead of writing complex scripts in a single tool call.',
      ),
    timeout: z
      .number()
      .default(DEFAULT_EXEC_TIMEOUT)
      .describe('Timeout in milliseconds for code execution (default: 10000ms, or PLAYWRITER_EXEC_TIMEOUT)'),
  },
  async ({ code, timeout }) => {
    try {
      // Check relay server on every execute to auto-recover from crashes
      // (skip in direct CDP mode — no relay involved)
      if (!process.env.PLAYWRITER_DIRECT) {
        const remote = getRemoteConfig()
        if (!remote) {
          await ensureRelayServerForMcp()
        }
      }

      const exec = await getOrCreateExecutor()
      const result = await exec.execute(code, timeout)

      // Transform executor result to MCP format
      // Append screenshot metadata to text for MCP (image is included inline as content)
      const MAX_TEXT = 10000
      let text = result.text
      for (const s of result.screenshots) {
        text += `\nScreenshot saved to: ${s.path} (image included below, ${s.labelCount} labels)\n`
        text += `Accessibility snapshot:\n${s.snapshot}\n`
      }
      if (text.length > MAX_TEXT) {
        text = text.slice(0, MAX_TEXT) + '\n\n[Truncated]'
      }

      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text },
      ]

      for (const image of result.images) {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }

      if (result.isError) {
        return { content, isError: true }
      }

      return { content }
    } catch (error: any) {
      const errorStack = error.stack || error.message
      const isTimeoutError =
        error instanceof CodeExecutionTimeoutError || error?.name === 'TimeoutError' || error?.name === 'AbortError'

      console.error('Error in execute tool:', errorStack)
      if (!isTimeoutError) {
        void sendLogToRelayServer('error', 'Error in execute tool:', errorStack)
      }

      const resetHint = isTimeoutError
        ? ''
        : '\n\n[HINT: If this is an internal Playwright error, page/browser closed, or connection issue, call the `reset` tool to reconnect. Do NOT reset for other non-connection non-internal errors.]'

      // timeout stacks are internal noise (Promise.race / setTimeout); only show the message
      const errorText = isTimeoutError ? error.message : errorStack
      return {
        content: [{ type: 'text', text: `Error executing code: ${errorText}${resetHint}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  'reset',
  dedent`
    Recreates the CDP connection and resets the browser/context. Use this when the MCP stops responding, you get connection errors, assertion failures, or other issues.

    After calling this tool, the context variable is automatically updated in the execution environment.

    This tools also removes any custom properties you may have added to the global scope AND clearing all keys from the \`state\` object. Only \`context\`, \`state\` (empty), \`console\`, and utility functions will remain. Assign \`state.page\` again after a reset.

    if playwright always returns all pages as about:blank urls and evaluate does not work you should ask the user to restart Chrome. This is a known Chrome bug.
  `,
  {},
  async () => {
    try {
      // Check relay server to auto-recover from crashes
      // (skip in direct CDP mode — no relay involved)
      if (!process.env.PLAYWRITER_DIRECT) {
        const remote = getRemoteConfig()
        if (!remote) {
          await ensureRelayServerForMcp()
        }
      }

      const exec = await getOrCreateExecutor()
      const { context } = await exec.reset()
      const pagesCount = context.pages().length
      return {
        content: [
          {
            type: 'text',
            text: `Connection reset successfully. ${pagesCount} page(s) available.`,
          },
        ],
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to reset connection: ${error.message}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  'cloud_tabs',
  dedent`
    List the cloud (synced) tabs open on the user's OTHER signed-in browser devices — Chrome Sync, Yandex Browser, Edge and Brave.

    Cloud tabs come from the browser extension's chrome.sessions API, so the Playwriter extension must be connected; a direct-CDP session cannot read them. Pass \`open\` to open a tab in the user's browser: its 1-based number from this listing, a full url, or a unique url fragment.
  `,
  {
    open: z
      .string()
      .optional()
      .describe('Open this cloud tab: its 1-based number from the listing, a url, or a unique url fragment'),
    extensionId: z.string().optional().describe('Extension id to query when several browsers are connected'),
  },
  async ({ open, extensionId }) => {
    try {
      if (!getRemoteConfig()) {
        await ensureRelayServerForMcp()
      }

      const query = extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : ''
      const response = await fetch(`${getRelayHttpBase()}/cli/cloud-tabs${query}`, {
        headers: getRelayAuthHeaders(),
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        return {
          content: [
            {
              type: 'text',
              text: `Could not read cloud tabs: ${body.error ?? response.status}. Cloud tabs need the Playwriter extension connected (chrome.sessions); direct CDP cannot see them.`,
            },
          ],
          isError: true,
        }
      }

      const result = (await response.json()) as CloudTabsResult

      if (open !== undefined) {
        const url = resolveCloudTabRef(flattenCloudTabs(result), open)
        if (!url) {
          return {
            content: [
              {
                type: 'text',
                text: `No single cloud tab matches "${open}". Call cloud_tabs without \`open\` first to list them.`,
              },
            ],
            isError: true,
          }
        }
        const openResponse = await fetch(`${getRelayHttpBase()}/cli/cloud-tabs/open`, {
          method: 'POST',
          headers: getRelayAuthHeaders(true),
          body: JSON.stringify({ url, extensionId }),
          signal: AbortSignal.timeout(20000),
        })
        if (!openResponse.ok) {
          const body = (await openResponse.json().catch(() => ({}))) as { error?: string }
          return {
            content: [{ type: 'text', text: `Could not open ${url}: ${body.error ?? openResponse.status}` }],
            isError: true,
          }
        }
        const opened = (await openResponse.json()) as { tabId?: number | null; url?: string }
        return { content: [{ type: 'text', text: `Opened ${opened.url ?? url} in the user's browser.` }] }
      }

      return { content: [{ type: 'text', text: formatCloudTabs(result) }] }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to read cloud tabs: ${error.message}` }],
        isError: true,
      }
    }
  },
)

// Yandex Cloud Tabs — reads synced tabs from the local profile files.
// Works even when the extension is disconnected or chrome.sessions.getDevices() returns empty (Yandex).
server.tool(
  'yandex_tabs',
  dedent`
    Read cloud (synced) tabs directly from a Yandex Browser profile's local files.

    Unlike \`cloud_tabs\`, this does NOT need the Playwriter extension — it reads the browser's own sync database on disk. This is useful when chrome.sessions.getDevices() returns empty in Yandex (the API doesn't wire Chromium's OpenTabsUIDelegate).

    Options:
    - \\\`device\\\`: filter by device name (e.g. "DEVICEX2")
    - \\\`limit\\\`: max groups to show (default 30, use a large number or omit for all)
    - \\\`open\\\`: open one tab — its 1-based index from the listing, url, or unique fragment
    - \\\`openGroup\\\`: open ALL tabs of one group in a new browser window — the group's 1-based index from this listing. Capped at 25 tabs per group to prevent flooding.

    The result is grouped by device → window (group). Each group can be opened as a single new browser window with \\\`openGroup\\\`.
  `,
  {
    device: z.string().optional().describe('Filter by device name (e.g. "DEVICEX2")'),
    limit: z.number().int().positive().optional().describe('Maximum number of device groups to show (default 30). Use a large number for all.'),
    open: z.string().optional().describe('Open one tab: its 1-based index from the listing, url, or unique fragment'),
    openGroup: z.number().int().positive().optional().describe('Open ALL tabs of one group in a new browser window — the group\'s 1-based index from this listing. Capped at 25 tabs per group.'),
  },
  async ({ device, limit, open, openGroup }) => {
    try {
      const result = readYandexTabs({ limit: limit ?? undefined })

      // Apply device filter.
      if (device) {
        const dev = device.toLowerCase()
        result.groups = result.groups.filter((g) => g.deviceName.toLowerCase().includes(dev))
        result.totalCount = result.groups.reduce((sum, g) => sum + g.tabs.length, 0)
      }

      // Handle openGroup — batch open via relay.
      if (openGroup !== undefined) {
        await ensureRelayServerForMcp()
        const idx = Number(openGroup) - 1
        const group = result.groups[idx]
        if (!group || !group.tabs.length) {
          return {
            content: [{ type: 'text', text: `No group at index ${openGroup}. Call yandex_tabs without openGroup to see available groups.` }],
            isError: true,
          }
        }
        const urls = group.tabs.slice(0, 25).map((t) => t.url)
        try {
          const response = await fetch(`${getRelayHttpBase()}/cli/cloud-tabs/open-group`, {
            method: 'POST',
            headers: getRelayAuthHeaders(true),
            body: JSON.stringify({ urls }),
            signal: AbortSignal.timeout(30000),
          })
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string }
            return { content: [{ type: 'text', text: `Could not open group ${group.deviceName}: ${body.error ?? response.status}` }] }
          }
          const opened = (await response.json()) as { windowId?: number; opened: number }
          return { content: [{ type: 'text', text: `Opened ${opened.opened} tab${opened.opened === 1 ? '' : 's'} in a new window for "${group.deviceName}"${group.windowId !== undefined ? ` (window ${group.windowId})` : ''}.` }] }
        } catch (error: any) {
          return { content: [{ type: 'text', text: `Failed to open group: ${error.message}` }] }
        }
      }

      // Handle single tab open.
      if (open !== undefined) {
        const url = resolveYandexTabRefs(result, open)?.singleUrl
        if (!url) {
          return {
            content: [{ type: 'text', text: `No single cloud tab matches "${open}". Call yandex_tabs without \`open\` first to list them.` }],
            isError: true,
          }
        }
        await ensureRelayServerForMcp()
        const response = await fetch(`${getRelayHttpBase()}/cli/cloud-tabs/open`, {
          method: 'POST',
          headers: getRelayAuthHeaders(true),
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          return { content: [{ type: 'text', text: `Could not open ${url}: ${body.error ?? response.status}` }] }
        }
        const opened = (await response.json()) as { tabId?: number | null; url?: string }
        return { content: [{ type: 'text', text: `Opened ${opened.url ?? url} in the user's browser.` }] }
      }

      // Default: print formatted listing.
      const output = formatYandexTabs(result)
      if (result.deviceMapError && result.groups.length === 0) {
        return { content: [{ type: 'text', text: `${output}\n\nNote: ${result.deviceMapError}` }] }
      }
      return { content: [{ type: 'text', text: output }] }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Failed to read Yandex tabs: ${error.message}` }],
        isError: true,
      }
    }
  },
)

export async function startMcp(options: { host?: string; token?: string } = {}) {
  if (options.host) {
    process.env.PLAYWRITER_HOST = options.host
  }
  if (options.token) {
    process.env.PLAYWRITER_TOKEN = options.token
  }

  // Direct CDP is the default transport. When neither mode was requested
  // explicitly, auto-discover every Chromium browser with debugging enabled
  // (Chrome, Chromium, Edge, Brave, Yandex, ...) and use the first one. If
  // nothing is found we fall back to the extension transport below, so existing
  // setups keep working. Set PLAYWRITER_EXTENSION=1 to always use the extension.
  if (!process.env.PLAYWRITER_DIRECT && !process.env.PLAYWRITER_EXTENSION) {
    try {
      const instances = await discoverChromeInstances()
      if (instances.length > 0) {
        process.env.PLAYWRITER_DIRECT = '1'
        mcpLog(
          `Defaulting to direct CDP (${instances[0].browser} on port ${instances[0].port}). ` +
            'Set PLAYWRITER_EXTENSION=1 to force the extension transport.',
        )
      }
    } catch {
      // Ignore discovery failures and fall back to the extension transport.
    }
  }

  // In direct CDP mode (PLAYWRITER_DIRECT env var), no relay server needed
  if (process.env.PLAYWRITER_DIRECT) {
    mcpLog(`Using direct CDP connection: ${process.env.PLAYWRITER_DIRECT}`)
  } else {
    const remote = getRemoteConfig()
    if (!remote) {
      await ensureRelayServerForMcp()
    } else {
      mcpLog(`Using remote CDP relay server: ${remote.host}`)
      await checkRemoteServer(remote)
    }
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

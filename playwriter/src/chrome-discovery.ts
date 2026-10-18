/**
 * Chromium browser instance discovery for direct CDP connections.
 *
 * Two complementary strategies are used:
 *
 * 1. DevToolsActivePort files. Every Chromium-based browser writes
 *    `<user-data-dir>/DevToolsActivePort` while a DevTools endpoint is active —
 *    either launched with `--remote-debugging-port` / `--remote-debugging-pipe`
 *    or after enabling the toggle at `chrome://inspect/#remote-debugging`.
 *    We read that file for every known browser (Chrome, Chromium, Edge, Brave,
 *    Yandex, Vivaldi, Opera) on macOS, Windows and Linux. This is the only way
 *    to find the random port used by the chrome://inspect toggle.
 *
 * 2. Default CDP ports (9222, 9223, ...). Probed via GET /json/version for
 *    instances launched with an explicit port.
 *
 * Chrome 136+ returns 404 on all HTTP endpoints when debugging was enabled from
 * chrome://inspect, but still accepts WebSocket connections on
 * /devtools/browser/*. We detect that (status 'blocked') and return a synthetic
 * wsUrl; the actual WS connection (which may trigger Chrome's approval dialog)
 * only happens when the user explicitly runs a command, not during discovery.
 *
 * For non-default ports or remote hosts, pass an explicit endpoint with
 * --direct host:port or --direct ws://....
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DiscoveredInstance {
  browser: string
  /** Stable identifier for the browser family, e.g. 'chrome', 'yandex', 'edge'. */
  browserId: string
  port: number
  wsUrl: string
  profiles: Array<{ name: string; email: string }>
  dataDir: string | null
}

export interface ParsedActivePort {
  port: number
  wsPath: string
}

/** Default CDP ports that browsers are commonly launched with. */
export const DEFAULT_CDP_PORTS = [9222, 9223, 9224, 9225, 9229] as const

/**
 * Parse the contents of a DevToolsActivePort file.
 * Format: line 1 = port number, line 2 = /devtools/browser/{guid}
 */
export function parseDevToolsActivePort(contents: string): ParsedActivePort | null {
  const lines = contents.trim().split('\n')
  if (lines.length < 2) {
    return null
  }
  const port = parseInt(lines[0].trim(), 10)
  if (isNaN(port) || port <= 0 || port > 65535) {
    return null
  }
  const wsPath = lines[1].trim()
  if (!wsPath.startsWith('/devtools/browser/')) {
    return null
  }
  return { port, wsPath }
}

interface JsonVersionResponse {
  Browser?: string
  webSocketDebuggerUrl?: string
  'Protocol-Version'?: string
}

type PortProbeStatus =
  | { type: 'live'; wsUrl: string; browser: string }
  /** HTTP response received but no CDP data (Chrome 136+ returns 404 on all HTTP
   *  endpoints but still accepts WS on /devtools/browser/*). We can't get browser
   *  info without a WS connection which would trigger Chrome's approval dialog. */
  | { type: 'blocked'; port: number; hostname: string }
  /** ECONNREFUSED or timeout — nothing is listening */
  | { type: 'dead' }

/** Injectable port prober (used by unit tests to avoid real network calls). */
export type PortProber = (port: number, hostname?: string) => Promise<PortProbeStatus>

/**
 * Probe a port via GET /json/version.
 *
 * Returns:
 * - 'live'    — browser responded with valid CDP JSON containing webSocketDebuggerUrl
 * - 'blocked' — HTTP response received but no CDP info (Chrome 136+ default profile)
 * - 'dead'    — connection refused or timeout (nothing listening)
 */
async function probePortStatus(port: number, hostname = '127.0.0.1'): Promise<PortProbeStatus> {
  try {
    const response = await fetch(`http://${hostname}:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) {
      await response.text() // consume body
      return { type: 'blocked', port, hostname }
    }
    const data = (await response.json()) as JsonVersionResponse
    if (data.webSocketDebuggerUrl) {
      return { type: 'live', wsUrl: data.webSocketDebuggerUrl, browser: data.Browser || 'Unknown' }
    }
    return { type: 'blocked', port, hostname }
  } catch {
    return { type: 'dead' }
  }
}

/**
 * Probe a port via GET /json/version.
 * Returns the webSocketDebuggerUrl and browser name, or null.
 */
export async function probePort(
  port: number,
  hostname = '127.0.0.1',
): Promise<{ wsUrl: string; browser: string } | null> {
  const status = await probePortStatus(port, hostname)
  if (status.type === 'live') {
    return { wsUrl: status.wsUrl, browser: status.browser }
  }
  return null
}

export interface KnownBrowserDataDir {
  /** Human readable browser name shown in tables, e.g. 'Yandex'. */
  browser: string
  /** Stable id, e.g. 'yandex'. */
  browserId: string
  /** Directory that contains `DevToolsActivePort` and the profile folders. */
  dir: string
}

/**
 * Known Chromium-family user-data directories for the current platform.
 *
 * The returned `dir` is the browser's top-level user data directory — the one
 * that directly contains `DevToolsActivePort` (not the `Default/` profile).
 */
export function getKnownBrowserDataDirs({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
} = {}): KnownBrowserDataDir[] {
  const home = (relative: string) => path.join(homeDir, relative)

  const dirs: KnownBrowserDataDir[] = []

  const push = (browser: string, browserId: string, dir: string) => {
    if (!dir) return
    dirs.push({ browser, browserId, dir })
  }

  if (platform === 'darwin') {
    const support = 'Library/Application Support'
    push('Chrome', 'chrome', home(`${support}/Google/Chrome`))
    push('Chrome Beta', 'chrome-beta', home(`${support}/Google/Chrome Beta`))
    push('Chrome Canary', 'chrome-canary', home(`${support}/Google/Chrome Canary`))
    push('Chromium', 'chromium', home(`${support}/Chromium`))
    push('Edge', 'edge', home(`${support}/Microsoft Edge`))
    push('Brave', 'brave', home(`${support}/BraveSoftware/Brave-Browser`))
    push('Yandex', 'yandex', home(`${support}/Yandex/YandexBrowser`))
    push('Vivaldi', 'vivaldi', home(`${support}/Vivaldi`))
    push('Opera', 'opera', home(`${support}/com.operasoftware.Opera`))
    return dirs
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || home('AppData/Local')
    const win = (...parts: string[]) => path.join(localAppData, ...parts)
    push('Chrome', 'chrome', win('Google', 'Chrome', 'User Data'))
    push('Chrome Beta', 'chrome-beta', win('Google', 'Chrome Beta', 'User Data'))
    push('Chrome Canary', 'chrome-canary', win('Google', 'Chrome SxS', 'User Data'))
    push('Chromium', 'chromium', win('Chromium', 'User Data'))
    push('Edge', 'edge', win('Microsoft', 'Edge', 'User Data'))
    push('Brave', 'brave', win('BraveSoftware', 'Brave-Browser', 'User Data'))
    push('Yandex', 'yandex', win('Yandex', 'YandexBrowser', 'User Data'))
    push('Vivaldi', 'vivaldi', win('Vivaldi', 'User Data'))
    push('Opera', 'opera', win('Programs', 'Opera'))
    return dirs
  }

  // linux and everything else
  const config = (relative: string) => home(`.config/${relative}`)
  push('Chrome', 'chrome', config('google-chrome'))
  push('Chrome Beta', 'chrome-beta', config('google-chrome-beta'))
  push('Chromium', 'chromium', config('chromium'))
  push('Edge', 'edge', config('microsoft-edge'))
  push('Brave', 'brave', config('BraveSoftware/Brave-Browser'))
  push('Yandex', 'yandex', config('yandex-browser'))
  push('Vivaldi', 'vivaldi', config('vivaldi'))
  push('Opera', 'opera', config('opera'))
  return dirs
}

/**
 * Read every known browser's `DevToolsActivePort` file and return the instances
 * whose CDP port is actually reachable.
 *
 * A stale file (browser closed without cleanup) is filtered out by probing the
 * port; only ports that respond (live or blocked) produce an instance.
 */
export async function discoverActivePortInstances({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
  hostname = '127.0.0.1',
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  probe = probePortStatus,
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  hostname?: string
  readFileSync?: (filePath: string, encoding: 'utf-8') => string
  existsSync?: (filePath: string) => boolean
  probe?: PortProber
} = {}): Promise<DiscoveredInstance[]> {
  const candidates = getKnownBrowserDataDirs({ platform, env, homeDir })
  const instances: DiscoveredInstance[] = []

  for (const candidate of candidates) {
    const activePortPath = path.join(candidate.dir, 'DevToolsActivePort')
    if (!existsSync(activePortPath)) {
      continue
    }

    let parsed: ParsedActivePort | null = null
    try {
      parsed = parseDevToolsActivePort(readFileSync(activePortPath, 'utf-8'))
    } catch {
      continue
    }
    if (!parsed) {
      continue
    }

    const status = await probe(parsed.port, hostname)
    if (status.type === 'dead') {
      // Stale DevToolsActivePort left behind by a closed browser.
      continue
    }

    instances.push({
      browser: candidate.browser,
      browserId: candidate.browserId,
      port: parsed.port,
      wsUrl:
        status.type === 'live'
          ? status.wsUrl
          : `ws://${hostname}:${parsed.port}${parsed.wsPath}`,
      profiles: [],
      dataDir: candidate.dir,
    })
  }

  return instances
}

/** Build a ws:// URL for direct CDP. The path is left bare — Chrome 136+
 *  accepts any value under /devtools/browser/. Call appendSessionToWsUrl()
 *  before connecting to make the path unique per session. */
function makeDirectWsUrl(hostname: string, port: number): string {
  return `ws://${hostname}:${port}/devtools/browser/`
}

/** Append a session ID to a /devtools/browser/ ws URL to make it unique.
 *  If the URL already has a full GUID path (e.g. from /json/version), return as-is. */
export function appendSessionToWsUrl(wsUrl: string, sessionId: string): string {
  // Only append if the path ends with / (our synthetic URLs from blocked probes)
  if (wsUrl.endsWith('/')) {
    return `${wsUrl}${sessionId}`
  }
  return wsUrl
}

/**
 * Discover Chromium browser instances with debugging enabled.
 *
 * Combines the DevToolsActivePort files of every known browser (Chrome,
 * Chromium, Edge, Brave, Yandex, Vivaldi, Opera) with probes of the default CDP
 * ports. Instances are de-duplicated by port.
 */
export async function discoverBrowserInstances({
  platform = os.platform(),
  env = process.env,
  homeDir = os.homedir(),
  hostname = '127.0.0.1',
  ports = DEFAULT_CDP_PORTS,
  probe = probePortStatus,
  readFileSync,
  existsSync,
}: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  hostname?: string
  ports?: readonly number[]
  probe?: PortProber
  readFileSync?: (filePath: string, encoding: 'utf-8') => string
  existsSync?: (filePath: string) => boolean
} = {}): Promise<DiscoveredInstance[]> {
  const byPort = new Map<number, DiscoveredInstance>()

  const activePortInstances = await discoverActivePortInstances({
    platform,
    env,
    homeDir,
    hostname,
    probe,
    ...(readFileSync ? { readFileSync } : {}),
    ...(existsSync ? { existsSync } : {}),
  })
  for (const instance of activePortInstances) {
    byPort.set(instance.port, instance)
  }

  const portProbes = await Promise.all(
    ports.map(async (port) => {
      if (byPort.has(port)) {
        return null
      }
      const status = await probe(port, hostname)
      return { port, status }
    }),
  )

  for (const probeResult of portProbes) {
    if (!probeResult) continue
    const { port, status } = probeResult
    if (status.type === 'live') {
      byPort.set(port, {
        browser: parseBrowserVersion(status.browser),
        browserId: browserIdFromVersion(status.browser),
        port,
        wsUrl: status.wsUrl,
        profiles: [],
        dataDir: null,
      })
    } else if (status.type === 'blocked') {
      byPort.set(port, {
        browser: 'Chrome',
        browserId: 'chrome',
        port,
        wsUrl: makeDirectWsUrl(hostname, port),
        profiles: [],
        dataDir: null,
      })
    }
  }

  return Array.from(byPort.values()).sort((a, b) => a.port - b.port)
}

/**
 * Backwards-compatible alias. Historically this only probed Chrome on port 9222;
 * it now discovers every known Chromium browser (including Yandex).
 */
export async function discoverChromeInstances(): Promise<DiscoveredInstance[]> {
  return discoverBrowserInstances()
}

/**
 * Resolve a --direct input value to a WebSocket URL.
 *
 * Accepts:
 * - ws:// or wss:// URL — returned as-is
 * - host:port — probes /json/version to get the webSocketDebuggerUrl
 *
 * Throws with a clear message if the endpoint can't be resolved.
 */
export async function resolveDirectInput(input: string): Promise<string> {
  if (input.startsWith('ws://') || input.startsWith('wss://')) {
    return input
  }

  // Cloud browser providers (Browser Use, Browserbase) return https:// CDP URLs.
  // Convert to wss:// since the WebSocket connection uses the same hostname.
  if (input.startsWith('https://')) {
    return 'wss://' + input.slice('https://'.length)
  }
  if (input.startsWith('http://')) {
    return 'ws://' + input.slice('http://'.length)
  }

  const match = input.match(/^([^:]+):(\d+)$/)
  if (!match) {
    throw new Error(
      `Invalid --direct value: expected a ws:// URL or host:port (e.g. localhost:9222), got: ${input}`,
    )
  }

  const [, hostname, portStr] = match
  const port = parseInt(portStr, 10)
  const status = await probePortStatus(port, hostname)

  if (status.type === 'live') {
    return status.wsUrl
  }

  if (status.type === 'blocked') {
    // Chrome 136+ returns 404 on HTTP but accepts WS on /devtools/browser/*
    return makeDirectWsUrl(hostname, port)
  }

  throw new Error(
    `Nothing found on ${hostname}:${port}. Is a browser running with remote debugging enabled? ` +
      `Try chrome://inspect/#remote-debugging (Chrome/Edge/Brave) or launch the browser with --remote-debugging-port=${port}.`,
  )
}

function browserIdFromVersion(browserString: string): string {
  const name = browserString.split('/')[0]?.toLowerCase() || ''
  if (name.includes('edg')) return 'edge'
  if (name.includes('brave')) return 'brave'
  if (name.includes('yandex')) return 'yandex'
  if (name.includes('vivaldi')) return 'vivaldi'
  if (name.includes('opr') || name.includes('opera')) return 'opera'
  if (name.includes('chromium')) return 'chromium'
  return 'chrome'
}

function parseBrowserVersion(browserString: string): string {
  if (browserString.startsWith('HeadlessChrome/')) {
    return 'Chrome (Headless)'
  }
  if (browserString.startsWith('Chrome/')) {
    return 'Chrome'
  }
  const slashIndex = browserString.indexOf('/')
  if (slashIndex > 0) {
    return browserString.slice(0, slashIndex)
  }
  return browserString
}

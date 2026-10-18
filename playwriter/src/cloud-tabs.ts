/**
 * Cloud (synced) tabs: the tabs that are open on the user's *other* signed-in
 * browser devices, as reported by the `chrome.sessions` extension API.
 *
 * The same API backs Chrome Sync, Yandex Browser's own sync, Edge and Brave, so
 * one implementation covers every Chromium browser Playwriter drives. The raw
 * shapes differ between browsers and between the two entry points
 * (`getDevices()` returns tab *or* window sessions, `getRecentlyClosed()`
 * returns only tabs), and `lastModified` lives on the session, not the tab.
 *
 * All of that normalization lives here: this module is pure, has no browser
 * dependency and is unit-tested, so the extension, the relay and the CLI can
 * share one shape.
 */

/** One synced tab that lives on another device or in the recently-closed list. */
export type CloudTab = {
  title: string
  url: string
  favIconUrl?: string
  /** Seconds since the epoch when the tab was last modified on its device. */
  lastModified: number
  /** Device the tab lives on. Absent for recently-closed entries. */
  deviceName?: string
}

export type CloudDevice = {
  deviceName: string
  /** Most recently modified tab first. */
  tabs: Array<Omit<CloudTab, 'deviceName'>>
}

export type CloudTabsResult = {
  /** True when the browser exposes no `chrome.sessions` API at all. */
  unsupported: boolean
  /** Other signed-in devices, most recently active first. */
  devices: CloudDevice[]
  /** Recently closed tabs on this device, most recent first. */
  recentlyClosed: CloudTab[]
}

export const EMPTY_CLOUD_TABS: CloudTabsResult = { unsupported: false, devices: [], recentlyClosed: [] }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readLastModified(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Normalize one `chrome.tabs.Tab`-shaped object. `lastModified` comes from the session. */
function toTab(rawTab: unknown, ctx: { lastModified: number; deviceName?: string }): CloudTab | undefined {
  const tab = asRecord(rawTab)
  if (!tab) {
    return undefined
  }
  const url = readString(tab.url) ?? readString(tab.pendingUrl)
  if (!url) {
    return undefined
  }
  const favIconUrl = readString(tab.favIconUrl)
  return {
    title: readString(tab.title) ?? url,
    url,
    lastModified: ctx.lastModified,
    ...(favIconUrl ? { favIconUrl } : {}),
    ...(ctx.deviceName ? { deviceName: ctx.deviceName } : {}),
  }
}

/** Expand one session (a single tab or a whole window) into cloud tabs. */
function sessionToTabs(rawSession: unknown, deviceName?: string): CloudTab[] {
  const session = asRecord(rawSession)
  if (!session) {
    return []
  }
  const lastModified = readLastModified(session.lastModified)

  const single = toTab(session.tab, { lastModified, deviceName })
  if (single) {
    return [single]
  }

  const window = asRecord(session.window)
  const windowTabs = Array.isArray(window?.tabs) ? window.tabs : []
  return windowTabs
    .map((tab) => toTab(tab, { lastModified, deviceName }))
    .filter((tab): tab is CloudTab => Boolean(tab))
}

/** Keep the first occurrence of each url so a device never lists the same page twice. */
function dedupeByUrl(tabs: CloudTab[]): CloudTab[] {
  const seen = new Set<string>()
  const result: CloudTab[] = []
  for (const tab of tabs) {
    if (seen.has(tab.url)) {
      continue
    }
    seen.add(tab.url)
    result.push(tab)
  }
  return result
}

/**
 * Turn the raw `chrome.sessions` payload into the stable {@link CloudTabsResult}
 * shape. Missing or malformed entries are dropped instead of throwing, because
 * browsers differ in how much of a tab they report for foreign sessions.
 */
export function normalizeCloudTabs(
  input: { devices?: unknown; recentlyClosed?: unknown; unsupported?: boolean } = {},
): CloudTabsResult {
  const devices: CloudDevice[] = []

  if (Array.isArray(input.devices)) {
    for (const rawDevice of input.devices) {
      const device = asRecord(rawDevice)
      if (!device) {
        continue
      }
      const deviceName = readString(device.deviceName) ?? 'Unknown device'
      const sessions = Array.isArray(device.sessions) ? device.sessions : []
      const tabs = dedupeByUrl(
        sessions
          .flatMap((session) => sessionToTabs(session, deviceName))
          .sort((a, b) => b.lastModified - a.lastModified),
      )
      if (tabs.length > 0) {
        devices.push({ deviceName, tabs: tabs.map(({ deviceName: _drop, ...tab }) => tab) })
      }
    }
  }

  devices.sort((a, b) => (b.tabs[0]?.lastModified ?? 0) - (a.tabs[0]?.lastModified ?? 0))

  const recentlyClosed = Array.isArray(input.recentlyClosed)
    ? dedupeByUrl(sessionToTabsList(input.recentlyClosed).sort((a, b) => b.lastModified - a.lastModified))
    : []

  return { unsupported: input.unsupported ?? false, devices, recentlyClosed }
}

function sessionToTabsList(sessions: unknown[]): CloudTab[] {
  return sessions.flatMap((session) => sessionToTabs(session))
}

/** Every cloud tab in display order: other devices first, then recently closed. */
export function flattenCloudTabs(result: CloudTabsResult): CloudTab[] {
  const fromDevices = result.devices.flatMap((device) =>
    device.tabs.map((tab) => ({ ...tab, deviceName: device.deviceName })),
  )
  return [...fromDevices, ...result.recentlyClosed]
}

/**
 * Resolve a `--open` reference to a url. Accepts the 1-based number from the
 * listing, a full url, or a substring that matches exactly one url. Returns
 * undefined when nothing (or more than one thing) matches.
 */
export function resolveCloudTabRef(tabs: CloudTab[], ref: string): string | undefined {
  const trimmed = ref.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.includes('://')) {
    return trimmed
  }
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= tabs.length) {
    return tabs[index - 1]?.url
  }
  const matches = tabs.filter((tab) => tab.url.includes(trimmed))
  return matches.length === 1 ? matches[0]?.url : undefined
}

const NO_TABS_MESSAGE = 'No cloud tabs found.'
const NO_TABS_HINT =
  'Sign in to browser sync on this device and at least one other, then enable tab/group syncing.'

/** Human-readable listing used by `playwriter cloud-tabs`. */
export function formatCloudTabs(result: CloudTabsResult): string {
  const flat = flattenCloudTabs(result)
  if (flat.length === 0) {
    if (result.unsupported) {
      return 'This browser does not expose the chrome.sessions API, so cloud tabs cannot be read.'
    }
    return `${NO_TABS_MESSAGE} ${NO_TABS_HINT}`
  }

  const rows = flat.map((tab, index) => ({
    index: index + 1,
    device: tab.deviceName ?? 'closed',
    tab,
  }))
  const deviceWidth = Math.max(6, ...rows.map((row) => row.device.length))
  const indexWidth = String(rows.length).length

  const lines: string[] = []
  lines.push(`${'#'.padStart(indexWidth)}  ${'DEVICE'.padEnd(deviceWidth)}  TITLE`)
  for (const row of rows) {
    lines.push(`${String(row.index).padStart(indexWidth)}  ${row.device.padEnd(deviceWidth)}  ${row.tab.title}`)
    lines.push(`${' '.repeat(indexWidth)}  ${' '.repeat(deviceWidth)}  ${row.tab.url}`)
  }
  return lines.join('\n')
}

/**
 * Yandex Cloud Tabs — read synced tabs from the local profile files.
 *
 * This module reads two sources inside a Yandex Browser profile:
 * 1. `Preferences` (JSON) → `shared_space.enabled_on_devices` maps session ids to device names.
 * 2. `Sync Data/LevelDB/*` — plaintext protobuf entities keyed by
 *    `shared_space_sessions-dt-<uuid>`, containing url + title pairs per tab/window.
 *
 * The data is grouped by device → window (group), sorted by recency, and capped
 * at a configurable limit so the agent's context never floods.
 *
 * This is a local-file reader — no browser API needed. It works even when the
 * extension is disconnected or `chrome.sessions.getDevices()` returns empty
 * (which happens in Yandex because it doesn't wire Chromium's OpenTabsUIDelegate).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getKnownBrowserDataDirs } from './chrome-discovery.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One synced tab discovered in the profile. */
export type YandexTab = {
  /** Full url (http/https). */
  url: string
  /** Page title. */
  title: string
  /** Device name from `shared_space.enabled_on_devices`. */
  deviceName: string
  /** Session id (used internally for grouping; not displayed directly). */
  sessionId: string
  /** Window id within the session — tabs with the same windowId form a "group". */
  windowId?: number
}

/** A group of tabs that belong to one browser window on one device. */
export type YandexTabGroup = {
  deviceName: string
  sessionId: string
  /** Window id (undefined means "ungrouped" / single-tab entries). */
  windowId?: number
  /** Tabs in this group, most recent first. */
  tabs: Array<Omit<YandexTab, 'deviceName' | 'sessionId'>>
}

/** Result of reading the Yandex profile. */
export type YandexTabsResult = {
  /** Device → groups mapping. */
  groups: YandexTabGroup[]
  /** Total tab count before limit was applied. */
  totalCount: number
  /** Whether the device map could not be read (profile may be wrong or browser closed). */
  deviceMapError?: string
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

/**
 * Find Yandex Browser profile directories on this platform.
 * Returns paths that contain a `Preferences` file (the canonical marker).
 */
export function findYandexProfileDirs(): string[] {
  const dirs = getKnownBrowserDataDirs()
  const yandex = dirs.find((d) => d.browserId === 'yandex')
  if (!yandex) {
    return []
  }

  // The `dir` is the top-level user-data dir (e.g. .../Yandex/YandexBrowser).
  // Profile subdirs are Default, Profile 1, etc.
  const profiles: string[] = []
  try {
    for (const entry of fs.readdirSync(yandex.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const prefPath = path.join(yandex.dir, entry.name, 'Preferences')
      if (fs.existsSync(prefPath)) {
        profiles.push(path.join(yandex.dir, entry.name))
      }
    }
  } catch {
    // Permission error — profile dir inaccessible.
  }

  // If no sub-profiles found, try the top-level dir itself.
  if (profiles.length === 0 && fs.existsSync(path.join(yandex.dir, 'Preferences'))) {
    profiles.push(yandex.dir)
  }

  return profiles.sort((a, b) => {
    // Prefer "Default" first.
    const aIsDefault = path.basename(a).toLowerCase() === 'default' ? 0 : 1
    const bIsDefault = path.basename(b).toLowerCase() === 'default' ? 0 : 1
    return aIsDefault - bIsDefault || b.length - a.length // longer (more recent) first
  })
}

// ---------------------------------------------------------------------------
// Device map reader — Preferences JSON
// ---------------------------------------------------------------------------

/**
 * Read `shared_space.enabled_on_devices` from the profile's Preferences file.
 * Returns `{ sessionId: { deviceName, deviceType } }`.
 */
export function readDeviceMap(profileDir: string): Record<string, { deviceName: string; deviceType: number }> | undefined {
  const prefPath = path.join(profileDir, 'Preferences')
  if (!fs.existsSync(prefPath)) return undefined

  try {
    const raw = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as Record<string, unknown>
    const sharedSpaceRaw = (raw['shared_space'] ?? raw['account_values']?.['shared_space']) as
      | { enabled_on_devices?: Record<string, unknown> }
      | undefined

    if (!sharedSpaceRaw?.enabled_on_devices) return undefined

    const map: Record<string, { deviceName: string; deviceType: number }> = {}
    for (const [sessionId, info] of Object.entries(sharedSpaceRaw.enabled_on_devices)) {
      if (typeof info !== 'object' || !info) continue
      const entry = info as Record<string, unknown>
      const name = typeof entry.device_name === 'string' && entry.device_name ? String(entry.device_name) : undefined
      if (!name) continue
      map[sessionId] = { deviceName: name, deviceType: Number(entry.device_type ?? 0) }
    }
    return Object.keys(map).length > 0 ? map : undefined
  } catch {
    // Corrupt Preferences — caller will get a warning.
    return undefined
  }
}

// ---------------------------------------------------------------------------
// LevelDB scanner — pragmatic string-pair extractor
// ---------------------------------------------------------------------------

const SESSION_KEY_RE = /shared_space_sessions-dt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const HTTP_RE = /^https?:\/\//i

/** Extract protobuf length-prefixed printable strings from a byte window. */
function extractLpStrings(buf: Uint8Array): string[] {
  const out: string[] = []
  let i = 0
  const n = buf.length
  while (i < n - 1) {
    const L = buf[i]
    if (L >= 1 && L <= 0x7f && i + 1 + L <= n) {
      try {
        const s = new TextDecoder().decode(buf.subarray(i + 1, i + 1 + L))
        if (stringIsPrintable(s) && s.length >= 2) {
          out.push(s)
          i += 1 + L
          continue
        }
      } catch { /* not valid UTF-8 */ }
    }
    i++
  }
  return out
}

/** Check if every character is printable (including common punctuation). */
function stringIsPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // Allow space, printable ASCII, and common non-ASCII ranges.
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 55295)) continue
    return false
  }
  return true
}

/** Host-like strings to skip (referrers, favicons) between url and title. */
function looksLikeHostOrReferrer(s: string): boolean {
  // Starts with www., contains a dot-slash pattern typical of hostnames.
  if (/^(www\.)?[a-z0-9](-*[a-z0-9])+\.[a-z]{2,}\//i.test(s)) return true
  // Looks like a favicon path.
  if (s.toLowerCase().includes('favicon')) return true
  return false
}

/** Scan one LevelDB file for session entities and extract url/title pairs. */
function scanLevelDbFile(
  filePath: string,
  deviceMap: Record<string, { deviceName: string; deviceType: number }>,
): YandexTab[] {
  const tabs: YandexTab[] = []
  try {
    const data = fs.readFileSync(filePath)
    let match: RegExpExecArray | null

    SESSION_KEY_RE.lastIndex = 0
    while ((match = SESSION_KEY_RE.exec(data.toString('utf-8'))) !== null) {
      // Take a window of bytes after the key.
      const startIdx = match.index + match[0].length
      const windowSize = 2500
      const windowBytes = data.subarray(startIdx, startIdx + windowSize)

      // Extract length-prefixed strings from this window.
      const strs = extractLpStrings(windowBytes)
      if (strs.length < 2) continue

      // Find the first http(s) URL in the string list.
      let urlIdx = -1
      for (let i = 0; i < strs.length; i++) {
        if (HTTP_RE.test(strs[i])) {
          urlIdx = i
          break
        }
      }
      if (urlIdx === -1) continue

      const url = strs[urlIdx]
      // Find title: first non-URL, non-host, non-uuid string after the URL.
      let title = ''
      for (let j = urlIdx + 1; j < strs.length && j < urlIdx + 8; j++) {
        const s = strs[j]
        if (!HTTP_RE.test(s) && !looksLikeHostOrReferrer(s) && !UUID_RE.test(s) && s.length >= 2) {
          title = s
          break
        }
      }

      // Find session id: first uuid in the string list.
      let sessionId = ''
      for (const s of strs) {
        if (UUID_RE.test(s)) {
          sessionId = s
          break
        }
      }

      const deviceName = deviceMap[sessionId]?.deviceName ?? 'Unknown'

      tabs.push({ url, title: title || url, deviceName, sessionId })
    }
  } catch {
    // Corrupt or locked file — skip.
  }
  return tabs
}

/** Scan all LevelDB files in the profile's Sync Data directory. */
function scanSyncDb(profileDir: string): YandexTab[] {
  const syncDir = path.join(profileDir, 'Sync Data', 'LevelDB')
  if (!fs.existsSync(syncDir)) return []

  const tabs: YandexTab[] = []
  try {
    for (const file of fs.readdirSync(syncDir).sort()) {
      // Skip non-data files.
      if (/^(LOG|CURRENT|LOCK|MANIFEST)/.test(file)) continue
      tabs.push(...scanLevelDbFile(path.join(syncDir, file), {}))
    }
  } catch {
    // Permission error — skip.
  }
  return tabs
}

// ---------------------------------------------------------------------------
// Window id extraction — look for numeric IDs near the url in the string list
// ---------------------------------------------------------------------------

/**
 * Try to extract a window id from the raw bytes around the URL match.
 * Returns undefined if not found (most entries won't have one).
 */
function tryExtractWindowId(data: Uint8Array, urlIdxInStrs: number, strs: string[]): number | undefined {
  // Look for a small integer (< 10000) that appears as a standalone value
  // in the strings list near the URL — this is typically the window_id field.
  const range = Math.min(urlIdxInStrs + 5, strs.length)
  for (let i = urlIdxInStrs - 2; i < range; i++) {
    if (i < 0 || i >= strs.length) continue
    const s = strs[i]
    // Window ids in Chromium sessions are small integers.
    if (/^\d{1,5}$/.test(s)) {
      const num = parseInt(s, 10)
      if (num > 0 && num < 10000) return num
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Grouping and formatting
// ---------------------------------------------------------------------------

/**
 * Read the Yandex profile and return grouped cloud tabs.
 */
export function readYandexTabs(options: {
  /** Profile directory (auto-detected if omitted). */
  profileDir?: string
  /** Maximum number of groups to return (default 30). */
  limit?: number
}): YandexTabsResult {
  const profiles = options.profileDir ? [options.profileDir] : findYandexProfileDirs()
  if (profiles.length === 0) {
    return { groups: [], totalCount: 0, deviceMapError: 'No Yandex Browser profile found on this system.' }
  }

  let deviceMap: Record<string, { deviceName: string; deviceType: number }> | undefined
  let deviceMapError: string | undefined

  // Try each profile until we find a valid one.
  for (const dir of profiles) {
    const map = readDeviceMap(dir)
    if (map && Object.keys(map).length > 0) {
      deviceMap = map
      break
    }
    if (!deviceMapError) {
      deviceMapError = `Could not read device map from "${dir}" — the profile may be empty or corrupted.`
    }
  }

  // Scan all profiles' sync DBs.
  const allTabs: YandexTab[] = []
  for (const dir of profiles) {
    const rawTabs = scanSyncDb(dir)
    if (deviceMap) {
      // Enrich with device names and window ids.
      for (const tab of rawTabs) {
        if (tab.sessionId && deviceMap[tab.sessionId]) {
          tab.deviceName = deviceMap[tab.sessionId].deviceName
        }
        // Try to extract window id from the raw data.
        const syncDir = path.join(dir, 'Sync Data', 'LevelDB')
        if (fs.existsSync(syncDir)) {
          try {
            for (const file of fs.readdirSync(syncDir).sort()) {
              if (/^(LOG|CURRENT|LOCK|MANIFEST)/.test(file)) continue
              const data = fs.readFileSync(path.join(syncDir, file))
              const strData = data.toString('utf-8')
              // Find the url in this file and try to extract window id.
              const idx = strData.indexOf(tab.url)
              if (idx >= 0) {
                // Extract strings from a window around the url.
                const winStart = Math.max(0, idx - 2500)
                const winBytes = data.subarray(winStart, winStart + 3000)
                const strs = extractLpStrings(winBytes)
                const urlIdx = strs.findIndex((s) => s === tab.url || s.startsWith(tab.url))
                if (urlIdx >= 0) {
                  const wid = tryExtractWindowId(data, urlIdx, strs)
                  if (wid && !tab.windowId) {
                    tab.windowId = wid
                  }
                }
              }
            }
          } catch { /* skip */ }
        }
      }
    }
    allTabs.push(...rawTabs)
  }

  // Deduplicate by url + device.
  const seen = new Set<string>()
  const unique: YandexTab[] = []
  for (const tab of allTabs) {
    const key = `${tab.deviceName}|||${tab.url}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(tab)
    }
  }

  // Group by device → window.
  const groupsMap = new Map<string, YandexTabGroup>()
  for (const tab of unique) {
    const groupId = `${tab.deviceName}|||${tab.sessionId}|||${tab.windowId ?? 'ungrouped'}`
    let group = groupsMap.get(groupId)
    if (!group) {
      group = { deviceName: tab.deviceName, sessionId: tab.sessionId, windowId: tab.windowId, tabs: [] }
      groupsMap.set(groupId, group)
    }
    // Only add to group if we have a title (skip noise entries).
    if (tab.title && tab.title !== tab.url) {
      group.tabs.push({ url: tab.url, title: tab.title })
    }
  }

  const groups = Array.from(groupsMap.values())
  // Sort devices by name, then windows within each device.
  groups.sort((a, b) => a.deviceName.localeCompare(b.deviceName))

  return { groups, totalCount: unique.length, deviceMapError }
}

/** Format the result as a human-readable table. */
export function formatYandexTabs(result: YandexTabsResult): string {
  if (result.groups.length === 0) {
    const msg = 'No cloud tabs found.'
    return result.deviceMapError ? `${msg}\n\n${result.deviceMapError}` : msg
  }

  const lines: string[] = []
  let index = 1
  for (const group of result.groups) {
    const windowLabel = group.windowId !== undefined ? ` [window ${group.windowId}]` : ''
    lines.push(`\n${group.deviceName}${windowLabel} (${group.tabs.length} tab${group.tabs.length === 1 ? '' : 's'})`)
    for (const tab of group.tabs) {
      lines.push(`  ${String(index).padStart(3)}  ${tab.title}`)
      lines.push(`       ${tab.url}`)
      index++
    }
  }

  if (result.totalCount > result.groups.reduce((sum, g) => sum + g.tabs.length, 0)) {
    const filtered = result.totalCount - result.groups.reduce((sum, g) => sum + g.tabs.length, 0)
    lines.push(`\n(${filtered} tab${filtered === 1 ? ' was' : 's were'} skipped due to parsing noise.)`)
  }

  return lines.join('\n')
}

/** Resolve a --open/--open-group reference to one or more urls. */
export function resolveYandexTabRefs(
  result: YandexTabsResult,
  ref: string,
): { singleUrl?: string; groupUrls?: string[] } | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined

  // Full url?
  if (HTTP_RE.test(trimmed)) return { singleUrl: trimmed }

  // Numeric index?
  const num = Number(trimmed)
  if (Number.isInteger(num) && num >= 1) {
    let idx = 0
    for (const group of result.groups) {
      for (let i = 0; i < group.tabs.length; i++) {
        if (idx + i + 1 === num) {
          return { singleUrl: group.tabs[i].url }
        }
      }
      idx += group.tabs.length
    }
    return undefined // out of range
  }

  // Substring match — try to find exactly one url.
  const matches: string[] = []
  for (const group of result.groups) {
    for (const tab of group.tabs) {
      if (tab.url.includes(trimmed)) matches.push(tab.url)
    }
  }
  return matches.length === 1 ? { singleUrl: matches[0] } : undefined
}

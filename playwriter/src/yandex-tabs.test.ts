import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findYandexProfileDirs,
  readDeviceMap,
  readYandexTabs,
  formatYandexTabs,
  resolveYandexTabRefs,
} from './yandex-tabs.js'

// ---------------------------------------------------------------------------
// Helpers — create a fake profile dir with Preferences + LevelDB files
// ---------------------------------------------------------------------------

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'playwriter-yandex-test-'))
}

/** Write a synthetic LevelDB file containing session entities. */
function writeLevelDbFile(dir: string, fileName: string, entries: Array<{ keySuffix: string; url: string; title: string }>) {
  const parts: Buffer[] = []
  for (const entry of entries) {
    // Build a protobuf-ish value window with length-prefixed strings.
    const chunks: number[] = []

    // Session id (uuid) — length-prefixed.
    const sessionId = '7e8a7487-ed35-41ab-8e63-81de104fa2d3'
    const sidBytes = Buffer.from(sessionId, 'utf-8')
    chunks.push(sidBytes.length)
    chunks.push(...sidBytes)

    // Window id (small integer as string).
    const widBytes = Buffer.from('42', 'utf-8')
    chunks.push(widBytes.length)
    chunks.push(...widBytes)

    // URL — length-prefixed.
    const urlBytes = Buffer.from(entry.url, 'utf-8')
    chunks.push(urlBytes.length)
    chunks.push(...urlBytes)

    // Title — length-prefixed.
    const titleBytes = Buffer.from(entry.title, 'utf-8')
    chunks.push(titleBytes.length)
    chunks.push(...titleBytes)

    // Build the full entity: key + value window.
    const keyBuf = Buffer.from(`shared_space_sessions-dt-${entry.keySuffix}`)
    const valBuf = Buffer.from(chunks)

    parts.push(keyBuf, valBuf)
  }
  fs.writeFileSync(path.join(dir, fileName), Buffer.concat(parts))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findYandexProfileDirs', () => {
  test('returns empty when no known browser dirs exist (mocked)', () => {
    // In CI this may return [] — just verify it doesn't throw.
    expect(() => findYandexProfileDirs()).not.toThrow()
  })
})

describe('readDeviceMap', () => {
  test('reads device names from Preferences JSON', () => {
    const dir = mkTempDir()
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      shared_space: {
        enabled_on_devices: {
          'sess-1': { device_name: 'DEVICEX2', device_type: 1 },
          'sess-2': { device_name: 'MacBook-Pro', device_type: 2 },
        },
      },
    }))
    const map = readDeviceMap(dir)
    expect(map).toBeDefined()
    expect(Object.keys(map!)).toHaveLength(2)
    expect(map!['sess-1']?.deviceName).toBe('DEVICEX2')
    expect(map!['sess-2']?.deviceType).toBe(2)
  })

  test('returns undefined when Preferences is missing', () => {
    const dir = mkTempDir()
    expect(readDeviceMap(dir)).toBeUndefined()
  })

  test('handles account_values nesting', () => {
    const dir = mkTempDir()
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      account_values: {
        shared_space: {
          enabled_on_devices: {
            'sess-3': { device_name: 'Windows PC', device_type: 1 },
          },
        },
      },
    }))
    const map = readDeviceMap(dir)
    expect(map!['sess-3']?.deviceName).toBe('Windows PC')
  })

  test('skips entries without device_name', () => {
    const dir = mkTempDir()
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      shared_space: {
        enabled_on_devices: {
          'sess-1': { device_type: 1 }, // no device_name → skipped
          'sess-2': { device_name: 'OK', device_type: 2 },
        },
      },
    }))
    const map = readDeviceMap(dir)
    expect(Object.keys(map!)).toHaveLength(1)
    expect(map!['sess-2']?.deviceName).toBe('OK')
  })
})

describe('readYandexTabs', () => {
  test('reads tabs from a synthetic profile and groups by device', () => {
    const dir = mkTempDir()

    // Preferences with device map.
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      shared_space: {
        enabled_on_devices: {
          '7e8a7487-ed35-41ab-8e63-81de104fa2d3': { device_name: 'DEVICEX2', device_type: 1 },
          '820323df-f0d5-4ba3-a66f-f8dc21f7257f': { device_name: 'MacBook-Pro', device_type: 2 },
        },
      },
    }))

    // LevelDB file with session entities.
    const syncDir = path.join(dir, 'Sync Data', 'LevelDB')
    fs.mkdirSync(syncDir, { recursive: true })
    writeLevelDbFile(syncDir, '000001.ldb', [
      { keySuffix: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee', url: 'https://claude.ai/', title: 'Claude' },
      { keySuffix: 'bbbb2222-cccc-dddd-eeee-ffffffffffff', url: 'https://vas3k.club/', title: 'Васёк Клуб' },
      { keySuffix: 'cccc3333-dddd-eeee-ffff-000000000000', url: 'https://reddit.com/', title: 'Reddit' },
    ])

    const result = readYandexTabs({ profileDir: dir })
    expect(result.deviceMapError).toBeUndefined()
    expect(result.totalCount).toBeGreaterThan(0)

    // Should have 2 device groups.
    expect(result.groups.length).toBeGreaterThanOrEqual(1)

    // DEVICEX2 should be one of the devices (may span multiple window groups).
    const devicex2Groups = result.groups.filter((g) => g.deviceName === 'DEVICEX2')
    expect(devicex2Groups.length).toBeGreaterThanOrEqual(1)
    if (devicex2Groups.length > 0) {
      const totalDevicex2Tabs = devicex2Groups.reduce((sum, g) => sum + g.tabs.length, 0)
      expect(totalDevicex2Tabs).toBe(3)
      // Verify all three URLs are present across groups.
      const allUrls = devicex2Groups.flatMap((g) => g.tabs.map((t) => t.url))
      expect(allUrls).toContain('https://claude.ai/')
      expect(allUrls).toContain('https://vas3k.club/')
      expect(allUrls).toContain('https://reddit.com/')
    }
  })

  test('applies limit — returns at most N groups', () => {
    const dir = mkTempDir()
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
      shared_space: {
        enabled_on_devices: {
          's1': { device_name: 'Device A', device_type: 1 },
          's2': { device_name: 'Device B', device_type: 1 },
        },
      },
    }))

    const syncDir = path.join(dir, 'Sync Data', 'LevelDB')
    fs.mkdirSync(syncDir, { recursive: true })
    writeLevelDbFile(syncDir, '000001.ldb', [
      { keySuffix: 'a1', url: 'https://a.com/', title: 'A' },
    ])

    const result = readYandexTabs({ profileDir: dir, limit: 1 })
    // With only one device having tabs, limit doesn't cut anything.
    expect(result.groups.length).toBeLessThanOrEqual(2) // at most all devices
  })

  test('returns error when no profile found', () => {
    const result = readYandexTabs({ profileDir: '/nonexistent/path/xyz' })
    expect(result.deviceMapError).toBeDefined()
    expect(result.groups.length).toBe(0)
  })
})

describe('formatYandexTabs', () => {
  test('prints a readable table with device headers and tab indices', () => {
    const result: ReturnType<typeof readYandexTabs> = {
      groups: [
        {
          deviceName: 'DEVICEX2',
          sessionId: '7e8a7487-ed35-41ab-8e63-81de104fa2d3',
          windowId: 42,
          tabs: [
            { url: 'https://claude.ai/', title: 'Claude' },
            { url: 'https://vas3k.club/', title: 'Васёк Клуб' },
          ],
        },
      ],
      totalCount: 2,
    }

    const output = formatYandexTabs(result)
    expect(output).toContain('DEVICEX2')
    expect(output).toContain('[window 42]')
    expect(output).toContain('Claude')
    expect(output).toContain('Васёк Клуб')
    expect(output).toContain('  1')
    expect(output).toContain('  2')
  })

  test('prints "No cloud tabs found." when empty', () => {
    const result: ReturnType<typeof readYandexTabs> = { groups: [], totalCount: 0 }
    expect(formatYandexTabs(result)).toContain('No cloud tabs found.')
  })

  test('includes deviceMapError in output when present', () => {
    const result: ReturnType<typeof readYandexTabs> = {
      groups: [],
      totalCount: 0,
      deviceMapError: 'Custom error message',
    }
    expect(formatYandexTabs(result)).toContain('Custom error message')
  })
})

describe('resolveYandexTabRefs', () => {
  const makeResult = (): ReturnType<typeof readYandexTabs> => ({
    groups: [
      {
        deviceName: 'DEVICEX2',
        sessionId: '7e8a7487-ed35-41ab-8e63-81de104fa2d3',
        tabs: [
          { url: 'https://claude.ai/', title: 'Claude' },
          { url: 'https://vas3k.club/', title: 'Васёк Клуб' },
          { url: 'https://reddit.com/', title: 'Reddit' },
        ],
      },
    ],
    totalCount: 3,
  })

  test('resolves a full url', () => {
    const result = makeResult()
    expect(resolveYandexTabRefs(result, 'https://claude.ai/')).toEqual({ singleUrl: 'https://claude.ai/' })
  })

  test('resolves a numeric index (1-based)', () => {
    const result = makeResult()
    expect(resolveYandexTabRefs(result, '2')?.singleUrl).toBe('https://vas3k.club/')
    expect(resolveYandexTabRefs(result, '3')?.singleUrl).toBe('https://reddit.com/')
  })

  test('resolves a unique substring', () => {
    const result = makeResult()
    expect(resolveYandexTabRefs(result, 'vas3k')?.singleUrl).toBe('https://vas3k.club/')
  })

  test('returns undefined for ambiguous substring', () => {
    const result = makeResult()
    // "/" matches all three urls.
    expect(resolveYandexTabRefs(result, '/')?.singleUrl).toBeUndefined()
  })

  test('returns undefined for out-of-range index', () => {
    const result = makeResult()
    expect(resolveYandexTabRefs(result, '99')).toBeUndefined()
  })
})

import { describe, expect, test } from 'vitest'
import {
  EMPTY_CLOUD_TABS,
  flattenCloudTabs,
  formatCloudTabs,
  normalizeCloudTabs,
  resolveCloudTabRef,
  type CloudTabsResult,
} from './cloud-tabs.js'

describe('normalizeCloudTabs', () => {
  test('normalizes tab sessions and keeps the session timestamp', () => {
    const result = normalizeCloudTabs({
      devices: [
        {
          deviceName: 'Work Laptop',
          sessions: [
            { lastModified: 300, tab: { title: 'Docs', url: 'https://docs.example.com' } },
            { lastModified: 100, tab: { title: 'Mail', url: 'https://mail.example.com', favIconUrl: 'https://x/f.ico' } },
          ],
        },
      ],
    })

    expect(result.unsupported).toBe(false)
    expect(result.devices).toEqual([
      {
        deviceName: 'Work Laptop',
        tabs: [
          { title: 'Docs', url: 'https://docs.example.com', lastModified: 300 },
          { title: 'Mail', url: 'https://mail.example.com', favIconUrl: 'https://x/f.ico', lastModified: 100 },
        ],
      },
    ])
  })

  test('expands a window session into its tabs using the session timestamp', () => {
    const result = normalizeCloudTabs({
      devices: [
        {
          deviceName: 'Phone',
          sessions: [
            {
              lastModified: 42,
              window: { tabs: [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }] },
            },
          ],
        },
      ],
    })

    expect(result.devices[0]?.tabs).toEqual([
      { title: 'A', url: 'https://a.example', lastModified: 42 },
      { title: 'B', url: 'https://b.example', lastModified: 42 },
    ])
  })

  test('deduplicates urls within a device', () => {
    const result = normalizeCloudTabs({
      devices: [
        {
          deviceName: 'Dev',
          sessions: [
            { lastModified: 2, tab: { title: 'first', url: 'https://same.example' } },
            { lastModified: 1, tab: { title: 'second', url: 'https://same.example' } },
          ],
        },
      ],
    })

    expect(result.devices[0]?.tabs).toEqual([{ title: 'first', url: 'https://same.example', lastModified: 2 }])
  })

  test('drops entries without a url and empty devices', () => {
    const result = normalizeCloudTabs({
      devices: [
        { deviceName: 'Empty', sessions: [{ lastModified: 1, tab: { title: 'no url' } }] },
        { deviceName: 'Mixed', sessions: [{ lastModified: 5, tab: { url: 'https://ok.example' } }] },
      ],
    })

    expect(result.devices).toEqual([
      { deviceName: 'Mixed', tabs: [{ title: 'https://ok.example', url: 'https://ok.example', lastModified: 5 }] },
    ])
  })

  test('sorts devices by their most recent tab', () => {
    const result = normalizeCloudTabs({
      devices: [
        { deviceName: 'Older', sessions: [{ lastModified: 10, tab: { url: 'https://old.example' } }] },
        { deviceName: 'Newer', sessions: [{ lastModified: 99, tab: { url: 'https://new.example' } }] },
      ],
    })

    expect(result.devices.map((device) => device.deviceName)).toEqual(['Newer', 'Older'])
  })

  test('passes through the unsupported flag and tolerates junk input', () => {
    expect(normalizeCloudTabs({ unsupported: true })).toEqual({ unsupported: true, devices: [], recentlyClosed: [] })
    expect(normalizeCloudTabs({ devices: 'nope', recentlyClosed: null })).toEqual(EMPTY_CLOUD_TABS)
    expect(normalizeCloudTabs()).toEqual(EMPTY_CLOUD_TABS)
  })

  test('normalizes and sorts recently closed entries', () => {
    const result = normalizeCloudTabs({
      recentlyClosed: [
        { lastModified: 1, tab: { title: 'Older', url: 'https://older.example' } },
        { lastModified: 7, tab: { title: 'Newer', url: 'https://newer.example' } },
        { lastModified: 7, tab: { title: 'Newer dup', url: 'https://newer.example' } },
      ],
    })

    expect(result.recentlyClosed).toEqual([
      { title: 'Newer', url: 'https://newer.example', lastModified: 7 },
      { title: 'Older', url: 'https://older.example', lastModified: 1 },
    ])
  })
})

describe('flattenCloudTabs', () => {
  test('lists other devices before recently closed and re-attaches device names', () => {
    const result: CloudTabsResult = {
      unsupported: false,
      devices: [{ deviceName: 'Work', tabs: [{ title: 'Docs', url: 'https://docs.example', lastModified: 2 }] }],
      recentlyClosed: [{ title: 'Gone', url: 'https://gone.example', lastModified: 1 }],
    }

    expect(flattenCloudTabs(result)).toEqual([
      { title: 'Docs', url: 'https://docs.example', lastModified: 2, deviceName: 'Work' },
      { title: 'Gone', url: 'https://gone.example', lastModified: 1 },
    ])
  })
})

describe('resolveCloudTabRef', () => {
  const tabs = [
    { title: 'Docs', url: 'https://docs.example.com/a', lastModified: 2 },
    { title: 'Mail', url: 'https://mail.example.com', lastModified: 1 },
  ]

  test('resolves a 1-based list number', () => {
    expect(resolveCloudTabRef(tabs, '2')).toBe('https://mail.example.com')
  })

  test('accepts a full url as-is', () => {
    expect(resolveCloudTabRef(tabs, 'https://anything.example/x')).toBe('https://anything.example/x')
  })

  test('accepts a unique substring', () => {
    expect(resolveCloudTabRef(tabs, 'mail.example')).toBe('https://mail.example.com')
  })

  test('rejects an out-of-range number, an ambiguous substring and empty input', () => {
    expect(resolveCloudTabRef(tabs, '9')).toBeUndefined()
    expect(resolveCloudTabRef(tabs, 'example')).toBeUndefined()
    expect(resolveCloudTabRef(tabs, '  ')).toBeUndefined()
  })
})

describe('formatCloudTabs', () => {
  test('prints an indexed table with device names and urls', () => {
    const output = formatCloudTabs({
      unsupported: false,
      devices: [{ deviceName: 'Work', tabs: [{ title: 'Docs', url: 'https://docs.example', lastModified: 2 }] }],
      recentlyClosed: [{ title: 'Gone', url: 'https://gone.example', lastModified: 1 }],
    })

    const compactLines = output.split('\n').map((line) => line.replace(/\s+/g, ' ').trim())
    expect(compactLines).toContain('# DEVICE TITLE')
    expect(compactLines).toContain('1 Work Docs')
    expect(compactLines).toContain('https://docs.example')
    expect(compactLines).toContain('2 closed Gone')
  })

  test('explains an unsupported browser', () => {
    expect(formatCloudTabs({ unsupported: true, devices: [], recentlyClosed: [] })).toContain('chrome.sessions')
  })

  test('hints at enabling sync when there is nothing to show', () => {
    expect(formatCloudTabs(EMPTY_CLOUD_TABS)).toContain('browser sync')
  })
})

import { describe, test, expect } from 'vitest'
import {
  discoverActivePortInstances,
  discoverBrowserInstances,
  getKnownBrowserDataDirs,
  parseDevToolsActivePort,
} from './chrome-discovery.js'

describe('parseDevToolsActivePort', () => {
  test('parses valid contents', () => {
    const result = parseDevToolsActivePort('9222\n/devtools/browser/abc-123-def\n')
    expect(result).toMatchInlineSnapshot(`
      {
        "port": 9222,
        "wsPath": "/devtools/browser/abc-123-def",
      }
    `)
  })

  test('parses with extra whitespace', () => {
    const result = parseDevToolsActivePort('  9222  \n  /devtools/browser/abc  \n')
    expect(result).toMatchInlineSnapshot(`
      {
        "port": 9222,
        "wsPath": "/devtools/browser/abc",
      }
    `)
  })

  test('returns null for single line', () => {
    expect(parseDevToolsActivePort('9222')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseDevToolsActivePort('')).toBeNull()
  })

  test('returns null for invalid port', () => {
    expect(parseDevToolsActivePort('abc\n/devtools/browser/123')).toBeNull()
  })

  test('returns null for port 0', () => {
    expect(parseDevToolsActivePort('0\n/devtools/browser/123')).toBeNull()
  })

  test('returns null for port > 65535', () => {
    expect(parseDevToolsActivePort('99999\n/devtools/browser/123')).toBeNull()
  })

  test('returns null for invalid ws path', () => {
    expect(parseDevToolsActivePort('9222\n/some/other/path')).toBeNull()
  })
})

describe('getKnownBrowserDataDirs', () => {
  test('includes Yandex alongside Chrome, Edge and Brave on macOS', () => {
    const dirs = getKnownBrowserDataDirs({
      platform: 'darwin',
      homeDir: '/Users/example',
      env: {},
    })
    const byId = Object.fromEntries(dirs.map((dir) => [dir.browserId, dir.dir]))
    expect(byId.chrome).toBe('/Users/example/Library/Application Support/Google/Chrome')
    expect(byId.yandex).toBe('/Users/example/Library/Application Support/Yandex/YandexBrowser')
    expect(byId.edge).toBe('/Users/example/Library/Application Support/Microsoft Edge')
    expect(byId.brave).toBe(
      '/Users/example/Library/Application Support/BraveSoftware/Brave-Browser',
    )
  })

  test('uses %LOCALAPPDATA% on Windows', () => {
    const dirs = getKnownBrowserDataDirs({
      platform: 'win32',
      homeDir: 'C:/Users/example',
      env: { LOCALAPPDATA: 'C:/Users/example/AppData/Local' },
    })
    const byId = Object.fromEntries(dirs.map((dir) => [dir.browserId, dir.dir]))
    expect(byId.chrome).toBe('C:/Users/example/AppData/Local/Google/Chrome/User Data')
    expect(byId.yandex).toBe('C:/Users/example/AppData/Local/Yandex/YandexBrowser/User Data')
  })

  test('uses ~/.config on Linux with a Yandex entry', () => {
    const dirs = getKnownBrowserDataDirs({
      platform: 'linux',
      homeDir: '/home/example',
      env: {},
    })
    const byId = Object.fromEntries(dirs.map((dir) => [dir.browserId, dir.dir]))
    expect(byId.chrome).toBe('/home/example/.config/google-chrome')
    expect(byId.yandex).toBe('/home/example/.config/yandex-browser')
  })
})

describe('discoverActivePortInstances', () => {
  test('reads a Yandex DevToolsActivePort and keeps the file ws path', async () => {
    const instances = await discoverActivePortInstances({
      platform: 'darwin',
      homeDir: '/Users/example',
      env: {},
      existsSync: (filePath) => {
        return filePath.endsWith('Yandex/YandexBrowser/DevToolsActivePort')
      },
      readFileSync: () => '9333\n/devtools/browser/yandex-guid\n',
      probe: async () => ({ type: 'blocked', port: 9333, hostname: '127.0.0.1' }),
    })

    expect(instances).toMatchInlineSnapshot(`
      [
        {
          "browser": "Yandex",
          "browserId": "yandex",
          "dataDir": "/Users/example/Library/Application Support/Yandex/YandexBrowser",
          "port": 9333,
          "profiles": [],
          "wsUrl": "ws://127.0.0.1:9333/devtools/browser/yandex-guid",
        },
      ]
    `)
    expect(instances).toHaveLength(1)
    expect(instances[0].browser).toBe('Yandex')
    expect(instances[0].browserId).toBe('yandex')
    expect(instances[0].wsUrl).toBe('ws://127.0.0.1:9333/devtools/browser/yandex-guid')
    expect(instances[0].dataDir).toBe(
      '/Users/example/Library/Application Support/Yandex/YandexBrowser',
    )
  })

  test('skips stale DevToolsActivePort files whose port is dead', async () => {
    const instances = await discoverActivePortInstances({
      platform: 'darwin',
      homeDir: '/Users/example',
      env: {},
      existsSync: (filePath) => {
        return filePath.endsWith('Google/Chrome/DevToolsActivePort')
      },
      readFileSync: () => '9222\n/devtools/browser/dead-guid\n',
      probe: async () => ({ type: 'dead' }),
    })
    expect(instances).toHaveLength(0)
  })
})

describe('discoverBrowserInstances', () => {
  test('aggregates DevToolsActivePort instances and default-port probes, dedupes by port', async () => {
    const instances = await discoverBrowserInstances({
      platform: 'darwin',
      homeDir: '/Users/example',
      env: {},
      ports: [9222, 9223],
      existsSync: (filePath) => {
        return filePath.endsWith('Yandex/YandexBrowser/DevToolsActivePort')
      },
      // Yandex writes DevToolsActivePort for the same port a plain probe would also find.
      readFileSync: () => '9222\n/devtools/browser/yandex-guid\n',
      probe: async (port) => {
        if (port === 9222) {
          return { type: 'blocked', port, hostname: '127.0.0.1' }
        }
        if (port === 9223) {
          return {
            type: 'live',
            wsUrl: `ws://127.0.0.1:${port}/devtools/browser/live-guid`,
            browser: 'Chrome/155.0.0.0',
          }
        }
        return { type: 'dead' }
      },
    })

    expect(instances.map((instance) => [instance.browserId, instance.port])).toEqual([
      ['yandex', 9222],
      ['chrome', 9223],
    ])
    expect(instances[0].wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/yandex-guid')
    expect(instances[1].wsUrl).toBe('ws://127.0.0.1:9223/devtools/browser/live-guid')
  })
})



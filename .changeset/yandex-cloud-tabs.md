---
'playwriter': minor
---

Add cloud (synced) tabs: `playwriter cloud-tabs` lists the tabs open on the user's other signed-in browser devices and can open one.

The tabs come from the extension `chrome.sessions` API, which is backed by Chrome
Sync, Yandex Browser sync, Edge and Brave, so one implementation covers every
Chromium browser Playwriter drives. The MCP server exposes the same data through
a new `cloud_tabs` tool.

```sh
# list cloud tabs from other signed-in devices
playwriter cloud-tabs
playwriter cloud-tabs --json
playwriter cloud-tabs --extension <id>

# open a cloud tab in the user's browser
playwriter cloud-tabs --open 3
playwriter cloud-tabs --open docs.example.com
```

The extension gains the `sessions` permission and two request methods
(`getCloudTabs`, `openCloudTab`). CDP has no equivalent of `chrome.sessions`, so
cloud tabs need the extension connected even when sessions use the default direct
CDP transport; the command explains this when no extension is connected. Cloud
tabs are blocked over Remote control because they expose the user's browsing on
their other devices.

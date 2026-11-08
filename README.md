# dsh-browser-use

English | [简体中文](README-zh.md)

Background browser automation for [DeepSeek Harness](https://github.com/deepseek-ai). One Electron host assigns independently numbered offscreen windows to conversations, with CDP input, snapshot refs and no focus stealing. Windows share login state and persistent site data.

This is not a fork of another browser plugin. It shares no package id, tool name, client module, settings route, or browser window with `dsh-builtin-browser`.

## What it does

- Starts a real Electron/Chromium window lazily on the first tool call.
- Parks windows offscreen by default; ordinary page tools do not activate them. Windows keeps taskbar previews, while macOS provides numbered Dock menu entries.
- Drives the page over the Chrome DevTools Protocol: real mouse events, `Input.insertText`, `Page.captureScreenshot`, `Runtime.evaluate`.
- Draws a page-local cursor (arrow + action bubble, click ripple) and inserts text one character at a time, so actions are visible without depending on the OS pointer.
- Gives the model numbered element refs from `browser_use_snapshot`; refs are valid for that snapshot only.
- Works while the DSH UI is in the background; no display surface is removed, so CDP input is not dropped.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_use_open` | Open an http(s) URL and return a snapshot |
| `browser_use_snapshot` | Numbered interactive elements |
| `browser_use_click` | Real mouse click by snapshot ref |
| `browser_use_type` | Focus an element, draw the cursor, insert text character by character |
| `browser_use_insert_text` | Insert text at the current selection without a snapshot ref |
| `browser_use_screenshot` | Save a JPEG and return its path |
| `browser_use_eval` | Evaluate page JavaScript |
| `browser_use_wait` | Wait for load / selector / text / URL |
| `browser_use_assert` | Check selector, text, URL, or JS truthiness |
| `browser_use_state` | URL, title, readyState, first visible text |
| `browser_use_back` / `browser_use_reload` | History / reload |
| `browser_use_close` | Close this conversation's window without affecting others |
| `browser_use_reset` | User-confirmed urgent recovery of this window; shared login storage remains |

`browser_use_assert` requires at least one non-blank string condition. Empty or whitespace-only conditions alone raise an argument error rather than passing; multiple valid conditions are combined with AND. Registration failures report the tool name and stop registration instead of silently leaving an incomplete tool set. After `browser_use_close` returns, the next call creates a new window for this conversation in the same host, retaining shared login data.

### Conversations and windows

- Tools use the trusted DSH execution identity `exec.agent.id`: one window per conversation, reused on later calls. Model arguments cannot select windows. Missing identity is an explicit error.
- Window numbers appear in titles and Dock menus and increase within a host lifetime. Routing uses conversation IDs, not window numbers or snapshot refs.
- Each window owns its page, snapshot refs, CDP connection and operation queue. Calls are serial within a window and can run in parallel across windows.
- All windows use `session.defaultSession`, preserving the previous default data directory. Same-origin cookies, localStorage and IndexedDB are shared; pages, back/forward navigation and sessionStorage remain separate. Logging out or switching accounts affects other windows.
- Shared data belongs to this plugin, not the system Chrome profile, accounts or bookmarks. Do not launch multiple hosts writing to the same profile directory.
- Windows, pages and unsaved input persist across turns by default; no end-of-turn or idle eviction. Use `browser_use_close` or `browser_use_reset` only after an explicit user request. Plugin disposal, disconnect or app exit ends the shared host.

## Install

Requirements: Node >= 22.19, DSH >= 0.1.1-rc.2 < 0.3.0, Electron 44+. From the checkout:

```bash
npm install
```

Add the checkout to a DSH profile's dependencies and bundles:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-browser-use": "file:/absolute/path/to/dsh-browser-use"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-browser-use"]
    }
  }
}
```

Reinstall the profile dependencies, restart DSH, and confirm that the `browser_use_*` tools appear. The [bundle patch](cordis.patch.yml) adds one plugin row; the browser starts only on the first tool call. It does not require `dsh-builtin-browser` and can coexist with it.

Electron lookup order: `ELECTRON_PATH` → this package's dependency → `$DSH_HOME/profiles/*/node_modules/electron/dist` (`DSH_HOME` defaults to `~/.dsh`). Lookup does not download a binary; if none exists, install one:

```bash
npm install electron@^44.10.0
```

Optional plugin configuration: `width` (default 1400), `height` (900), and `screenshotDir` (default `$DSH_HOME/browser-use/screenshots`). The legacy `quiet` option is ignored; background operation is always the default. Set `BROWSER_USE_USER_DATA_DIR` to an absolute path before startup only when a separate profile is needed. Without it, the previous data location is retained; selecting a new path does not migrate existing login data.

## Browser window

- Created with `show: false`, then shown through nonactivating `showInactive()` and parked offscreen. Ordinary tools never raise the window.
- macOS/Linux retain opacity 0, unfocusable, click-through background windows. On macOS, the Dock menu lists numbered windows; clicking the icon reveals the most recently used ready window without creating another.
- Windows uses one AppUserModelID and keeps a taskbar window entry per conversation, with no tray icon. When taskbar grouping and thumbnails are enabled in Windows, hover the grouped icon to select numbered windows; activating a preview restores that window onscreen.
- To avoid blank transparent thumbnails, Windows keeps an opaque, focusable, click-through background surface, parks it outside all displays first, then shows it without activation. Switching away or hiding retains its taskbar entry. Revealed windows use configured dimensions capped to the primary display's work area.
- Closing the window or switching to another app returns it to the background without closing the page. If the OS minimizes it, the host restores it silently and re-parks it. Tools never raise the window.
- `BROWSER_USE_HIDE_DOCK=1` hides the Dock icon; `BROWSER_USE_KEEP_DOCK=1` takes precedence and keeps it visible.

`browser_use_type` and `browser_use_click` inject a pointer-events-none overlay: a black arrow, an action bubble, and a click ripple. It appears in screenshots without moving the user's real cursor.

## Architecture

```text
index.js                  Plugin setup and system prompt
src/tools.js              Model-facing tool definitions and result formatting
src/client.js             Lazy process startup and authenticated loopback RPC
host/main.cjs             Conversation windows, shared Session, independent CDP and queues
```

The child prints one ready line (`{ "port": ... }`) on stdout. The parent connects to `127.0.0.1`, sends `{ op: "hello", token }` with a random per-spawn token, and only then issues commands. Concurrent first calls share startup and wait for authentication. Commands are serialized per conversation; different windows do not share one operation queue. A second control connection is refused. Timeouts, disconnects, cancellation and disposal share cleanup paths. Cancellation and client timeouts notify the host with the original request and conversation IDs. Queued requests are skipped; running operations stop subsequent steps at safe boundaries. An already-sent CDP call retains the window queue barrier until it really settles, rather than overlapping later operations. Completed clicks, input and server-side effects cannot be undone.

### Cancellation, recovery and page validation

- No automatic close, reset or retries of mutations. Cancelling character-by-character input stops remaining characters but preserves those already entered. A mouse press already sent is paired with its release to avoid leaving a pressed button.
- Host requests have a 60-second deadline including queue time. Open waits up to 15 seconds for main-frame navigation; back/reload wait up to 10 seconds. Tools or callers can cancel earlier. Timeouts report an error without releasing the barrier of still-running underlying work.
- For a blocked window, warn that DOM, forms, sessionStorage and page state will be lost and obtain explicit user confirmation before `browser_use_reset` with `confirm: true`. It bypasses the page queue, destroys only this window and rejects old requests. The next ordinary tool call creates its replacement. Other conversations and shared cookies remain. `browser_use_close` is also urgent explicit closure, never routine cleanup.
- Snapshot refs are never reused within one host lifetime. A new snapshot or main-frame navigation invalidates old refs. Click/type check actual DOM node identity, visibility, occlusion and focus rather than guessing from stale coordinates or a matching selector. After a stale-ref error, take another snapshot; do not retry mutations automatically.
- Navigation observes this main-frame load and checks connection errors, HTTP failures, downloads and timeouts instead of treating the old document readyState as success. `browser_use_wait` still returns `ready: false` when its optional business conditions time out.

### Reading the source

This project uses **JavaScript, not Java**. Important execution boundaries have Chinese comments for new readers. Suggested reading order:

1. [index.js](index.js): how `apply` receives DSH services, configures the client and registers a disposal callback.
2. [src/tools.js](src/tools.js): `parameters` / `schema` describe inputs and outputs, `execute` runs the operation, and `render` produces model-facing text.
3. [src/client.js](src/client.js): a `Promise` represents a future result; `await` waits for it. Request IDs match responses to callers; every completion path must release listeners and timers.
4. [host/main.cjs](host/main.cjs): distinguish Electron's main process, page JavaScript executed through CDP, and user-initiated window events. Page scripts receive serialized values rather than accessing main-process variables directly.

`.js` uses ESM `import` / `export`; `.cjs` uses CommonJS `require`. These are module formats for the same language, with no extra compilation step.

## Limitations

- One page/window per conversation; `browser_use_open` only replaces that conversation's page. Website HTTP(S) popups load in their owning window instead of creating unmanaged windows.
- Snapshots do not include iframes or shadow roots; the cursor is injected only into the top document.
- Screenshots capture the viewport, not a full-page scroll. The `fullPage` parameter is reserved and has no effect.
- Typing is character-by-character through `Input.insertText`, with about 18 ms between characters.
- Real Electron regressions run on macOS. Windows taskbar policy has platform-mock coverage but needs Windows hardware validation of thumbnail content, preview activation and multiple displays. Linux has no hardware validation.
- Multi-display setups may show a blank tile in Mission Control; the window stays transparent and click-through, but there is no native z-order (`orderBack`) yet.
- Windows controls grouping and thumbnail availability through system settings/policies; disabling grouping may show separate buttons. If the OS clamps a background window onscreen, opacity falls back to zero and previews may be blank rather than exposing the page on the desktop. Taskbar previews and per-window capture can expose page content; background operation is not a privacy boundary.
- No client settings panel; enable or disable the plugin through its bundle row.

## License

MIT. See [LICENSE](./LICENSE).

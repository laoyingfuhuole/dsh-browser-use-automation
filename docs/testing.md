# Testing

English | [简体中文](testing-zh.md)

```bash
npm test
```

The suite is five Node tests:

| Test | What it proves |
| --- | --- |
| `tests/host.test.mjs` | Navigate, snapshot, type, click, eval and screenshot against a real Electron host; the window stays offscreen (`x < 0`), transparent (`opacity 0`), unfocused, and the frontmost application does not change. |
| `tests/tools-e2e.test.mjs` | The same path through the registered `browser_use_*` tools, including an assertion and a saved JPEG. |
| `tests/plugin.test.mjs` | The plugin registers 12 independent `browser_use_*` tools and no `dsh_browser_*` name. |
| `tests/package.test.mjs` | The package is a DSH bundle with one patch row. |

## Manual Baidu smoke

Run on macOS with an Electron binary available (`ELECTRON_PATH`, the package dependency, or a DSH profile):

1. `browser_use_open https://www.baidu.com`
2. `browser_use_type` the search box ref with `dsh官网`
3. `browser_use_click` the `百度一下` ref
4. `browser_use_wait` for `https://www.baidu.com/s`
5. `browser_use_assert` that `document.querySelectorAll("h3").length > 0`

Observed: 11 `h3` results; the results page URL contains `wd=dsh官网`; the frontmost app stayed unchanged (when not switching apps manually); the window remained offscreen, opacity 0, unfocused.

## Limits worth knowing

- The host is macOS-first; Windows/Linux are untested.
- One tab; `browser_use_open` replaces the current page.
- Snapshots do not descend into same-origin iframes or shadow roots.
- Screenshots capture the viewport, not a full-page scroll.

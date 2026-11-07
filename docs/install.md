# Installing as a DSH bundle

English | [简体中文](install.zh.md)

The plugin has no client half and does not need `dsh-builtin-browser`. It adds one bundle row (`dsh-browser-use`) with a quiet offscreen Electron host.

## From a checkout

```bash
cd dsh-browser-use
npm install
npm test
```

Then make the checkout resolvable from a DSH profile and add it to that profile's bundles. For a development profile:

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

Reinstall the profile dependencies, restart DSH, and confirm that the `browser_use_*` tools are present. The host is spawned on the first tool call; it is offscreen, opacity 0, and not focusable.

## Electron

`ELECTRON_PATH` wins. Otherwise the host checks the package's `electron` dependency and then `$DSH_HOME/profiles/*/node_modules/electron/dist`. It never calls `require('electron')`, so a profile without a downloaded Electron reports a clear error instead of starting a download.

If neither exists:

```bash
npx electron --version
# or
npm install electron@^44.10.0
```

## Coexistence

The tool names are `browser_use_*`, not `dsh_browser_*`, and the module/settings ids are different. It can coexist with `dsh-builtin-browser`, though running two browser hosts at once is unnecessary.

# 作为 DSH bundle 安装

插件没有客户端半边，也不依赖 `dsh-builtin-browser`。它只添加一个 bundle 行（`dsh-browser-use`），配一个安静、离屏的 Electron host。

[English](install.md) | 简体中文

## 从 checkout 安装

```bash
cd dsh-browser-use
npm install
npm test
```

然后让这个 checkout 能被某个 DSH profile 解析，并把它加入该 profile 的 bundles。开发 profile 示例：

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

重新安装 profile 依赖、重启 DSH，确认 `browser_use_*` 工具已经出现。host 在首次工具调用时才启动；它离屏、opacity 为 0、不可聚焦。

## Electron

`ELECTRON_PATH` 优先。否则 host 会检查包自己的 `electron` 依赖，再检查 `$DSH_HOME/profiles/*/node_modules/electron/dist`。它从不调用 `require('electron')`，所以没有下载 Electron 的 profile 会得到明确错误，而不是触发一次下载。

如果两者都不存在：

```bash
npx electron --version
# 或
npm install electron@^44.10.0
```

## 共存

工具名是 `browser_use_*`，不是 `dsh_browser_*`，模块 id 和设置 id 也不同。它可以和 `dsh-builtin-browser` 共存，不过同时跑两个浏览器 host 没有必要。

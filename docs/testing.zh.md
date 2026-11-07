# 测试

```bash
npm test
```

测试套件是五个 Node 测试：

| 测试 | 证明什么 |
| --- | --- |
| `tests/host.test.mjs` | 对真实 Electron host 执行导航、快照、输入、点击、eval 和截图；窗口保持离屏（`x < 0`）、透明（`opacity 0`）、不可聚焦，且前台应用不发生变化。 |
| `tests/tools-e2e.test.mjs` | 走已注册的 `browser_use_*` 工具执行同一路径，包括一次断言和一张保存的 JPEG。 |
| `tests/plugin.test.mjs` | 插件注册 12 个独立的 `browser_use_*` 工具，且没有 `dsh_browser_*` 名称。 |
| `tests/package.test.mjs` | 包是 DSH bundle，且只有一行 patch。 |

[English](testing.md) | 简体中文

## 手动百度 smoke

在 macOS 上、且有可用 Electron 二进制时运行（`ELECTRON_PATH`、包依赖或 DSH profile）：

1. `browser_use_open https://www.baidu.com`
2. 用 `browser_use_type` 往搜索框 ref 输入 `dsh官网`
3. 用 `browser_use_click` 点击「百度一下」ref
4. 用 `browser_use_wait` 等 `https://www.baidu.com/s`
5. 用 `browser_use_assert` 断言 `document.querySelectorAll("h3").length > 0`

观察结果：11 个 `h3` 结果；结果页 URL 包含 `wd=dsh官网`；前台应用保持不变（在不手动切换应用的前提下）；窗口保持离屏、opacity 0、不可聚焦。

## 值得知道的限制

- host 以 macOS 为先；Windows/Linux 未实测。
- 单标签；`browser_use_open` 会替换当前页面。
- 快照不会进入同源 iframe 或 shadow root。
- 截图只截当前视口，不是整页滚动截图。

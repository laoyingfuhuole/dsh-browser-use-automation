# dsh-browser-use

[English](README.md) | 简体中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的后台浏览器自动化插件。一个 Electron host 为不同对话分配独立编号的离屏窗口，使用 CDP 输入和快照 ref，不抢焦点；各窗口共享登录状态与持久化站点数据。

这不是另一个浏览器插件的 fork。它与 `dsh-builtin-browser` 不共享包 id、工具名、客户端模块、设置路由或浏览器窗口。

## 功能

- 首次工具调用时才惰性启动真实 Electron/Chromium 窗口。
- 窗口默认离屏停放；普通页面工具不主动激活窗口。Windows 保留任务栏预览，macOS 使用 Dock 编号菜单。
- 通过 Chrome DevTools Protocol 驱动页面：真实鼠标事件、`Input.insertText`、`Page.captureScreenshot`、`Runtime.evaluate`。
- 在页面内绘制光标（箭头 + 动作气泡、点击涟漪），逐字符输入，动作可见但不依赖系统指针。
- `browser_use_snapshot` 返回编号元素 ref；ref 只在当次快照内有效。
- DSH 界面在后台时仍可工作；不移除 display surface，因此 CDP 输入不会被丢弃。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_use_open` | 打开 http(s) URL 并返回快照 |
| `browser_use_snapshot` | 返回编号的可交互元素 |
| `browser_use_click` | 按快照 ref 执行真实鼠标点击 |
| `browser_use_type` | 聚焦元素、绘制光标、逐字符输入 |
| `browser_use_insert_text` | 在当前选区插入文本，无需快照 ref |
| `browser_use_screenshot` | 保存 JPEG 并返回路径 |
| `browser_use_eval` | 执行页面 JavaScript |
| `browser_use_wait` | 等待加载 / 选择器 / 文本 / URL |
| `browser_use_assert` | 校验选择器、文本、URL 或 JS 真值 |
| `browser_use_state` | URL、标题、readyState、首段可见文本 |
| `browser_use_back` / `browser_use_reload` | 后退 / 刷新 |
| `browser_use_close` | 关闭当前对话窗口，不影响其他对话 |
| `browser_use_reset` | 经用户确认后，立即重置当前卡住的窗口；共享登录数据保留 |

`browser_use_assert` 至少需要一个非空字符串条件；仅传空参数或空白内容会报参数错误，不再视为通过。多个有效条件按 AND 判断。工具注册失败会带工具名报错，不继续悄悄加载不完整的工具集合。`browser_use_close` 返回后，下次调用会在同一 host 中新建此对话的窗口，保留共享登录数据。

### 对话与窗口

- 工具从 DSH 执行上下文的 `exec.agent.id` 获取对话标识；同一对话复用窗口，不同对话使用不同窗口。模型无需、也不能通过参数选择窗口。缺失标识时明确报错。
- 编号只用于标题和 Dock 菜单，在本次 host 生命周期中递增；内部始终按对话 ID 路由，不能将编号或快照 ref 当作跨对话标识。
- 每个窗口独立持有页面、快照 ref、CDP 会话和操作队列。同窗口顺序执行，不同窗口可并行。
- 所有窗口使用同一个 `session.defaultSession`，保留之前的默认数据目录。同源 Cookie、localStorage、IndexedDB 等共享；页面、后退/前进历史和 sessionStorage 各自独立。退出登录或切换账号会影响其他窗口。
- 共享的是插件的浏览器数据，不是系统 Chrome 的账户、书签或资料。不要启动多个 host 进程同时写同一个数据目录。
- 默认跨轮次保留窗口、页面和未提交内容，不因一轮回复结束或空闲而回收。仅用户明确要求关闭/恢复时调用 `browser_use_close` 或 `browser_use_reset`；插件卸载、断连或应用退出才结束共享 host。

## 安装

要求：Node >= 22.19，DSH >= 0.1.1-rc.2 < 0.3.0，Electron 44+。在项目目录运行：

```bash
npm install
```

将项目加入 DSH profile 的依赖和 bundles：

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

重新安装 profile 依赖、重启 DSH，确认 `browser_use_*` 工具出现。[Bundle patch](cordis.patch.yml) 只添加一个插件行；浏览器在首次工具调用时启动。不依赖 `dsh-builtin-browser`，也可以与它共存。

Electron 查找顺序：`ELECTRON_PATH` → 本包依赖 → `$DSH_HOME/profiles/*/node_modules/electron/dist`（`DSH_HOME` 默认为 `~/.dsh`）。查找不会触发下载；缺少二进制时可安装：

```bash
npm install electron@^44.10.0
```

可选插件配置：`width`（默认 1400）、`height`（900）、`screenshotDir`（默认 `$DSH_HOME/browser-use/screenshots`）。旧版 `quiet` 配置会被忽略；始终默认在后台运行。仅需独立数据目录时，启动前设置 `BROWSER_USE_USER_DATA_DIR` 为绝对路径；不设置则沿用旧目录，设置新路径不会自动搬迁旧登录数据。

## 浏览器窗口

- 初始以 `show: false` 创建，再用 `showInactive()` 非激活显示并离屏停放；普通工具不会抬起窗口。
- macOS/Linux 保留 opacity 0、不可聚焦、点击穿透的后台策略。macOS Dock 菜单按窗口编号提供查看入口；点击图标显示最近使用的已就绪窗口，不额外创建窗口。
- Windows 使用同一个 AppUserModelID，并为每个对话保留任务栏窗口条目，不创建托盘图标。在系统启用任务栏合并及缩略图时，悬停分组图标可选择各编号窗口；点击预览激活对应窗口，将它移回屏内。
- 为避免透明窗口缩略图空白，Windows 后台保持不透明绘制面、可激活和点击穿透，但先移到所有显示器范围之外，再非激活显示。切出或隐藏后仍保留任务栏条目。人工查看时尺寸采用配置值，并限制在主显示器工作区内。
- 关闭窗口或切换应用会回到后台，页面继续存活。被系统最小化时会静默恢复并重新离屏停放。工具不会主动抬起窗口。
- `BROWSER_USE_HIDE_DOCK=1` 隐藏 Dock 图标；`BROWSER_USE_KEEP_DOCK=1` 优先级更高，强制保留图标。

`browser_use_type` 和 `browser_use_click` 会注入 `pointer-events-none` 覆盖层，显示黑色箭头、动作气泡和点击涟漪。覆盖层会出现在截图中，但不会移动用户的真实光标。

## 架构

```text
index.js                  插件装配与系统提示词
src/tools.js              对外工具定义与结果格式化
src/client.js             惰性启动进程与带认证的回环 RPC
host/main.cjs             对话窗口映射、共享 Session、独立 CDP 与命令队列
```

子进程在 stdout 打印一行 ready（`{ "port": ... }`）。父进程连接 `127.0.0.1`，先发送 `{ op: "hello", token }`（每次 spawn 随机生成 token），然后才发命令。并发的首次调用共用一次启动，且都等待认证完成。命令按对话分别排队，不同窗口互不等待；第二个控制连接会被拒绝。超时、断连、取消和卸载共用清理逻辑。取消与客户端超时会把原请求 ID 和对话 ID 通知 host。未执行的请求跳过，运行请求在安全边界停止后续步骤；已发出的 CDP 调用仍占用本窗口队列直到真正结束，不与下一请求交错。已经发生的点击、输入和服务端副作用无法撤销。

### 取消、恢复与页面校验

- 不自动关闭、重置或重试提交动作。取消逐字输入会停止剩余字符，但已输入内容保留；鼠标已经按下时会完成同一次点击的释放，避免留下长按状态。
- host 请求期限为 60 秒，包含排队时间；打开页面等待主框架最多 15 秒，后退/刷新最多 10 秒。工具层或调用方可以更早取消。超时会报错，但不会为了放行队列而丢弃仍在运行的底层调用。
- 窗口完全卡住时，说明 DOM、表单、sessionStorage 和当前页面现场将丢失，并取得用户明确同意后调用 `browser_use_reset`，参数必须是 `confirm: true`。它绕过页面队列、销毁该窗口并拒绝旧请求；下一次普通工具调用才新建窗口。其他对话及共享 Cookie 不受此窗口清理影响。`browser_use_close` 同样是绕过队列的显式关闭，不用于日常收尾。
- 快照 ref 在本次 host 生命周期中不重复分配。新快照和主框架导航使旧引用失效；点击/输入校验真实 DOM 节点及可见性、遮挡和焦点，不再通过旧坐标或相同 selector 猜测替代元素。收到 stale/ref 错误时先重新快照，不自动重试修改动作。
- 导航等待本次主框架加载事件，并检查连接失败、HTTP 错误、下载响应和超时，不能把旧页面的 readyState 当作成功。`browser_use_wait` 的业务条件不满足仍返回 `ready: false`，与导航报错区分。

### 阅读代码

本项目使用 **JavaScript，不是 Java**。源码的重要边界附有中文注释；建议按以下顺序阅读：

1. [index.js](index.js)：看 `apply` 如何获取 DSH 服务、配置客户端和注册卸载清理函数。
2. [src/tools.js](src/tools.js)：`parameters` / `schema` 描述输入输出，`execute` 执行业务，`render` 生成模型看到的文本。
3. [src/client.js](src/client.js)：`Promise` 表示稍后返回的结果，`await` 等待结果；请求 id 用来把响应交还对应调用，监听器和计时器必须在所有结束路径释放。
4. [host/main.cjs](host/main.cjs)：区分 Electron 主进程、通过 CDP 执行的页面 JavaScript，以及用户主动查看窗口的事件。页面脚本不能直接访问主进程变量；通过序列化参数传入值。

`.js` 使用 ESM 的 `import` / `export`，`.cjs` 使用 CommonJS 的 `require`，是同一语言的不同模块格式；无需新增编译步骤。

## 已知限制

- 每个对话只有一个窗口/页面；`browser_use_open` 只替换本对话页面。网页弹出的 HTTP(S) 链接仍在所属窗口打开，不创建额外无人管理的窗口。
- 快照不包含 iframe 和 shadow root；光标只注入顶层文档。
- 截图只截当前视口，不是整页滚动截图；`fullPage` 是预留参数，暂不生效。
- 输入通过 `Input.insertText` 逐字符完成，字符间隔约 18 ms。
- macOS 已做真实 Electron 回归；Windows 任务栏策略已做平台模拟测试，仍需在 Windows 实机验收缩略图内容、预览点击和多屏行为。Linux 未做实机验证。
- 多显示器下，Mission Control 可能显示空白 tile；窗口保持透明且点击穿透，但尚无原生 z-order（`orderBack`）。
- Windows 任务栏分组和缩略图由系统设置/策略控制；禁用合并时可能显示多个按钮。若系统将窗口夹回屏内，代码回退到透明状态，预览可能空白，避免直接显示后台页面。任务栏预览或按窗口采集可能暴露页面内容，后台状态不是隐私保护。
- 没有客户端设置面板，通过 bundle 行启停插件。

## 许可证

MIT。见 [LICENSE](./LICENSE)。

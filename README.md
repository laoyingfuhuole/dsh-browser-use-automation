# dsh-parallel-browser

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的后台浏览器自动化插件。一个 Electron host 为不同对话分配独立编号的离屏窗口，使用 CDP 输入和快照 ref，不抢焦点；各窗口共享登录状态与持久化站点数据。

## 当前版本

`v0.3.2`：包名迁移到 npm **`dsh-parallel-browser`**（原 `dsh-browser-use`），安装与更新改走市场 / npm 路线；功能与 `v0.3.1` 一致。

`v0.3.1`：修复 Windows 启动前导 CRLF 导致的握手失败，增加只读 Electron 就绪诊断；Windows 点 X 关闭当前对话窗口，最后一个原生窗口关闭后刷新共享存储并退出 host。macOS 保持 X 隐藏、Cmd+Q 退出整个浏览器 host。项目仅保留本篇中文 README。

保留 `v0.3.0` 的按对话独立窗口、共享登录数据、请求取消、显式恢复、过期 ref 与导航失败校验。多轮对话默认保留页面；`browser_use_reset` 必须经过明确确认。

macOS 真实 Electron 回归已覆盖主要路径；Windows 新修复已通过平台模拟测试，仍需用匹配版本、无 shim 的 Electron 在 Windows 实机复验。真实 DSH UI 双对话验收仍待完成。对外使用 `vX.Y.Z` 标签，package.json 使用标准数字版本 `0.3.2`。

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

要求：Node >= 22.19，DSH >= 0.1.1-rc.2 < 0.3.0，Electron 44+。

推荐从插件市场安装，或直接执行：

```bash
dsh plugin add dsh-parallel-browser
```

首次工具调用时才启动浏览器；Electron 依赖随包声明，由 DSH profile 的包管理器负责安装。

开发/调试时也可以改用本仓库源码，把项目加入 DSH profile 的依赖和 bundles：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-parallel-browser": "file:/absolute/path/to/dsh-parallel-browser"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-parallel-browser"]
    }
  }
}
```

重新安装 profile 依赖、重启 DSH，确认 `browser_use_*` 工具出现。[Bundle patch](cordis.patch.yml) 只添加一个插件行；浏览器在首次工具调用时启动。与 DSH 官方 `@deepseek-ai/dsh-browser-use` 注册服务及 Playwright MCP 提供方属于不同实现；只应按各自集成方式选择启用的浏览器后端。

Electron 查找顺序：`ELECTRON_PATH` → 本包依赖 → `$DSH_HOME/profiles/*/node_modules/electron/dist`（`DSH_HOME` 默认为 `~/.dsh`）。显式覆盖路径无效时会报错，不悄悄使用其他程序。查找只读取文件，不触发下载；npm 包存在不代表 Electron 二进制已经就绪。

从插件目录运行只读预检：

```bash
npm run check:runtime
npm run check:runtime -- --json
```

预检区分依赖包缺失、`dist`/可执行文件未下载、覆盖路径无效和文件就绪；文件就绪不保证实际版本/架构匹配，仍以真实 host 启动为准。包缺失时，使用该 DSH profile 原有的包管理器安装声明的 Electron 依赖；如果包已存在但二进制缺失，先确认允许下载，再按报告给出的具体路径运行该包的安装器：

```bash
node "/absolute/path/to/profile/node_modules/electron/install.js"
```

这条修复命令可能联网，预检不会替你执行。`npm --registry` 仅控制 npm 包源，不保证 Electron 下载源也改变；需要二进制镜像时显式配置并核验 `ELECTRON_MIRROR`。不要用低版本缓存、伪装脚本或替换安装目录下的 `electron.exe` 作为正式修复。


可选插件配置：`width`（默认 1400）、`height`（900）、`screenshotDir`（默认 `$DSH_HOME/browser-use/screenshots`）。旧版 `quiet` 配置会被忽略；始终默认在后台运行。仅需独立数据目录时，启动前设置 `BROWSER_USE_USER_DATA_DIR` 为绝对路径；不设置则沿用旧目录，设置新路径不会自动搬迁旧登录数据。

### 通过 dshmarket 图形界面更新

市场目录可能有多个同名插件；必须核对来源是 **`laoyingfuhuole/dsh-browser-use`**。本项目的 npm 包是 **`dsh-parallel-browser`**，市场会从仓库 `package.json` 自动识别它，并按 npm 版本检查更新。

- 从正确仓库条目安装后，由 dshmarket 的“更新”按钮检查远端版本、选择提交、执行完整安装并管理插件重载。无需额外运行本项目命令行脚本，插件也不自行下载安装、修改 profile 或强制重启。
- `file:` / `link:` 开发目录与市场在线来源不同，改源码或本地版本号不能让远端出现更新。想使用市场更新，应在确认停止当前任务后，通过市场切换/恢复到正确 GitHub 条目；恢复不可用时按市场提示移除开发安装并重新安装，不要停留在 `file:` 开发安装。
- 更新状态以市场结果为准：`applied` 表示已应用，`restart-required` 等状态需按桌面程序提示处理；不要将下载完成或文件版本一致视为进程已经重载。更新卸载可能关闭正在运行的浏览器窗口，应先结束或确认放弃当前页面现场，不能无感更新活跃对话。
- 清单文件 [integrity.json](integrity.json) 随仓库与发布包分发。插件加载以及启动新 host 前自动检查发布文件的 SHA-256；缺文件、版本不符、旧 host 混装会明确拒绝运行，要求通过市场完整重装并重载。不会自动关闭现有窗口或覆盖市场正在安装的文件。
- 无需 `prepare` / `postinstall` 等安装脚本，也不依赖本机源码目录；因此市场安装时禁用额外构建脚本仍可校验本插件。完整性校验用于发现混装，不是签名或来源认证，不能替代市场自己的来源和供应链检查。

本次按已安装的 **dshmarket 1.73.15 / DSH 0.2.2-rc.1** 核对更新接口、来源匹配和桌面适配器；验证使用临时目录及模拟管理器，没有点击真实市场更新、切换本机安装来源或重启 DSH。后续市场版本以实际 capabilities 和更新结果为准。

### 发布与开发诊断

每次发布保持 package 数字版本、Git 标签 `vX.Y.Z` 和同一提交一致。修改任意发布文件后执行：

```bash
npm run prepare:release
npm run check:release
npm pack --dry-run
```

将更新后的 `integrity.json` 和源码一起提交；这些命令不会提交、打标签或发布。GitHub 来源更新要求远端已有新代码及更高的 package 版本，不能只修改标签或本机版本。正式打包前同样先运行 `check:release`。

普通市场用户不需要下面的诊断命令。维护者可在安装目录执行自检，或从 checkout 比较整个安装副本：

```bash
# 进入已安装包目录后，独立验证随包清单，不需要开发 checkout
npm run check:install -- --self --json
# 仅开发诊断：从 checkout 与指定安装目录比较内容
npm run check:install -- /absolute/path/to/profile/node_modules/dsh-parallel-browser --json
```

[检查脚本](scripts/check-install.mjs) 只读本机文件，不联网、不安装、不停止进程；退出码 `0` 为一致，`1` 为不一致，`2` 为参数/目录错误。它不检查依赖、用户资料或进程内已加载的代码。硬链接的 inode 可因编辑器原子保存而分离，因此不能只比版本号或只用 `ln -f` 修单个 host。实际修复交给市场整包安装；离线维护也须先停用插件并使用原 profile 的包管理器，勿在线逐文件覆盖。

## 浏览器窗口

- 初始以 `show: false` 创建，再用 `showInactive()` 非激活显示并离屏停放；普通工具不会抬起窗口。
- macOS/Linux 保留 opacity 0、不可聚焦、点击穿透的后台策略。macOS Dock 菜单按窗口编号提供查看入口；点击图标显示最近使用的已就绪窗口，不额外创建窗口。
- Windows 使用同一个 AppUserModelID，并为每个对话保留任务栏窗口条目，不创建托盘图标。在系统启用任务栏合并及缩略图时，悬停分组图标可选择各编号窗口；点击预览激活对应窗口，将它移回屏内。
- 为避免透明窗口缩略图空白，Windows 后台保持不透明绘制面、可激活和点击穿透，但先移到所有显示器范围之外，再非激活显示。切出或隐藏后仍保留任务栏条目。人工查看时尺寸采用配置值，并限制在主显示器工作区内。
- Windows 点击 X 真正销毁当前对话窗口，取消它正在执行及排队的请求，不影响其他对话；点掉最后一个原生窗口后刷新共享 Cookie/存储并退出空 host。下次工具调用可重新启动，但未提交表单、DOM 和页面现场不会恢复。该显式关闭直接销毁页面，不等待网页的 `beforeunload` 确认。
- macOS 点 X 仅隐藏当前窗口，Cmd+Q 退出整个浏览器 host；Linux 沿用原有关闭隐藏行为。切换应用会回到后台，页面继续存活。被系统最小化时会非激活恢复并重新离屏停放。
- 工具 `browser_use_close` / `browser_use_reset` 仍只作用于指定对话，按原协议保留共享 host 以便重建；不按轮次、空闲或后台状态自动清理窗口。工具不会主动抬起窗口。
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

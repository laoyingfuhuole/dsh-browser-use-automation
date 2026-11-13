# dsh-browser-use-automation

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的后台浏览器自动化插件。一个 Electron host 为不同对话分配独立编号的离屏窗口，使用 CDP 输入和快照 ref，不抢焦点；各窗口共享登录状态与持久化站点数据。

## 当前版本

`v0.4.1`（当前版本）。`browser_use_*` 工具名、`BROWSER_USE_*` 环境变量与错误码保持稳定。

## 功能迭代

- `v0.4.1`：`browser_use_read` 支持页面版本绑定的 `nextCursor` 续读；超长 eval 返回添加安全上限及截断提示；运行时完整性校验仅阻断执行文件，发布校验继续覆盖完整包；统一 `type` / `insertText` 输入计数为 Unicode 码点。
- `v0.4.0`：新增 `browser_use_hover`（按 ref 悬停）、`browser_use_scroll`（真实滚轮事件，支持横向）、`browser_use_key`（受限功能键与修饰键组合）与 `browser_use_read`（带长度预算与截断提示的正文读取）；补充 `node:test` 回归测试、语法检查脚本与跨平台 CI 工作流。
- `v0.3.1`：修复 Windows 启动前导 CRLF 导致的握手失败；新增只读 Electron 就绪诊断 `npm run check:runtime`；Windows 点 X 关闭当前对话窗口，最后一个原生窗口关闭后刷新共享存储并退出 host；macOS 保持 X 隐藏、Cmd+Q 退出整个浏览器 host。项目仅保留本篇中文 README。
- `v0.3.0`：从一个离屏窗口改为**每个对话一个独立窗口**，按对话 ID 路由，工具不能跨对话选窗口；新增 `browser_use_insert_text`、`browser_use_reset`，`browser_use_close` 只关闭当前对话窗口；所有窗口共享 `session.defaultSession`（Cookie、localStorage、IndexedDB），页面与 sessionStorage 独立；新增发布文件完整性校验（`integrity.json` + SHA-256）。
- `v0.2.0`：重建基础版本——单窗口离屏后台运行、CDP 驱动、编号快照 ref、截图、`eval`、等待与断言、Dock 菜单，不抢焦点。

macOS 真实 Electron 回归已覆盖主要路径；Windows 新修复已通过平台模拟测试，仍需用匹配版本、无 shim 的 Electron 在 Windows 实机复验。真实 DSH UI 双对话验收仍待完成。对外使用 `vX.Y.Z` 标签，package.json 使用标准数字版本 `0.4.1`。

## 功能

- 首次工具调用时才惰性启动真实 Electron/Chromium 窗口。
- 窗口默认离屏停放；普通页面工具不主动激活窗口。Windows 保留任务栏预览，macOS 使用 Dock 编号菜单。
- 通过 Chrome DevTools Protocol 驱动页面：真实鼠标/滚轮事件、有限键盘事件、`Input.insertText`、`Input.dispatchKeyEvent`、`Page.captureScreenshot`、`Runtime.evaluate`。
- 在页面内绘制光标（箭头 + 动作气泡、点击涟漪），逐字符输入，动作可见但不依赖系统指针。
- `browser_use_snapshot` 返回编号元素 ref；ref 只在当次快照内有效。
- DSH 界面在后台时仍可工作；不移除 display surface，因此 CDP 输入不会被丢弃。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_use_open` | 打开 http(s) URL 并返回快照 |
| `browser_use_snapshot` | 返回编号的可交互元素 |
| `browser_use_click` | 按快照 ref 执行真实鼠标点击 |
| `browser_use_hover` | 按 ref 悬停，只移动页面指针、不点击 |
| `browser_use_scroll` | 在页面 CSS 视口坐标发送真实滚轮事件，垂直/水平 |
| `browser_use_key` | 发送受限功能键与修饰键组合，并尝试释放按下的键 |
| `browser_use_type` | 聚焦元素、绘制光标、逐字符输入 |
| `browser_use_insert_text` | 在当前选区插入文本，无需快照 ref |
| `browser_use_screenshot` | 保存 JPEG 并返回路径 |
| `browser_use_eval` | 执行页面 JavaScript |
| `browser_use_wait` | 等待加载 / 选择器 / 文本 / URL |
| `browser_use_assert` | 校验选择器、文本、URL 或 JS 真值 |
| `browser_use_state` | URL、标题、readyState、首段可见文本 |
| `browser_use_read` | 读取顶层页面或 CSS 区域的渲染文本，支持长度预算、截断提示和 nextCursor 续读，不刷新 ref |
| `browser_use_back` / `browser_use_reload` | 后退 / 刷新 |
| `browser_use_close` | 关闭当前对话窗口，不影响其他对话 |
| `browser_use_reset` | 经用户确认后，立即重置当前卡住的窗口；共享登录数据保留 |

`browser_use_hover` 接收最新快照的 `ref`，复用目标可见性、遮挡和真实 DOM 节点校验，必要时滚动到目标，再发送一次 CDP `mouseMoved`。不发送按下/释放事件，不激活原生窗口、不刷新 refs、不固定等待或自动点击。返回 `dispatched`、`ref` 和视口坐标，只证明移动事件已派发，不证明菜单或 tooltip 已出现。建议流程：snapshot → hover → wait（等待选择器/文本）→ 新 snapshot → 点击展开的控件。悬停可能触发网站请求或页面变化，取消不撤销已派发事件；过期或跨对话 ref 明确报错，不猜测替代节点。本版与点击一样仅支持现有快照能识别的目标，不提供任意坐标、iframe 或 Shadow DOM 定位。

`browser_use_scroll` 默认在页面 CSS 视口中心向下滚动 600 像素。可选 `deltaX` / `deltaY` 为 -10000 至 10000 的整数，不能同时为零；可选 `x` / `y` 必须落在当前页面 CSS 视口范围。坐标按页面实际 viewport 校验，而非窗口配置尺寸。返回值表示滚轮事件已派发，不代表滚动位置发生变化或懒加载已完成；对固定弹窗和嵌套滚动区域，可将坐标放在相应区域内。之后用 `browser_use_read`、`browser_use_wait` 或 `browser_use_assert` 检查页面。

`browser_use_key` 支持 Enter、Tab、Escape、Backspace、Delete、Insert、Home、End、PageUp/Down、方向键、Space、F1-F12 及 `Control` / `Ctrl`、`Alt`、`Shift`、`Meta` / `Cmd` / `Command` 修饰键。`Mod` 在 macOS 表示 Meta/Command，在 Windows/Linux 表示 Control；例如 `Shift+Tab`、`Mod+ArrowLeft`。本版不支持任意字符键码、长按、剪贴板及多键同时按住。按键操作会尽力成对发送 keydown/keyup；取消无法撤销已触发的 Enter、快捷键或页面副作用，因此绝不自动重试。派发成功不代表表单已提交，应显式读取或断言结果。

这两个工具按对话串行；独立对话仍可并行。滚动和按键可能触发站点行为，模型必须检查页面，避免不确定时重复提交。

`browser_use_assert` 至少需要一个非空字符串条件；仅传空参数或空白内容会报参数错误，不再视为通过。多个有效条件按 AND 判断。工具注册失败会带工具名报错，不继续悄悄加载不完整的工具集合。`browser_use_close` 返回后，下次调用会在同一 host 中新建此对话的窗口，保留共享登录数据。

### 正文读取与交互快照的区别

- `browser_use_snapshot` 用于找可点击、可输入的元素，返回最多 150 个编号 ref；它不是正文读取器。
- `browser_use_state` 用于快速定位页面，只返回正文前 400 个字符，保持原有行为。
- `browser_use_read` 用于阅读、总结和查找页面说明。默认读取顶层 `body.innerText`，也可传 `selector` 读取第一个匹配的 HTML 区域，例如 `main` 或 `article`；不是自动识别文章、去除广告/导航的提取器。

`browser_use_read` 参数：

| 参数 | 含义 |
| --- | --- |
| `selector` | 可选非空 CSS 选择器，默认 body；非法选择器、未匹配或非 HTML 目标明确报错 |
| `maxChars` | 可选整数，默认 6000，范围 1–24000；非法值报错，不静默修正 |

结果包含 `url`、`title`、`text`、`totalChars`、`returnedChars`、`truncated`、`hasMore` 和可选 `nextCursor`。长度按 JavaScript UTF-16 单元计，截断不拆开 emoji 等字符的代理对，因此实际返回长度可能略小于预算。`hasMore: true` 时，把不透明的 `nextCursor` 原样传回同一页面和 selector 可继续读取；cursor 不包含正文，只绑定页面版本、selector、下一个位置和正文指纹。导航、selector 变化或正文变化后会明确报 stale cursor，不会把不同版本正文拼在一起。

读取采用浏览器 `innerText` 的渲染文本语义，包括视口之外已渲染的内容，不自动滚动、不改变表单或刷新 snapshot refs。隐藏或无布局的读取根节点返回空文本，避免 `innerText` 在隐藏根上回退为隐藏内容；这不是像素级可见性检测，透明后代、被覆盖文本等仍可能出现在 `innerText` 中。不存在 body 时明确报错；空区域返回空文本而不是伪造内容。

本版只读取顶层 HTML 区域，不递归 iframe 或 Shadow DOM，不做 OCR、文章排序、跨页检索或自动过滤导航。读取期间主框架导航会使 cursor 失效；动态内容在两次读取之间变化时可能需要重新读取。此实现使用页面版本绑定的 opaque cursor 借鉴成熟分页 API 的续读语义，未复制 inner-browser 的读取器，也未更换 Electron/CDP 架构。

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
dsh plugin add dsh-browser-use-automation
```

首次工具调用时才启动浏览器；Electron 依赖随包声明，由 DSH profile 的包管理器负责安装。

开发/调试时也可以改用本仓库源码，把项目加入 DSH profile 的依赖和 bundles：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-browser-use-automation": "file:/absolute/path/to/dsh-browser-use-automation"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-browser-use-automation"]
    }
  }
}
```

重新安装 profile 依赖、重启 DSH，确认 `browser_use_*` 工具出现。[Bundle patch](cordis.patch.yml) 只添加一个插件行；浏览器在首次工具调用时启动。本插件与 DSH 官方浏览器后端注册服务及 Playwright MCP 提供方属于不同实现；只应按各自集成方式选择启用的浏览器后端。

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

在市场中核对 npm 包名 **`dsh-browser-use-automation`** 及仓库来源 **`laoyingfuhuole/dsh-browser-use-automation`**，不要安装其他作者的同名包。

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
npm run check:install -- /absolute/path/to/profile/node_modules/dsh-browser-use-automation --json
```

[检查脚本](scripts/check-install.mjs) 只读本机文件，不联网、不安装、不停止进程；退出码 `0` 为一致，`1` 为不一致，`2` 为参数/目录错误。它不检查依赖、用户资料或进程内已加载的代码。硬链接的 inode 可因编辑器原子保存而分离，因此不能只比版本号或只用 `ln -f` 修单个 host。实际修复交给市场整包安装；离线维护也须先停用插件并使用原 profile 的包管理器，勿在线逐文件覆盖。

## 测试与 CI（源码仓库）

测试使用 Node 内建 `node:test`、断言和 VM 隔离夹具，无需安装 Electron 或 DSH SDK，也不启动浏览器、连接真实账号或读取本机 profile。请使用 Node >= 22.19；测试启动器自动发现 `test/` 下的 `*.test.mjs`，不依赖 shell 通配符，因此 Windows、macOS、Linux 使用相同命令：

```bash
npm test
npm run check:syntax
# 仅运行名称匹配的测试；参数传给 Node 测试运行器
npm test -- --test-name-pattern="startup|cancel"
```

测试执行真实客户端/工具模块及 host 源码，仅替换进程、TCP、Electron 或 DSH SDK 等外部边界。客户端和工具测试通过 `--experimental-vm-modules` 链接 ESM；Node 显示 VM Modules 实验性警告是预期行为，此标志仅用于测试。临时文件在测试后清理，夹具不操作真实浏览器数据。

- **客户端**：惰性/共享启动、ready 拆包及认证、路由捕获、响应拆包/粘包、取消/超时/迟到响应、写入失败、断连和旧生命周期清理。
- **host**：隔离 Electron 环境下验证对话路由、操作队列、取消、ref 失效、滚轮坐标/限幅、键盘映射和 keyDown/keyUp 清理以及显式 close/reset；模拟测试不证明原生窗口或真实 CDP 的平台行为。
- **正文读取**：预算/截断、区域和错误输入、代理对边界、隐藏根、对话隔离、导航变化及读取后继续使用原 ref；最小 DOM 夹具不代替真实 Chromium 排版验收。
- **工具契约**：工具注册、可信对话 ID 和 signal 转发、reset 严格确认、非空断言及 AND 语义、截图字节与路径输出。
- **安装完整性**：在独立临时包中检查运行文件改动/缺失、清单变更、非法清单和版本混装；运行时校验只阻断执行文件，发布校验仍覆盖完整包。

[CI 工作流](.github/workflows/ci.yml) 在 push、pull request 和手动触发时，对 Ubuntu/Windows/macOS × Node 22.19.0/24 运行测试、语法检查、发布清单和安装自检，另检查 npm 打包内容。CI 不执行依赖安装、不下载 Electron、不启动 DSH，也不会自动生成清单来掩盖陈旧清单；修改发布文件后仍需维护者主动运行 `npm run prepare:release`。工作流提交并推送后才会产生远端结果，本地通过不能视为远端矩阵已经通过。

这些开发测试、启动器和工作流不进入插件发布文件列表；`npm test` 和 `npm run check:syntax` 仅在源码 checkout 中可用，市场安装用户无需运行。尚需另行进行真实 DSH 双对话、Electron 导航/输入、Windows 任务栏/多屏及 Linux 实机验收。模拟环境中的跨平台绿灯不等同实机兼容性认证。

## 浏览器窗口

- 初始以 `show: false` 创建，再用 `showInactive()` 非激活显示并离屏停放；普通工具不会抬起窗口。
- macOS/Linux 保留 opacity 0、不可聚焦、点击穿透的后台策略。macOS Dock 菜单按窗口编号提供查看入口；点击图标显示最近使用的已就绪窗口，不额外创建窗口。
- Windows 使用同一个 AppUserModelID，并为每个对话保留任务栏窗口条目，不创建托盘图标。在系统启用任务栏合并及缩略图时，悬停分组图标可选择各编号窗口；点击预览激活对应窗口，将它移回屏内。
- 为避免透明窗口缩略图空白，Windows 后台保持不透明绘制面、可激活和点击穿透，但先移到所有显示器范围之外，再非激活显示。切出或隐藏后仍保留任务栏条目。人工查看时尺寸采用配置值，并限制在主显示器工作区内。
- Windows 点击 X 真正销毁当前对话窗口，取消它正在执行及排队的请求，不影响其他对话；点掉最后一个原生窗口后刷新共享 Cookie/存储并退出空 host。下次工具调用可重新启动，但未提交表单、DOM 和页面现场不会恢复。该显式关闭直接销毁页面，不等待网页的 `beforeunload` 确认。
- macOS 点 X 仅隐藏当前窗口，Cmd+Q 退出整个浏览器 host；Linux 沿用原有关闭隐藏行为。切换应用会回到后台，页面继续存活。被系统最小化时会非激活恢复并重新离屏停放。
- 工具 `browser_use_close` / `browser_use_reset` 仍只作用于指定对话，按原协议保留共享 host 以便重建；不按轮次、空闲或后台状态自动清理窗口。工具不会主动抬起窗口。
- `BROWSER_USE_HIDE_DOCK=1` 隐藏 Dock 图标；`BROWSER_USE_KEEP_DOCK=1` 优先级更高，强制保留图标。

`browser_use_type`、`browser_use_click` 和 `browser_use_hover` 会注入 `pointer-events-none` 覆盖层，显示黑色箭头和动作气泡；只有点击额外绘制涟漪。覆盖层会出现在截图中，但不会移动用户的真实光标。

## 架构

```text
index.js                  插件装配与系统提示词
src/tools.js              对外工具定义与结果格式化
src/client.js             惰性启动进程与带认证的回环 RPC
host/main.cjs             对话窗口映射、共享 Session、独立 CDP 与命令队列
```

子进程在 stdout 打印一行 ready（`{ "port": ... }`）。父进程连接 `127.0.0.1`，先发送 `{ op: "hello", token }`（每次 spawn 随机生成 token），然后才发命令。并发的首次调用共用一次启动，且都等待认证完成。命令按对话分别排队，不同窗口互不等待；第二个控制连接会被拒绝。超时、断连、取消和卸载共用清理逻辑。取消与客户端超时会把原请求 ID 和对话 ID 通知 host。未执行的请求跳过，运行请求在安全边界停止后续步骤；已发出的 CDP 调用仍占用本窗口队列直到真正结束，不与下一请求交错。已经发生的点击、输入和服务端副作用无法撤销。

### 取消、恢复与页面校验

- 不自动关闭、重置或重试提交动作。取消逐字输入会停止剩余字符，但已输入内容保留；滚轮已经派发后无法撤回，鼠标和键盘输入会尽力完成对应释放，避免遗留按下状态。
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

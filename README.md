# dsh-browser-use-automation

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的后台浏览器自动化插件。一个 Electron host 为不同对话分配独立编号的离屏窗口，使用 CDP 输入和快照 ref，不抢焦点；默认共享登录状态，也可选择按对话隔离的内存会话。

## 当前版本

`v0.8.0` 在每个对话的浏览器窗口加入地址栏和标签栏。人工浏览和 DSH 工具可以操作同一组标签页。

## 功能迭代

- `v0.8.0` 支持手动输入网址、前进、后退、刷新，以及创建、切换和关闭标签。模型可用 `browser_use_tabs` 查看各页，并用 `tabId` 指定页面。

- `v0.7.2` 恢复 Enter 和 Space 的默认编辑行为，新窗口表单在当前窗口提交时保留 POST 正文。输入工具明确说明选中文字会被替换，并在缺少可编辑焦点时报告错误。`read` 支持读取 `display: contents` 区域，`wait` 会立即报告非法 CSS 选择器。新增打包产物的真实 Electron 表单回归测试。
- `v0.7.1`：修复 CI 在两个既有环境上的失败——Node 测试矩阵改用 22.23.5（22.19.0/22.20.0 在 `node --test` 配合 `--experimental-vm-modules` 退出阶段会偶发 SIGSEGV），打包冒烟作业在安装 Electron 后显式执行 `install.js`（Electron 44 起不再有 postinstall，二进制需单独下载）并校验 `path.txt`。功能与工具契约不变。
- `v0.7.0`：快照不再把输入框或文本域的当前值用作标签；后台下载增加可配置的单文件、并发和目录配额；控制连接通过认证后才占用唯一控制通道。新增按对话隔离的内存会话。CI 对实际 npm 包运行 Electron 冒烟测试，并为官方版本标签的已测试包生成构建来源证明。
- `v0.6.0`：拆成六个可独立开关的组件（核心进程 + 基础网页操作 / 正文读取 / 文件与 PDF / 网页请求处理 / 高级 JavaScript），共享同一 host，工具名与默认行为不变；新增 `browser_use_requests`、`browser_use_respond`、`browser_use_upload`、`browser_use_pdf`；接管网页原生对话框（confirm/prompt、文件选择、保存）走 IPC，不弹系统框。
- `v0.5.0`：新增 `browser_use_downloads`——host 在共享 Session 上接管 `will-download`，在事件内同步指定保存路径，后台落盘且不弹系统保存框；每次下载独占 `download-*` 目录，按对话隔离记录进度与状态，close/reset 取消本对话活动下载但保留历史与文件。
- `v0.4.2`：`browser_use_snapshot` 支持按 `selector` 限定区域、`maxElements` 限制数量（1–150）与 `includeSelectors` 精简输出，并在结果中标明范围与截断；`browser_use_type` 新增 `mode: human|fast`，fast 每块最多 256 个 Unicode 码点、逐块复核节点与焦点；`browser_use_read` 返回 `offset`/`nextCursor` 续读进度，游标过期与预算不足明确报错。
- `v0.4.1`：`browser_use_read` 支持页面版本绑定的 `nextCursor` 续读；超长 eval 返回添加安全上限及截断提示；运行时完整性校验仅阻断执行文件，发布校验继续覆盖完整包；统一 `type` / `insertText` 输入计数为 Unicode 码点。
- `v0.4.0`：新增 `browser_use_hover`（按 ref 悬停）、`browser_use_scroll`（真实滚轮事件，支持横向）、`browser_use_key`（受限功能键与修饰键组合）与 `browser_use_read`（带长度预算与截断提示的正文读取）；补充 `node:test` 回归测试、语法检查脚本与跨平台 CI 工作流。
- `v0.3.1`：修复 Windows 启动前导 CRLF 导致的握手失败；新增只读 Electron 就绪诊断 `npm run check:runtime`；Windows 点 X 关闭当前对话窗口，最后一个原生窗口关闭后刷新共享存储并退出 host；macOS 保持 X 隐藏、Cmd+Q 退出整个浏览器 host。项目仅保留本篇中文 README。
- `v0.3.0`：从一个离屏窗口改为**每个对话一个独立窗口**，按对话 ID 路由，工具不能跨对话选窗口；新增 `browser_use_insert_text`、`browser_use_reset`，`browser_use_close` 只关闭当前对话窗口；所有窗口共享 `session.defaultSession`（Cookie、localStorage、IndexedDB），页面与 sessionStorage 独立；新增发布文件完整性校验（`integrity.json` + SHA-256）。
- `v0.2.0`：重建基础版本——单窗口离屏后台运行、CDP 驱动、编号快照 ref、截图、`eval`、等待与断言、Dock 菜单，不抢焦点。

macOS 真实 Electron 回归已覆盖主要路径；Windows 新修复已通过平台模拟测试，仍需用匹配版本、无 shim 的 Electron 在 Windows 实机复验。真实 DSH UI 双对话验收仍待完成。对外使用 `vX.Y.Z` 标签，`package.json` 使用不带 `v` 的数字版本。

## 功能

- 首次工具调用时才惰性启动真实 Electron/Chromium 窗口。
- 窗口默认离屏停放；普通页面工具不主动激活窗口。Windows 保留任务栏预览，macOS 使用 Dock 编号菜单。
- 通过 Chrome DevTools Protocol 驱动页面：真实鼠标/滚轮事件、有限键盘事件、`Input.insertText`、`Input.dispatchKeyEvent`、`Page.captureScreenshot`、`Runtime.evaluate`。
- 在页面内绘制光标（箭头 + 动作气泡、点击涟漪）；输入可选逐字符或受控快速分块，动作不依赖系统指针。
- `browser_use_snapshot` 返回编号元素 ref；ref 只在当次快照内有效。快照不会把输入框或文本域的当前值用作标签；网页自己展示的文字、标签、截图及显式脚本读取不在此脱敏范围内。
- DSH 界面在后台时仍可工作；不移除 display surface，因此 CDP 输入不会被丢弃。

## 组件开关

同一个安装包通过 `cordis.patch.yml` 提供六个独立组件行，可以在 DSH 插件页分别开关；所有工具组件共享一个 `browserUse` 核心服务和一个惰性启动的 Electron host，不会每组启动一个浏览器。默认六组都启用，工具名及默认操作行为保持不变。

| 组件 | 配置行 ID / 模块入口 | 内容 |
| --- | --- | --- |
| 后台浏览器核心 | `dsh-browser-use-automation` / 包根入口 | 提供共享进程、窗口、队列、取消及原生 UI 拦截，不直接注册工具 |
| 基础网页操作 | `browser-use-basic` / `dsh-browser-use-automation/basic` | open、snapshot、click、hover、type、insert_text、scroll、key、screenshot、wait、assert、state、back、reload、close、reset |
| 正文读取 | `browser-use-read` / `dsh-browser-use-automation/read` | read，包括区域读取、预算和游标续读 |
| 文件与 PDF 导出 | `browser-use-files` / `dsh-browser-use-automation/files` | downloads、upload、pdf；上传还需网页请求处理组件 |
| 网页请求处理 | `browser-use-requests` / `dsh-browser-use-automation/requests` | requests、respond；通过 DSH 主对话逐次审核 |
| 高级 JavaScript | `browser-use-eval` / `dsh-browser-use-automation/eval` | 仅向模型直接暴露 eval |

模块导出配有独立中英文显示名称。关闭某个工具组件会撤销它的工具注册与专属提示，取消该组件的排队/运行调用及待审人机问答，不关闭其他组件的页面。重新开启注册一次新实例，旧工具引用或旧问答不能恢复授权。已发出的 CDP 调用仍可能完成，不回滚网站效果；仍需先检查页面，禁止自动重试写操作。

- 关闭核心：Cordis 将依赖它的全部工具组件卸载/挂起，释放共享 host、拒绝请求并关闭窗口；Cookie 等持久化数据不主动清除。重新开启核心后，原本启用的工具组件自动恢复，但旧 DOM、未提交表单、refs、游标和请求不恢复。应先结束任务或确认放弃现场。
- 关闭正文读取/高级 JS/基础操作：仅撤销该组，不关闭共享窗口。基础操作关闭后其他组仍可作用于已有页面，但没有导航/点击等入口。所有工具组关闭而核心保留时，不自动清理已有窗口；再次启用可继续现场。
- 关闭文件组：取消仍在进行的下载，后续原生下载直接拒绝（不回退保存框）；既有保存文件及内存历史保留，重新开启后可查询。上传/PDF 及其待处理请求失效，不影响仍启用的网页确认框。
- 关闭请求处理：拒绝并释放未完成弹框/权限请求，后续请求明确拒绝，不自动同意、不弹系统框；上传要求文件组和请求组同时开启。关闭请求组也会取消文件组里等待的主对话审批，迟到许可无效。文件组仍可下载/导出 PDF。
- 关闭 eval 只移除模型直接调用入口，assert 和其他工具内部仍可执行所需 JavaScript；这不是权限隔离沙箱。组件开关只覆盖插件管理的调用，不能防止其他系统的浏览器工具或页面脚本做相同操作。

**更新迁移：**保留原核心行 `id` 与模块名，所以已有该行的 `disabled`、窗口尺寸和 screenshotDir 配置继续有效。原始 bundle 安装在重载新补丁后会获得其他五个默认启用行；旧核心行禁用时，这些行依赖缺失而不注册工具。旧版手工只加载包根模块、没有启用 bundle 的配置需要改为启用本包 bundle，或显式增加上述子入口；不能只加载根入口就期待全部工具。插件不会自行改写正在使用的 profile；市场/HMR 是否可热应用，以 DSH 返回结果为准，不能把“包下载完成”当作组件已生效。

全局通用约束只由核心贡献，各组提示随开关移除，因此关闭不用的组会减少提供给模型的工具 schema 和专属说明。实际 token/费用仍受 DSH 请求组装和模型缓存策略影响，不承诺固定节省比例。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_use_tabs` | 用 `list` 查看标签 ID、标题、地址和当前页，用 `new` 新建空白页，用 `select` 或 `close` 操作指定标签 |
| `browser_use_open` | 打开 http(s) URL 并返回快照 |
| `browser_use_snapshot` | 返回编号的可交互元素，可限定区域、数量及 selector 展示 |
| `browser_use_click` | 按快照 ref 执行真实鼠标点击 |
| `browser_use_hover` | 按 ref 悬停，只移动页面指针、不点击 |
| `browser_use_scroll` | 在页面 CSS 视口坐标发送真实滚轮事件，垂直/水平 |
| `browser_use_key` | 发送受限功能键与修饰键组合，并尝试释放按下的键 |
| `browser_use_type` | 聚焦 ref 元素，在光标处输入或替换选中文字，支持 human / fast 模式 |
| `browser_use_insert_text` | 向当前聚焦的可编辑区域派发文本；缺少可编辑焦点时报错，无需快照 ref |
| `browser_use_screenshot` | 保存 JPEG 并返回路径 |
| `browser_use_downloads` | 查询本对话后台下载的保存路径、进度和最终状态 |
| `browser_use_requests` | 查看本对话待处理的网页弹框、文件选择、权限和打印请求 |
| `browser_use_respond` | 拒绝请求，或经 DSH 主对话反问后接受 alert/confirm/prompt 与受支持权限 |
| `browser_use_upload` | 经主对话明确授权后，向待处理的 HTML 文件选择器提供指定文件 |
| `browser_use_pdf` | 后台导出当前页面为 PDF，不调用实体打印机或系统打印框 |
| `browser_use_eval` | 执行页面 JavaScript |
| `browser_use_wait` | 等待加载、选择器、文本或 URL；非法选择器立即报错，有效条件超时返回 `ready: false` |
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

### 后台下载（不弹系统保存框）

host 在创建页面前为所用的 Session 注册 `will-download`，在事件内同步指定保存路径，避免 Electron 默认弹出 macOS/Windows 的“另存为”对话框。此规则覆盖浏览器正常触发的附件、`download` 链接和 Blob 下载，不会自动打开保存后的文件。

- 默认保存到 `$DSH_HOME/browser-use/downloads`（未设 DSH_HOME 时为 `~/.dsh/browser-use/downloads`）。可在启动 host 前用 `BROWSER_USE_DOWNLOAD_DIR` 指定绝对目录；非法路径明确报错，不自动改为其他目录。目录在首次下载时创建。
- 每次下载分配独占的 `download-*` 子目录，文件名经清理及长度限制；同名/并发下载不会覆盖其他文件。不把对话 ID 写进文件名，不让模型任意选择覆盖路径。
- `browser_use_downloads` 只返回当前对话记录，包含 `id`、`filename`、`state`、已收/总字节数及可选 `path`、`error`。查询不创建窗口，不受该页面队列卡住影响。只有 `completed` 且确认文件存在才表示可使用；`progressing` 或 `interrupted` 不表示成功，`cancelled` / `failed` 要检查原因。总字节数未知时可能为 0 或负值，不据此判断完成。
- 默认单文件最多 256 MiB、单 host 同时最多 4 个下载、整个保存目录预算 2 GiB（含 PDF、已有及残留文件）。启动前可用 `BROWSER_USE_DOWNLOAD_MAX_FILE_BYTES`、`BROWSER_USE_DOWNLOAD_MAX_CONCURRENT`、`BROWSER_USE_DOWNLOAD_MAX_DIRECTORY_BYTES` 设置正整数。未知大小会预留剩余预算与单文件上限的较小者；Electron 报告超限时取消并清理该次生成的文件。应用层配额不是文件系统硬配额，可能短时超出；不要让多个 host 同时写同一目录。
- 历史保存在本次 host 内存中，每对话保留 50 条，优先淘汰已结束项。close/reset 保留历史和已有文件，但取消所属窗口仍在下载的文件，不影响其他对话。host 重启后历史不恢复，已有文件仍占用配额。
- 工具取消/超时不回滚已发起的下载；查询状态后再决定下一步，不要自动重试。普通取消/失败可能残留部分文件，插件不会自动删除之前的下载。
- 路径准备失败时阻止该次下载并记录错误，不能回退到原生保存框；来源不属于存活对话窗口的下载直接拒绝并记录日志，不分配到其他对话。

推荐流程：点击下载 → `browser_use_downloads` → 必要时再次查询，直到 `completed` 后使用返回路径。直接导航到附件 URL 仍可能报告“导航转为下载”，这是页面没有加载成功，不代表文件失败；应查询下载状态，不能自动重试导航或点击。打印与 File System Access API 不属于此下载事件路径，分别按下节的 PDF 导出和显式不支持策略处理。

### 常用网页弹框与主对话授权

插件通过隔离的沙箱 preload 接管网页 `alert()` / `confirm()` / `prompt()`。网页的同步函数仍等待回答并返回原本的值类型，不把 confirm 改成 Promise，也不默认确认。主框架和子框架运行同一受限 preload；保留 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，`nodeIntegrationInSubFrames` 仅用于让 Electron 在子框架运行沙箱 preload。实测主页面和子框架都没有 `require` / `process` / `Buffer`。原生 JS 弹框另用 `disableDialogs` 兜底禁止；preload 加载失败会明确关闭该窗口，避免静默回退。

操作触发请求后会返回 `request is pending`，这表示原页面操作可能仍在等待，**不能重新点击或重新执行提交**。推荐流程：

1. 调用 `browser_use_requests` 查看请求的 `id`、`kind`、来源 URL 和网页消息。
2. 拒绝时调用 `browser_use_respond({ requestId, accept: false })`。
3. 接受时调用 `browser_use_respond({ requestId, accept: true })`；prompt 可加 `value` 作为拟提交答案。
4. 插件调用官方 `ctx.userQuestions.ask`，在该工具所属的 DSH 主对话询问用户，展示来源、网页消息及拟提交文本。只有用户选择“仅本次允许”才继续；拒绝或空答复按拒绝处理，取消/超时/反问服务不可用明确报错且不放行。
5. 回答完成后先读取页面确认结果，不重试旧动作。alert 的拒绝只是结束提示，不能撤销其之前的网页副作用。

反问依赖宿主已启用的 `userQuestions` 服务，本插件不安装或重配 DSH 服务。若缺少该服务仍可查看/拒绝请求，但接受和上传会明确失败；子代理等无权发起主对话问题的调用者遵循 DSH 服务限制。主对话等待预算为 5 分钟，工具取消后不自动把迟到回答用于其他请求。没有永久许可或“模型 confirm=true 即授权”的旁路。

请求按对话、具体随机 ID 和页面代次绑定；导航（含子框架变化）、close/reset 和页面销毁会拒绝旧请求并释放等待。查询/回答/上传走带期限与取消的控制面，绕过被同步 JS 弹框卡住的页面队列。待回答弹框或权限会阻止新的普通页面操作；另一个对话仍可继续。每窗口最多 10 个待处理请求、20 条内存审计摘要，摘要只含 ID、类型、结果；插件不另行落盘回答。DSH 主对话仍按宿主自身日志策略记录问题和用户答复，可能包含文件路径及拟提交的 prompt 文本。网页消息属于不可信待审内容，不能当作用户指令。

### 上传文件与权限边界

HTML `<input type=file>` 的选择框由 CDP 拦截，不显示原生文件选择器。点击或页面调用 `.showPicker()` 后，用 `browser_use_requests` 取得 `upload` 请求，再调用：

```json
{ "requestId": "请求ID", "paths": ["/absolute/path/report.pdf"] }
```

以上参数传给 `browser_use_upload`。插件先在主对话展示网页来源和**确切文件路径**询问；获准后才检查文件并调用 CDP `DOM.setFileInputFiles`。支持 1–32 个绝对路径的可读普通文件（仍受页面单选/多选限制），不支持目录上传，页面可能在文件选中后立即开始传输。符号链接按本机真实路径解析，不复制文件；审批与上传间仍可能有外部文件变化，不能将此当作文件内容锁定或 OS 级授权。

上传请求一次派发即消耗，失败/超时可能已有网页效果，不恢复为可重复授权，不自动重试。拒绝只丢弃本次选择请求，不设置文件；不承诺与原生文件选择器完全相同的 cancel 事件。选择成功不等于服务器上传完成，应检查页面业务结果。

通知和剪贴板读写权限请求也可通过主对话逐次审核，默认权限检查为未获准，不持久保存授权。摄像头/麦克风、定位、外部应用等尚无完整后台/系统授权流程，本版明确拒绝并记录 `unsupported`，不能通过 respond 强行允许。需这类能力时应单独设计和验收，不能用网页消息伪造系统许可。

### 打印与 File System Access API

- 网页 `window.print()` 被记录为 `print` 请求，**不弹原生打印框、不发送到打印机**。用 `browser_use_pdf({})` 导出当前页面，文件保存在下载目录下独占的 `pdf-* / page.pdf`，返回路径、字节数及 MIME。它使用网页打印样式，不等于下载网站原始文件。PDF 失败、页面变化或取消会报错，不自动重试或覆盖文件；先处理阻塞弹框再导出。
- `showOpenFilePicker()`、`showSaveFilePicker()`、`showDirectoryPicker()` 被明确记录为 `unsupported` 并以 `NotAllowedError` 拒绝，避免系统选择器抢前台。即使用户同意，也无法用普通路径等价生成真实 `FileSystemFileHandle` / 目录句柄；本版不伪造返回值、不注入广泛文件系统权限。可用普通 HTML 上传、后台下载或 PDF 工具替代，若站点只接受 FSA 则该工作流尚不支持。
- 这些拦截是合作页面的后台交互适配，不是对恶意网页的系统弹框沙箱。物理键盘/原生菜单的打印、打印预览/PDF 内嵌查看器、系统证书/HTTP 认证/密码管理器、原生 OS 权限、特殊浏览器窗口或被站点另行取得的原生函数尚未完整接管，不承诺全部系统 UI 都不会出现。

### 减少重复读取与快速输入

`browser_use_open`、`browser_use_back` 和 `browser_use_reload` 已返回快照及 refs，优先直接使用，不要紧接着再次 snapshot。确需刷新时，可只读取相关弹窗或表单：

```json
{ "selector": "[role=dialog]", "maxElements": 20, "includeSelectors": false }
```

以上是 `browser_use_snapshot` 参数。`selector` 选择第一个匹配区域（根节点若可交互也包含在内），省略时仍读顶层文档；`maxElements` 为 1–150 的整数，默认 150；`includeSelectors` 默认 true，false 时仅省略每项诊断 CSS 选择器，不影响 ref 操作。结果含 `maxElements` 和可选的区域 `selector`，超过预算会提示 `truncated`。未匹配、非法选择器或预算明确报错。每次新快照都替换本对话全部 refs，包括此前其他区域的 refs；区域快照不是多个独立 ref 集合，也不是分页读取。快照按不可并发动作调度，host 仍按本对话串行执行。

长文本可在 `browser_use_type` 中显式使用快速模式：

```json
{ "ref": 151, "text": "要输入的文本", "mode": "fast" }
```

`mode` 支持 `human`（默认）和 `fast`。human 逐 Unicode 码点输入，间隔约 18 ms。fast 每块最多 256 个码点，每块前校验原 DOM 节点、可编辑性、遮挡及焦点。两种模式都在光标处输入，有选区时会替换选中文字。需要追加时，先将光标移到末尾。`typed` 表示已确认派发的码点数，字段最终内容以页面为准。

fast 遇到目标被移除、焦点变化、取消或 CDP 失败时停止后续块，不自动重试。host 错误会附已获 CDP 确认的输入进度；在途块仍可能完成，不能据该进度直接补输剩余内容。客户端先超时/取消时没有最终进度，只明确提醒可能部分插入或仍在执行，必须先检查页面。正在执行的 CDP 调用仍占用该窗口队列；其他对话不受影响。

### 正文读取与交互快照的区别

- `browser_use_snapshot` 用于找可点击、可输入的元素，返回最多 150 个编号 ref；它不是正文读取器。
- `browser_use_state` 用于快速定位页面，只返回正文前 400 个字符，保持原有行为。
- `browser_use_read` 用于阅读、总结和查找页面说明。默认读取顶层 `body.innerText`，也可传 `selector` 读取第一个匹配的 HTML 区域，例如 `main` 或 `article`；不是自动识别文章、去除广告/导航的提取器。

`browser_use_read` 参数：

| 参数 | 含义 |
| --- | --- |
| `selector` | 可选非空 CSS 选择器，默认 body；非法选择器、未匹配或非 HTML 目标明确报错 |
| `maxChars` | 可选整数，默认 6000，范围 1–24000；非法值报错，不静默修正 |
| `cursor` | 续读时原样传回上一段的 nextCursor；可省略 selector 以沿用原区域，显式传入则必须相同 |

结果包含 `url`、`title`、`text`、`offset`、`totalChars`、`returnedChars`、`truncated`、`hasMore` 和可选 `nextCursor`。`offset` 为本段起点，模型文本会显示实际起止范围和完整游标，避免知道“还有内容”却无法续读。末页 `hasMore: false`，省略 nextCursor（不返回 null）；内部正文指纹不作为公共字段返回，结果与工具 schema 一致。

长度按 JavaScript UTF-16 单元计，截断不拆开 emoji 等字符的代理对，因此实际返回长度可能略小于预算。预算为 1 且下一个字符需要两个单元时会明确要求增大预算，不返回重复的零进度游标。`hasMore: true` 时，把 nextCursor 原样传回即可继续，可重新指定 maxChars；不自动读取剩余内容。游标不保存正文，以每个标签独立的 HMAC 绑定读取位置、页面版本、区域和正文指纹；跨对话、close/reset、host 重启或令牌被改动都会拒绝。导航或正文变化同样要求重新读取。旧版本的游标不兼容，应重新开始读取。

读取采用浏览器 `innerText` 的渲染文本语义，包括视口之外已渲染的内容。`display: contents` 区域按其内容的布局读取，保留直接文本和可见后代。隐藏或无布局的区域返回空文本。读取保留当前选区和快照 refs。透明后代、被覆盖文本等仍可能出现在 `innerText` 中。不存在 body 时明确报错。

本版只读取顶层 HTML 区域，不递归 iframe 或 Shadow DOM，不做 OCR、文章排序、跨页检索或自动过滤导航。读取期间主框架导航会使 cursor 失效；动态内容在两次读取之间变化时可能需要重新读取。此实现使用页面版本绑定的 opaque cursor 借鉴成熟分页 API 的续读语义，未复制 inner-browser 的读取器，也未更换 Electron/CDP 架构。

### 对话与窗口

- 工具从 DSH 执行上下文的 `exec.agent.id` 获取对话标识；同一对话复用窗口，不同对话使用不同窗口。模型无需、也不能通过参数选择窗口。缺失标识时明确报错。
- 编号只用于标题和 Dock 菜单，在本次 host 生命周期中递增；内部始终按对话 ID 路由，不能将编号或快照 ref 当作跨对话标识。
- 每个标签独立持有页面、快照 ref、读取游标、CDP 会话和操作队列。同一标签的页面操作依次执行，不同标签可以并行。
- 人工查看窗口时，在地址栏输入 HTTP(S) 网址后按 Enter。省略协议时使用 HTTPS。用标签栏的 ＋、标题和 × 新建、切换、关闭页面。macOS 使用 Cmd+L/T/W，其余平台使用 Ctrl+L/T/W，分别定位地址栏、新建和关闭当前标签。关闭最后一页会保留一个空白页。
- 页面工具默认操作宿主收到请求时选中的标签。多步任务可先用 `browser_use_tabs` 获取 `tabId`，后续调用一直传入该 ID。切换标签会保留草稿。关闭标签会取消该页的任务和待审批请求。整窗 `browser_use_close` 和 `browser_use_reset` 会关闭该对话的全部标签。
- 默认使用 `BROWSER_USE_SESSION_MODE=shared`，保留之前的默认数据目录。同源 Cookie、localStorage、IndexedDB 等共享，退出登录或切换账号会影响其他窗口。
- 启动 host 前设置 `BROWSER_USE_SESSION_MODE=isolated`，同一对话的标签共享一份独立、非持久化的会话；close/reset 后的新窗口不继承旧登录。不会迁移或删除共享资料，下载等落盘产物也不会被清除。这不是 OS 或网络隔离。
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

- 从正确仓库条目安装后，由 dshmarket 的“更新”按钮检查远端版本、选择提交、执行完整安装并管理插件重载。无需额外运行本项目命令行脚本，插件也不自行下载安装、修改 profile 或强制重启；多组件 bundle 更新可能重建核心并丢失当前页面现场，先结束任务。
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

官方仓库推送与 `package.json` 匹配的 `vX.Y.Z` 标签时，CI 为通过测试的 npm tarball 生成 GitHub 构建来源证明。发布时应使用该次运行的 `tested-npm-tarball`，不要另行重打包。下载后可在安装前核验来源（下例将版本替换为实际标签）：

```bash
repo=laoyingfuhuole/dsh-browser-use-automation
version=X.Y.Z
gh attestation verify "dsh-browser-use-automation-$version.tgz" \
  --repo "$repo" --signer-workflow "$repo/.github/workflows/ci.yml" \
  --source-ref "refs/tags/v$version" --deny-self-hosted-runners
```

来源证明绑定的是 tarball 字节和构建身份，不证明代码没有缺陷，也不覆盖 GitHub 自动生成的源码 ZIP、dshmarket 的源码安装或独立下载的 Electron 二进制。插件仍只做本地文件一致性检查，不在启动时联网验签。

普通市场用户不需要下面的诊断命令。维护者可在安装目录执行自检，或从 checkout 比较整个安装副本：

```bash
# 进入已安装包目录后，独立验证随包清单，不需要开发 checkout
npm run check:install -- --self --json
# 仅开发诊断：从 checkout 与指定安装目录比较内容
npm run check:install -- /absolute/path/to/profile/node_modules/dsh-browser-use-automation --json
```

[检查脚本](scripts/check-install.mjs) 只读本机文件，不联网、不安装、不停止进程；退出码 `0` 为一致，`1` 为不一致，`2` 为参数/目录错误。它不检查依赖、用户资料或进程内已加载的代码。硬链接的 inode 可因编辑器原子保存而分离，因此不能只比版本号或只用 `ln -f` 修单个 host。实际修复交给市场整包安装；离线维护也须先停用插件并使用原 profile 的包管理器，勿在线逐文件覆盖。

## 测试与 CI（源码仓库）

测试使用 Node 内建 `node:test`、断言和 VM 隔离夹具，无需安装 Electron 或 DSH SDK，也不启动浏览器、连接真实账号或读取本机 profile。运行测试请使用 Node >= 22.23.5：22.19.0 与 22.20.0 在 `node --test` 配合 `--experimental-vm-modules` 的进程退出阶段会偶发 SIGSEGV（上游缺陷，插件运行本身仍支持 Node >= 22.19）。测试启动器自动发现 `test/` 下的 `*.test.mjs`，不依赖 shell 通配符，因此 Windows、macOS、Linux 使用相同命令：

```bash
npm test
npm run check:syntax
# 仅运行名称匹配的测试；参数传给 Node 测试运行器
npm test -- --test-name-pattern="startup|cancel"
```

测试执行真实客户端/工具模块及 host 源码，仅替换进程、TCP、Electron 或 DSH SDK 等外部边界。客户端和工具测试通过 `--experimental-vm-modules` 链接 ESM；Node 显示 VM Modules 实验性警告是预期行为，此标志仅用于测试。临时文件在测试后清理，夹具不操作真实浏览器数据。

- **客户端**：惰性/共享启动、ready 拆包及认证、路由捕获、响应拆包/粘包、取消/超时/迟到响应、写入失败、断连和旧生命周期清理。
- **后台下载**：事件同步分配路径、同名隔离、文件名清理、进度/完成文件验证、目录/保存失败、未知来源拒绝、记录限额及关闭/重置的跨对话隔离。另以独立资料目录的 Electron 本地服务验证附件和 Blob 自动落盘；不代表已验收所有网站的文件选择器。
- **后台网页 UI**：同步弹框值类型、主对话许可允许/拒绝/取消/缺服务、跨对话/导航失效、文件选择取消与一次性派发、PDF 失败/取消不写盘、请求数量和审计限额。独立 Electron 验证主/子框架同步对话框、HTML 上传、通知拒绝、打印转 PDF 及 FSA 明确拒绝；DSH 反问卡片仅做官方接口对照与模拟测试，真实主对话 UI、Windows/Linux 与复杂站点仍待验收。
- **host**：隔离 Electron 环境下验证对话路由、操作队列、取消、ref 失效、滚轮坐标/限幅、键盘映射和 keyDown/keyUp 清理以及显式 close/reset；模拟测试不证明原生窗口或真实 CDP 的平台行为。
- **正文读取**：预算/截断、区域和错误输入、代理对边界、隐藏根、对话隔离、导航变化及读取后继续使用原 ref；最小 DOM 夹具不代替真实 Chromium 排版验收。
- **续读链路**：实际 host 输出与 schema 对齐、从 render 文本取得游标并继续原区域、末页/空页、篡改/跨窗口/重建失效、emoji 小预算保证前进。
- **快速输入/区域快照**：分块数量和文本一致、焦点变化/取消/错误后的部分进度、不重试；区域根节点、数量和 selector 省略、全局 refs 更新及截断边界。
- **工具契约**：工具注册、可信对话 ID 和 signal 转发、reset 严格确认、非空断言及 AND 语义、截图字节与路径输出；跨层 schema 检查不等于真实 DSH UI/SDK 验收。
- **组件启停**：同包 exports、tool 分组唯一归属、共享客户端、首次/运行中能力配置同步、工具/提示卸载、取消待审操作、禁用后 host 拒绝下载/旧调用及核心级联依赖。另在临时 profile 副本使用官方 Cordis 4.1.0 / loader 1.1.0 验证六行加载、单组开关、核心级联和重新注册；真实 Electron 验证运行中切换不换 PID、不丢其他页面。未操作正在运行的真实插件页开关，界面外观/HMR及市场迁移仍待验收。
- **安装完整性**：在独立临时包中检查运行文件改动/缺失、清单变更、非法清单和版本混装；运行时校验只阻断执行文件，发布校验仍覆盖完整包。

[CI 工作流](.github/workflows/ci.yml) 在 push、pull request 和手动触发时，对 Ubuntu/Windows/macOS × Node 22.23.5/24 运行隔离回归、语法检查、发布清单和安装自检，另检查 npm 打包内容。独立 macOS 作业为打包产物安装 Electron（Electron 44 起没有 postinstall，需显式运行 `node node_modules/electron/install.js` 下载二进制），在临时资料目录和本地测试页上验证地址栏导航、标签切换、后台截图与点击、POST 新标签、快照脱敏、共享/隔离登录状态、弹框和下载。设置 `DSH_TEST_FOREGROUND=1` 运行打包测试时，还会短暂显示测试窗口，检查快捷键和实际键盘焦点。不启动 DSH，也不验证 DSH 反问卡片。CI 不自动生成清单；修改发布文件后要主动运行 `npm run prepare:release`。

这些开发测试、启动器和工作流不进入插件发布文件列表；`npm test` 和 `npm run check:syntax` 仅在源码 checkout 中可用，市场安装用户无需运行。尚需另行进行真实 DSH 双对话、Electron 导航/输入、Windows 任务栏/多屏及 Linux 实机验收。模拟环境中的跨平台绿灯不等同实机兼容性认证。

## 浏览器窗口

- 初始以 `show: false` 创建；macOS/Linux 从构造时即不可聚焦，首次加载前就启用鼠标穿透，首次显示前先透明，再用 `showInactive()` 保留后台绘制表面。普通工具不会抬起窗口。
- macOS/Linux 保留 opacity 0、不可聚焦、点击穿透的后台策略。macOS Dock 菜单按窗口编号提供查看入口；点击图标显示最近使用的已就绪窗口，不额外创建窗口。
- Windows 使用同一个 AppUserModelID，并为每个对话保留任务栏窗口条目，不创建托盘图标。在系统启用任务栏合并及缩略图时，悬停分组图标可选择各编号窗口；点击预览激活对应窗口，将它移回屏内。
- 为避免透明窗口缩略图空白，Windows 后台保持不透明绘制面、可激活和点击穿透，但先移到所有显示器范围之外，再非激活显示。切出或隐藏后仍保留任务栏条目。人工查看时尺寸采用配置值，并限制在主显示器工作区内。
- Windows 点击 X 真正销毁当前对话窗口，取消它正在执行及排队的请求，不影响其他对话；点掉最后一个原生窗口后刷新共享 Cookie/存储并退出空 host。下次工具调用可重新启动，但未提交表单、DOM 和页面现场不会恢复。该显式关闭直接销毁页面，不等待网页的 `beforeunload` 确认。
- macOS 点 X 仅隐藏当前窗口，Cmd+Q 退出整个浏览器 host；Linux 沿用原有关闭隐藏行为。切换应用会回到后台，页面继续存活。回后台时显式释放原生键盘焦点；macOS/Linux 被系统最小化后，先禁止聚焦、透明并离屏停放，再恢复窗口，避免可聚焦的恢复过程短暂打断其他应用输入。Windows 保留任务栏恢复分支。
- 工具 `browser_use_close` / `browser_use_reset` 仍只作用于指定对话，按原协议保留共享 host 以便重建；不按轮次、空闲或后台状态自动清理窗口。工具不会主动抬起窗口。
- `BROWSER_USE_HIDE_DOCK=1` 隐藏 Dock 图标；`BROWSER_USE_KEEP_DOCK=1` 优先级更高，强制保留图标。

`browser_use_type`、`browser_use_click` 和 `browser_use_hover` 会注入 `pointer-events-none` 覆盖层，显示黑色箭头和动作气泡；只有点击额外绘制涟漪。覆盖层会出现在截图中，但不会移动用户的真实光标。

## 架构

```text
index.js                  提供共享 browserUse 核心服务和通用提示
src/{basic,read,files,requests,eval}.js  可独立启停的同包组件入口
src/core.js / component.js 共享客户端、组件租约、取消和工具/提示卸载
src/components.json       工具归属及 host 操作权限映射
src/prompts.js            通用及各组件的提示
src/tools.js              工具定义、按组选取注册与结果格式化
src/client.js             惰性启动进程与带认证的回环 RPC
host/main.cjs             对话窗口映射、共享 Session、独立 CDP 与命令队列
```

子进程在 stdout 打印一行 ready（`{ "port": ... }`）。父进程连接 `127.0.0.1`，先发送 `{ id: 0, op: "hello", token }`（每次 spawn 随机生成 token），然后才发命令。握手有独立的时间、字节和连接数上限；只有通过认证的连接才占用唯一控制槽，未认证连接断开不会关闭宿主。并发的首次调用共用一次启动，且都等待认证完成。命令按对话分别排队，不同窗口互不等待。超时、断连、取消和卸载共用清理逻辑。取消与客户端超时会把原请求 ID 和对话 ID 通知 host。未执行的请求跳过，运行请求在安全边界停止后续步骤；已发出的 CDP 调用仍占用本窗口队列直到真正结束，不与下一请求交错。已经发生的点击、输入和服务端副作用无法撤销。

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

- 每个对话只有一个窗口。弹出的 HTTP(S) 链接和以新窗口为目标的表单在同窗新标签中打开，Chromium 处理 POST 正文和来源策略，来源页保留原有内容。
- 快照不包含 iframe 和 shadow root；光标只注入顶层文档。
- 截图只截当前视口，不是整页滚动截图；`fullPage` 是预留参数，暂不生效。
- 输入通过 `Input.insertText` 完成；human 默认逐码点约 18 ms 间隔，fast 为显式选择的受控分块。快速模式的站点兼容性需按页面实际事件行为验证。
- macOS 已做真实 Electron 回归；Windows 任务栏策略已做平台模拟测试，仍需在 Windows 实机验收缩略图内容、预览点击和多屏行为。Linux 未做实机验证。
- 输入中断的焦点时序修复已覆盖创建/首次加载/显示、人工查看回后台及最小化恢复的模拟回归；隔离 macOS Electron 实测普通 CDP 操作期间未切换前台应用。该结果不等于已复现所有输入法、桌面空间和用户现场的间歇性输入中断。
- 多显示器下，Mission Control 可能显示空白 tile；窗口保持透明且点击穿透，但尚无原生 z-order（`orderBack`）。
- Windows 任务栏分组和缩略图由系统设置/策略控制；禁用合并时可能显示多个按钮。若系统将窗口夹回屏内，代码回退到透明状态，预览可能空白，避免直接显示后台页面。任务栏预览或按窗口采集可能暴露页面内容，后台状态不是隐私保护。
- 没有自定义客户端设置面板，使用 DSH 插件页的六个 bundle 组件行启停；各组依赖核心，上传额外依赖请求处理。

## 许可证

MIT。见 [LICENSE](./LICENSE)。

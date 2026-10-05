# 用户插件平台与节点工具 MVP

## 目标

允许用户编写本地 JavaScript 插件，并为不同节点类型贡献右键工具和节点工具栏操作。插件只能接收 manifest 明确声明的节点字段与宿主弹窗参数，返回结构化节点数据；宿主校验结果后再通过 Store Action 写回画布。

本阶段不开放主窗口 DOM、Zustand Store、Tauri IPC、Shell、任意文件、任意网络或凭据访问。

## 插件包

首版以文件夹导入，不引入压缩包依赖：

```text
example-plugin/
├── manifest.json
└── main.js
```

`manifest.json` 示例：

```json
{
  "apiVersion": 1,
  "id": "com.example.text-tools",
  "name": "文本节点工具",
  "version": "1.0.0",
  "author": "示例作者",
  "description": "为文本节点提供内容转换工具",
  "category": "content",
  "keywords": ["文本", "转换"],
  "entry": "main.js",
  "permissions": ["node.read", "node.write"],
  "contributes": {
    "nodeTools": [
      {
        "id": "uppercase-output",
        "title": "输出转大写",
        "placements": ["node-context-menu", "node-toolbar"],
        "icon": "lucide:case-upper",
        "dialog": {
          "title": "输出转大写",
          "submitLabel": "转换",
          "fields": [
            { "id": "prefix", "label": "结果前缀", "type": "text" }
          ]
        },
        "nodeTypes": ["ai-text", "source-text"],
        "inputFields": ["label", "prompt", "output"],
        "output": {
          "mode": "update-current",
          "fields": ["output"]
        }
      }
    ]
  }
}
```

`main.js` 使用同步 `definePlugin` 协议：

```js
definePlugin({
  tools: {
    "uppercase-output": (input) => ({
      data: {
        output: String(input.parameters.prefix || "")
          + String(input.node.data.output || "").toUpperCase()
      },
      message: "已转换输出"
    })
  }
});
```

## 执行边界

1. 前端导入文件夹，校验 manifest、入口文件、大小、ID、节点类型、权限和字段声明。
2. 插件源码与 manifest 独立保存在 IndexedDB，不进入项目数据或聊天消息。
3. 用户在节点右键菜单选择插件工具时直接执行；点击节点工具栏插件按钮时，宿主先按 `dialog` 渲染操作弹窗。
4. 宿主按 `inputFields` 构造不可变节点快照，并将经过校验的弹窗值放入 `input.parameters`；本地路径、身份字段和过大值不会进入插件。
5. Rust 为每次调用创建独立 QuickJS Runtime，不安装模块加载器或任何宿主函数；设置内存、栈和执行时间上限。
6. Rust 只接受可 JSON 序列化的同步返回值。
7. 前端复核插件仍启用、项目未切换、canvas revision 未变化，并按 `output.fields` 校验返回字段。
8. `update-current` 通过 `updateNodeData()` 一次性提交历史；`create-node` 通过 `addNode()` 在源节点右侧创建结果节点。

## AI Canvas Plugin Manifest Standard v1

- 身份：`id`、`name`、`version`、`author`。
- 用途：`description`、`category`、`keywords`，安装页据此说明插件是内容、媒体、工作流还是通用工具。
- 兼容：`apiVersion` 是宿主契约版本；未知版本直接拒绝安装。
- 权限：`permissions` 声明可读、可写能力；源码不能扩大权限。
- 贡献点：`contributes.nodeTools` 声明工具及其 `placements`；v1 支持 `node-context-menu` 与 `node-toolbar`。
- 工具栏 UI：`node-toolbar` 必须声明安全的 Iconify `icon` 与宿主 `dialog`；弹窗支持文本、长文本、数字、下拉框和复选框，不允许插件注入 DOM、HTML 或 React 组件。
- 作用域：每个工具以 `nodeTypes` 精确声明出现在哪类节点，以 `inputFields` / `output.fields` 声明会读取和修改什么。

## MVP 边界

- 支持：安装、替换、启用、禁用、卸载；按节点类型显示右键工具和工具栏按钮；声明式操作弹窗；结构化输入/输出；更新当前节点；创建结果节点；超时与内存隔离；GitHub Release 安装、市场索引和更新提示。
- 暂不支持：代码签名、静默自动更新、压缩包、异步 JS、第三方模块、任意网络、自定义 React 节点、任意插件 UI/HTML 面板、Agent 工具注册。
- 后续扩展必须继续走 capability API，不得把 Store、Tauri API 或密钥直接交给插件。

## Plugin API v1 自定义节点与宿主能力（已实施）

- `contributes.nodes` 可声明宿主渲染的自定义节点、字段及输入输出端口；画布统一使用 `plugin-node` 渲染器，不加载插件 React/HTML。
- 自定义节点继续复用同步 QuickJS 函数，通过最多 4 次受控 effect 请求异步宿主能力。
- `models.read` 只提供脱敏模型目录，`models.invoke` 由现有文本、图片、视频和音频生成服务代为调用，插件拿不到密钥或连接地址。
- `files.connected.read` 只通过调用级不透明资源句柄读取当前节点或直接入边项目文件；`files.output.create` 由宿主创建派生输出。
- 插件停用或卸载后自定义节点保留为不可用占位，不删除项目数据。

## GitHub 插件市场扩展（已实施）

- Manifest 可声明 `repository`、`homepage` 和 `license`；市场安装要求 `repository` 与实际 GitHub 仓库一致。
- `public/plugin-marketplace.json` 是轻量仓库索引；收录采用 Pull Request，未收录仓库仍可直接输入地址安装。
- 宿主通过 GitHub 最新正式 Release 追踪版本，只接受 `vX.Y.Z`，并要求标签版本与 Manifest `version` 一致。
- 市场下载的 `manifest.json` 和 Manifest 声明入口继续复用本地安装校验；JavaScript 使用 QuickJS 沙箱，Python 使用下述可信运行时。
- 插件页自动检查更新并做 15 分钟内存缓存；安装和更新都必须由用户点击，不静默执行。
- 当前不提供代码签名或市场服务端代理；规模超过匿名 GitHub API 限额后，再增加可信聚合服务。

## Plugin API v1 可信 Python 运行时（已实施）

- v1 通过 `runtime: "python"` 与 `entry: "main.py"` 显式声明可信 Python 代码；JavaScript 使用 `runtime: "javascript"` 与 `main.js`。
- Python 使用本机 Python 3 与当前环境已安装包，每次调用独立子进程，通过有界 JSON stdin/stdout 协议执行 `define_plugin` 注册的同步工具。
- Rust 使用固定参数数组启动解释器，不经过 Shell；提供 30 秒超时、进程终止、512 KiB 源码、1 MiB 输出和 64 KiB 错误上限。
- Python 插件不是沙箱，可以以当前用户权限访问文件、网络、环境变量和系统 API；安装、更新与重新启用时均显示不可混淆的高风险确认。
- Manifest 权限继续约束宿主代办能力、输入投影、输出字段、宿主 effect 与 UI，但不声称限制 Python 对操作系统的直接访问。
- 设置页检测 `python`、`python3` 或 Windows `py -3` 并展示版本；不下载解释器、不创建虚拟环境、不执行 `requirements.txt`。
- Python 不注册为 Agent/MCP 工具，不修改 Tauri Shell capability、IndexedDB schema 或凭据边界。

## 回滚

插件记录使用独立 object store。关闭插件入口或降级应用时，旧版本只会忽略该 store，不影响项目画布；禁用插件即可停止其所有节点工具。

## 2026-10-05 宿主能力扩展（代码与自动化验证完成，实机验收待完成）

任务类型为平台能力。用户已确认补齐 UI 数据校验、按域名授权 HTTP 和插件私有设置的范围。保留 API v1；未声明新权限的旧插件不新增授权，不增加依赖、不修改 tauri.conf.json、不开放插件窗口的通用 IPC。UI 超限从裁剪改为明确拒绝。

- 合同：`network.request` 配合 `network.allowedOrigins`，只允许精确的公共 HTTPS 来源；宿主代发有界 HTTP，不跟随重定向、不自动重试。`settings.read/write` 只读写插件自己的非敏感偏好，不存凭据、文件路径或正文。
- 权威：Manifest、域名白名单和权限绑定 revision，安装/换版使用原生确认；每次执行与返回复核活动版本。设置写入与版本切换共用注册表锁，网络请求可在 UI 关闭、停用、更新、卸载时取消。
- 文件范围：`types/plugin.ts`、`services/plugins/pluginManifest.ts`、`pluginRuntime.ts`、`pluginUiSessionService.ts`、`components/settings/PluginSettings.tsx`；Rust `plugins/registry.rs`、新增 `plugins/host_effects.rs`、`agent/web.rs`、`lib.rs` 与第一方命令 ACL；对应 Manifest/执行/UI/Store 回归、插件规范及模块文档。
- 验收：UI 超限不改变参数或提交；无权限、越权来源、私网地址、重定向、超限响应、取消与旧 revision 均拒绝；设置隔离、原子写入和跨版本保留；前端 lint/类型检查/定向测试与 Rust test/check。
- 回滚：当前宿主内可停用使用新权限的插件并关闭新增 effect，保留偏好供恢复。降级应用前须卸载包含新权限的注册记录并重装兼容 revision；仅停用仍会留下旧宿主无法识别的权限。回退版本不能改为任意联网或文件读写。
- 实现：新增联网与偏好权限/effect、原生域名授权与活动版本复核、网络取消和私有偏好原子更新；UI 网络 16 次、设置 64 次独立计数。UI 参数合并与提交严格校验；普通工具也拒绝整体参数键数超限，模型提示词与文本创建不再截断，文本生成接入会话取消。HTTP 库的协议重试明确关闭；设置文件损坏或超限拒绝读取，但安全的普通文件仍可随卸载清理。
- 已验证：14 个前端插件测试文件、356 项通过；应用和测试 TypeScript 类型检查、修改文件 ESLint 通过。`cargo test --lib plugin_ --no-default-features --features tauri-channel-tests` 61 项通过，包含真实应用 capability 下的 MockRuntime 越权命令拒绝；默认特性 `cargo check` 通过。新增 Rust 文件与注册表定向 rustfmt、diff 空白和 UTF-8 检查通过。
- 待完成：真实 WebView 安装/重新启用授权、关闭取消与重启后偏好恢复，以及实际公共 HTTPS API 的端到端验收；测试响应读取使用本地 HTTP fixture，DNS/IP 校验为原生单元回归，不替代真实 TLS、页面与系统生命周期验收。

## 2026-10-05 JavaScript 异步工具（代码与自动化验证完成）

上一轮已提交推送；按用户继续优化的指示，小步完善平台执行能力。

- 范围：`plugins/runtime.rs`（含原生回归）、插件开发规范和本计划，共 3 个文件，不新增依赖、权限或安全配置。
- 合同：同步工具兼容保留，工具也可返回 Promise 或使用 async/await，完成值仍为原有 JSON data/effect。只驱动本次 QuickJS 的微任务；宿主 I/O 仍走既有 effect 重入，不提供 fetch、计时器、模块导入或脱离调用的后台任务。
- 边界：同步脚本、异步微任务和结果序列化共用原有 2 秒期限、64 MiB 内存和输出上限。每个微任务之间主动检查期限和取消，拒绝未完成且无剩余任务的 Promise；更新、停用、卸载与修复注册表时，JavaScript 也接入现有调用取消守卫。
- 验收：多轮 await/Promise.all、异步 effect、同步兼容、拒绝/未完成/不可序列化/超限、同步与微任务死循环、取消和调用守卫回收；Rust test/check、前端插件兼容回归与文档合同检查。
- 实现：工具结果通过 Promise 等待完成后序列化；每次只推进一个微任务，并在任务之间检查取消和统一期限，避免短微任务无限排队绕过 JS 指令中断。JavaScript 和 Python 共用既有调用守卫；先登记守卫、再读取原生活动版本，取消登记与版本切换之间不留竞态。
- 已验证：Rust 运行时定向 19 项通过；完整插件 `cargo test --lib plugin_ --no-default-features --features tauri-channel-tests` 66 项通过；默认特性 `cargo check` 通过。前端执行、Manifest、UI 会话、独立窗口与安装 Store 共 245 项回归通过；定向 rustfmt、diff 空白和 UTF-8 检查通过。
- 未完成：模块导入、独立后台任务和自定义画布节点 HTML 不在本步范围；异步工具的真实桌面安装与交互仍待验收，上一轮 WebView/公共 HTTPS 端到端验收缺口保持开放。
- 回滚：恢复仅同步执行实现并重装同步工具 revision；使用 async 工具的插件须配套宿主升级，旧宿主会拒绝 Promise 返回值。

## 2026-10-05 取消、兼容与开发体验（代码完成，实机验收待补）

按用户确认的五项范围实施平台能力完善，不新增 npm/cargo 依赖，不修改 Tauri 安全配置。

- 取消：普通节点/工具复用画布派生守卫并监听 Store，UI 提交接入同一调用信号；项目、节点、canvas revision 或插件版本失效时取消模型、联网和原生 JS/Python。新增仅主窗口可调用的单次取消 IPC，保留取消先到的有界短期记录及原生并发限制；完成或失败后回收监听和资源。
- 兼容：API 1 保留，API 2 增加 `minHostVersion` / `requiredCapabilities`；安装、原生暂存、启用/回切和执行复核。`input.host` / `props.host` 提供版本、能力和额度，原生执行覆盖 Renderer 自报的 host 元数据。共享目录和额度以 `plugin-host.json` 为准，能力发现不代替权限授权。
- 降级边界：包含兼容声明的活动、上一版或暂存记录以原生 registry schema 2 保存，旧宿主拒绝整表，避免忽略新字段；没有这类记录时保存回 schema 1。新宿主能读两种格式，单个插件能力不兼容不触发注册表损坏修复。回退旧宿主前须在新宿主卸载含兼容声明的插件，不能只回滚代码或手工改表版本。
- 诊断：JS 源码单独以 `main.js` 编译，返回工具、阶段、512 字符内消息与最多 6 个源码位置；常见敏感标记、URL 和路径隐藏，不记录输入、源码或完整异常对象；异常属性读取服从原调用期限。
- 额度：普通节点/工具最多 32 个 effect，模型 4、网络 8、设置 16、资源读取 8、创建/导出 4、本地媒体 8；失败也计数，分类和总额度均检查。UI 沿用已有额度并从共享合同读取，不因支持异步而增加模型次数。
- 开发：SDK 复用宿主领域类型并生成便携声明；CLI 提供 init/sdk/check/build/watch，支持纯 JS 模块与 UI 单文件打包、类型/语法检查、包资源与 UI 摘要更新，不执行或自动安装作者代码。本地安装后可在当前面板重新载入同一目录，走原 stage/persist/activate 与授权流程；目录不持久化、ID 变更拒绝覆盖。
- 自动验证：18 个前端插件/画布守卫测试文件共 386 项通过；最后增加派生守卫直接取消的回归，并重新复核执行与 UI 会话。应用与测试 TypeScript 检查、修改 TS 文件 ESLint 通过。Rust 插件及真实 capability 的 MockRuntime 测试共 69 项通过，默认 `cargo check` 通过。CLI 初始化/导入打包/类型失败保护/UI 与资源摘要/非法包路径测试通过；实际进程验证源码变化后自动重建及 SIGINT 清理。
- 待完成：真实 WebView 的两种展示、原生授权、关闭/切项目取消、重启偏好与公共 HTTPS 端到端验收仍未进行；JS 行号指向打包后的 main.js，不提供 TypeScript source map。模块运行时导入、后台任务、自定义画布 HTML 不在本轮范围。

## 2026-10-05 监听构建恢复（完成）

- 范围：开发脚本、脚本回归与本计划，共 3 个文件，属于一次性修复，不新增依赖或权限。
- 行为：`watch` 首次构建失败仍进入监听，后续修正自动重建；防抖合并同批文件事件，清单内容未变时只跳过单独的清单事件，避免漏掉源码变化。构建失败继续保留上次有效产物。
- 验证：CLI 两项回归通过，包含真实子进程从损坏清单恢复、类型失败保护、源码与清单同时保存后重建及 SIGINT 清理；脚本语法检查与两份 JS 文件的 ESLint 推荐规则检查通过。
- 边界：仅构建开发目录，不自动安装或执行插件；桌面 WebView 与公共 HTTPS 验收缺口仍保留。

## 2026-10-05 桌面验收与入口标注（主要验收完成，授权交互待补）

- 验收使用独立应用标识和数据目录，以及临时 QuickJS 测试包；不配置模型凭据，不调用付费模型。已启动当前源码的真实桌面窗口并完成测试包安装，接受/拒绝授权弹窗的路径仍需独立确认。
- 插件详情的入口按每个工具实际声明的节点类型与位置组合展示并去重，例如「文本节点右键菜单、文本节点工具栏」；来源节点类型使用可读名称，混合自定义节点的插件同时列出节点选择器。保持原有样式和安装行为。
- 实机修复：opaque iframe 的 `'self'` 无法加载宿主引导脚本，改为每份文档生成随机 nonce，仅授权该引导脚本；保留 `allow-scripts` 沙箱、私有 UI 协议和禁止直连。Rust 错误字符串在统一调用入口转成 `Error`，保留已脱敏的工具、阶段和源码位置。启动加载同时接受 API v1/v2，避免重启时错误停用 API v2；仍经原生注册、摘要和兼容检查，不重新提交源码。
- 已验证：macOS 真实 WebView 的内嵌与独立界面正常加载；iframe 拒绝父页面、存储和原生 IPC，独立页面重开无旧标记、主窗口专用命令拒绝，两种界面均拒绝直接联网。宿主请求公共 HTTPS 返回 200；偏好写入、读取和应用重启后恢复，异步 QuickJS 写回、JS 阶段/源码位置与敏感内容隐藏通过。确认请求等待后分别关闭内嵌/原生界面，迟到结果未写入；原生窗口等待请求时经真实项目 Action 切换，窗口撤销，返回原项目复核输出保留基线。
- 自动验证：11 个相关测试文件共 327 项通过，覆盖安装管理、目录选择、UI 文档 nonce、bootstrap/会话/窗口、执行诊断、Manifest、Store 重启与开发脚本；应用与测试 TypeScript 检查及全部修改 TS 文件 ESLint 通过，脚本语法与 ESLint 推荐规则检查通过。
- 尚未完成：安装和重新启用虽成功，但原生授权弹窗的接受/拒绝交互未被自动化工具可靠捕获，不视为该路径通过；Windows/Linux 与发布包环境未进行本轮实机验收。临时包改用当前实际节点类型 `ai-text`，未扩大旧 `source-text` 的匹配范围。

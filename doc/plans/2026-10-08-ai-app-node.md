# AI 应用节点

## 范围与阶段

用户已确认三阶段方案，当前实施第一阶段，属于新增产品能力和可复用运行能力。只有内部 Agent/MCP 能创建 `ai-app`，用户可使用、保存应用状态、停止和删除；普通创建、复制、剪切复制、粘贴及模板插入入口拒绝生成新实例，项目加载、合法导入和历史恢复保留已有实例。

1. 第一阶段：自由 HTML/CSS、隔离 JavaScript、只读绑定资源、动作目录、无界面动作调用、显式保存状态/结果、项目恢复与版本保护。
2. 第二阶段：画布写入、结果节点、输出端口与撤销。
3. 第三阶段：模型/文件工具编排、内部 Agent 续作和状态迁移。

## 第一阶段实现边界

- 定义通过既有 `services/fs/projectFiles.ts` 写入不可变项目文件，保存相对路径、SHA-256 与字节数；节点和审计不保存源码。加载/执行前验证引用及内容，损坏时停止执行。
- 生成 JavaScript 只在可终止 Worker 中运行。第一方静态隔离页面负责经过清理的 HTML/CSS 和事件桥接；不直接执行模型提供的 DOM 脚本，不新增依赖、不调整 Tauri 安全配置或 IPC 权限。
- WebKit 的 opaque iframe 通过精确哈希信任固定 loader，再用此页 CSP meta 的 nonce 加载第一方 bootstrap；Tauri 全局 CSP 同时允许两处独立生成的 nonce，不使用会向 Worker 传播脚本信任的 `strict-dynamic`。监听消息和接收 AI 内容前再收紧为 `script-src 'none'`。nonce 不承担会话授权；真实 iframe Window、随机 sessionId 与运行身份负责通信授权。
- 持久定义/状态、临时 UI 会话、单次动作分别管理。首版动作只有只读计算，临时状态/结果不会自动写入 Store；用户点击宿主保存按钮或调用 `canvas_app_save_state` 才执行持久写入。
- 输入是当前项目内显式绑定的节点 ID。正文只返回有界画布输出，图片读取只接受绑定节点并复用文件服务；不开放任意路径、URL、网络、Store 或凭据。
- 代码升级、节点删除、项目切换撤销会话；动作读取和结果交付复核应用身份、代码摘要、资源快照与 canvas revision。宿主每次保存只提交一次历史，自己的提交完成后重建会话快照。
- 创建/更新/保存工具声明 `canvas_write`；定义查询和动作运行声明 `read`。Plan/B/C/MCP 继续由现有 Registry 与 Policy 执行，发现阶段不依赖真实 taskId。
- 无界面调用在隐藏隔离页面中执行同一动作，完成后释放 Worker。MCP 结束不影响已保存节点；不依赖外部客户端回调，不恢复在途动作，不自动重试。
- 图片通过 `resources.readImage` 读取有界栅格数据，较大图片通过 `ui.setImage` 挂载到应用内既有图片元素，不占用 HTML 字符串额度。停止、超时或上下文失效后禁用运行/保存，可重新加载。
- 当前项目的节点、撤销历史和消息引用在存储健康检查中按项目目录解析；无法确认项目或实时引用时停止扫描/清理，避免旧版定义在撤销前被当作孤儿移除。

## 文件范围

- 新增 `src/types/aiApp.ts`、`src/services/aiApps/` 定义校验/项目存储/运行时/创建保护，以及 `src/services/chat/tools/aiAppTools.ts`。
- 新增节点/弹窗组件和 `public/ai-app-host.html`、`public/ai-app-bootstrap.js`。
- 接入 `types/index.ts`、`components/Canvas.tsx`、`services/chat/tools/index.ts`；收敛 Store 新建、剪贴板和相关成功提示/剪切入口；历史增加应用字段。
- 既有项目文件服务补充有界图片读取；存储健康服务与设置界面补充当前项目实时相对引用解析。
- 添加定义、执行、策略/MCP、创建保护和组件定向测试；画布模块保留专项计划链接。

## 验收与回滚

验收：仅工具创建、代码快照验证、绑定范围、无界面动作、显式状态保存及撤销、MCP 发现/调用、项目/版本变化和关闭取消、恶意 DOM/网络/消息拒绝、死循环 Worker 超时。

实际验证（以 Tauri 桌面端为主）：

- `npm test -- --exclude '.planning/**'`：410 个测试文件、5573 项测试通过；最终启动策略调整后另跑 `aiAppSandbox.test.ts`，20 项通过。
- `npm run typecheck`、`npm run test:typecheck`、本阶段 TypeScript/JavaScript 文件 ESLint、bootstrap 语法、UTF-8 与差异空白检查通过。Vite 生产构建与 Tauri 内嵌生产资源的 debug 编译通过。
- macOS Tauri/WKWebView 开发模式实测通过：创建节点、原生定义落盘校验、读取绑定文本/图片、较大图片预览、显式保存后继续运行、关闭及完整重载后的状态恢复、无界面动作不自动保存、定义升级及死循环终止。
- macOS `tauri://localhost` 生产资源实测通过：opaque iframe 启动、Worker 初始化和动作返回；动态 `import(data:)` 被 CSP 拒绝，网络、IndexedDB 与 DOM API 不可用。开发模式同样复测通过。浏览器仅完成基础启动与交互检查，不替代桌面验收。
- 待补充验收：Windows/Linux 原生 WebView、真实外部 MCP 客户端端到端传输；MCP 工具发现与调用边界已由自动化测试覆盖。未执行签名安装包或发布。

回滚仅撤销本阶段源码与文档修改；不升级 IndexedDB schema，项目内新定义文件可保留，旧应用版本无法渲染 `ai-app` 时沿用节点错误占位，不运行代码。不删除既有用户数据、不改动生成的 ACL 文件。

## 状态

- 第一阶段：已实现，macOS 桌面核心验收通过；跨平台及外部 MCP 手工验收待补充。
- 第二、三阶段：待实施。

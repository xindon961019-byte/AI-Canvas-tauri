# 自动化测试与 CI 门禁 Implementation Plan

> 初始实施方案保留在下方；当前门禁以 `package.json` 和 `.github/workflows/ci.yml` 为准。最近复核：2026-10-08。

**Goal:** 为高风险 Agent、持久化、画布历史和项目恢复链路建立可重复的自动化回归测试，并阻止未通过质量检查的代码进入发布构建。

**Architecture:** 使用 Vitest 运行 TypeScript 单元与集成测试，使用 `fake-indexeddb` 在 Node 环境验证 IndexedDB schema 和升级行为。测试通过模块 mock 隔离 Tauri 文件系统、动画和网络副作用，不修改生产权限或持久化结构；GitHub Actions 分别执行前端质量检查与 Rust `cargo check`，Release 在质量任务通过后才启动多平台打包。前端必过门禁为 `npm run ci`：全量 lint、应用类型、测试类型、全量测试与生产构建。

**Tech Stack:** Vitest、fake-indexeddb、TypeScript、Zustand、IndexedDB、GitHub Actions、Cargo。

## 2026-10-08 自检与修复

本轮属于一次性 CI 回归修复，基于 `ebb2e584`，共修改 10 个文件。最新远端 Frontend quality 失败集中在 5 个测试文件的 48 条用例，Rust check 通过；不调整应用执行边界、依赖版本或质量门禁。

- 资产库 Hook 测试驱动保持 setter 身份稳定，避免反复触发加载；补齐真实路径归一化函数的 mock，并在用例前后清理模块级拖放占用状态。
- 文本缩略图测试补充窗口事件环境与监听清理；最近资源测试按直接打开文档预览的现行行为验收，保留项目归属、使用记录与关闭验证。
- 图片信息测试覆盖现行保存选项参数，将服务加载移到测试准备阶段，避免冷加载计入用例超时；插件监听测试区分 Windows 强制终止和 POSIX 正常退出语义。
- 三种翻译字典移除已无源码引用的四个旧词条；主应用 ESLint 排除独立宣传视频项目，不跳过主应用源码检查。

实际验证：`npm run check` 通过（lint、两套类型检查、402 个测试文件 / 5411 条测试全部通过）；`npx vite build --outDir <系统临时目录>` 与 `cargo check --lib` 通过；差异空白与严格 UTF-8 检查通过。生产构建仍有既存的无效动态导入警告，未在此次修复中调整模块边界。

验收限制：未推送或触发新的 GitHub CI，未执行桌面业务真机回归。回滚可整体撤回本批测试、字典、ESLint 配置与本文档的差异，不涉及持久化迁移或用户数据。

---

### Task 1: 测试运行器与环境

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

**Steps:**
1. 安装 `vitest` 与 `fake-indexeddb` 开发依赖。
2. 增加 `test`、`test:watch`、`test:typecheck` 和 `ci` 脚本。
3. 配置 Node 测试环境、统一 setup、mock 清理和单线程 IndexedDB 测试。
4. 运行空测试配置，确认测试发现和失败退出码正常。

### Task 2: Agent 安全边界

**Files:**
- Create: `tests/services/chat/policyEngine.test.ts`
- Create: `tests/services/chat/agentToolSchemas.test.ts`
- Create: `tests/services/chat/toolRegistry.test.ts`
- Create: `tests/services/chat/agentApproval.test.ts`

**Steps:**
1. 验证 B/C 模式与六类 effect 的固定权限矩阵。
2. 验证授权拒绝优先于模式自动执行。
3. 验证 required、unknown field、enum、长度、数值和数组限制。
4. 验证未注册/不可用工具被拒绝，合法调用通过准备阶段。
5. 验证审批通过、拒绝和中止不会绕过工具执行边界。

### Task 3: 持久化与画布事务

**Files:**
- Create: `tests/services/indexedDbService.test.ts`
- Create: `tests/store/history.test.ts`

**Steps:**
1. 验证全新数据库创建 v13 所需 object stores 和关键索引。
2. 构造旧版本数据库，升级后确认旧项目数据保留且 AgentTask/项目记忆 store 可用。
3. 验证批量删除只增加一次历史快照。
4. 验证一次 undo 恢复整批节点、边和分组。

### Task 4: 项目与任务恢复

**Files:**
- Create: `tests/store/projects.test.ts`
- Create: `tests/services/chat/agentTaskService.test.ts`
- Create: `tests/services/pollManager.test.ts`

**Steps:**
1. 验证项目切换先保存旧项目，再加载目标项目并清空画布历史。
2. 验证会话、AgentTask、项目记忆和待续生成任务只按目标项目加载。
3. 验证应用重启后运行中任务转为 paused、活动步骤回到 pending、旧审批过期。
4. 验证孤立 loading 节点转为可解释错误，过期待续记录被清理。

### Task 5: CI 与发布门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Steps:**
1. PR 和 master push 执行 npm clean install、typecheck、测试类型检查、test 和生产构建。
2. Windows job 执行 `cargo check --lib`。
3. Release 增加前端质量 job，publish 使用 `needs` 等待其通过。
4. 运行 YAML 静态复核，确认发布密钥只在 publish job 使用。

**检查范围：** 主应用 lint 排除已有独立依赖的 `promo-video/` 宣传视频子项目。该目录不受 Git 跟踪，本地扫描时会选择其旧版 TypeScript parser，触发 `scopeManager.addGlobals is not a function`；当前主应用解析器与 CI lint 可正常运行，不需要降级依赖或跳过主应用检查。

### Task 6: 完整验收

**Steps:**
1. 运行 `npm run test:typecheck`。
2. 运行 `npm run test`。
3. 运行 `npm run check`。
4. 运行 `npx vite build --outDir <系统临时目录>`。
5. 在 `src-tauri/` 运行 `cargo check --lib`。
6. 运行 `git diff --check` 和严格 UTF-8/乱码扫描。

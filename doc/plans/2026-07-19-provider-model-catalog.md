# 厂商连接与模型目录重构 Implementation Plan

> **For Codex:** 按阶段小步迁移，每阶段验证并提交；不删除旧通用模型字段，不改 Tauri 安全配置或 IndexedDB schema。

**Goal:** 将 API 凭据与模型选择分离，让用户按厂商添加连接、拉取目录并只启用真正需要的模型；画布、项目设置和对话助手统一消费用户启用的模型。

**Architecture:** 代码内置 `ProviderDefinition` 描述厂商凭据与目录能力，`ApiProviderConfig` 每个连接只保存一份凭据，`ProviderModelSelection` 保存不含密钥的模型选择。远程目录统一解析 OpenAI 兼容响应，无目录能力的厂商使用调用方提供的本地 manifest；旧 `generalModels` 渐进迁移并继续作为执行兼容层。

**Tech Stack:** React 19、TypeScript、Zustand、现有 Fetch API 与模型 Provider 服务。

---

## 范围与约束

- 覆盖 APIMart、火山方舟、RunningHub、GRSAI、即梦和自定义 OpenAI 兼容接口。
- APIMart、火山方舟和自定义接口优先请求 `/models`；远程失败时内置厂商可回退本地 manifest。
- RunningHub、GRSAI 和即梦使用本地 manifest，不把 RunningHub 资源列表误当标准模型目录。
- `selectedModels === undefined` 表示旧配置尚未选择；空数组表示用户明确未启用模型。
- API Key 只保存在 `config.providers`，不进入模型选择、日志、消息或任务元数据。
- 不新增依赖，不提升 IndexedDB schema 版本，不修改 `tauri.conf.json`。

### 阶段 1：目录类型、Adapter 与配置兼容

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/services/ai/providerCatalogService.ts`
- Modify: `src/store/store.config.ts`
- Create: `doc/plans/2026-07-19-provider-model-catalog.md`

**Steps:**
1. 定义厂商目录 Adapter、模型选择和连接扩展字段，保持新增字段可选。
2. 建立内置厂商 Registry，实现 OpenAI 兼容目录解析、模型类别推断、取消与安全错误。
3. 为无官方目录的厂商支持调用方本地 manifest，并允许远程目录失败后回退。
4. 增加连接保存/删除 Action；自定义连接同步兼容 `generalModels`。
5. 加载旧 `generalModels` 时按地址和 Key 分组迁移为自定义连接，保留旧字段和模型 ID。

### 阶段 2：API Key 设置页添加流程

**Files:**
- Create: `src/components/settings/ProviderConnectionDialog.tsx`
- Modify: `src/components/settings/ApiKeySettings.tsx`
- Modify: `src/styles/settings.css`

**Steps:**
1. 在 API Key 页标题右侧添加加号，打开厂商选择与连接配置弹窗。
2. 根据 Provider Definition 渲染凭据字段和即梦 OAuth 状态。
3. 拉取或读取模型目录，提供搜索、类别过滤、全选与逐项勾选。
4. 保存后仅在设置列表展示已接入厂商，支持编辑和删除。
5. 连接测试复用厂商配置，修正火山方舟与 RunningHub 的错误测试端点。

### 阶段 3：画布与项目设置模型过滤

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/components/settings/ProviderConnectionDialog.tsx`
- Modify: `src/components/nodes/shared/defaultModels.ts`
- Modify: `src/components/nodes/shared/ModelSelector.tsx`
- Modify: `src/components/ProjectSettingsPopover.tsx`

**Steps:**
1. 将完整模型目录缓存到厂商配置，重新编辑时按“内置目录、缓存目录、已选模型”顺序合并恢复。
2. 建立目录选择到既有 `ModelOption` 的统一映射，明确选择后仅显示勾选项。
3. 为每个厂商增加文本、图片、视频、音频分类可见性；全部关闭时从所有节点模型列表移除该厂商。
4. 自定义连接模型继续通过兼容 `generalModels` 出现在对应节点类型，并遵循厂商分类可见性。
5. 项目默认模型失效时显示“已隐藏”状态，不静默改写已保存配置。

### 阶段 4：对话与执行链统一解析

**Files:**
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/components/chat/ChatPanel.tsx`
- Modify: `src/services/ai/helpers.ts`
- Modify: `src/services/ai/assistantStream.ts`
- Modify: `src/services/ai/generationRuntime.ts`
- Modify: `src/services/chat/tools/mediaTools.ts`
- Modify: `src/components/nodes/shared/toolbar/presetAction.ts`

**Steps:**
1. 对话模型菜单仅展示用户启用且连接可用的模型。
2. 文本与媒体执行通过 `providerConfigId` 读取单份凭据，兼容旧模型内嵌字段。
3. 独立对话窗口快照仅传递执行所需配置，不输出或记录凭据。
4. 预设和 Agent 媒体工具使用相同的模型可用性判断。

### 阶段 5：端到端验证

1. 严格 UTF-8 解码并扫描常见乱码字符。
2. 运行 `npm run typecheck` 和改动文件定向 ESLint。
3. 运行 `git diff --check` 与临时目录生产构建。
4. 在桌面与窄窗口验证添加、编辑、删除、目录回退、搜索筛选和各模型入口。

## 完成记录

- 2026-07-19 完成阶段 1：厂商目录类型、Provider Definition Registry、OpenAI 兼容目录 Adapter、本地 manifest 回退、连接 Store Action 和旧通用模型兼容迁移。
- `npm run typecheck` 通过。
- 阶段 1 改动 TS 文件定向 ESLint 通过。
- `git diff --check` 通过。
- 阶段 1 文件严格 UTF-8 解码通过，未发现常见乱码序列。
- `npx vite build --outDir %TEMP%/ai-canvas-provider-catalog-build-20260719` 通过；仅有既有动态导入与 chunk 体积警告。
- 2026-07-19 完成阶段 2：API Key 标题加号、厂商选择、凭据配置、远程/本地模型目录、搜索分类勾选、编辑删除，以及 RunningHub 双 Key 与即梦 OAuth 兼容。
- `npm run typecheck` 与阶段 2 TSX 文件定向 ESLint 通过。
- `git diff --check` 与阶段 2 文件严格 UTF-8 解码通过。
- `npx vite build --outDir %TEMP%/ai-canvas-provider-settings-build-20260719` 通过；仅有既有动态导入与 chunk 体积警告。
- 在本地 Web 模式验证 1280×720 与 680×760 视口：厂商弹窗 Portal 层级、搜索、分类、勾选、自定义手动模型、RunningHub 双 Key、固定操作栏和内部滚动均正常；浏览器控制台无错误，未写入测试配置。
- 2026-07-19 完成阶段 3：完整模型目录本地缓存、节点模型白名单过滤、厂商分类可见性、RunningHub 模型 API 配置映射，以及项目默认模型隐藏状态。
- `npm run typecheck`、阶段 3 改动文件定向 ESLint 与 `git diff --check` 通过。
- 在本地 Web 模式验证 APIMart 仅展示 4 个已选图片模型；关闭图片分类后整个 APIMart 分组从生图节点移除。
- 阶段 3 厂商编辑弹窗在 1280×720 与 680×760 视口无横向溢出，浏览器控制台无 warning/error；测试连接与测试节点已清理。

## 2026-10-07：CCC 分组连接

- 范围：沿用现有连接、模型身份与 Rust 凭据存储，为 CCC 控制台的 8 个分组提供独立连接。新增连接使用唯一 ID；旧 `cccapi` 不自动归组。分组名称仅为非敏感配置，实际权限由 Key 的 `/v1/models` 返回值确定，不从渠道监控列表推断权限，不代用户修改远端 Key 分组。
- CCC 设置在同一页同时展示 8 组，每组独立填写 Key、勾选和拉取模型，一次保存全部组；不再通过下拉切换并覆盖当前 Key。内部每组仍为独立连接，已有配置复用原 ID；旧连接、重复分组及未知分组额外展示并保留，不自动合并。旧连接未显式选择模型时保留原启用语义，原图片协议默认值沿用已有兼容逻辑。模型在节点与对话菜单标注分组，选择后执行通过 `providerConfigId` 读取该连接凭据。分享不携带 Key 或凭据引用，导入保留分组并要求补填 Key；暂未填 Key 的连接仍可在设置中重新编辑。
- 各组显示对应模型族的预置目录，无需 Key；香蕉筛选 Gemini/Nano Banana 图片，官方 GPT 图片筛选 2/2.5 系列，两个自营图片组筛选 GPT 图片，国产文本筛选控制台列出的五个型号，GPT 文本与 Claude 分别筛选。预置仅为候选，明确标注未验证 Key 权限；两个自营图片组与 GPT 文本组的具体型号权限仍需 Key 验收。成功拉取只保留 Key 返回且匹配分组的条目，移除已消失条目并保留匹配用户元数据；未知分组与旧连接沿用 Key 目录，不猜预置映射。单组目录失败报错且保留该组预览，其他组不受影响。编辑某组 Key 仅取消该组的旧请求，保留各组模型与选择；目录刷新不影响其他组。保存先同步全部组，再一次提交配置与凭据；失败保留编辑内容供重试。空白组常驻展示，仅填写 Key 或选择模型后保存对应连接。
- 新分组保存默认接口地址；配置读取和保存时补齐旧 CCC 连接缺失的地址，保留自定义地址、Key 和模型身份。通用模型与助手共享连接解析，缺省地址沿用内置厂商定义，反推无需手填 CCC 地址；自定义连接缺少地址仍失败，不按模型名称或连接 ID 前缀猜厂商。
- 删除连接只清理该连接模型引用；其他分组与旧根连接引用保持独立。凭据沿用既有保存成功后清理的事务边界。
- CCC 图片生成在处理参考图或提交前检查本连接的 Key，缺失时明确提示对应分组；不会发送空 Key 或借用其他分组凭据。
- 官方依据：[API Key 控制台](https://cccapi.cn/keys)、[渠道状态](https://cccapi.cn/monitor)、[API 文档](https://cccapi.cn/legal/api-docs)。只读取分组名称与说明，不复制账号密钥；渠道能力与价格以服务端实时结果为准。
- 状态：完成。12 个定向测试文件共 272 项通过，覆盖多组 Key/勾选同时保留、一次保存和重新打开恢复、旧/重复/未知分组兼容、8 组远端混合目录过滤、单组失败与过期响应隔离、保存失败重试、同名模型独立身份、文本/图片/流式对话的 Key 路由、反推与对话的默认地址/空白地址/自定义地址、旧配置地址修复、缺失 Key 拦截、凭据恢复、配置分享与删除隔离；应用和测试类型检查、定向 ESLint、UTF-8 与差异检查通过。
- 界面验证：独立本地 Web 环境检查深浅主题下同页 8 组输入、两组测试值同时保留和各组模型勾选；未保存测试连接，未使用真实 Key 或调用付费生成。桌面原生凭据存储沿用现有实现，本阶段仅通过协议桩验证恢复隔离，未进行桌面真实 Key 验收。
- 回滚：撤回本阶段 UI、分组目录策略与标签变化；新增连接依然具有现有 `catalogId: cccapi`、模型和独立凭据身份，未知可选分组字段可忽略。不得删除或合并用户凭据，不改写旧连接 ID。

## 2026-10-09：CCC 统一管理入口

- 设置列表将所有 CCC 连接汇总为一张卡片，打开原有多分组编辑页；复制已保存配置与删除操作下沉到各组，删除前确认，只作用于该连接。已有连接 ID、Key 与模型引用不迁移、不合并。
- 节点与对话媒体目录只显示一个 CCC API 厂商分组，各模型继续标注组名并保留唯一 `general/` 引用；类别可见性仍按原连接判断，执行继续通过 `providerConfigId` 匹配 Key。
- 删除成功会清除对应草稿，常驻组保留空白输入；重新配置创建新连接，避免后续保存全部分组恢复已删除的身份。其他组的 Key、模型选择与未保存编辑保留；失败允许重试并丢弃已取消的目录响应。
- 定向验证：4 个测试文件共 122 项通过，覆盖单卡片汇总、多组编辑入口、指定组复制/删除与凭据恢复、删除后保存/重建、目录取消与失败重试、旧连接及类别过滤、同名模型身份和文本/图片 Key 路由；前端及测试类型检查、定向 ESLint 通过。
- 已在 Tauri 桌面调试环境核对设置单卡片汇总、同页分组与已有 Key 掩码恢复、内部复制/删除入口和图片节点的 CCC 目录聚合。未修改现有凭据、删除真实连接或调用付费生成；删除及凭据持久化由定向测试覆盖，未在真实凭据上演练。UTF-8 与差异检查通过。
- 回滚：撤回本批界面聚合、模型分组与测试文档补丁；配置和原生凭据仍为原来的独立连接，无数据迁移。

# 启动页最近使用资源实施计划

**目标**：项目列表下方展示最近使用资源，右上角整页进入全局资产库，提供“返回启动页”，保留项目列表状态。

**方案**：复用资产索引身份、IndexedDB metadata 和现有全屏媒体预览。通过 UI Store Action 记录主窗口资产预览、成功拖入画布的真实素材；扫描、取消拖拽和失败导入不计入使用。最多保留 50 条记录，首页展示 12 条；读取时检查目录关联和文件可用性，不在启动页扫描整个磁盘。

**技术栈**：React、Zustand、IndexedDB、既有文件服务和 UI Kit；不新增依赖、数据库版本或原生权限。

## 实施与验证

1. 在 `types/assetUsage.ts` 定义仅包含 assetId、usedAt 的记录；在 `indexedDbService.ts` 增加 metadata 事务读取和合并写入，避免并发覆盖。
2. 新增 `services/fs/recentAssets.ts`，只解析现有索引、检查当前目录授权范围和文件存在性；文件删除、权限失败、项目删除或目录取消关联均跳过展示。重命名在既有扫描更新身份后跟随索引新位置，不猜测同名文件。
3. 扩展 `store.ui.ts` 的记录 Action、运行期刷新标识和资产库打开请求；`AssetsPanel.tsx` 消费指定目录入口并在实际预览时记录使用。启动页采用 page 模式，无弹窗、遮罩和 portal；项目列表保留挂载但隐藏，返回后恢复搜索、滚动位置和焦点。原 modal/drawer 模式保持不变。
4. `useNodeCreation.ts` 在素材成功导入、原项目和节点仍匹配时记录源文件，失败和取消拖拽不写记录。
5. 新增 `components/assets/RecentAssetsSection.tsx`，挂载到 `ProjectLibraryModal.tsx` 的 page 展示中；保持新建项目首位、项目弹窗及其搜索语义。复用媒体预览，空状态显示已关联目录入口。
6. 回归入口：`tests/services/recentAssets.test.ts`、`tests/hooks/useNodeCreation.test.tsx`、`tests/components/recentAssetsSection.test.tsx`、既有启动页与资产面板测试。覆盖并发、重复使用、50/12 上限、失效资源、项目切换、空状态和入口选择。
7. 执行定向 Vitest、ESLint、应用及测试类型检查；核对明暗主题和真实媒体预览，说明不能覆盖的原生实机行为。

## 边界与回滚

- 最近记录不保存绝对路径，不冒充生成时间或扫描时间；只列出有真实使用记录的素材。
- 不改独立资源搜索窗口的播放方式；从该窗口成功拖入主画布的素材仍由统一落点记录。
- 保留现有“新建项目卡片首位”改动。撤销本次源码差异即可回滚；旧客户端忽略 metadata 中的最近使用记录，无须数据库降级。
- 状态：实现完成。图片预览及整个资源区按需加载，保留项目列表的轻量启动路径。

## 实际验证

- 最近资源、原生拖放落点、启动页、资产面板、IndexedDB 和资产信息 Store 共 101 项定向回归通过，覆盖无画布整页导航、返回列表、并发记录与资源失效；应用类型检查、定向 ESLint、UTF-8 和差异空白检查通过。
- 测试类型检查仍受 3 处既有问题影响：`HiddenFilmSet.tsx` 的 Timeout 类型、`assetImagePreview.test.tsx` 的 unknown/boolean 类型、`assetTextPreview.test.tsx` 的 props 断言；本次新增文件未报告类型错误。
- 使用独立浏览器测试数据与模拟文件服务验证空状态、无需画布整页进入全局资产、无弹窗遮罩、返回时保留项目搜索与最近记录、预览后刷新最近记录、重载保留 12 项记录、图片和视频的全屏信息面板、明暗主题及窄/宽窗口布局；原生磁盘权限和安装包环境仍需桌面实测。

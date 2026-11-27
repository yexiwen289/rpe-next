# VibePhi 知识库处理与关键决策

> 2026-11-27 整理。覆盖内置协议、工作区增量、AI 检索/写入、UI 增删改、术语自动注入，以及这些设计背后的取舍。

## 1. 总体结构

知识库分三层，互不混淆：

| 层 | 位置 | 作用 | 可写 |
|---|---|---|---|
| 内置基线 | `protocols/*.md`（打包进 `AGENT_SOURCE_DOCUMENTS`） | 只读事实源：协议、版式、设计知识、高级手法 | 否（通过本地副本编辑） |
| 工作区增量 | `knowledge.local.md` | AI 实战写入的补充知识；合并时优先于基线 | 是 |
| 可插拔文档 | `knowledge/**/*.md`、`protocols/*.local.md` | 用户/标签分类自建文档、基线副本 | 是（完整 CRUD） |

相关模块：

- `src/core/agent-knowledge.mjs`：解析、合并、检索、追加
- `src/core/agent-source.mjs`：内置文档白名单与读取
- `src/core/agent-terminology.mjs`：术语定义 + 指令自动注入
- `src/application/agent-editor.mjs`：`chart_knowledge` / `chart_knowledge_write` 两个 AI 工具
- `src/application/agent-roles.mjs`：各角色均挂载 `chart_knowledge`
- `src/ui/knowledge-panel.mjs`：知识库查看/编辑/新建/重命名/删除面板
- `protocols/CHART-DESIGN-KNOWLEDGE.zh-CN.md`：核心制谱知识基线
- `protocols/ADVANCED-CHART-TECHNIQUES.zh-CN.md`：11 条高级手法基线
- `src/ui/app.mjs`：挂载面板、菜单入口、右键反馈

## 2. 内置基线文档

`AGENT_SOURCE_DOCUMENTS` 当前包含 7 份：

1. `EDITOR-SKIN-PROTOCOL.zh-CN.md`
2. `MOD-PROTOCOL.zh-CN.md`
3. `GLOBAL-EVENTS-PROTOCOL.zh-CN.md`
4. `AI-AGENT-PROTOCOL.zh-CN.md`
5. `CHART-VERSION-CONTROL.zh-CN.md`
6. `CHART-DESIGN-KNOWLEDGE.zh-CN.md`
7. `ADVANCED-CHART-TECHNIQUES.zh-CN.md`

`AgentSourceReader` 只允许读取白名单路径，拒绝绝对路径、`..`、URL、非法字符；这让 AI 能查协议但不能任意读本地文件。

## 3. 解析与合并

`parseKnowledgeDocument(text)` 把 Markdown 拆成检索条目：

- 一级/二级标题 → 章节
- 三级标题 → 条目
- 行首 `**小节名**：` → 子条目（父级指向所属条目）
- `| N1 | ... |` 形式表格行 → 独立「检测项」条目（带 `code`）
- 标题中的编号前缀（如 `2.1`）被剥离，提升检索命中率
- 代码块用 fence 状态跳过标题解析

`mergeKnowledgeDocuments([baseline, local])` 的合并规则：

- 基线内部同名条目不去重（不同父级下允许重名）
- 增量与已有条目 key 相同 → **增量覆盖基线**
- key 优先用 `code`，否则用 `section::parent::title`

决策理由：AI 后来写入的实战知识应优先于通用基线；但基线自身的结构不能被增量抹掉。

## 4. 检索

`searchKnowledge(document, query, limit)`：

- `TOPIC_ALIASES` 提供主题别名，如 `纵连 ↔ jack / stream / trill`、`噪域 ↔ blockArea / 判定屏蔽 / 限制手位`、`倒打 ↔ reverse / 翻转`
- 命中标题、父级、章节、正文与别名后按相关性排序
- 返回限定条数（`limit` 默认 10，工具上限 20）

调用链：`chart_knowledge(query, limit)` → 读基线 + 读 `knowledge.local.md` → parse + merge → search。

`chart_knowledge` 是**只读工具**，无需审批；所有 AI 角色（规划/音频/制谱/视觉/审查/评审）都挂载它。

## 5. AI 写入

`chart_knowledge_write(section, title, body)`：

- 需要 `workspace`
- 只允许写 `knowledge.local.md`
- 默认 section 为「实战补充」
- 是 **edit 级工具**，执行前会走审批流程
- 追加格式由 `appendKnowledgeEntry` 生成，保留时间戳/来源语义

决策理由：AI 可积累经验，但不能污染只读基线；写入集中到一个文件，便于备份与审阅。

## 6. UI 面板（`知识库` 入口）

`mountKnowledgePanel` 提供：

- 左侧文档列表：本地增量知识库 + 7 份内置协议 + 工作区可插拔文档
- 预览 / 编辑双模式；编辑态显示脏标记
- 保存：本地文档直接写；基线文档写入 `protocols/<name>.local.md`，原文不动
- 搜索：逐行命中高亮 + 行号列表（最多显示 60 行）
- 工具栏：重新加载、保存、复制为可编辑、重命名、删除

### 可插拔与完整 CRUD

- `＋ 新建文档`：接受标签名或带路径的名称，写入 `knowledge/<name>.md`
- 侧栏自动扫描 `knowledge/`（递归）与 `protocols/` 的 `.md`
- `复制为可编辑`：把基线全文复制到 `.local.md` 后切换过去
- `重命名 / 删除`：调用工作区 `move` / `delete`，支持基线副本与自建文档
- `显示已隐藏按钮`（UI 编辑器）可恢复被隐藏的入口

决策理由：用户明确要求「可插拔、完整增删改，而不是仅增量」。因此从「基线只读 + 增量覆盖」升级为「基线只读但可整份复制编辑 + 任意工作区文档 CRUD」。

## 7. 术语自动注入

`src/core/agent-terminology.mjs` 定义 14 条术语：

- 高级 11 条：无判定线、零速音符、移位、仁王盾、快慢刀、垂判、锁手、天地、倒打、侧判、四合院
- 基础 5 条：纵连、噪域、红区、初见杀、采音

`augmentInstruction(text)` 在用户发送消息时扫描术语；命中则在指令末尾附「术语定义（自动识别）」。若指令已包含该定义块则跳过，避免重复。

谱面手法卡片（AI 输入区）点击后直接插入「术语 + 定义 + 请实际采用」，供写谱阶段使用。

决策理由：仅靠 AI 主动检索知识库可能漏掉用户口中的黑话；在入口处确定性注入定义，保证语义一致。

## 8. 高级手法知识库

`ADVANCED-CHART-TECHNIQUES.zh-CN.md` 收录用户提供的 11 条定义，含实现要点与限制：

- 并排高密纵联最多 5 排、最好 3 排（仁王盾）
- 垂判：在落点做判定线垂线，点线上任意位置可判定；可遮挡判定线
- 锁手：长条至多 5 个即强迫单手
- 四合院：四条判定线，建议垂判压制两条、红区糊两条，慎用

这份文档同时是「人类极限测试」的规则来源：测试会识别隐藏+噪域覆盖、旋转判定线或元数据声明的垂判场景，按垂判 lane 合并并发音符，避免误报。

决策理由：把社区术语固化为可检索、可执行的规则，而不是散落在提示词里；同一份定义同时服务 AI 与测试算法。

## 9. 工作区与持久化

- 桌面端：`AgentWorkspace` 桥接本地工作区文件
- 网页端：`AgentWorkspace.browser()` 用 IndexedDB 记录 `agent-files-v1:<id>:` 前缀
- 原生端支持 `stat/list/read/bytes/write/mkdir/move/delete/download/open`
- 知识库 UI 的 CRUD 与 AI 的写入共用同一工作区

决策理由：桌面/网页/APK 用同一套路径语义，避免平台分叉。

## 10. 关键决策汇总

| 决策 | 选择 | 理由 |
|---|---|---|
| 基线是否可写 | 否；用 `.local.md` 副本 | 保护上游署名与许可证，避免误改内置协议 |
| 增量优先级 | 增量覆盖基线 | 后来学到的实战知识更贴近当前工程 |
| AI 写入范围 | 仅 `knowledge.local.md` | 单点集中、易审阅、审批可控 |
| 知识组织方式 | 多文档 + 标签路径 | 用户要求按标签普遍分类，而非单一增量文件 |
| 术语处理 | 入口注入 + 卡片插入 | 避免 AI 漏检黑话，保证定义唯一来源 |
| 高级手法位置 | 独立文档而非塞进核心 | 可插拔、可单独更新，且便于测试读取 |
| 垂判语义 | 写入知识库并驱动测试算法 | 同一定义同时约束 AI 和自动判定，避免两套标准 |
| UI 编辑 | 图形化 CRUD、无配置文件 | 用户明确拒绝代码/配置文件 |
| 检索关键词 | 主题别名表 | 自然语言提问也能命中术语 |

## 11. 已知边界

- `chart_knowledge` 只检索核心基线 + `knowledge.local.md`，**不自动检索用户新建的任意文档**；新文档需通过知识库面板查看，或在指令中明确指定路径
- `chart_knowledge_write` 只追加到 `knowledge.local.md`，不会自动分类到标签文档
- 内置协议更新后，本地副本不会自动同步；需手动重新复制或比对
- 术语注入基于字符串匹配，多义词可能误命中（如「交互」在 `TOPIC_ALIASES` 中）

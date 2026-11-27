# VibePhi

Phigros 非官方制谱器。作者 **cmdysj**；本分支界面与交互由 **yexiwen289** 使用 **WorkBuddy** 在 cmdysj 重构版基础上二次重构而成。

> 谱面格式、编辑器核心与原项目归属仍归 **Re:PhiEdit（RPE）** 与 cmdysj 的重构版所有；原作者署名、版权与许可证保持不变。

- 桌面 / 网页 / Android（APK）三端可用
- 内置 **AI 制谱工作台**：自然语言改谱、工具调用、谱面体检、音频分析
- 内置 **知识库系统**：可检索制谱知识 + **AI 深度解包分析**（让 AI 真正读谱面，把经验写回知识库）
- 内置 **多 Agent 协同**：多对话并行、任务广播、评审团、概念碰撞、反向教练
- 计算密集部分走 **Worker + AssemblyScript WASM** 内核，主线程只做 UI

当前版本：**1.0.0**。原项目来源：[在线使用](https://kclg-ysj.github.io/vibephi/) · [源码](https://github.com/kclg-YSJ/vibephi)

---

## 快速开始

### 本地运行

需要 **Node.js 22+**（编辑器本身零运行时依赖，无需 `npm install`）：

```sh
npm start
```

默认打开 `http://127.0.0.1:4173`（可用 `RPE_PORT` 覆盖）。Windows 也可双击 `start.cmd`。

### 桌面版（Electron）

```sh
npm ci
npm run build:desktop
```

产物在 `release/`（打包脚本当前仅产出 Windows x64）。桌面版用原生文件存储，默认谱面库位于系统「文档」目录下的 `VibePhi/Library`，实际路径可在「设置 → 本地存储与外部备份」查看、打开与迁移；运行配置与加密密钥存在 `%APPDATA%\rpe-next-desktop`。桌面版与网页版谱面库**相互独立**（网页端是 IndexedDB），可用 PEZ 迁移项目。

### Android（APK）

```sh
node tools/build-apk.mjs
```

产物：`dist-apk/VibePhi-1.0.0-mobile.apk`（包名 `com.vibephi.app`，minSdk 29 / targetSdk 34）。构建机需要 JDK 17、build-tools `android-14`、platform `android-34`（脚本默认在 `E:/android-build` 下查找，可用 `ANDROID_BUILD_TOOLS` 覆盖）与 Python（用于把 dex 与 assets 写入 APK）。首次构建会自动生成签名密钥库。构建时会把 `.env` 中的 `RPE_GLM_API_KEY` / `RPE_SENSENOVA_API_KEY` 注入为 `rpe-env` meta，APK 装完即可直接对话。

---

## AI 制谱工作台

### 模型接入

内置三家供应商，均为 OpenAI 兼容协议：

| 供应商 | id | 接口地址 | 默认模型 |
|---|---|---|---|
| DeepSeek 官方 | `deepseek` | DeepSeek API | — |
| DeepSeek·中转 | `glm`（默认） | `https://xh.v1api.cc/v1` | `deepseek-v4.1-flash-1017` |
| 商汤 SenseNova | `sensenova` | `https://token.sensenova.cn/v1` | `sensenova-6.8-flash-lite` |
| 自定义 | 自定义 | 任意 OpenAI 兼容地址 | — |

密钥两种来源（任选其一）：项目根目录复制 `.env.example` 为 `.env` 填入 `RPE_GLM_API_KEY` / `RPE_SENSENOVA_API_KEY`（`.env` 已被忽略，不入库）；或在应用内「设置 → AI 供应商」填写（保存在本地偏好，桌面端系统加密存储）。**源码不含任何密钥。**

### 实际默认值

| 项 | 默认 |
|---|---|
| 权限档位 | `full`（完全访问） |
| 单次输出上限 | 16384 tokens |
| 单任务模型请求上限 | 128 轮 |
| 上下文预算 | 自动（模型上下文窗口的 65%） |
| 自动压缩上下文 | 开启 |
| 请求超时 | 300000 ms |
| 思考模式 | 关闭（可开） |

「设置 → AI 供应商」可改为逐次批准 / 仅批准危险操作 / 只读。

### 工具目录

Agent 可调用 **53 个原生工具**，全部走原生校验与撤销栈：

- **谱面读写**：`chart_read`、`chart_query`、`chart_insights`、`chart_patch`、`chart_transform`、`chart_generate`、`chart_script`、`chart_templates`、`chart_tools`、`bpm_set`
- **编辑器控制**：`editor_context`、`editor_entities`、`editor_navigate`、`editor_source`、`editor_view`、`editor_capture`、`preview_capture`、`preview_check`、`ui_inspect`、`ui_action`
- **专用生成器**：`trajectory_generate`、`trajectory_presets`、`trajectory_split`、`curve_notes`、`text_fit`、`noise_circle`、`noise_fit`、`noise_track`、`event_shake`、`multi_line`、`line_manage`
- **音频**：`audio_analyze`、`audio_taps`、`audio_onsets_segment`、`audio_onsets_status`、`audio_detector`、`audio_separate`、`audio_source`、`audio_sources`
- **知识库**：`chart_knowledge`、`chart_knowledge_write`、`knowledge_ingest`、`knowledge_ingest_current`
- **资源与文件**：`assets_list`、`asset_read`、`asset_write`、`global_events`、`project_save`
- **其他**：`ask_user`、`diagnose`、`human_limits_check`、`history`、`web_search`、`web_fetch`

### 对话与上下文

多对话并行，每条对话独立上下文；上下文模式可选「全部 / 最近 N 轮 / 无历史」。支持编辑历史消息重发（分支）、重试、任务中排队与插话、逐轮查看完整请求与返回、用量圆环与编辑器截图、通用脚本修改完整谱面副本。Agent 可只读检索打包进 `assets/agent-source.json` 的自身源码（上限 4000 文件 / 2400 万字符）核实实现，并直接调用曲线轨迹、文字拼合、噪域图案/追踪等原生工具。

### 多 Agent 协同

顶栏「AI 协同」入口：多对话并行执行、任务广播、评审团（同一任务并发发给多个模型并按具体度打分）、概念碰撞（两个机制辩手并行辩论后由合成 Agent 融合新机制，可选直接写入谱面）、反向教练（读取「人类极限测试」的失败报告自检并微调谱面）。

### 音频与采音

- **声部分离**：桌面端支持本机 Demucs 四/六声部分离、独立环境安装、缓存与取消；网页与桌面均可导入外部工具分离的声部并导出 WAV。
- **起音候选**：预览播放头起 10 秒的起音候选，绿色标记与波形对齐，仅预览不写入谱面；`audio_analyze` / `audio_taps` 共用同一检测服务。
- **Mapperatorinator**：预训练模型生成节奏草稿，支持 V32 / Mini、参考模式、难度、固定随机种子与谱面 BPM 上下文（桌面端）。

---

## 知识库系统

三层结构：

1. **内置基线**：8 份协议文档（见下方「协议文档」），只读。
2. **本地增量**：`knowledge.local.md`，AI 与 UI 都往这里追加。
3. **工作区可插拔**：任意路径的 `.md`，UI 支持新建、复制为可编辑、重命名、删除。

### 检索与术语

`searchKnowledge` 对合并后的文档做条目级匹配（返回命中条目与目录）；16 条制谱术语（纵连、采音、垂判、噪域、红区、初见杀、仁王盾、四合院等）会在构造 AI 指令时自动注入定义。

### 通用摄取

| 输入 | 处理 |
|---|---|
| 任意纯文本（`.md/.txt/.jsonl/.lrc/.log`） | 无标题时按段落/行自动切分为可检索条目 |
| `chart.json` | 解析为谱面对象 → 分析 |
| `.pez` / `.zip` 工程包 | 安全解包（20000 文件 / 1GB / 单文件 512MB 上限）→ 定位谱面 → 分析 |
| 谱面库中的已有谱面 | `readProject` → 分析 |

### AI 深度解包分析

「解包分析」指的是**让 AI 真正分析谱面，把经验写进知识库**，而不是只跑统计规则：

1. **构建分析底稿**：全局统计（类型分布、平均与峰值 NPS、最小间隔、人类极限结论）+ 12 段分段音符样本（秒|拍|类型|X|判定线|上下层，含每段最小间隔与双押次数）+ 判定线 moveX/moveY/rotate 关键帧幅度 + 噪域起止拍布局。
2. **模型阅读**：以「Phigros 谱面分析师」角色调用当前配置的模型，明确要求不复述数字，而是总结结构叙事、采音与密度编排、音符形态、判定线运用、噪域使用、亮点与潜在问题，输出结构化条目 JSON。
3. **写入知识库**：AI 条目在前，规则统计作为「数据附录」附后，写入 `knowledge/经验/<名称>.md`。

三个入口：知识库面板「分析并写入」「从谱面库提取经验」，以及 AI 工具 `knowledge_ingest`；另有 `knowledge_ingest_current` 可直接分析当前打开的谱面。**模型未配置、请求失败或输出不可解析时自动降级为规则分析并标注模式，不会中断摄取。**

---

## 性能架构

- **Worker 化**：音频分析、flux 起音、段落检测、人类极限测试、体检报告、谱面统计全部在后台 Worker 计算，主线程只做 UI 更新；Worker 不可用时自动回退同步 JS。DDC 原生模型桥接仍在独立原生进程中。
- **WASM 内核**：AssemblyScript 实现最小间隔、逐秒桶计数、峰值计数、脉冲序列、BPM 自相关、并发峰值、长条峰值等统计内核，编译为 1KB 级 WASM 由 Worker 调用。
- **极限基准**（10 万音符 / 120 判定线 / 4000 红区，3 轮中位数）：整体 251.31ms → 205.29ms（**1.22×**），其中人类极限测试 57.78ms → 29.77ms（**1.94×**）。详见 `docs/BENCHMARK.md`。
- **极客 HUD**：`Ctrl+Shift+D` 呼出，显示实时 FPS、WASM 内存占用、Worker 队列长度。

---

## 编辑器功能

- **谱面库**：导入导出 JSON / PEZ，原 RPE 项目迁移，资源去重，恢复副本，版本化存储。
- **噪域**：多层级合成、反转规则、激活与预备闪烁；噪域皮肤（内置 NoiseField、Ocean，可导入含 `main.glsl` 的皮肤包）；噪域图案（文字/图片二值化为矩形噪域）；噪域追踪（把判定线或音符轨迹拟合成噪域运动事件）。
- **轨迹与曲线**：曲线轨迹生成（32 种预设 + 参数方程 + 极坐标 + 缓动拟合 + 整体/普通事件拆分）、曲线音符填充、判定线角度自动切线。
- **文字拼合**：把文字拟合为音符排列（骨架提取、统一笔画宽度、IoU 与连通部分覆盖度双阈值）。
- **多线编辑**：跨线多选、批量脚本、多线属性面板。
- **全局事件**：自定义事件类型与多列属性，模组可注册新类型。
- **可视化面板**：谱面指标、密度曲线、类型分布、诊断与体检报告。
- **版本控制**：提交图、差异、分支、标签、储藏、合并、重置。
- **UI 自定义**：设置内进入拖拽编辑模式，可重排顶栏/工具栏按钮、改背景与文字色与缩放、隐藏恢复、调整抽屉宽度；另有内置编辑器皮肤包系统。
- **人类极限测试**：一键检测单点并发击打、最小间隔与逐秒密度、长条锁手、跨手横跨大屏、长时间持续高密度（耐力），给出「可打 / 勉强 / 打不过来」结论与问题清单，可一键反馈给 AI 反向优化；含垂判（判定线被噪域覆盖或旋转近 90°）的识别与例外处理。
- **搜歌导入**：内置网易云音乐搜索与下载（搜索 / 下载音频与封面 / 取歌），导入后自动跑全曲预分析再进入谱面编辑。
- **皮肤与素材**：内置编辑器皮肤「墨线 Inkline」、噪域皮肤 NoiseField / Ocean、音符皮肤「梦之海 Sea of Dreams - Neo」，均可导入自定义包。
- **导入导出兼容**：官方 v3 JSON / ZIP / PEZ 导入，Next 与原 RPE 双格式导出，噪域与轨迹的版本兼容处理。

---

## 数据与隐私

谱面、媒体、热键、设置与自动备份保存在本机（网页端为同源本地存储，桌面端为所选原生谱面库），**没有分析埋点**。只有主动创建/加入联机房间时，当前谱面、编辑操作、昵称、鼠标位置与聊天才会发给指定协作服务器与获准参与者，媒体由房主手动共享。打开模组市场会向配置的服务请求目录与素材，检查更新会发送所选模组的 ID、版本与内容指纹。

外部模组导入须主动确认风险，导入后默认禁用；模组在页面内执行，拥有完整编辑器权限。紧急恢复键 `Ctrl+Alt+Shift+F11` 禁用全部模组，地址 `?mods=off` 或桌面参数 `--mods-off` 可跳过自动装载。内置模组：星航·谱面躲避、像素矿工、三维摄像机、Nyamon 模组市场。

清除网站数据可能删除谱面库与自动备份，请定期导出 PEZ 备份。

---

## 联机协作

维护者用独立服务器启动服务并配置公网入口：

```sh
npm ci --prefix collaboration-server
npm run build:collaboration-server   # Windows GUI：RPE-Collaboration-Server.exe
# 或无 GUI：cd collaboration-server && npm start
```

默认监听 `127.0.0.1:4182`（`RPE_COLLAB_PORT` / `RPE_COLLAB_HOST` 可改，GUI 里也可勾选允许局域网直连或启动 Cloudflare 隧道）。单服务最多 20 个房间、每房 12 人，房间只存内存、重启即清空，全员离线 30 分钟后回收。

编辑器「谱面工具 → 联机协作」填地址创建房间、复制邀请加入：各自时间与视野独立，横向时间滑条显示协作者位置，`/` 打开聊天；对象选中后申请编辑锁，批量操作原子提交，个人撤销不覆盖他人后续修改。公网使用 WSS，鼠标位置尝试 WebRTC 直连并自动回退。素材为手动共享。

---

## 开发与验证

```sh
npm test              # 856 个测试
npm run build         # 生成可本地运行的 dist/
npm run build:pages   # 静态站点（GitHub Pages）
npm run smoke-build   # 打包冒烟
npm run build:desktop # Electron 桌面包
npm run build:release # 发布包
npm run benchmark     # 极限性能基准
npm run build:wasm    # 重新编译 AssemblyScript 内核
```

CI（`.github/workflows`）：

- `pages.yml`：push 到 `main` 触发，跑 `npm test` 与协作服务器测试，构建静态站并冒烟校验后部署 GitHub Pages。
- `release-packages.yml`：手动触发，在 6 个平台组合（Windows/macOS/Linux × x64/arm64）构建发布包并逐包校验。
- `publish-release.yml`：手动触发，需填入构建批次与源码提交，校验产物哈希后创建草稿发布并发布为预发布。

### 协议文档

| 文档 | 用途 |
|---|---|
| `protocols/CHART-DESIGN-KNOWLEDGE.zh-CN.md` | 制谱设计知识库（核心） |
| `protocols/ADVANCED-CHART-TECHNIQUES.zh-CN.md` | 高级谱面手法 |
| `protocols/AI-AGENT-PROTOCOL.zh-CN.md` | AI 代理命令层、权限与扩展 |
| `protocols/AUDIO-SEPARATION.zh-CN.md` | 声部分离使用指南 |
| `protocols/CHART-VERSION-CONTROL.zh-CN.md` | 版本控制与存储格式 |
| `protocols/EDITOR-SKIN-PROTOCOL.zh-CN.md` | 编辑器皮肤 API 3 |
| `protocols/GLOBAL-EVENTS-PROTOCOL.zh-CN.md` | 全局事件协议 |
| `protocols/MOD-PROTOCOL.zh-CN.md` | 模组协议与开发指南 |

机器可读定义：`schemas/mod-v1.schema.json`、`schemas/editor-skin-v1.schema.json`、`schemas/editor-skin-components.v1.json`、`schemas/mod-api-v1.d.ts`。

开发文档：`docs/KNOWLEDGE-SYSTEM.md`（知识库体系与关键决策）、`docs/UPDATE-HISTORY.md`（完整更新历史）、`docs/BENCHMARK.md`（性能基准）——`docs/` 属于本地工作目录，不随仓库分发。

---

## 许可与来源

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE)，仅许可符合条款的非商业用途，商业用途需另行取得授权。它是源码可用许可，不是 OSI 定义的开源许可。再分发须保留许可证及 [NOTICE](NOTICE) 中的必需声明。

原 RPE 代码与素材是本次重构的基础，保留其来源及相应权利；独立第三方内容的原有权利与许可不因本项目许可而改变。本项目并非 Phigros 官方产品。

感谢 Stellate 提供噪域皮肤协议与 NoiseField、Ocean 内置噪域皮肤；感谢 -虹之梦- 提供内置音符皮肤「梦之海（Sea of Dreams - Neo）」；感谢 NyamonZone 提供 Nyamon 模组市场。

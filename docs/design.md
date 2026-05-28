# Travel Album Site V2 系统设计文档

本文档基于 [requirements.md](requirements.md) 编写，是项目的架构设计基线，覆盖整体架构、前后端、数据库、文件存储、上传流程、图片处理、视频处理、任务队列、错误处理与后续扩展。

设计原则与红线见 [`../CLAUDE.md`](../CLAUDE.md)。

---

## 1. 总体架构

### 1.1 架构图（逻辑分层）

```
┌──────────────────────────────────────────────────────────────┐
│ 前端 (React + TypeScript, SPA)                              │
│  - Trip 列表 / 创建 / 编辑                                  │
│  - 上传页（拖拽 + 批量）                                    │
│  - Gallery / 重复组 / 图片详情 / 视频片段 / 任务状态        │
└──────────────▲───────────────────────────────────────────────┘
               │ REST (JSON) + 静态文件
               │
┌──────────────┴───────────────────────────────────────────────┐
│ 后端 API 层 (Node.js + TypeScript + Express)                │
│  - Trip / Media / Duplicate / Video / Job 路由              │
│  - StorageProvider（本地 → S3 可替换）                      │
│  - 鉴权与校验（第一版仅基础校验，无多用户）                 │
└──────────────▲────────────────────────▲──────────────────────┘
               │                        │
               │ 同进程函数调用         │ DB
               │                        ▼
┌──────────────┴───────────┐   ┌────────────────────────────┐
│ Job Queue (内置)          │   │ SQLite (better-sqlite3)    │
│  - processing_jobs 表为   │   │  - trips / media_items     │
│    单一事实源             │   │  - media_analysis          │
│  - Worker 轮询拉取        │   │  - duplicate_groups(_items)│
│  - 支持并发限制 / 重试    │   │  - media_versions          │
└──────────────▲────────────┘   │  - video_segments          │
               │                │  - processing_jobs         │
               │                │  - ai_invocations          │
               ▼                └────────────────────────────┘
┌──────────────────────────────────────────────────────────────┐
│ Worker / 处理器（同进程模块，可后续拆出独立进程）            │
│  ImageWorker:  sharp / exif / pHash / blur / quality        │
│  VideoWorker:  ffprobe / ffmpeg / 抽帧 / 切片 / 黑场        │
│  DedupEngine:  hash / pHash 聚合 → duplicate_groups         │
│  QualitySelector: 评分排序 → 推荐保留                       │
│  AIProvider (可选): 图片精修 / 视频理解 / 剪辑方案          │
└──────────────▲───────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│ 文件存储 (StorageProvider)                                   │
│  本地磁盘：storage/{trips}/{tripId}/{originals|derived|…}   │
│  后续可切换至 S3，业务侧仅持有逻辑路径                       │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 部署形态

- 第一版：单进程 Node.js 服务，前端打包后由后端静态托管或独立 dev server。
- 数据库：SQLite 文件，位于 `data/app.db`。
- 文件：本地目录 `storage/`，按 Trip 分目录。
- Worker：与 API 同进程启动，使用 in-process queue 轮询 `processing_jobs` 表。**第一版必须按任务类型限制并发**：
  - 图片处理（thumbnail / metadata / hash / quality / enhance / dedup）：默认并发 **2**。
  - 视频处理（metadata / cover / proxy / segments / segment_analysis）：默认并发 **1**。
  - FFmpeg 任务（视频处理的实际执行单元）严禁无限并发；任何时刻系统中处于 `running` 状态的 FFmpeg 子进程不得超过 `VIDEO_WORKER_CONCURRENCY`。
  - AI 任务：独立通道，默认并发 1，受配额额外限制（见 §7.6）。
- 这些上限在 §11.1 配置层集中管理，并在 §9.2 调度策略中实现。
- 后续可扩展为：API 进程 + 独立 Worker 进程 + Postgres + S3 + Redis/BullMQ 队列。在迁移到独立 Worker 或 BullMQ 之前，本节的并发上限不得放开。

### 1.3 模块清单（与需求 §5 术语对齐）

| 模块 | 职责 | 第一版实现位置（建议） |
|---|---|---|
| `Upload_Manager` | 接收批量上传、写入原始文件、建 `media_items` 与初始 `processing_jobs` | `server/src/upload/` |
| `File_Classifier` | MIME + 扩展名 + 文件头判定 image / video / unknown | `server/src/classify/` |
| `Dedup_Engine` | 文件 hash + 感知 hash → `duplicate_groups` | `server/src/dedup/` |
| `Quality_Selector` | 综合评分排序，挑出推荐保留 | `server/src/quality/` |
| `ImageWorker` | 缩略图、EXIF、模糊、曝光、色彩、增强 | `server/src/workers/image/` |
| `VideoWorker` | 元数据、封面、抽帧、切片、片段评分 | `server/src/workers/video/` |
| `JobQueue` | 任务调度、重试、僵尸恢复 | `server/src/queue/` |
| `StorageProvider` | 文件读写抽象 | `server/src/storage/` |
| `AIProvider` | 可插拔 AI 调用（默认关闭） | `server/src/ai/` |

---

## 2. 前端设计

### 2.1 技术选型

- React + TypeScript。
- 路由：React Router。
- 数据获取：fetch / axios + SWR 或 React Query 任选其一（在阶段 1 决定，写入 design 修订）。
- 样式：CSS Modules 或 Tailwind（阶段 1 决定）。
- 状态：以服务端状态为主（缓存 + 轮询），少量客户端状态（上传队列、灯箱开关等）。

### 2.2 页面与路由

| 路由 | 页面 | 关键交互 |
|---|---|---|
| `/` | Trip 列表 | 卡片网格、按时间排序、点击进入详情 |
| `/trips/new` | 新建 Trip | 表单：标题（必填）、说明、地点、起止日期 |
| `/trips/:id` | Trip 详情（多 tab，P12 起默认 Curated） | 见 §2.5 |
| `/trips/:id/edit` | 编辑 Trip | 表单 |
| `/trips/:id/upload` | 上传页 | 拖拽 + 批量、单文件进度 |
| `/trips/:id/duplicates` | 重复组列表 | 组卡片、组内对比 |
| `/duplicate-groups/:id` | 重复组详情 | 切换推荐图、批量删除候选（二次确认） |
| `/media/:id` | 图片/视频详情 | 元数据、版本切换、增强 / AI 精修按钮 |
| `/videos/:id/segments` | 视频片段 | 片段列表、片段预览、保留/删除 |
| `/trips/:tripId/render` | 视频剪辑渲染（P11） | plan 预览、audio 选择、render 触发、job 轮询 |
| `/trips/:tripId/slideshow` | 幻灯片视频生成与历史（P12 新增） | 见 §2.5 |
| `/jobs` | 任务状态 | pending/running/failed 列表、重试 |

### 2.3 关键 UX 规则

1. 上传后立即跳转或就地展示占位卡片，不等待处理完成。
2. 处理中的媒体显示状态徽章（“处理中 / 失败 / 已增强 / 模糊 / 重复”）。
3. 推荐删除候选必须显示**推荐原因**（来自 `media_analysis.reason` 或 `duplicate_group_items.reason`）。
4. 任何删除前出现二次确认弹窗，明确“可恢复 / 永久删除”。
5. 大图懒加载，列表只加载缩略图。视频列表使用封面图，点击才加载播放器。
6. 任务状态采用轮询（默认 3–5s），后续可升级为 WebSocket / SSE。

### 2.4 上传组件行为

1. 选择文件后立即在前端做扩展名 / 大小预校验，过滤明显不支持的文件。
2. 每个文件一个并发槽，最大并发可配置（默认 3）。
3. 文件级失败独立重试，不影响其他文件。
4. 上传成功后立即从后端拿到 `mediaId`，挂上占位卡片，开始轮询处理状态。

### 2.5 Trip 详情页与精选 / 幻灯片入口（P12 新增）

requirements §15.5 + §15.6 要求 Trip 详情页默认展示精选集 + 可切换全部素材 + 提供幻灯片入口。详情页因此从单视图升级为多 tab + 操作面板：

#### 2.5.1 `/trips/:id` 页面结构

```
┌──────────────────────────────────────────────────────────────┐
│ Trip 标题 / 说明 / 计数                                       │
│ [Edit] [Upload] [Render video] [Curate album] [Slideshow]   │
├──────────────────────────────────────────────────────────────┤
│  [ Curated ] [ All Media ] [ Duplicates ]   ← Tab 切换       │
│   ▲ 默认                                                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ── 视图随 tab 切换 ──                                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 2.5.2 Curated tab（默认）

来源：`GET /api/trips/:tripId/curated`。

内容：
- 按场景组分块展示（每组一个 section header，含 `scene_group_id` + `member_count` + 时间范围 + 代表照片 thumbnail）。
- 每张精选照片显示：
  - 缩略图（如有 `ai_refined_param` 版本则有 "AI Refined" 徽章 + 可一键切换"原图 / AI 精修"双视图对比）。
  - `reason` 文本说明（来自 AI 或 user pin 的标注）。
  - `source` 徽章：`AI` / `User Pin`。
  - 操作按钮区分两种语义：
    - `source = 'AI'`：[Exclude] 按钮 → `POST /curated-overrides {decision: 'excluded'}`，把这张从精选移出。
    - `source = 'User Pin'`：[Clear pin] 按钮 → `DELETE /curated-overrides/:mediaId`，回到 AI 当前轮次决定（不再强制保留）。
    - 任何有 override 的行（kept 或 excluded）右上角额外显示 [Clear override] 小图标，明示"该决定来自用户手动，可清除"。
- 顶部按钮：
  - **[Curate album]**：调用 `POST /api/trips/:tripId/curate`，新增 round；触发后展示进度条 + job 轮询。
  - **[Re-curate (force)]**：等同于上面但 `force=true`，即使无新素材也新增 round。
  - **[Reset overrides]**：调用 `DELETE /api/trips/:tripId/curated-overrides`，回到纯 AI 推荐（带二次确认）。
  - **[Round selector]**：下拉选历史 round 看历史快照（只读，不再可 unpin 旧 round）。

空状态：
- 无 AI 配置：显示 "AI is not configured — falling back to quality_score baseline" + 仍然展示 Code 兜底版精选。
- 完全无素材：显示 "Upload photos to get started" + 链接到 `/trips/:id/upload`。
- AI 跑过但 0 入选：显示 "All photos were excluded — review and pin photos manually" + 自动切到 All Media tab。

#### 2.5.3 All Media tab

来源：`GET /api/trips/:tripId/curated?includeAll=true`（or 既有 trip media 列表 API）。

内容：
- 全部 `deleted_at IS NULL` 的素材网格视图（即 P3 起的既有 Gallery 体验）。
- 每张照片右上角根据其 `source` / `userDecision` 显示：
  - 精选中：[Pin] 按钮已激活 + 灰色背景。
  - 不在精选：[Pin] 按钮可点（写入 round=0 user_decision='kept'）。
  - User excluded：[Unpin] 按钮（清空 user_decision，回到 AI 决定）。
- 视频卡片照旧（视频不参与精选）。

#### 2.5.4 Duplicates tab

不变（既有 P5 体验）。

#### 2.5.5 `/trips/:tripId/slideshow` 页面

来源：`GET /api/trips/:tripId/slideshows`。

结构：
```
┌──────────────────────────────────────────────────────────────┐
│  Generate new slideshow                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Input photos: [Use current curated set] / [Custom]    │  │
│  │ Per-photo duration: [2.0s] slider                     │  │
│  │ Transition: ( xfade 0.3s | none )                     │  │
│  │ Resolution: ( 1920x1080 | 1280x720 | 4K )             │  │
│  │ Background music: ( None | <audio-library row> )      │  │
│  │ [Generate]                                            │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  History                                                     │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ 2026-05-28 14:30  ●success  3:24  [▶ Preview] [⬇ DL] │    │
│  │ 2026-05-27 22:10  ●failed   —     [! Show error]     │    │
│  │ 2026-05-26 09:00  ●success  2:48  [▶ Preview] [⬇ DL] │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

- "Use current curated set" 按 §8.7.1 默认逻辑。
- "Custom" 切换后展示 All Media 风格的多选 + 拖拽排序 widget（前端单独组件，复用 P11.T7 已有的 useJobPolling）。
- History 列表用 `GET /api/trips/:tripId/slideshows`，每行支持 inline `<video preload="metadata">` 预览 + 下载（`GET /api/slideshows/:renderId/download`）+ 失败行展开 `error_message`。
- 同时只允许一个 slideshow_render in-flight（前端检查 + 后端 service 层闸防双触发）。

#### 2.5.6 关键 UX 约束

1. 进入 `/trips/:id` 默认 Curated tab；URL fragment `?tab=all` / `?tab=duplicates` 可深链。
2. AI off 时 Curated tab 顶部显示橙色 banner："AI is disabled — showing quality-score baseline; configure AI for smarter selection"，但 tab 本身仍可用。
3. Curate album 与 Slideshow 触发都是异步 job，前端用 `useJobPolling`（P11.T7 复用）2s 轮询，终态停止 + unmount cleanup。
4. round 选择器只影响 Curated tab 的展示；切到 All Media tab 永远基于"最新状态"。
5. user_decision='excluded' 的照片在 Curated tab 不显示；要看就切到 All Media tab。

---

## 3. 后端设计

### 3.1 技术选型

- Node.js + TypeScript。
- HTTP 框架：Express（也可换为 Fastify，第一版以 Express 为准）。
- 数据库驱动：`better-sqlite3`（同步 API、事务方便）。
- 文件处理：`sharp`、`exifr`、`image-hash`（pHash/dHash）、`fluent-ffmpeg`（仅 Node 封装层） + 系统级 `ffmpeg` / `ffprobe` 二进制。
  - `fluent-ffmpeg` **不附带** `ffmpeg` / `ffprobe` 可执行文件，必须由部署环境提供。
  - 启动时检测：见 §8.4 启动检查。
  - 缺失时，视频任务路径必须以明确错误码失败（如 `FFMPEG_NOT_AVAILABLE`），**不得静默退化**，**也不得影响图片处理流程**。
- 上传：`multer` 或 `busboy` 做流式落盘。
- 校验：`zod` 做输入校验。
- 日志：`pino` 结构化日志。

### 3.2 目录结构（建议）

```
server/
  src/
    index.ts              # 启动入口
    config/               # 环境配置、阈值集中
    db/                   # 迁移、连接、Repository
    routes/               # Express 路由（trips/media/...）
    upload/               # Upload_Manager
    classify/             # File_Classifier
    dedup/                # Dedup_Engine
    quality/              # Quality_Selector
    workers/
      image/              # ImageWorker
      video/              # VideoWorker
    queue/                # JobQueue
    storage/              # StorageProvider
    ai/                   # AIProvider（默认 NoopProvider）
    utils/
  tests/
client/
  src/
    pages/
    components/
    api/
    hooks/
storage/                  # 运行时文件（gitignore）
data/                     # SQLite 文件（gitignore）
docs/
```

### 3.3 API 设计要点

- 路径与方法见 `requirements.md` §9。
- 错误响应统一格式：`{ "error": { "code": "...", "message": "...", "details": {...} } }`。
- 上传接口 `POST /api/trips/:tripId/media/upload`：
  - `multipart/form-data`，支持多文件字段。
  - 每个文件返回独立结果对象，包含 `mediaId`、`status`、`reason`（拒绝原因）。
  - 永远返回 200（除非整体校验失败），单文件错误体现在数组项中。
- 列表接口必须分页（`page` + `pageSize` 或 `cursor`），默认每页 50。
- 删除接口区分软删除（默认）与永久删除（`?permanent=true` 且需要二次确认 token）。
- 音频库 API（P11 新增，详见 requirements.md §9.7）：
  - `GET /api/audio-library`：返回音频库条目列表。
  - `POST /api/audio-library/upload`：`multipart/form-data` 上传单个音频，写入 `audio_library/user/`。
  - `POST /api/audio-library/import-url`：body 含 `{ url, name? }`；服务器端先下载到 `audio_library/imported/`，再写表；下载失败时回滚事务。
  - `DELETE /api/audio-library/:id`：仅允许删除用户上传 / 导入的条目；引用检查不通过时返回业务错误。
- 视频合成 API（P11 新增）：
  - `POST /api/videos/compose`：body 包含 `inputs: [{ mediaVersionId, order }]` + `audioPolicy`；返回 `compositionId` 与初始 `processing_job` 信息；实际渲染异步执行。
- **AI 精选 API（P12 新增）**：
  - `POST /api/trips/:tripId/curate`：手动触发精选 pipeline。body 可选 `{ force?: boolean }`（true 时即使没有新增素材也强制 re-curate，新增 round）。返回 `{ jobId, selectionRound }` — **`jobId` 是 `processing_jobs.id` of the `curation_run` orchestrator job**，同时充当本轮 run 的唯一标识（不引入独立 `curation_runs` 表）。前端用 `useJobPolling(jobId)` 轮询进度，子任务（L2 – L7）的 partial_failures 累积在该 row 的 `payload` JSON 字段供 UI 展示。
  - `GET /api/trips/:tripId/curated`：返回当前精选集（按 §7.8.4 合并公式计算）。可选 query：`round` 看历史轮次（缺省 = current），`includeAll=true` 把"未入选"的也返回以便 UI 显示 unpin 操作。返回 `{ currentRound, items: [{ mediaId, sceneGroupId, reason, refinementParams, source: 'ai' | 'user_pin', userDecision }] }`。
  - `POST /api/trips/:tripId/curated-overrides`：body `{ mediaId, decision: 'kept' | 'excluded' }`。upsert 一行 `curated_selections` (selection_round=0, user_decision=decision)。前端 [Pin] / [Exclude] 按钮调用。
  - `DELETE /api/trips/:tripId/curated-overrides/:mediaId`：清空**单张** media 的 round=0 行，让该照片回到 AI 当前轮次决定（即取消单次 pin 或 unpin，不影响其他 override）。前端 [Clear override] 按钮调用 — UI 区分于 "Reset overrides"。
  - `DELETE /api/trips/:tripId/curated-overrides`：清空该 trip 的**全部** round=0 行（"Reset overrides"，整批回到纯 AI 推荐）；带二次确认。
  - 三个写 API 的语义层次：单张 POST（pin/unpin）→ 单张 DELETE（clear one）→ 整批 DELETE（reset all）。语义不冲突，前端按按钮触发不同 endpoint，不会出现"unpin 一张照片导致清空整 trip"的错觉。
  - `GET /api/trips/:tripId/scene-groups?round=N`：列出第 N 轮的全部场景组与组成员（让用户能看到 AI 把哪些照片归到一起）；缺省 round = current。
- **幻灯片视频 API（P12 新增）**：
  - `POST /api/trips/:tripId/slideshow`：触发幻灯片渲染。body 可选 `{ mediaIds?: string[], perImageDurationSec?, transitionType?, transitionDurationSec?, outputResolution?, outputFps?, audioPolicy?, backgroundAudioId? }`；缺省按 §8.7.1 默认输入（`getCurrentCuratedMediaIds`）+ §8.7.2 默认参数。返回 `{ renderId, jobId }`，渲染异步执行。
  - `GET /api/trips/:tripId/slideshows`：列出该 trip 的全部 `slideshow_renders` 行（按 `created_at DESC`），每行含 status / 参数摘要 / 输出 mediaVersionId。
  - `GET /api/slideshows/:renderId`：单条详情，含完整 `input_media_ids` 数组 + 完整参数 + 输出 `media_versions` 关联。
  - `GET /api/slideshows/:renderId/download`：直接重定向到 `/storage/...` 下的 mp4 文件，并设置 `Content-Disposition: attachment`（让浏览器走下载而非预览）。404 当 status ≠ `success` 或 output 不存在。

所有 P12 API 遵守：
- 错误码用 `code` 字段，前端按 code 渲染本地化文案（如 `AI_NOT_CONFIGURED`、`AI_QUOTA_EXCEEDED`、`CURATION_IN_PROGRESS`、`SLIDESHOW_NO_INPUT`）。
- 异步任务返回 `jobId` 让前端走 `useJobPolling` 复用 P11.T7 已有 hook。
- 幻灯片下载用 `Content-Disposition: attachment` 避免与既有 `/storage/...` 预览路由冲突。

---

## 4. 数据库设计

### 4.1 引擎

- 第一版：SQLite，文件存放 `data/app.db`。
- 启用 `PRAGMA foreign_keys = ON`、`journal_mode = WAL`。
- 使用迁移脚本管理 schema（`server/src/db/migrations/000_init.sql` 等）。

### 4.2 表结构

字段定义以 `requirements.md` §8 为权威。下面只补充设计层面的约束与索引。

| 表 | 主要外键 | 关键索引 | 设计要点 |
|---|---|---|---|
| `trips` | `cover_media_id → media_items.id`（可空，ON DELETE SET NULL） | `created_at`、`deleted_at`、`last_upload_at`（P12，用于 idle scanner） | 软删除字段 `deleted_at`。**P12 新增 3 列**：`last_upload_at` TEXT NULL — **由 Upload API 在每个文件上传成功并写入 `media_items` 后立刻更新**（同一事务内），用于 curation idle scanner 去抖。**禁止**由后续 image/video 处理 worker 更新（缩略图 / hash / 模糊检测 / 视频转码等），否则 idle 触发语义会从"用户最后一次上传"漂移成"系统最后一次处理完成"，导致大量素材时 idle 永远不触发；`last_curation_at` TEXT NULL（每次 `curation_run` 任务进入 running 时由 service 层写入）；`curation_auto_enabled` INTEGER NOT NULL DEFAULT 1（trip 级开关，可让用户对单个 trip 关闭自动 curation 而不影响其他 trip；与全局 `CURATION_AUTO_TRIGGER_ENABLED` 是 AND 关系，任一为 false 都不自动触发） |
| `media_items` | `trip_id → trips.id`（ON DELETE RESTRICT，先处理） | `trip_id`、`file_hash`、`status`、`deleted_at` | `user_decision` 默认 `undecided` |
| `media_analysis` | `media_id → media_items.id`（ON DELETE CASCADE） | `media_id`（唯一） | 1:1 关系，`raw_result` 存 JSON。P12 新增列 `ai_blur_class` ∈ {`sharp`,`maybe_blurry`,`blurry`,`unknown`}，默认 `unknown`，独立于现有 `blur_class`（Code Laplacian），不互相覆盖 |
| `duplicate_groups` | `trip_id`, `recommended_media_id`（SET NULL） | `trip_id`、`group_type` | 删除推荐图前必须先 reset |
| `duplicate_group_items` | `group_id`（CASCADE）、`media_id`（CASCADE） | `(group_id, media_id)` 唯一 | 记录每张在组内的状态 |
| `media_versions` | `media_id`（CASCADE） | 见右栏：分类型部分唯一索引 | `version_type` 闭合枚举（详见 §4.2.1）。P12 起**废除全局 `(media_id, version_type)` UNIQUE**，按版本类型分两类：**Single-instance**（`thumbnail` / `preview` / `video_cover` / `video_proxy` / `metadata` / `video_optimized`）— 每个 media 至多一条 active 行，partial unique index `(media_id, version_type) WHERE is_active=1 AND deleted_at IS NULL`；**Multi-history**（`enhanced` / `ai_refined` / `ai_refined_param` / `edited` / `final_composition` / `slideshow`）— 允许同 media 多行历史，partial unique index `(media_id, version_type, params_hash) WHERE deleted_at IS NULL` 防止字节相同的重复入库。新增字段：`params_hash` TEXT NULL（SHA256 of params JSON，multi-history 行的去重键，single-instance 行可空）、`is_active` INTEGER DEFAULT 1（标记该行是否是当前活跃版本；multi-history 类型允许多行 is_active=1）、`deleted_at` TEXT NULL（软删除，与 media_items 保持一致）|
| `video_segments` | `media_id`（CASCADE） | `media_id`、`is_recommended` | 每段独立缩略图 / 预览 |
| `processing_jobs` | `media_id`（CASCADE 或 SET NULL，见下）、`trip_id`（SET NULL，P12 新增） | `status`、`job_type`、`started_at`、`(target_type, target_id)`、`(job_type, target_type, target_id, dedupe_key)` UNIQUE | 状态机表，详见 §9。P12 扩展为多 target：除 `media_id` 外新增 `trip_id`（trip 级任务）+ `target_type` ∈ {`media`,`trip`,`audio`,`composition`,`slideshow`,`scene_group`} + `target_id` TEXT（指向对应表主键）+ `payload` JSON（任务参数）+ `dedupe_key` TEXT（去重键，详见 §7.8.3 与 §9.1）。`target_type='scene_group'` 时 `target_id = scene_groups.id`（P12.T6 `scene_best_pick` worker 用到）；其余按 target_type 指向对应表主键。`media_id` 保留用于 media 级任务的向后兼容；trip / composition / slideshow / scene_group 级任务把 `media_id` 留空，由 `target_type` + `target_id` 标识目标 |
| `ai_invocations` | `media_id`（SET NULL）、`trip_id`（SET NULL，P12 新增）、`job_id`（SET NULL） | `created_at`、`(trip_id, request_type, target_type, target_id, input_hash)` UNIQUE WHERE status='success'（部分唯一索引） | 审计 + 成本缓存。P12 扩展：新增 `trip_id` / `target_type` ∈ {`media`,`trip`,`audio`,`composition`,`slideshow`,`scene_group`} / `target_id` TEXT / `request_type` 闭合枚举（值同 `AIRequestType`：`image_ai_refine` / `ai_caption` / `ai_classify` / `aesthetic_score` / `video_plan` / `ranking` / `scene_embedding` / `ai_blur_check` / `scene_best_pick` / `refinement_suggest`） / `input_hash` TEXT（输入素材 + 关键参数的 SHA256，用于成本缓存键，详见 §7.8.3）。`target_type='scene_group'` 时 `target_id` = `scene_groups.id`；其余按 target_type 指向对应表主键。P0–P11 既有行 migration 补齐 `target_type='media'` + `target_id = media_id` + `request_type = 'image_ai_refine'` + `input_hash = NULL`（无法事后回填的视为不参与缓存）|
| `audio_library` | 无强外键（与媒体解耦） | `source_type`、`is_default`、`is_user_uploaded` | 系统默认 + 用户上传 + URL 导入条目；删除时需先校验是否被进行中的渲染任务引用（详见 §8.5） |
| `video_compositions` | `trip_id`（SET NULL）、`output_media_version_id`（SET NULL） | `status`、`created_at` | 多视频合成历史；inputs 列表通过子表或 JSON 字段记录顺序敏感的剪辑视频引用 |
| `scene_groups` (P12) | `trip_id`（CASCADE）、`representative_media_id → media_items.id`（SET NULL） | `(trip_id, selection_round, group_index)` UNIQUE、`representative_media_id` | P12.T2 新增。一行 = 一个场景组（组本身的元信息，不含成员明细）。字段：`id` PK、`trip_id`、`selection_round`、`group_index`（INTEGER，组在该 round 内的序号，从 0 开始；与 `(trip_id, selection_round)` 一起构成稳定的组对外标识）、`captured_at_start`、`captured_at_end`、`gps_center_lat`、`gps_center_lon`、`representative_media_id`、`member_count`、`algorithm_version`、`created_at`。**组成员明细另存于 `scene_group_items` 表**（见下） |
| `scene_group_items` (P12) | `scene_group_id → scene_groups.id`（CASCADE）、`media_id → media_items.id`（CASCADE） | `(scene_group_id, media_id)` UNIQUE、`(scene_group_id, rank_in_group)` | P12.T2 新增。一行 = "某场景组的一个成员"。字段：`id` PK、`scene_group_id`、`media_id`、`selection_round`（冗余但便于 round 级过滤）、`group_score` real（组内代表性分数，AI embedding 给出的相似度或代码兜底的 quality_score）、`similarity_score` real（与组中心的相似度，可空）、`rank_in_group` INTEGER（组内排序，0 最高）、`reason` text、`created_at`。**L2 写入全部组成员**（无论是否最终入选 curated_selections），让前端"展开场景组"能看到完整成员列表 + AI 把它们归到一起的依据 |
| `curated_selections` (P12) | `trip_id`（CASCADE）、`media_id`（CASCADE）、`scene_group_id → scene_groups.id`（SET NULL） | `(trip_id, selection_round, media_id)` UNIQUE、`(trip_id, is_current, included)` | P12.T2 新增。一行 = "某 trip 第 N 轮精选中 mediaX 的决定"。字段：`id`、`trip_id`、`media_id`、`scene_group_id`、`selection_round`、`included`(0/1)、`is_current`(0/1)、`reason` text、`ai_confidence` real、`refinement_params` JSON、`user_decision` ∈ {`kept`,`excluded`,null}、`created_at`、`updated_at`。`round >= 1` 行：最新 AI 轮次 `is_current=1`，旧 AI 轮 0；`round = 0` 行：用户 pin/unpin 覆盖层，统一 `is_current=0`，不参与 AI 自动覆盖 |
| `slideshow_renders` (P12) | `trip_id`（CASCADE）、`output_media_version_id → media_versions.id`（SET NULL）、`background_audio_id → audio_library.id`（SET NULL） | `(trip_id, created_at DESC)`、`status` | P12.T2 新增。一行 = "某 trip 的一次幻灯片渲染历史"。每次用户点 "Generate slideshow" 都 **INSERT 新行**，不 UPSERT。字段：`id` PK、`trip_id`、`status` ∈ {`pending`,`running`,`success`,`failed`,`cancelled`}、`input_media_ids` JSON（顺序敏感数组）、`per_image_duration_sec`、`transition_type`、`transition_duration_sec`、`output_resolution`、`output_fps`、`audio_policy`、`background_audio_id`、`output_media_version_id`、`error_message`、`created_at`、`updated_at`、`deleted_at` TEXT NULL（软删除）。每行对应一个独立的 `media_versions(version_type='slideshow')` 行（INSERT not UPSERT，保留历史） |

#### 4.2.1 `media_versions.version_type` 闭合枚举与单 / 多版本分类

P12 修订后所有合法 `version_type` 值集中列在这里，是单一事实源（重新生成的 CHECK 约束以此为准；任何新增类型必须先改本表再写代码）：

| version_type | 是 Single-instance 还是 Multi-history | 引入阶段 | 说明 |
| --- | --- | --- | --- |
| `original` | Single-instance | P0 | 上传原文件元数据行（不一定有 `derived` 文件） |
| `thumbnail` | Single-instance | P3 | 列表缩略图 |
| `preview` | Single-instance | P3 | 灯箱 / 编辑器中等分辨率预览 |
| `metadata` | Single-instance | P3 | EXIF JSON（无文件，仅 params 字段）|
| `enhanced` | Multi-history | P8 | 一键增强结果（同一原图多次增强允许多行）|
| `ai_refined` | Multi-history | P10 | AI image-to-image 精修结果 |
| `ai_refined_param` | Multi-history | P12 | AI 参数化精修结果（每轮可能有新一行）|
| `video_cover` | Single-instance | P9 | 视频封面静帧 |
| `video_proxy` | Single-instance | P9 | 720p 视频代理（分析用）|
| `video_optimized` | Single-instance | P11 | 1080p 浏览器友好转码 |
| `edited` | Multi-history | P11 | 视频剪辑输出 |
| `final_composition` | Multi-history | P11 | 多视频合成输出 |
| `slideshow` | Multi-history | P12 | 幻灯片视频输出 |

约定：
- **Single-instance**：partial unique index `(media_id, version_type) WHERE is_active=1 AND deleted_at IS NULL`。同 media 同类型允许多行历史只在 `is_active=0` 或 `deleted_at` 非空时存在（用户主动重建时旧行不再 active）。
- **Multi-history**：partial unique index `(media_id, version_type, params_hash) WHERE deleted_at IS NULL`。`params_hash` 是 `params` JSON 字段规范化后的 SHA256；`is_active=1` 可以并存多行。
- 任何 type 都通过 `deleted_at IS NULL` 过滤软删除。
- migration 014→P12 时既有 single-instance 类型行 backfill `is_active=1` + `params_hash=NULL`；既有 multi-history 类型行也 backfill `is_active=1` + 按 params 字段算 `params_hash`（缺 params 的旧行用 `id` 兜底，保证 partial unique 不冲突）。

### 4.3 删除关联处理顺序

> **第一版策略**：软删除 + 恢复为主路径并率先实现；永久删除接口预留但**不在第一轮主流程启用**，必须等软删除、恢复、外键关联测试全部通过后才放开。详见 tasks.md 阶段 7。

软删除 `media_items`（推荐路径，第一轮主流程）：
1. 事务开始。
2. 把所有 `duplicate_groups.recommended_media_id = ?` 重置为 `NULL`，并标记该组需要重新评估。
3. 标记 `duplicate_group_items.user_decision = 'remove'`（或保留记录，但 group 用户视图忽略）。
4. `media_items.deleted_at = now()`，`status = 'deleted'`。
5. 事务提交。
6. 文件保留在磁盘（软删除阶段）。

恢复（与软删除对偶）：
1. 事务开始。
2. `media_items.deleted_at = NULL`，`status` 回到合理状态（默认 `processed`，若历史失败可置 `failed` 由用户重试）。
3. 该媒体重新参与 `duplicate_groups` 评估（但不自动覆盖已 `user_confirmed` 的组）。
4. 事务提交，文件本就在原位。

永久删除（**预留，不在第一轮主流程**）：
1. 前置条件：软删除 / 恢复 / 外键关联测试全部通过（tasks.md P7 中明确）。
2. 接口先以 `501 Not Implemented` 或 `403 Disabled` 占位，后续阶段单独放开。
3. 启用后路径：二次确认 token → 事务内 `DELETE FROM media_items WHERE id = ?`，依赖外键 `CASCADE` 级联清理 `media_analysis` / `duplicate_group_items` / `media_versions` / `video_segments`，`processing_jobs` 中相关任务先 `cancelled`。
4. 数据库事务成功后再删除文件；文件删除失败时数据库不能再回滚，必须写补偿日志，由定期任务清理孤儿。

### 4.4 软删除查询约定

所有列表查询默认带 `WHERE deleted_at IS NULL`。封装在 Repository 层，避免业务侧遗漏。

---

## 5. 文件存储设计

### 5.1 StorageProvider 抽象

```ts
interface StorageProvider {
  putOriginal(tripId, mediaId, buffer/stream): Promise<{ path }>
  putDerived(tripId, mediaId, kind, buffer): Promise<{ path }>
  read(path): Promise<Stream>
  remove(path): Promise<void>
  toPublicUrl(path): string  // 给前端拼地址
}
```

第一版实现 `LocalStorageProvider`，后续替换为 `S3StorageProvider` 不动业务代码。

### 5.2 目录布局

```
storage/
  trips/
    {tripId}/
      originals/
        {mediaId}.{ext}                # 原始文件，永不覆盖
      derived/
        {mediaId}/
          thumb.webp                    # 列表缩略图
          preview.webp                  # 详情预览
          enhanced.jpg                  # 一键增强结果（可多版本）
          ai_refined_{n}.jpg            # AI 精修
          video_cover.jpg               # 视频封面
          video_proxy.mp4               # 低清代理
          frames/{ts}.jpg               # 抽帧
          segments/{segmentId}.mp4      # 切片
          segments/{segmentId}_thumb.jpg
      outputs/
        edits/{editId}.mp4              # 单个视频的剪辑输出（含 audioPolicy 渲染结果）
        compositions/{compositionId}.mp4 # 多视频合成的最终视频（P11 新增）
        slideshows/{renderId}.mp4       # 幻灯片视频输出（P12 新增；trip 级输出，不挂在某张照片下）
  audio_library/
    system/
      {audioId}.{ext}                  # 系统内置默认音频；普通删除接口不可删
    user/
      {audioId}.{ext}                  # 用户上传的音频
    imported/
      {audioId}.{ext}                  # URL 导入音频的本地落盘副本（不依赖远程 URL 渲染）
```

### 5.3 文件命名与路径规则

1. 业务表只存逻辑路径（相对 `storage/`），不存绝对路径。
2. 派生文件以 `mediaId` 为目录前缀，便于级联清理。
3. `original_path` 保存原始扩展名，不做归一化（避免污染原文件）。
4. 缩略图统一 `webp`，预览图首选 `webp`，增强 / AI 输出按用户期望保留 `jpg`。

---

## 6. 上传流程

### 6.1 时序

```
Client                Upload API           DB                    Queue
  │  multipart upload    │                  │                     │
  │ ──────────────────▶  │                  │                     │
  │                      │ 1. classify      │                     │
  │                      │ 2. write original│                     │
  │                      │ 3. INSERT media  │                     │
  │                      │ ───────────────▶ │                     │
  │                      │ 4. INSERT job(s) │                     │
  │                      │ ───────────────▶ │                     │
  │                      │ 5. respond 200   │                     │
  │ ◀────────────────── │                  │                     │
  │                      │                  │  Worker poll ─────▶ │
  │ poll status (3–5s)   │                  │ ◀────── pull job    │
  │ ──────────────────▶  │                  │                     │
```

### 6.2 上传 API 行为

1. 接收 multipart，逐文件流式写入临时位置。
2. 调用 `File_Classifier` 判定 image / video / unknown。
3. unknown：建 `media_items` 但 `type = 'unknown'`，不建任何处理任务，前端显示原因。
4. 已知类型：移动到 `originals/`，写 `media_items`（`status = 'uploaded'`），按类型创建初始任务（图片：`thumbnail` 任务；视频：`video_metadata` 任务）。
5. 每个文件独立处理，单文件失败不回滚其他文件，错误以数组项返回。
6. 不计算 hash、不读 EXIF、不抽帧——这些全部交给 Worker。

### 6.3 文件类型判定策略

- 第一层：`Content-Type` 头。
- 第二层：扩展名白名单。
- 第三层：读取前若干字节判断 magic number（如 `ffd8ff` JPEG、`89504e47` PNG、`66747970` MP4 box）。
- 三层中任意一层判定为不支持就拒绝并解释原因。

---

## 7. 图片处理设计

### 7.1 图片处理任务链

每张图片上传后顺序跑（前一步成功才跑下一步，但每步独立任务可单独重试）：

1. `image_thumbnail`：sharp 生成 `thumb.webp`、`preview.webp`，记录 `width`/`height`。
2. `image_metadata`：`exifr` 读取 EXIF（拍摄时间、相机、镜头、ISO 等）。
3. `image_hash`：计算文件 hash（SHA256）+ pHash/dHash。
4. `image_dedup`：比对 `media_items.file_hash` 与 pHash 邻居，写入 `duplicate_groups` / `duplicate_group_items`。
5. `image_quality`：模糊（Laplacian variance）、曝光（直方图）、色彩（白平衡偏差）评分，写入 `media_analysis`，更新 `quality_score`。
6. `image_recommendation`：在受影响的 `duplicate_groups` 上重新跑 `Quality_Selector`，更新 `recommended_media_id`（**前提：组内未被用户手动确认**）。

任务粒度按需拆，但状态全记在 `processing_jobs`，便于重试和观察。

### 7.2 模糊检测

第一版：
- Laplacian variance（OpenCV 或纯 JS 实现）。
- 对图片缩放到统一短边（如 1024px）后再计算，避免分辨率影响。
- 阈值：`< T_blur` → `blurry`；`[T_blur, T_maybe)` → `maybe_blurry`；`>= T_maybe` → `clear`。
- 阈值在 config 中可调，不写死。

后续：人脸 / 主体区域局部清晰度、AI 视觉判断。

### 7.3 去重策略

1. 完全重复：`file_hash` 相等 → `group_type = 'exact'`，置信度 1.0。
2. 视觉近似：pHash / dHash 海明距离 ≤ `T_phash` → `group_type = 'similar'`，置信度按距离归一化。
3. 同一 Trip 内才聚合，不跨 Trip。
4. 一张图片可同时属于一个 exact 组和一个 similar 组（exact 优先）。
5. 用户确认（`duplicate_groups.user_confirmed = 1`）后，自动流程不再修改该组的 `recommended_media_id`。

### 7.4 质量评分

`quality_score = wR·R + wB·B + wE·E + wC·C` 形式，权重在 config 中：
- R：分辨率得分（取 min(width·height / baseline, 1)）。
- B：清晰度（Laplacian variance 归一化）。
- E：曝光（与理想直方图距离）。
- C：色彩（偏色惩罚）。

模糊判定为 `blurry` 的图片直接降权或扣分，但仍参与排序，避免“整组都模糊时无人可推”。
`reason` 字段以人话写入：例如 `"分辨率最高且清晰度评分最高"`。

### 7.5 一键增强

- 使用 sharp 做白平衡 / 曝光 / 对比度 / 锐化 / 降噪（轻量）。
- 输出 `derived/{mediaId}/enhanced.jpg`。
- 写 `media_versions(version_type='enhanced')`。
- 不动原图，不动其他派生文件。

### 7.6 AI 精修（默认关闭）

AI 精修有**两条并存路径**，由不同 request type 区分；用户在不同入口触发不同路径，互不干扰：

| 路径 | request_type | 出参 | version_type | 触发入口 | 引入阶段 |
| --- | --- | --- | --- | --- | --- |
| Image-to-image | `image_ai_refine` | AI 返回**精修后的图片字节** | `ai_refined` | 单图详情页"AI Refine"按钮 | P10 |
| JSON 参数 + sharp 执行 | `refinement_suggest` | AI 返回**精修参数 JSON** + Code（sharp）执行 | `ai_refined_param` | P12 精选 pipeline L5–L6 自动触发 | P12 |

共同约束（两条路径都遵守）：
- 通过 `AIProvider` 抽象，不直接依赖任何厂商 SDK。
- 调用前后写 `ai_invocations`（含模型、参数、状态、耗时、费用估算）。
- 原图与既有派生文件一律不被覆盖。
- 配置不齐全或 `AI_ENABLED=false` 时，路径降级：
  - `image_ai_refine`：前端按钮置灰提示 "AI 未配置"，不入队。
  - `refinement_suggest`：精选 pipeline L5 跳过；L7 把 `curated_selections.refinement_params` 置为 `null` 并**不生成** `ai_refined_param` 派生行。Curated tab 展示原图（thumbnail / preview）而不是任何 "AI Refined" 徽章。**严禁拷贝原图字节伪装成 `ai_refined_param`** — 那会让前端徽章撒谎（显示"AI 已精修"但其实是原图）+ 浪费磁盘 + 让用户对比双视图时困惑。
- 受 `AI_DAILY_LIMIT` / `AI_TRIP_LIMIT` 配额闸约束。

**JSON 参数路径的细则（P12）**：
- AI 返回 JSON 字段集合（详见 requirements §7.21.6）：`brightness` / `contrast` / `saturation` / `shadows` / `highlights` / `crop` / `rotation_deg` / `reason`。
- **两层边界**（明确避免 spec 与 runtime 冲突）：
  - **Schema 上限**（在 requirements §7.21.6 定义）：AI 返回值的最宽容上限，亮度/对比/饱和/阴影/高光 ∈ `[-1, 1]`、crop 子字段 ∈ `[0, 1]`、`rotation_deg ∈ [-180, 180]`。AI 出参越过此范围视为 schema 违规，整条建议被丢弃（fallback 到不精修）。
  - **Runtime 安全上限**（在本文 §11.1 `REFINEMENT_PARAM_*` 配置）：实际 sharp 执行允许的窄范围，例如默认 brightness ±0.4、contrast ±0.3、rotation ±15°，确保即使 AI 在 schema 内"激进"输出也不会让图片严重失真。
  - **执行规则**：Code 先验证 AI 出参在 Schema 上限内；然后用 Runtime 安全上限做 clamp（不抛错，按 clamp 后值应用）；最终参数记入 `media_versions.params` JSON 含 `requested_*`（AI 原始值）+ `applied_*`（clamp 后值）双字段，便于审计与回溯。
- sharp 执行链固定为：`extract`（crop）→ `rotate` → `modulate`（brightness / saturation）→ `linear`（contrast）→ `gamma`（shadows / highlights 模拟）→ JPEG q=85。
- 输出文件 `derived/{mediaId}/ai_refined_param.jpg`，并通过 sharp metadata 验证文件非空、维度合理后写入 `media_versions(version_type='ai_refined_param')`。
- `params` JSON 字段记录完整精修参数（供前端"详情"页展示 + 对比 + 重放）。
- 同一 `media_id` 多轮精选可以产生多个 `ai_refined_param` 行（不像 `edited` 那样 UPSERT），通过 `params.selection_round` 字段区分。

### 7.7 Trip 封面渐进策略

需求 §7.16 要求每个 Trip 自动选择封面图。考虑到不同阶段可用信息不同，第一版按阶段渐进实现，避免阻塞主流程：

| 阶段 | 数据可用性 | 封面策略 |
|---|---|---|
| 阶段 1（Trip CRUD 完成）| 没有任何媒体 / 缩略图 / 评分 | 使用**默认占位封面**（前端静态资源，例如 `client/public/placeholder-cover.svg`），后端 `cover_media_id` 为 `NULL` |
| 阶段 3（缩略图完成后）| 有缩略图、无 quality_score | 当 `cover_media_id IS NULL` 时，**临时取该 Trip 中按 `created_at` 升序的第一张已生成缩略图的图片**作为封面；该选择不写库，仅在响应层动态计算（避免与后续自动选择冲突） |
| 阶段 6（quality_score 完成后）| 有 quality_score | 启用**自动最佳封面选择**：取 quality_score 最高的图片，写入 `trips.cover_media_id` |
| 任意阶段 | 用户手动指定 | `POST /api/trips/:id/cover` 写入 `cover_media_id`，自动流程不得覆盖（除非用户重置）|

实现要点：
1. 后端 GET Trip 详情 / 列表时，按上表策略计算 `cover_url` 字段返回，便于前端无脑展示。
2. 阶段 3 的“临时封面”仅在 `cover_media_id IS NULL` 时生效，是只读派生值，不持久化，避免与阶段 6 的写库逻辑互相覆盖。
3. 视频也可作为封面来源（取视频封面帧）：第一版仅在 Trip 中没有任何图片时使用，作为兜底。
4. 没有任何素材 / 视频封面时，回到默认占位。

### 7.8 精选 pipeline 数据流（P12 新增）

requirements §7.21 定义了 AI 精选相册的功能；本节描述对应的数据流、模块边界、外部 ID 依赖。

#### 7.8.1 funnel 与数据流

```
                    ┌────────────────────────┐
   全部素材 →       │ L1  既有质量过滤        │  (P5 dedup + P6 blur/exposure/color
                    │                        │   已完成；本层是输入)
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L2  场景分组            │  Code (时间+GPS) + AI embedding
                    │  scene_groups +        │  request_type=scene_embedding
                    │  scene_group_items     │  job_type=scene_grouping
                    │  写库（含全部成员）     │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L3  AI 二次模糊         │  request_type=ai_blur_check
                    │  写 media_analysis     │  job_type=ai_blur_check
                    │  .ai_blur_class        │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L4  组内最佳挑选        │  request_type=scene_best_pick
                    │  每组 top-K 缩略图 → 1 │  job_type=scene_best_pick
                    │  写 curated_selections │  (输入 top-K，输出 best_media_id)
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L5  AI 精修建议         │  request_type=refinement_suggest
                    │  输出 JSON 参数         │  job_type=refinement_suggest
                    │  写 curated_selections │
                    │  .refinement_params    │
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L6  Code 应用精修       │  job_type=image_refine_param
                    │  sharp 执行             │  写 media_versions
                    │                        │   (version_type='ai_refined_param')
                    └────────────┬───────────┘
                                 ▼
                    ┌────────────────────────┐
                    │ L7  精选集 finalize     │  job_type=curation_finalize
                    │  写 curated_selections │  汇总 included=1 行
                    │  .included=1           │  + reason + ai_confidence
                    └────────────────────────┘
                                 ▼
                          前端 Curated tab
```

#### 7.8.2 触发模型

两种触发互不冲突：

- **手动**：`POST /api/trips/:tripId/curate` → 立即入队 orchestrator（job_type=`curation_run`）。返回 `{ jobId, selectionRound }`，其中 `jobId` 即 `curation_run` orchestrator job 的 `processing_jobs.id`（不引入独立 `curation_runs` 表），同时充当本轮 run 的唯一标识，前端用 `useJobPolling(jobId)` 轮询。详见 §3.3 API 定义。
- **自动 idle 触发**：
  - **Upload API（不是 worker）**在每个文件上传成功并写入 `media_items` 后同一事务内更新 `trips.last_upload_at = now()`。处理 worker（缩略图 / hash / 模糊检测 / 视频转码 / AI 等）**不允许**触碰这列 — 见 §4.2 trips 行的红线注释。idle 语义是"用户最后一次上传"，不是"系统最后一次处理完成"。
  - 周期 scanner 任务（每 `CURATION_IDLE_SCANNER_INTERVAL_MS`，默认 5 分钟）扫描：`SELECT FROM trips WHERE deleted_at IS NULL AND curation_auto_enabled = 1 AND last_upload_at IS NOT NULL AND last_upload_at < (now() - CURATION_IDLE_TIMEOUT_MS) AND (last_curation_at IS NULL OR last_curation_at < last_upload_at)`。
  - 命中行入队 `curation_run` 任务（`target_type='trip'` / `target_id=tripId` / `dedupe_key='{tripId}:r{newRound}'`），并把 `trips.last_curation_at = now()` 写入避免下一轮扫描重复入队。
  - **三层关停**：全局 env `CURATION_AUTO_TRIGGER_ENABLED=false` 关闭整个 scanner；trip 级 `trips.curation_auto_enabled = 0` 对单个 trip 跳过；运行时如果 `AI_ENABLED=false` 也仍然会跑（但走 Code 兜底路径，无 AI 调用，零成本）。

#### 7.8.3 Orchestrator 设计

`curation_run` 任务是一个**协调器**，本身不做计算，只负责按顺序入队 L2 – L7 的子任务，并在每一步完成后推进 round 状态：

```
curation_run(tripId, round)
  ├─ L2: enqueue scene_grouping(tripId, round)        wait → success (blocking)
  ├─ L3: foreach media in candidates:
  │       enqueue ai_blur_check(mediaId, round)       parallel, best-effort,
  │                                                   collect partial failures
  ├─ L4: foreach scene_group:
  │       enqueue scene_best_pick(groupId, round)     parallel, best-effort
  ├─ L5: foreach picked media:
  │       enqueue refinement_suggest(mediaId, round)  parallel, AI 配额闸,
  │                                                   best-effort
  ├─ L6: foreach refinement:
  │       enqueue image_refine_param(mediaId, round)  parallel, image channel,
  │                                                   best-effort
  └─ L7: enqueue curation_finalize(tripId, round)     blocking
```

容错策略：
- **L2 是阻塞 step**：场景分组必须完成才能进入 L3+（其他层都依赖 `scene_groups` 与 `scene_group_items` 行存在）。L2 必须**在单一事务内**同时写 `scene_groups` 行（每个组一行）+ `scene_group_items` 行（组内每个成员一行，含 `rank_in_group` / `group_score` / `reason`）。L2 自身失败 → 整个事务回滚，run 标 `failed`，已写的两表行一并消失，保证不残留半截组。
- **L3 / L4 / L5 / L6 是 best-effort step**：每层入队 N 个并行子任务，orchestrator 等所有子任务 settle（success / failed / cancelled / 超时）再推进。**单 job 失败不阻塞整个 run**，失败的 media 在该层"漏过"但 L7 仍然 finalize；orchestrator 在 `processing_jobs.payload` 里累积 `partial_failures: [{ step, mediaId, errorMessage }]`，前端可看到"本轮哪些照片漏过 AI 模糊检测 / 漏过最佳挑选 / 漏过精修建议"。
- **L7 是 blocking step**：finalize 把已完成层的结果合并成"本轮精选集"写入 `curated_selections`（`included=1` 行）+ 把旧 round 的 `is_current` 改 0、本 round 改 1。L7 失败 → run 标 `failed`，但已写入的中间结果（scene_groups / ai_blur_class / refinement_params）保留，供下次重跑跳过已完成部分。
- **AI 不可用降级**：L3 / L4 / L5 跳过；L7 基于 L2 输出 + `media_analysis.quality_score` 排序选出每组 top 1 写入 `curated_selections`。CLAUDE.md §2.8 兜底路径。
- **AI 部分可用降级**：L3 / L4 / L5 任一层全部子任务失败时，该层视为整体跳过；L7 用上一层（如 L4 失败时回退到 quality_score 排序）兜底，不让中间失败传播成 run 失败。
- **Idempotent**：同 round 重复入队受 `(job_type, target_type, target_id, dedupe_key)` UNIQUE 约束保护，重复入队返回既有非终态 jobId；不同 round 的 dedupe_key 不同（`{tripId}:r{round}:{...}`），所以 multi-round 工作流不会被卡住。详细去重模型见 §9.1。**AI 调用结果缓存**走 `ai_invocations` 表（§4.2），与 `processing_jobs` UNIQUE 约束解耦 — "本 trip 同一张照片同一 request_type 不重复花 AI 钱" 的保证由 ai_invocations 的 `(trip_id, request_type, target_type, target_id, input_hash)` UNIQUE 给。

#### 7.8.4 精选轮次（round）语义

`selection_round` 是单调递增整数，每次完整 `curation_run` 自增一次，记录在 `curated_selections.selection_round` 与 `media_versions.params.selection_round`。约定：

- **`round >= 1`**：AI 生成的轮次。每行带 `is_current` 标志，最新一轮 `is_current=1`，旧轮 `is_current=0`。
- **`round = 0`**：用户 override 的"虚拟轮次"，存放 pin / unpin 决定。`round=0` 行的 `is_current` 字段不参与"最新轮"语义，**统一约定 `round=0` 行的 `is_current=0`**（避免与 AI 轮次的 is_current 冲突）；它们是叠加层，不是替换层。
- 一张 `media_id` 在 trip 内最多 1 行 round=0（受 `(trip_id, selection_round, media_id) UNIQUE` 保护）；用户切换 pin/unpin 是 UPDATE 该行，不新插入。

**"当前精选集"合并公式**（前端 Curated tab 渲染 + curation_finalize 写入逻辑都按此公式）：

```
let aiCurrent = curated_selections
                  WHERE trip_id = T
                    AND selection_round = MAX(selection_round WHERE round >= 1)
                    AND is_current = 1
                    AND included = 1

let userPins = curated_selections
                  WHERE trip_id = T
                    AND selection_round = 0
                    AND user_decision = 'kept'

let userUnpins = curated_selections
                  WHERE trip_id = T
                    AND selection_round = 0
                    AND user_decision = 'excluded'

CurrentSelection(T) = (aiCurrent ∪ userPins) − userUnpins   (按 media_id 去重)
```

- "AI 选中 + 用户手动加入" 都进精选，**user_decision='excluded' 优先级最高**（即使 AI 选中也排除）。
- 同一 media_id 同时出现在 aiCurrent 与 userPins 时去重（按 media_id 取一行，UI 优先显示 user pin 的 reason）。
- re-curate 创建新 AI round 时 `aiCurrent` 自动切到新 round；用户 round=0 行不动，自然保留。

**implementation 注**：
- `curation_finalize` 任务写入新 AI round 时，**不**直接 INSERT 用户 pin/unpin 行；只 UPDATE 旧 AI round 的 `is_current=0`、INSERT 新 AI round 行（`is_current=1`）。round=0 行由前端 pin/unpin API 单独维护。
- Repository 层提供 `getCurrentCuratedMediaIds(tripId)` 直接返回合并后的精选 media_id 集合，前端无需关心 round 细节。
- 用户希望"忘掉某条 pin/unpin、回到纯 AI 推荐"时，提供一个"reset overrides" API：`DELETE FROM curated_selections WHERE trip_id=? AND selection_round=0`。

#### 7.8.5 不覆盖原则（红线）

- L2 – L7 全程不修改原图，不修改 P5/P6 写入的 `media_analysis` 主字段；只追加新列（`ai_blur_class`）或写新表（`scene_groups` / `scene_group_items` / `curated_selections`）或新 `media_versions` 行（`ai_refined_param`）。
- 用户 override 优先级高于 AI 推荐：re-curate 时 `curated_selections.user_decision IN ('kept', 'excluded')` 的行不被覆盖（CLAUDE.md §3.9）。
- 精选轮次历史不删除：旧轮次的 `curated_selections` 行只标 `is_current=0`，不 DELETE。

#### 7.8.6 V1 范围限定：场景组结构不可手动重排

requirements §16.7 "AI 场景分组误差" 的控制措施第 2 条提到 "用户可手动把 AI 误归到 A 组的照片移到 B 组"。**V1（P12）不实现此能力**，理由：

- P12 实现范围已经包含 4 个新表 + 多个 worker + AI request type + 前端 tab 改造，再加场景组手动重排会显著拉长交付。
- 场景组结构是 AI 算法的中间产物，用户**不需要直接编辑它**就能纠正精选结果。
- 已有纠错路径足够覆盖 §15.5 全部 10 条验收：
  - 用户对单张照片 **[Pin]** → `POST /curated-overrides {decision:'kept'}` 把误漏的照片加入精选。
  - 用户对单张照片 **[Exclude]** → `POST /curated-overrides {decision:'excluded'}` 把误选的照片移出精选。
  - 用户 **[Clear pin / Clear override]** → `DELETE /curated-overrides/:mediaId` 单张回到 AI 决定。
  - 用户 **[Reset overrides]** → `DELETE /curated-overrides` 整批回到 AI 决定。

V1 disposition：用户**只能编辑精选结果**（`curated_selections`），**不能编辑 AI 的场景分组结构**（`scene_groups` / `scene_group_items`）。未来如果有真实需求，新增：
- `PATCH /api/trips/:tripId/scene-groups/:groupId/items/:mediaId` body `{ targetSceneGroupId }` 端点。
- 配套 `scene_group_item_overrides` 表（或 `scene_group_items.user_override_group_id` 列）记录手动重排，re-curate 时不被 AI 覆盖。
- 该升级与 R-147（精选历史 / 多 edit 保留）共属"未来扩展点"，按真实需求驱动。

---

## 8. 视频处理设计

### 8.1 视频处理任务链

1. `video_metadata`：ffprobe 读时长 / 分辨率 / 帧率 / 码率 / 编码 / 音频。
2. `video_cover`：FFmpeg 抽取封面帧 → `derived/{mediaId}/video_cover.jpg`。
3. `video_proxy`（可选，第一版可选实现）：转码低清代理（如 720p、CRF 28）。
4. `video_keyframes`：固定间隔抽帧到 `frames/`。
5. `video_segments`：第一版用固定时长切片（例如 10s），后续接 PySceneDetect。
6. `video_segment_analysis`：每段计算 blur_score / stability_score / quality_score，识别黑场（`blackdetect`）、模糊片段、抖动片段，写 `video_segments`。

### 8.2 关键策略

1. 长视频先生成代理再做后续分析，避免反复读原片。
2. 切分失败兜底：退回到固定时间切片。
3. 黑场检测：FFmpeg `blackdetect` filter 输出时间区间。
4. 抖动检测：第一版可基于关键帧帧差或 `vidstabdetect`，后续优化。
5. 片段表 `video_segments` 中 `waste_type` 枚举：`black` / `blurry` / `unstable` / `silence` / `none`。

### 8.3 视频基础优化与剪辑（后续阶段）

- 优化：转码、统一分辨率/帧率、轻防抖、音量归一化，输出新文件，记 `media_versions`。
- 剪辑方案（render plan）：基于候选 `video_segments` 生成片段顺序、起止时间与目标总时长，存为 JSON 字段。
- 剪辑方案必须包含一个顶层字段 `audioPolicy`，描述音频处理策略，建议结构：

  ```jsonc
  {
    "audioPolicy": {
      "mode": "keep_original" | "remove_original" | "replace_with_default" | "replace_with_library_audio" | "mute",
      "audioLibraryId": "uuid-or-null",       // 仅 replace_with_* 模式需要
      "removeOriginalAudio": true,             // 与 mode 联动，便于 worker 直接读
      "normalizeVolume": true,
      "fadeInMs": 500,
      "fadeOutMs": 800,
      "loopToFit": true,                       // 音频不足目标时长时循环
      "trimToDuration": true                   // 音频超过目标时长时裁剪
    }
  }
  ```

- 渲染：FFmpeg concat / filter_complex 合成 → `outputs/edits/{editId}.mp4`，结果作为新的 `media_versions` 行（建议 `version_type='edited'` 或等价），**不覆盖原始视频，也不覆盖之前的 edit 输出**。
- 用户在手动编辑界面可以重新发起渲染并替换 `audioPolicy.audioLibraryId`，每次替换都产生新 edit 版本。
- AI 不可用时，使用规则引擎兜底（按 `quality_score` + 时长目标贪心选择）。

### 8.4 ffmpeg / ffprobe 启动检查

`fluent-ffmpeg` 仅是 Node 封装，不附带二进制；本系统强依赖宿主机上的 `ffmpeg` 与 `ffprobe`。

启动检查要求：
1. 服务启动阶段（API 进程启动后、开始接受 HTTP 请求前）执行一次探测：
   - 在 `PATH` 或 `FFMPEG_PATH` / `FFPROBE_PATH` 配置项中查找二进制。
   - 调用 `ffmpeg -version` / `ffprobe -version`，捕获版本号与失败信息。
2. 探测结果写入运行时状态：`{ ffmpegAvailable: boolean, ffprobeAvailable: boolean, version: string }`。
3. 缺失时的行为（**不退出进程**，避免影响图片流程）：
   - 启动日志输出明确警告，包含建议安装方式（如 `brew install ffmpeg`）。
   - 任何视频任务在出队执行前先检查该状态，不可用时立即标记 `failed`，`error_message` 使用错误码 `FFMPEG_NOT_AVAILABLE`，不进入实际执行。
   - 视频上传仍允许（保留原始视频），但前端在媒体卡片上显示“视频处理不可用”徽章，可点击查看原因。
   - 图片任务路径（thumbnail / hash / quality / dedup / enhance）**完全不受影响**。
4. 运维侧暴露 `GET /api/health`（最小实现）返回 `ffmpegAvailable` / `ffprobeAvailable`，便于诊断。
5. README、`.env.example` 必须明确写出该系统依赖（详见 P0.T1 / P0.T4 任务）。

### 8.5 音频库与音频处理（P11 新增）

#### 8.5.1 audio_library 表设计

第一版字段建议（与 requirements.md §8.10 对齐）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT (uuid) | 主键 |
| `name` | TEXT NOT NULL | 显示名称 |
| `source_type` | TEXT NOT NULL CHECK (`'system_default'`/`'upload'`/`'url_import'`) | 来源类型，闭合枚举 |
| `source_url` | TEXT | 来源 URL，仅 `url_import` 必填 |
| `storage_path` | TEXT NOT NULL | 本地存储相对路径 |
| `duration_ms` | INTEGER | 时长（毫秒） |
| `mime_type` | TEXT | MIME 类型 |
| `format` | TEXT | 容器 / 编码 |
| `file_size` | INTEGER | 文件大小（字节） |
| `is_default` | INTEGER NOT NULL DEFAULT 0 | 是否系统内置默认音频 |
| `is_user_uploaded` | INTEGER NOT NULL DEFAULT 0 | 是否用户上传 / 导入 |
| `metadata_json` | TEXT | 版权 / 来源说明（JSON）|
| `created_at` | TEXT NOT NULL | 创建时间 |
| `updated_at` | TEXT NOT NULL | 更新时间 |

索引建议：`source_type`、`is_default`、`is_user_uploaded`、`created_at`。

#### 8.5.2 音频文件存储

- 默认音频与用户音频物理目录分离（见 §5.2）：
  - 系统默认：`audio_library/system/{audioId}.{ext}`，普通删除接口不可删，避免渲染回退失败。
  - 用户上传：`audio_library/user/{audioId}.{ext}`。
  - URL 导入：`audio_library/imported/{audioId}.{ext}`（先下载到本地，再注册到表，渲染**不再依赖远程 URL**）。
- 业务表只存逻辑路径，`StorageProvider` 后续可平滑切换到 S3。
- URL 导入需要在下载阶段做：MIME / 扩展名白名单校验、大小上限、超时控制；下载失败 → 整个导入事务回滚，不留半成品 audio_library 行。

#### 8.5.3 ffmpeg 音频处理

- 替换配乐：先 demux 视频音轨（或忽略），再用 `-i video -i audio -map 0:v -map 1:a -shortest`（或带 filter_complex 的精确长度控制）重新 mux 输出。
- 去原声：`-an` 或 `-map 0:v -an` 输出视频 only / 静音轨。
- 音频长度不足：`-stream_loop -1` + 输出端裁剪到目标时长；或 filter_complex `aloop`。
- 音频长度过长：filter_complex `atrim=duration=X,asetpts=PTS-STARTPTS`。
- 淡入淡出：`afade=t=in:st=0:d=<ms>`、`afade=t=out:st=<endStart>:d=<ms>`。
- 音量归一化：`loudnorm`（EBU R128 标准）或 `volume` filter。
- 输出文件落到 `outputs/edits/{editId}.mp4`，写入新的 `media_versions` 行（`version_type='edited'`），**绝不覆盖原视频或既有 edit 版本**。

#### 8.5.4 删除保护

删除 `audio_library` 条目前必须：
1. 检查是否被 `video_compositions` 或正在排队 / 运行的渲染任务引用，若是则拒绝并提示原因；
2. 系统默认音频（`is_default=1`）走单独的管理路径，普通用户接口 `DELETE /api/audio-library/:id` 返回 403 / 业务错误码。

### 8.6 多视频合成（P11 新增）

#### 8.6.1 合成流程

1. 用户在前端选择多个已剪辑视频（来自 `media_versions(version_type='edited')` 或等价类型）。
2. 用户调整顺序，选择音频策略：
   - 保留各段音频（concat 时不动每段音轨）。
   - 统一替换为音频库某条音频（整段最终视频共享一个新音轨，原各段音轨被替换）。
   - 静音（输出无声）。
3. 后端创建 `video_compositions` 行，状态 `pending`，记录 inputs / 顺序 / `audioPolicy` / `audio_library_id`。
4. 渲染 worker 拉起任务：
   - 校验所有输入文件存在且可读。
   - 规格归一化：以第一段或全局配置为基准（统一分辨率 / 帧率 / 像素格式 / 音频采样率），其他段按需 transcode 到统一规格。
   - 用 FFmpeg `concat` demuxer 或 filter_complex 拼接视频流。
   - 音频按所选策略处理（保留 / 替换 / 静音），逻辑复用 §8.5.3。
   - 输出到 `outputs/compositions/{compositionId}.mp4`。
   - 写入新的 `media_versions` 行（建议 `version_type='final_composition'`），记 `video_compositions.output_media_version_id`。
5. 任务结束更新 `video_compositions.status`，失败时保留 `error_message`，**不修改任何输入剪辑视频或原视频**。

#### 8.6.2 异常输入处理

- 分辨率不同：在归一化阶段统一 scale + pad（或 crop），保证最终视频分辨率一致。
- 帧率不同：统一到目标帧率（建议 30fps，可配置）。
- 音频参数不同：统一采样率、声道数；保留各段音频策略下要在合并时插入 `aresample` filter。
- 输入文件缺失 / 损坏：任务直接 `failed`，error 信息指明哪一段缺失。

#### 8.6.3 不覆盖原则（红线）

- 多视频合成只读取输入剪辑视频，绝不修改、删除、覆盖它们。
- 多视频合成产生新文件 `outputs/compositions/{compositionId}.mp4` 和新的 `media_versions` 行；同一组输入可重复触发合成，每次都是独立的输出。

### 8.7 幻灯片视频（P12 新增）

requirements §7.22 定义了幻灯片视频的功能；本节描述渲染管线、ffmpeg 命令链与 P11 视频渲染基础设施的复用关系。

#### 8.7.1 输入与输出

- **输入**：一组图片 `media_items`。
  - **默认来源**：调用 Repository 层 `getCurrentCuratedMediaIds(tripId)`，该方法按 §7.8.4 的合并公式返回当前精选集：`(aiCurrent ∪ userPins) − userUnpins`。**禁止**在 worker 内直接查 `curated_selections.included=1`，否则会忽略用户的 unpin 决定 + 漏掉 round=0 的 pin。
  - **用户可覆盖**：通过 `POST /api/trips/:tripId/slideshow` 的 body `mediaIds` 字段显式传一组 media_id 数组（顺序敏感），完全旁路精选集逻辑；用于"我想用一组不在精选集里的照片做幻灯片"场景。
  - **顺序规则**：默认按 `media_items.captured_at` 升序（无 captured_at 时回退 `created_at`）；用户显式传 `mediaIds` 时按传入数组顺序。
- **可选音频**：从 `audio_library` 选一条（含系统默认 / 用户上传 / URL 导入）；或选择"静音"。
- **输出**（详细历史保留语义见 §8.7.5）：
  - 每次触发 INSERT 一行 `slideshow_renders`，拿到 `renderId`。
  - 输出文件落到 **trip 级 outputs 目录**：`storage/trips/{tripId}/outputs/slideshows/{renderId}.mp4`（与 P11 `outputs/edits/` 和 `outputs/compositions/` 同层级，详见 §5.2）。**不挂在某张照片的 derived/ 下**——幻灯片是 trip 级输出，第一张照片只是 cover 候选，不是文件的所有者；如果该照片被软删除 / 永久删除，幻灯片文件归属不会变得诡异。
  - 渲染成功后 INSERT（**不 UPSERT**）一行 `media_versions(version_type='slideshow')`；`media_id` 仍按需求挂到精选集第一张照片以方便前端 UI 关联（封面缩略图），但 `media_versions.params.storagePath` 指向 trip 级路径而非该照片的 derived 目录。
  - UPDATE `slideshow_renders.output_media_version_id` 完成关联。

#### 8.7.2 渲染参数（默认值见 §11.1）

| 参数 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `perImageDurationSec` | 2.0 | [1.0, 5.0] | 每张照片停留时长（含转场）|
| `transitionType` | `xfade` | `xfade` / `none` | 淡入淡出 / 硬切 |
| `transitionDurationSec` | 0.3 | [0, 1.0] | xfade 时长，0 等同 none |
| `outputResolution` | `1920x1080` | 1280x720 / 1920x1080 / 3840x2160 | 与 P11.T5 render 统一 |
| `outputFps` | 30 | 24 / 25 / 30 / 60 | |
| `audioPolicy` | `replace_with_library` | `replace_with_library` / `mute` | 复用 P11.T4 audioPolicy（`keep_original` 对图片无意义，禁用）|
| `backgroundAudioId` | null | 任意 audio_library.id | 与 audioPolicy 联动 |

#### 8.7.3 ffmpeg pipeline

复用 P11.T5 render worker 的 4-stage 框架，但替换 Stage 2 / Stage 3 为图片专属逻辑：

**Stage 1：plan + media 验证**
- 与 P11.T5 一致：trip 存在性、media 存在且非 soft-deleted、image MIME 校验。
- 计算总时长 = `N * perImageDurationSec`（N 张图片）。

**Stage 2：per-image 强归一化**

每张图片：
```
ffmpeg -loop 1 -t {perImageDurationSec} -i {originalPath} \
       -vf "scale={W}:{H}:force_original_aspect_ratio=decrease,
            pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,
            fps={outputFps},format=yuv420p" \
       -c:v libx264 -preset medium -crf 23 -movflags +faststart \
       -an \
       {tmp}/clip_{idx}.mp4
```

要点：
- `-loop 1 -t` 把单图变成视频流，时长精确控制。
- `scale+pad+force_original_aspect_ratio=decrease` 处理横竖屏混合的 letterbox / pillarbox。
- 复用 P11.T5 的 `libx264 / yuv420p / 30fps` 输出规格，保证 Stage 3 concat 兼容。
- `-an` 显式去音，因为图片本身无音轨；最终音轨在 Stage 4 注入。

**Stage 3：concat + xfade（如启用）**

- `transitionType='none'`：直接 concat demuxer `-c copy` 拼接（同 P11.T5 Stage 3）。
- `transitionType='xfade'`：用 filter_complex 串 xfade：
  ```
  ffmpeg -i clip_0.mp4 -i clip_1.mp4 -i clip_2.mp4 \
         -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.3:offset=1.7[v01];
                          [v01][2:v]xfade=transition=fade:duration=0.3:offset=3.4[vout]" \
         -map "[vout]" -c:v libx264 -preset medium -crf 23 \
         {tmp}/concat.mp4
  ```
  - `offset` = 累积时长 - transitionDurationSec
  - 注意 xfade 会让总时长比 `N * perImageDurationSec` 短 `(N-1) * transitionDurationSec` 秒，前端文案要清楚说明。

**Stage 4：audioPolicy 应用 + 最终封装**

- 复用 P11.T2 `prepareBackgroundMusic`（loop / atrim / afade / loudnorm）准备 audio 轨道，长度精确匹配 Stage 3 输出。
- `audioPolicy='mute'`：直接 `-an` 输出。
- `audioPolicy='replace_with_library'`：`ffmpeg -i concat.mp4 -i bgm.aac -c:v copy -c:a aac -shortest`。
- ffprobe 验证 → `storage.putOutput(overwrite=false, path='trips/{tripId}/outputs/slideshows/{renderId}.mp4')` → **INSERT**（不 UPSERT）`media_versions(version_type='slideshow', media_id=firstMediaId)`，`params.storagePath` 字段记录上述 trip 级路径 → UPDATE `slideshow_renders.output_media_version_id` + `status='success'`。
- 上述写库步骤必须在同一事务内（避免 media_versions 已插入但 slideshow_renders 还停在 running 的中间状态）。

#### 8.7.4 与 P11 render worker 的关系

幻灯片渲染**不复用** P11.T5 的 `video_render` job 类型 / `edit_plans` 表 / `videoRenderWorker.ts`：

- 新增独立 job type `slideshow_render`、独立 worker `slideshowRenderWorker.ts`、独立 route `POST /api/trips/:tripId/slideshow`。
- **复用** P11.T2 `audioProcessor.ts`（音频准备）、P11.T3 `audio_library` 表与服务、`storage.putDerived`、`media_versions` 写入、video 通道（共享 `VIDEO_WORKER_CONCURRENCY=1` 预算）。
- 不复用 `edit_plans` 表：幻灯片"plan"本身简单（图片列表 + 参数），直接放在 `processing_jobs.payload` JSON 字段即可，无需独立表。

#### 8.7.5 历史保留 + 不覆盖原则（红线）

requirements §7.22 / §15.6 显式要求"用户可以查看历史生成的幻灯片视频"。本设计采用**方案 A：保留历史**，每次生成都是新行，不 UPSERT 任何已有记录。

**`slideshow_renders` 表（§4.2 已新增）+ 输出文件命名**：
- 每次用户触发"Generate slideshow"，先 INSERT 一行 `slideshow_renders`（status=`pending`），拿到 `renderId`。
- 输出文件路径含 `renderId` + 落到 trip 级 outputs：`storage/trips/{tripId}/outputs/slideshows/{renderId}.mp4`（不是 `derived/{firstMediaId}/...`），多个历史文件并存不互相覆盖；幻灯片文件归属 trip 而非某张照片，照片删除不影响幻灯片存活。
- 渲染成功后 INSERT 一行新的 `media_versions(version_type='slideshow')`（**不 UPSERT**），把 `id` 写回 `slideshow_renders.output_media_version_id`。
- `media_versions.params` JSON 字段记录 `{ slideshowRenderId, inputMediaIds, perImageDurationSec, transitionType, transitionDurationSec, outputResolution, outputFps, audioPolicy, backgroundAudioId }` 全套审计。
- `slideshow` 属于 §4.2.1 闭合枚举中的 **Multi-history** 类，使用 partial unique index `(media_id, version_type, params_hash) WHERE deleted_at IS NULL` 作为唯一约束（详见 §4.2 `media_versions` 行与 §4.2.1 分类）。每次 render 都 **INSERT 新行**（不 UPSERT），`params_hash` 由 params JSON 规范化后取 SHA256。这是 §4.2.1 已经定死的方案，不留 migration 期临时决策余地。

**不覆盖红线**：
- Stage 2 / 3 / 4 全程在临时目录操作；最终 `storage.putOutput(overwrite=false)` 写到 `trips/{tripId}/outputs/slideshows/{renderId}.mp4`。同名冲突直接失败（renderId 是 UUID，碰撞概率为 0）。
- 原图字节不被读为可写句柄，永不修改（与 P11.T8 SHA256 验证同理）。
- 已有的历史 `slideshow-{oldRenderId}.mp4` 文件与 `media_versions` 行永不被删除或覆盖；用户在前端"幻灯片历史"列表能看到每一次生成 + 下载 + 重新触发新一轮渲染。
- 用户主动"删除某次历史幻灯片"（未来需求）：通过 soft-delete `slideshow_renders.deleted_at` + soft-delete 对应 `media_versions` 行；CLAUDE.md §2.4 红线不允许自动永久删除。

---

## 9. 任务队列设计

### 9.1 模型

- 单一事实源：`processing_jobs` 表。
- 状态机：`pending → running → success | failed`，`failed → retrying → running`，可 `cancelled`。
- 字段：`id, media_id, trip_id, target_type, target_id, dedupe_key, job_type, payload(JSON), status, progress, retry_count, error_message, started_at, finished_at, next_run_at, created_at, updated_at`。
- **多 target 模型（P12 扩展）**：早期 P0 – P11 假定每个任务都属于一张 `media_items`，因此只有 `media_id` 一列。P12 引入 trip 级 / composition 级 / slideshow 级任务（`curation_run` / `scene_grouping` / `slideshow_render` / 已有的 `video_render` / `video_composition`），单 `media_id` 列不足以表达任务目标。扩展规则：
  - `target_type` ∈ {`media`,`trip`,`audio`,`composition`,`slideshow`,`scene_group`}：闭合枚举，CHECK 约束。`scene_group` 对应 `scene_best_pick` worker（P12.T6），其余按表名映射。
  - `target_id` TEXT：指向对应表主键（`media_items.id` / `trips.id` / `audio_library.id` / `video_compositions.id` / `slideshow_renders.id`）。
  - `media_id` 与 `trip_id` 是显式 FK 列（便于直接 JOIN + ON DELETE 行为可控）；当 `target_type='media'` 时 `media_id IS NOT NULL`，`target_type='trip'` 时 `trip_id IS NOT NULL`，其余情况 `target_id` 必填、两个 FK 列可空。
  - 既有 media 级 job（P0 – P11）插入时统一设 `target_type='media'` + `target_id = media_id`；migration 一次性补齐。
  - 路由层 / repository 层提供 `findByTarget(targetType, targetId)` 检索 API，替代之前的 `findByMediaId`（保留为薄包装）。
- **去重键 `dedupe_key`（P12 引入）**：单独一列，配合 UNIQUE `(job_type, target_type, target_id, dedupe_key)` 用于"同一逻辑任务不重复入队"。**注意：这是入队幂等键，不是 AI 成本缓存**——AI 调用结果缓存由 §4.2 `ai_invocations` 表的 `(trip_id, request_type, target_type, target_id, input_hash)` 控制，与 `processing_jobs` 解耦。
  - 设计目的：P12 多轮精选场景下，同一 `(media_id, refinement_suggest)` 在第 1 轮和第 2 轮都需要入队，单纯 `(job_type, target_type, target_id)` UNIQUE 会卡住第 2 轮。`dedupe_key` 把 round 等"作用域"维度纳入幂等键，使 multi-round 工作流不被阻塞。
  - `dedupe_key` 列**强制 NOT NULL**（CHECK 约束 + 列定义 NOT NULL）。SQLite 多个 NULL 不冲突的语义会让 partial NULL 旁路 UNIQUE 约束 — 等于把"幂等保护"变成"看运气"。一律 NOT NULL，强制每个 enqueue 路径显式给出去重维度，要么有意义、要么用 UUID。
  - `dedupe_key` 命名规则（约定见 §7.8.3，每个 job_type 的具体格式）：
    - `curation_run`：`{tripId}:r{round}`
    - `scene_grouping`：`{tripId}:r{round}`
    - `ai_blur_check`：`{tripId}:r{round}:{mediaId}`
    - `scene_best_pick`：`{tripId}:r{round}:g{groupIndex}`
    - `refinement_suggest`：`{tripId}:r{round}:{mediaId}`
    - `image_refine_param`：`{tripId}:r{round}:{mediaId}`
    - `slideshow_render`：`{slideshowRenderId}`（每次新生成一个 UUID 永远唯一）
    - P0 – P11 既有 media 级 job 的 migration 补齐策略：**禁止留 NULL**。优先生成结构化 key（如 `{mediaId}:{jobType}` 或 `{mediaId}:{operationVersion}`，依据该 job_type 业务幂等需求决定）；确实不需要幂等保护的（如手动重试触发的 reprocess job）用 UUID 作为 dedupe_key，等同于"独一无二一次性"。
  - **重复入队语义**：service 层 enqueue 之前先 `SELECT FROM processing_jobs WHERE job_type=? AND target_type=? AND target_id=? AND dedupe_key=?`；若已有非终态行（`pending` / `running` / `retrying`）则返回既有 jobId；终态行（`success` / `failed` / `cancelled`）按"是否要重跑"决定 INSERT 新行（不同 round / 不同业务语义 → 不同 dedupe_key 自然不冲突）。
- `next_run_at` TEXT NULL：retry 退避时间锚点。`status='retrying'` 时不为空；scheduler 用 `next_run_at <= now()` 判定是否可重试。

允许的状态迁移（其他迁移视为非法）：

```
pending  → running, cancelled
running  → success, failed, cancelled
failed   → retrying, cancelled
retrying → running
```

### 9.2 调度

第一版：单进程内 Worker 池，按任务**类别**分组限并发，互不抢占。

- 三类独立通道（每类各自维护并发计数器）：
  - **图片通道**：`IMAGE_WORKER_CONCURRENCY`，默认 **2**。涵盖 `image_thumbnail / image_metadata / image_hash / image_dedup / image_quality / image_enhance / image_recommendation`。P12 新增：`image_refine_param`（sharp 参数化精修执行；§7.6 JSON 参数路径）、`scene_grouping`（纯 Code 时间+GPS 粗分组，无 AI 调用）。
  - **视频通道**：`VIDEO_WORKER_CONCURRENCY`，默认 **1**。涵盖 `video_metadata / video_cover / video_proxy / video_keyframes / video_segments / video_segment_analysis` 等所有调用 FFmpeg / ffprobe 的任务。系统范围内并行的 FFmpeg 子进程总数不得超过此值。P12 新增：`slideshow_render`（图片→视频幻灯片合成）。
  - **AI 通道**：`AI_WORKER_CONCURRENCY`，默认 **1**，并受日 / Trip 配额额外约束。P12 新增 4 类 AI request type 对应的 worker：`scene_embedding`（embedding 调用，作为 scene_grouping 的可选 enrichment）、`ai_blur_check`（AI 二次模糊检测）、`scene_best_pick`（场景内最佳挑选）、`refinement_suggest`（精修参数 JSON 建议）。
  - **协调器（不占通道）**：P12 新增 `curation_run` 是纯协调任务，不走 ffmpeg / sharp / AI，只负责按 §7.8.3 顺序入队子任务；它在 AI 通道分配槽位但 in-flight 时间几乎为零（每步入队 + 等待回写）。可选改进：单独 `orchestrator` 通道，V1 暂不引入。
- 拉取方式：
  - 轮询 SQL：`SELECT ... WHERE (status='pending' OR (status='retrying' AND next_run_at<=now)) AND job_type IN (<channel_types>) ORDER BY created_at LIMIT (channelCap - channelInFlight)`。注意最外层括号 — SQL 中 `AND` 优先级高于 `OR`，缺少括号会让 `job_type IN (...)` 只约束 `retrying` 分支，导致某个通道意外拉到其他通道的 `pending` 任务（V1 早期 SQL 笔误，P12 修正）。
  - 用 `UPDATE ... WHERE id=? AND status='pending'` 抢占，避免并发拉同一条。
- 任务执行统一封装：开始更新 `running` + `started_at`；成功更新 `success` + `finished_at`；失败写 `error_message` + 决定 `failed` / `retrying`。
- 视频任务出队前必须先检查 §8.4 的 ffmpeg 可用状态，不可用则直接 `failed` 不占用并发槽。
- 后续若迁移到 BullMQ / 独立 Worker 进程，三个通道映射到三个独立队列，并发上限继承本节定义。

### 9.3 重试与僵尸

- 失败重试：指数退避（如 30s / 2min / 10min），最多 3 次，超过转 `failed`，等待人工。
- 任务可手动重试：`POST /api/jobs/:id/retry` → 状态改回 `pending`、清错误消息、`retry_count` 归零或保留（设计层选择保留以便观察）。
- 僵尸恢复：Worker 启动时扫描 `running` 但 `started_at` 早于阈值（例如 30 分钟无心跳）的任务 → 标记 `failed` 并写 `error_message='zombie recovered'`，由用户决定重试。
- 任务粒度小：缩略图、hash、模糊各自一个任务，避免一次失败重跑全部。

### 9.4 与 Media 状态联动

- 任意活跃任务存在 → `media_items.status = 'processing'`。
- 全部关键任务 `success` → `processed`。
- 任一关键任务 `failed`（无法继续）→ `failed`，但不影响其他媒体。
- 关键任务定义在 config（图片：thumbnail / hash / quality；视频：metadata / cover）。

---

## 10. 错误处理

### 10.1 错误分级

1. **用户输入错误**（HTTP 400）：标题为空、文件类型不支持、确认 token 缺失等。
2. **业务规则错误**（HTTP 409）：删除推荐图未先重置、状态机非法迁移等。
3. **资源未找到**（HTTP 404）：trip / media / group / job 不存在或已软删。
4. **功能未启用**（HTTP 501 / 403）：永久删除接口在第一轮关闭、AI 未配置、ffmpeg 不可用时的视频专属功能。
5. **服务器错误**（HTTP 500）：依赖（FFmpeg / sharp / DB）异常。
6. **任务级错误**：不抛 HTTP，写入 `processing_jobs.error_message`，前端可见。

常见错误码（集中维护）：

| code | 含义 |
|---|---|
| `FFMPEG_NOT_AVAILABLE` | 系统未安装 ffmpeg/ffprobe，视频任务直接失败；图片不受影响 |
| `PERMANENT_DELETE_DISABLED` | 永久删除在第一版未启用 |
| `DUPLICATE_GROUP_RECOMMENDED` | 删除推荐图前未重置 |
| `AI_NOT_CONFIGURED` | AI 未启用或缺关键配置 |
| `AI_QUOTA_EXCEEDED` | 超出每日 / 每 Trip 配额 |
| `INVALID_STATE_TRANSITION` | 状态机非法迁移 |

### 10.2 统一错误响应

```json
{
  "error": {
    "code": "DUPLICATE_GROUP_RECOMMENDED",
    "message": "该图片是重复组的推荐保留图，请先重新选择推荐图后再删除。",
    "details": { "groupId": 123 }
  }
}
```

错误码用大写 + 下划线常量集中维护。

### 10.3 日志

- 结构化 JSON 日志。
- 关键字段：`requestId`、`tripId`、`mediaId`、`jobId`、`jobType`、`status`、`durationMs`。
- 错误日志包含错误码与堆栈，但脱敏文件路径外的敏感信息（GPS 等）。
- 任务日志单独输出，便于诊断。

### 10.4 前端错误体验

- 上传错误：单文件红色提示 + 重试按钮。
- 处理错误：媒体卡片显示“处理失败”徽章 + “重试”按钮（调用 `POST /api/jobs/:id/retry`）。
- 删除错误：弹窗显示具体原因（如外键冲突映射后的友好文案）。
- 永远不要在前端默默吞掉错误。

---

## 11. 配置与环境

### 11.1 配置项（集中在 `server/src/config/`）

- 阈值：`BLUR_THRESHOLD_BLURRY`、`BLUR_THRESHOLD_MAYBE`、`PHASH_DISTANCE_MAX`、`QUALITY_WEIGHTS_*`。
- 视频：`VIDEO_SEGMENT_DURATION`、`VIDEO_PROXY_HEIGHT`、`VIDEO_KEYFRAME_INTERVAL`、`BLACK_DETECT_DURATION`。
- 队列：`IMAGE_WORKER_CONCURRENCY`（默认 2）、`VIDEO_WORKER_CONCURRENCY`（默认 1）、`AI_WORKER_CONCURRENCY`（默认 1）、`JOB_RETRY_MAX`、`ZOMBIE_TIMEOUT_MS`。
- 存储：`STORAGE_DRIVER`（`local` / `s3`）、`STORAGE_LOCAL_ROOT`。
- 外部二进制：`FFMPEG_PATH`、`FFPROBE_PATH`（可选；未配置时从 `PATH` 查找）。
- AI：`AI_ENABLED`、`AI_PROVIDER`、`AI_DAILY_LIMIT`、`AI_TRIP_LIMIT`。
- 上传：`UPLOAD_MAX_FILE_SIZE`、`UPLOAD_ALLOWED_IMAGE_EXT`、`UPLOAD_ALLOWED_VIDEO_EXT`。
- 删除：`PERMANENT_DELETE_ENABLED`（默认 `false`，第一轮主流程关闭，等软删除 / 恢复 / 外键测试通过后再开启）。
- **P12 精选 pipeline**：
  - `CURATION_AUTO_TRIGGER_ENABLED`（默认 `true`）：上传 idle 后自动触发；`false` 时只允许手动触发。
  - `CURATION_IDLE_TIMEOUT_MS`（默认 `600000`，10 分钟）：上传完成后等多久才允许 auto-trigger。
  - `CURATION_IDLE_SCANNER_INTERVAL_MS`（默认 `300000`，5 分钟）：周期扫描 `trips.last_upload_at` 的间隔。
  - `SCENE_GROUPING_TIME_WINDOW_SEC`（默认 `300`，5 分钟）：Code 粗分组时间窗。
  - `SCENE_GROUPING_GPS_RADIUS_M`（默认 `50`）：Code 粗分组 GPS 半径（米）；无 GPS 的图片只按时间窗分组。
  - `SCENE_GROUPING_EMBEDDING_ENABLED`（默认 `true`）：是否在 Code 粗分组内做 AI embedding 细分。`AI_ENABLED=false` 时强制视为 false。
  - `SCENE_BEST_PICK_TOP_K`（默认 `5`）：每组送 AI 挑选的 top-K 缩略图数量。
  - `CURATION_REFINEMENT_ENABLED`（默认 `true`）：是否在 L5 / L6 跑精修建议 + sharp 执行。`false` 时精选集直接展示原图。
- **P12 幻灯片视频**：
  - `SLIDESHOW_DEFAULT_PER_IMAGE_DURATION_SEC`（默认 `2.0`）：每张照片停留时长。
  - `SLIDESHOW_DEFAULT_TRANSITION_TYPE`（默认 `xfade`）：`xfade` / `none`。
  - `SLIDESHOW_DEFAULT_TRANSITION_DURATION_SEC`（默认 `0.3`）：xfade 时长。
  - `SLIDESHOW_DEFAULT_RESOLUTION`（默认 `1920x1080`）。
  - `SLIDESHOW_DEFAULT_FPS`（默认 `30`）。
  - `SLIDESHOW_CRF`（默认 `23`，与 P11.T5 render 统一）。
  - `SLIDESHOW_PRESET`（默认 `medium`，libx264 preset）。
  - `SLIDESHOW_TIMEOUT_MS`（默认 `600000`，单 job 墙钟上限）。
- **P12 精修参数边界**（防御 AI 输出越界 — Runtime 安全上限，与 requirements §7.21.6 的 Schema 上限不是冲突而是分层）：
  - **语义**：requirements §7.21.6 定义的 `[-1, 1]` / `[-180, 180]` 等是 **Schema 上限**（AI 出参允许的最宽容范围；越过即 schema 违规丢弃）。本节定义的是 **Runtime 安全上限**（实际执行允许的窄范围；schema 通过后再按本节配置 clamp）。执行顺序：schema 验证 → runtime clamp → sharp 执行；任何冲突时以本节运行时配置为准。
  - `REFINEMENT_PARAM_BRIGHTNESS_MAX_ABS`（默认 `0.4`）：clamp 范围 ±0.4。
  - `REFINEMENT_PARAM_CONTRAST_MAX_ABS`（默认 `0.3`）。
  - `REFINEMENT_PARAM_SATURATION_MAX_ABS`（默认 `0.3`）。
  - `REFINEMENT_PARAM_CROP_MIN_AREA`（默认 `0.5`）：最小裁剪后保留面积（相对原图），低于此值拒绝 crop。
  - `REFINEMENT_PARAM_ROTATION_MAX_DEG`（默认 `15`）：旋转角度上限（绝对值），超过按 clamp。

### 11.2 环境变量

- 仅提交 `.env.example`。
- 真实密钥（AI provider key、S3 key）只通过 `.env` 注入，永不落库。
- CI / 本地都从 `.env.example` 复制后改。

---

## 12. 安全与合规

1. 不引入用户系统的第一版下，API 不做鉴权，但要有“仅本机访问”的运行假设，文档里写清。
2. 上传校验：扩展名 + magic number + 大小上限。
3. SQL：全部用预编译语句，杜绝拼接。
4. 文件路径：业务接口只接受 `mediaId`，不接受路径，避免路径穿越。
5. AI 调用：脱敏后写日志，不上传无关用户数据，遵守 provider 的内容策略。

---

## 13. 后续扩展

按 `requirements.md` §13 与各阶段“后续”小节落地：

| 方向 | 替换点 | 替换策略 |
|---|---|---|
| 数据库 SQLite → Postgres | Repository 层 + 迁移脚本 | 保持 SQL 兼容（避免 SQLite 专有语法），换驱动即可 |
| 存储本地 → S3 | `StorageProvider` | 实现 `S3StorageProvider` 并切配置 |
| 队列内置 → Redis/BullMQ | `JobQueue` 接口 | 适配器替换，状态依然落 `processing_jobs` 或迁出 |
| 高级相似度 | DINOv2 / CLIP + FAISS | 增加 Python 子服务，pHash 兜底 |
| 视频镜头切分 | PySceneDetect | 用 Python 子服务包装，FFmpeg 抽帧兜底 |
| AI 精修 / 剪辑 | `AIProvider` 多实现 | 配置切换 provider，接口不变 |
| 多用户 | 引入 user 表与鉴权中间件 | trips / media 表加 `owner_id` |
| 实时进度 | WebSocket / SSE | 现有轮询不变，作为兜底 |

---

## 14. 与需求的对应关系

| 需求章节 | 设计落点 |
|---|---|
| §3 设计原则 | §1 总体架构、§9 队列、CLAUDE.md §2 红线 |
| §6 第一版范围 | tasks.md 阶段 1–7（图片）、阶段 9（视频基础） |
| §7 功能需求 | §6 上传、§7 图片、§8 视频、§3 后端 API |
| §8 数据模型 | §4 数据库 |
| §9 API | §3.3 API 要点 |
| §10 前端页面 | §2 前端 |
| §11 处理流程 | §7、§8 任务链 |
| §12 非功能 | §9 队列、§10 错误处理、§11 配置 |
| §16 风险 | §7.2 模糊、§7.3 去重、§9 重试、§12 安全；P12 新增风险：§16.6 AI 成本 → §7.8.3 容错 + §11.1 cost cap envs；§16.7 场景分组误差 → §7.8.6 V1 disposition + §4.2 scene_group_items；§16.8 精修越界 → §7.6 双层 clamp + §11.1 `REFINEMENT_PARAM_*` |
| §7.13 / §7.14 视频优化与剪辑 | §8.3、§8.5（音频处理）|
| §7.19 音频库 | §8.5、§5.2 存储布局、§3.3 API |
| §7.20 多视频合成 | §8.6、§5.2 存储布局、§3.3 API |
| §7.21 AI 精选相册 | §2.5、§3.3 API、§4.2 表、§4.2.1 version_type、§7.6（双路径）、§7.8（pipeline）、§9.1（dedupe_key）/ §9.2、§11.1 |
| §7.22 幻灯片视频 | §2.5.5、§3.3 API、§4.2 slideshow_renders 表、§4.2.1 version_type、§5.2 outputs 布局、§8.7、§9.2、§11.1 |

阶段实现进度回写到本文件 §1 / §13，与 `tasks.md` 同步。

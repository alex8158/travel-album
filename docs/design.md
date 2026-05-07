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
| `/trips/:id` | Trip 详情（Gallery） | 网格、筛选、灯箱、视频卡片 |
| `/trips/:id/edit` | 编辑 Trip | 表单 |
| `/trips/:id/upload` | 上传页 | 拖拽 + 批量、单文件进度 |
| `/trips/:id/duplicates` | 重复组列表 | 组卡片、组内对比 |
| `/duplicate-groups/:id` | 重复组详情 | 切换推荐图、批量删除候选（二次确认） |
| `/media/:id` | 图片/视频详情 | 元数据、版本切换、增强 / AI 精修按钮 |
| `/videos/:id/segments` | 视频片段 | 片段列表、片段预览、保留/删除 |
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
| `trips` | `cover_media_id → media_items.id`（可空，ON DELETE SET NULL） | `created_at`、`deleted_at` | 软删除字段 `deleted_at` |
| `media_items` | `trip_id → trips.id`（ON DELETE RESTRICT，先处理） | `trip_id`、`file_hash`、`status`、`deleted_at` | `user_decision` 默认 `undecided` |
| `media_analysis` | `media_id → media_items.id`（ON DELETE CASCADE） | `media_id`（唯一） | 1:1 关系，`raw_result` 存 JSON |
| `duplicate_groups` | `trip_id`, `recommended_media_id`（SET NULL） | `trip_id`、`group_type` | 删除推荐图前必须先 reset |
| `duplicate_group_items` | `group_id`（CASCADE）、`media_id`（CASCADE） | `(group_id, media_id)` 唯一 | 记录每张在组内的状态 |
| `media_versions` | `media_id`（CASCADE） | `(media_id, version_type)` | `version_type` 枚举严格校验 |
| `video_segments` | `media_id`（CASCADE） | `media_id`、`is_recommended` | 每段独立缩略图 / 预览 |
| `processing_jobs` | `media_id`（CASCADE 或 SET NULL，见下） | `status`、`job_type`、`started_at` | 状态机表，详见 §8 |
| `ai_invocations` | `media_id`、`job_id`（SET NULL） | `created_at` | 审计用，不参与业务流 |

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
        edits/{editId}.mp4              # 后续视频剪辑输出
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

- 通过 `AIProvider` 抽象。
- 用户主动触发，前端必须先弹提示（耗时 / 成本）。
- 调用前后写 `ai_invocations`（含模型、参数、状态、耗时、费用估算）。
- 输出 `media_versions(version_type='ai_refined', model_name=...)`。
- 配置不齐全或 `AI_ENABLED=false` 时，前端按钮置灰并提示“未配置”。

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
- 剪辑方案：基于候选 `video_segments` 生成顺序与时长，存为 JSON。
- 渲染：FFmpeg concat / filter_complex 合成 → `outputs/edits/`。
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

---

## 9. 任务队列设计

### 9.1 模型

- 单一事实源：`processing_jobs` 表。
- 状态机：`pending → running → success | failed`，`failed → retrying → running`，可 `cancelled`。
- 字段：`id, media_id, job_type, payload(JSON), status, progress, retry_count, error_message, started_at, finished_at, created_at, updated_at`。

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
  - **图片通道**：`IMAGE_WORKER_CONCURRENCY`，默认 **2**。涵盖 `image_thumbnail / image_metadata / image_hash / image_dedup / image_quality / image_enhance / image_recommendation`。
  - **视频通道**：`VIDEO_WORKER_CONCURRENCY`，默认 **1**。涵盖 `video_metadata / video_cover / video_proxy / video_keyframes / video_segments / video_segment_analysis` 等所有调用 FFmpeg / ffprobe 的任务。系统范围内并行的 FFmpeg 子进程总数不得超过此值。
  - **AI 通道**：`AI_WORKER_CONCURRENCY`，默认 **1**，并受日 / Trip 配额额外约束。
- 拉取方式：
  - 轮询 SQL：`SELECT ... WHERE status='pending' OR (status='retrying' AND next_run_at<=now) AND job_type IN (<channel_types>) ORDER BY created_at LIMIT (channelCap - channelInFlight)`。
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
| §16 风险 | §7.2 模糊、§7.3 去重、§9 重试、§12 安全 |

阶段实现进度回写到本文件 §1 / §13，与 `tasks.md` 同步。

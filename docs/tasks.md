# Travel Album Site V2 任务清单

本文件基于 [requirements.md](requirements.md) 与 [design.md](design.md) 拆分，是开发执行的唯一任务来源。

执行规则（同 [`../CLAUDE.md`](../CLAUDE.md)）：

1. 一次只做一项任务（`P{阶段}.T{编号}`）。
2. 动手前先复述任务编号、要改的文件、不做的事情。
3. 完成后回填验证结果，并把任务前的 `[ ]` 改成 `[x]`。
4. 任务过大就先在本文件里拆，再做其中一个。
5. 红线（不覆盖原文件、不自动永久删除、删除前清外键、AI 默认关闭）始终遵守。

任务标签含义：

- 状态：`[ ]` 待办 / `[x]` 完成 / `[~]` 进行中 / `[!]` 阻塞。
- `MUST` 第一版必须；`SHOULD` 时间允许做；`LATER` 后续阶段。

---

## 阶段 0：项目骨架（前置基础设施）

> 对应 requirements §14 阶段 1 的“初始化前后端项目”和 design §3.2 目录结构。

- [ ] **P0.T1 [MUST]** 初始化 Git 仓库基础文件
  - 输出：`.gitignore`（忽略 `node_modules/`、`storage/`、`data/`、`.env`、构建产物）、`README.md` 简介、`.editorconfig`。
  - `README.md` 必须明确**系统级依赖**：宿主机需安装 `ffmpeg` 与 `ffprobe`（建议给出 macOS `brew install ffmpeg`、Ubuntu `apt-get install ffmpeg` 等示例命令），并说明缺失时仅视频功能失效、图片功能不受影响。
  - 不做：还不初始化任何 npm 项目。
- [ ] **P0.T2 [MUST]** 初始化后端 TypeScript 工程
  - 输出：`server/package.json`、`tsconfig.json`、`server/src/index.ts` 空启动、ESLint + Prettier 基础。
  - 验证：`npm run build` 通过。
- [ ] **P0.T3 [MUST]** 初始化前端 React + TS 工程
  - 输出：`client/`（Vite 模板或等价），路由壳子，可访问 `/`。
  - 验证：`npm run dev` 可起本地服务。
- [ ] **P0.T4 [MUST]** 集中配置层 + `.env.example`
  - 输出：`server/src/config/index.ts` 读取并校验配置（`zod`）；根目录 `.env.example` 列出所有变量名（无真实值）。
  - `.env.example` 至少包含：`IMAGE_WORKER_CONCURRENCY=2`、`VIDEO_WORKER_CONCURRENCY=1`、`AI_WORKER_CONCURRENCY=1`、`JOB_RETRY_MAX`、`ZOMBIE_TIMEOUT_MS`、`STORAGE_DRIVER`、`STORAGE_LOCAL_ROOT`、`FFMPEG_PATH`（可选）、`FFPROBE_PATH`（可选）、`AI_ENABLED=false`、`AI_PROVIDER`、`AI_DAILY_LIMIT`、`AI_TRIP_LIMIT`、`UPLOAD_MAX_FILE_SIZE`、`UPLOAD_ALLOWED_IMAGE_EXT`、`UPLOAD_ALLOWED_VIDEO_EXT`、`PERMANENT_DELETE_ENABLED=false`。
  - `.env.example` 顶部以注释形式说明：`ffmpeg` / `ffprobe` 为系统级依赖，未安装时视频任务会失败但不影响图片处理。
  - 验证：缺少必需变量时启动报错；`PERMANENT_DELETE_ENABLED` 默认为 `false`。
- [ ] **P0.T5 [MUST]** 引入 SQLite 与迁移机制
  - 输出：`server/src/db/connection.ts`、迁移脚本 runner、`migrations/000_init.sql` 占位（先只放 PRAGMA）。
  - 验证：启动后 `data/app.db` 生成，PRAGMA 生效。
- [ ] **P0.T6 [MUST]** 结构化日志与统一错误响应
  - 输出：`pino` 日志中间件、`AppError` 基类、错误码常量、Express 错误处理中间件。
  - 验证：抛出 `AppError` 时返回设计文档定义的错误结构。
- [ ] **P0.T7 [MUST]** `StorageProvider` 抽象 + 本地实现
  - 输出：`server/src/storage/index.ts` 接口、`LocalStorageProvider`（按 design §5.2 目录布局）。
  - 验证：单元测试覆盖 `putOriginal` / `putDerived` / `read` / `remove`。
- [ ] **P0.T8 [MUST]** ffmpeg / ffprobe 启动检测 + `/api/health`
  - 输出：启动阶段一次性探测 `ffmpeg -version` / `ffprobe -version`（优先 `FFMPEG_PATH` / `FFPROBE_PATH`，否则走 `PATH`），结果存为运行时状态 `{ ffmpegAvailable, ffprobeAvailable, version }`。
  - 缺失时：日志输出明确警告（含安装建议），**不退出进程**；后续视频任务执行时识别该状态并以 `FFMPEG_NOT_AVAILABLE` 失败；图片任务路径完全不受影响。
  - `GET /api/health` 返回 `{ ffmpegAvailable, ffprobeAvailable, version, permanentDeleteEnabled, aiEnabled }`，便于诊断。
  - 验证：模拟无 ffmpeg 环境（临时改 `FFMPEG_PATH` 指向不存在的路径）启动应成功，`/api/health` 反馈 `false`。

---

## 阶段 1：Trip 管理（CRUD）

> requirements §7.1 / §10.1 / §10.2 / §14 阶段 1。

- [ ] **P1.T1 [MUST]** 新建迁移：`trips` 表（含软删除）
  - 字段以 requirements §8.1 为准。
- [ ] **P1.T2 [MUST]** Trip Repository + Service
  - 提供 `create / list / getById / update / softDelete`。所有列表过滤 `deleted_at IS NULL`。
- [ ] **P1.T3 [MUST]** Trip API 路由
  - `POST/GET /api/trips`、`GET/PATCH/DELETE /api/trips/:id`、`POST /api/trips/:id/cover`。
  - 此阶段封面策略：Trip 详情 / 列表响应中返回 `cover_url` 字段，固定指向**默认占位封面**（前端静态资源，例如 `/placeholder-cover.svg`）；`trips.cover_media_id` 默认 `NULL`。`POST /api/trips/:id/cover` 接受手动指定但此时尚无媒体可选，可先实现写入 `cover_media_id` 但允许 `null` 复位。
  - 校验：标题必填。
- [ ] **P1.T4 [MUST]** 前端 Trip 列表页
  - 卡片网格、占位封面、空状态、按时间倒序。
- [ ] **P1.T5 [MUST]** 前端 Trip 创建/编辑页
  - 表单：标题（必填）、说明、地点、起止日期。
- [ ] **P1.T6 [MUST]** 前端 Trip 详情页骨架
  - 显示标题、说明、计数（先全为 0），上传入口、Gallery 占位。
- [ ] **P1.T7 [MUST]** Trip 删除二次确认
  - 软删除路径，前端弹窗 + “可恢复”说明。
- [ ] **P1.T8 [MUST]** 阶段验收
  - 手动验证 requirements §7.1 验收标准 6 条全部通过。

---

## 阶段 2：媒体上传与文件识别

> requirements §7.2 / §7.3 / §14 阶段 2。

- [x] **P2.T1 [MUST]** 迁移：`media_items` 表（含 `status`、`user_decision`、软删除）
- [x] **P2.T2 [MUST]** 迁移：`processing_jobs` 表（先建表，状态机逻辑放阶段 4）
- [x] **P2.T3 [MUST]** `File_Classifier` 模块
  - MIME + 扩展名 + magic number 三层判定，返回 `image | video | unknown` + reason。
- [x] **P2.T4 [MUST]** `Upload_Manager` + `POST /api/trips/:tripId/media/upload`
  - multipart 流式落盘、写 `media_items`、为图片建 `image_thumbnail` 任务、为视频建 `video_metadata` 任务（任务执行能力还没接，先入库 `pending`）。
  - 单文件失败不影响其他文件，结果数组返回。
- [x] **P2.T5 [MUST]** `GET /api/trips/:tripId/media`、`GET /api/media/:id`
  - 分页（默认 50）。
- [x] **P2.T6 [MUST]** 前端上传页：拖拽 + 多选 + 单文件进度 + 失败提示
- [x] **P2.T7 [MUST]** 前端 Gallery 网格基础版
  - 占位卡片显示文件名 / 状态徽章（`uploaded` / `processing` / ...），轮询刷新。
- [x] **P2.T8 [MUST]** 阶段验收
  - 手动验证 §7.2、§7.3 验收标准；伪造扩展名文件被识别为 unknown 不进入处理流。

---

## 阶段 3：图片缩略图与元数据

> requirements §7.4 / §14 阶段 3。
>
> **任务顺序调整说明（P2.T8 验收后于 commit `74d3435` 之后校准）**：
> 原 P3.T1 ~ P3.T7 顺延为 P3.T3 ~ P3.T9，在前面新增 P3.T1 / P3.T2 两个 MUST 前置任务，
> 用于消化 P2 验收记录的两个进入 P3 前的硬阻断风险：
> - R-34（无 HTTP 静态文件路由 serve `storage/`，缩略图 / Gallery 即使生成也无法被浏览器加载）
> - R-36（`processing_jobs` 写入但无 Worker 执行；CLAUDE.md §3.6 禁止 HTTP 同步执行耗时任务）
>
> P3.T2 是 P4.T1 的**最小 stub**：只跑 image-channel、单并发、无 retry / 无 zombie / 无 Job API。
> 完整的 Worker pool（含三通道、退避、僵尸恢复、Job API、Media 状态联动）保留在 P4.T1 ~ P4.T7。
> 设计层面 stub 与正式 Worker pool 共用 handler 注册表接口，P4.T1 落地时不需改 P3 的 ImageWorker 代码。

- [x] **P3.T1 [MUST]** Storage 静态文件路由
  - `GET /storage/<logicalPath>` 从 `LocalStorageProvider` 根 read-only serve 文件，供前端 `<img>` / `<video>` 直接消费。
  - 复用 P0.T7 的路径校验三道闸（`assertSafeRelPath` / `resolveUnderRoot`），拒越界 / null byte / 绝对路径；404 走 `STORAGE_NOT_FOUND`。
  - Content-Type 优先从 `media_items.mime_type` 查；缺失时按扩展名映射；未知回 `application/octet-stream`。
  - 基础 `Cache-Control`（如 derived 文件 `max-age=3600, immutable`；originals 视情况）。
  - **明确不做**：鉴权 / signed URL / IP 限流（design.md §12.1 "仅本机访问"假设）；Range header / 视频 seek（留给 P9 / 后续）；ETag / CDN 缓存策略。
  - 验证：smoke 覆盖正常 GET / 404 / traversal 拒绝 / stream 完整性。
  - 消化 R-34。
- [x] **P3.T2 [MUST]** 最小 image-channel job 执行器（P4.T1 的 stub）
  - 进程内执行器，启动时挂在 server bootstrap；setInterval 周期（1–3s）扫 `processing_jobs WHERE status='pending' AND job_type LIKE 'image_%'`。
  - 抢占式 UPDATE 防并发拉同一行：`UPDATE ... SET status='running', started_at=? WHERE id=? AND status='pending'`。
  - 单并发（IMAGE_WORKER_CONCURRENCY 配置项参考，实现层先固定 inflight=1）；状态推进 `pending → running → success / failed`，失败写 `error_message + finished_at`。
  - handler 注册表：`job_type → async handler`；P3.T4 / P3.T5 落地时各自注册 `image_thumbnail` / `image_metadata` handler，不改执行器代码。
  - 优雅关停：SIGINT / SIGTERM 期间不接新任务，等当前 inflight 完成。
  - **明确不做**（全部留给 P4.T1 ~ P4.T7）：三通道（image / video / AI）拆分、retry + 退避、僵尸恢复、Job API（GET / retry / cancel）、Media 状态联动（`uploaded → processing → processed`）、FFmpeg 可用性 gating。
  - **与 P4.T1 的衔接契约**：执行器接口稳定，P4.T1 落地时替换扫描循环为多通道独立调度器 + 加退避 + 僵尸 + Job API + Media 状态联动；handler 注册表与 P3 已注册的 handler 不变。
  - 消化 R-36 最小子集。
- [x] **P3.T3 [MUST]** 迁移：`media_versions` 表  *(原 P3.T1)*
- [x] **P3.T4 [MUST]** `ImageWorker.thumbnail`（注册到 P3.T2 执行器）  *(原 P3.T2)*
  - sharp 生成 `thumb.webp` + `preview.webp`，写 `media_versions`，更新 `media_items.width/height/preview_path/thumbnail_path`。
- [x] **P3.T5 [MUST]** `ImageWorker.metadata`（注册到 P3.T2 执行器）  *(原 P3.T3)*
  - `exifr` 读 EXIF；新增 `image_metadata` 任务类型（与 thumbnail 同链）。
- [x] **P3.T6 [MUST]** 前端图片详情页（v1）  *(原 P3.T4)*
  - 展示原图（按需加载）、预览图、EXIF 信息表。
  - 原图 / 预览图 URL 通过 P3.T1 静态路由加载。
- [x] **P3.T7 [MUST]** 失败重试入口（先在详情页做单任务“重新处理”按钮）  *(原 P3.T5)*
- [x] **P3.T8 [MUST]** 临时封面：第一张图片  *(原 P3.T6)*
  - 当 `trips.cover_media_id IS NULL` 时，Trip 详情 / 列表响应层动态计算 `cover_url`：取该 Trip 中按 `created_at` 升序、已生成缩略图、`deleted_at IS NULL` 的第一张图片的 `thumbnail_path`。
  - **不写入 `cover_media_id`**，仅在响应层派生，避免与 P6 自动最佳封面写库逻辑冲突。
  - 没有任何已生成缩略图时回退到默认占位。
- [x] **P3.T9 [MUST]** 阶段验收  *(原 P3.T7)*
  - 手动验证 §7.4 验收标准 5 条；上传图片后 Trip 卡片自动显示第一张图片为临时封面。
  - 额外验证（前置任务闭环）：
    - Gallery / 详情页缩略图通过 P3.T1 静态路由可正常 GET（R-34 闭环）。
    - 上传后 pending `image_thumbnail` / `image_metadata` job 能被 P3.T2 执行器拉起并标 success（R-36 stub 闭环）。

---

## 阶段 4：任务队列与处理状态

> requirements §7.17 / §14 阶段 4。

- [x] **P4.T1 [MUST]** `JobQueue` 实现：抢占式拉取、按通道分组的并发控制、状态迁移、`started_at/finished_at`
  - 三类独立通道（实现层各自维护并发计数）：图片通道默认并发 `IMAGE_WORKER_CONCURRENCY=2`、视频通道默认 `VIDEO_WORKER_CONCURRENCY=1`、AI 通道默认 `AI_WORKER_CONCURRENCY=1`。
  - 严禁出现“所有任务共用一个并发上限”的实现；FFmpeg 子进程总数不得超过视频通道并发上限。
  - 视频任务出队执行前先检查 `ffmpegAvailable`，不可用直接以 `FFMPEG_NOT_AVAILABLE` 标记失败，不占用并发槽。
- [x] **P4.T2 [MUST]** 失败重试与退避（max 3 次，指数退避，可配置）
- [x] **P4.T3 [MUST]** 僵尸任务恢复（启动扫描 + 心跳超时阈值）
- [x] **P4.T4 [MUST]** Job API：`GET /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/retry`、`POST /api/jobs/:id/cancel`
- [x] **P4.T5 [MUST]** Media 状态联动：根据关键任务结果更新 `media_items.status`
- [x] **P4.T6 [MUST]** 前端任务状态页（§10.8）
- [x] **P4.T7 [MUST]** 阶段验收
  - 单文件失败不影响其他；重试后状态正确；僵尸任务可识别恢复。

---

## 阶段 5：图片去重

> requirements §7.5 / §14 阶段 5。

- [x] **P5.T1 [MUST]** 迁移：`duplicate_groups`、`duplicate_group_items`
- [x] **P5.T2 [MUST]** `image_hash` 任务：SHA256 + pHash + dHash
- [x] **P5.T3 [MUST]** `Dedup_Engine.exact`：file_hash 相等聚合
- [x] **P5.T4 [MUST]** `Dedup_Engine.similar`：pHash 海明距离 ≤ 阈值聚合（同 Trip 内）
- [x] **P5.T5 [MUST]** Duplicate Group API（§9.4 全部）
- [x] **P5.T6 [MUST]** 前端重复组列表 + 详情（§10.5）
- [x] **P5.T7 [MUST]** 用户切换推荐图，写入 `user_confirmed`，自动流程不再覆盖
- [x] **P5.T8 [MUST]** 阶段验收：§7.5 验收 7 条（2026-05-18 完成，详见 `docs/progress.md`）

---

## 阶段 6：图片质量评分

> requirements §7.6 / §7.7 / §7.8（曝光/色彩属 SHOULD）/ §14 阶段 6。

- [x] **P6.T1 [MUST]** 迁移：`media_analysis`
- [x] **P6.T2 [MUST]** `image_quality.blur`：Laplacian variance（缩放归一化），写 `blur_score / sharpness_score / is_blurry`，三档（clear / maybe_blurry / blurry）
- [x] **P6.T3 [SHOULD]** `image_quality.exposure`：直方图判过曝/欠曝
- [x] **P6.T4 [SHOULD]** `image_quality.color`：偏色检测
- [x] **P6.T5 [MUST]** `Quality_Selector`：组内排序、生成 `recommended_media_id` 与 `reason`，跳过已被 `user_confirmed` 的组
- [x] **P6.T6 [MUST]** 前端：模糊徽章、推荐徽章、推荐原因展示
- [x] **P6.T7 [MUST]** 启用自动最佳封面选择
  - 策略：当用户未手动指定（`trips.cover_media_id` 为 `NULL` 或先前由系统写入）时，取该 Trip 中 quality_score 最高、未被软删除的图片，**写入** `trips.cover_media_id`。
  - 用户曾手动设置（通过 `POST /api/trips/:id/cover`）的 Trip 不得被自动覆盖；区分方式建议加 `trips.cover_set_by_user`（迁移补字段，或用单独标志位）。
  - 自动选择应在质量评分完成后异步触发（例如新增 `trip_cover_refresh` 任务），避免阻塞主流程；P3.T8 的响应层临时封面在 `cover_media_id` 写入后自动失效。
- [x] **P6.T8 [MUST]** 阶段验收：§7.6 / §7.7 验收；上传足够图片后 Trip 封面会自动收敛到 quality_score 最高的图片，且用户手动设置不被覆盖。（2026-05-20 完成，详见 `docs/progress.md`）

---

## 阶段 7：安全删除与恢复

> requirements §7.18 / §14 阶段 7。
>
> **第一轮主流程仅做软删除 + 恢复（P7.T1–T6）**。永久删除（P7.T7–T9）作为预留，前置条件是 P7.T1–T6 全部完成且自动化测试通过；在此之前，永久删除接口默认禁用（`PERMANENT_DELETE_ENABLED=false`，返回 `PERMANENT_DELETE_DISABLED`）。
>
> **状态：第一轮（P7.T1–T6）已完成（2026-05-20）。** P7.T7–T9（永久删除）保留为后续阶段任务，默认禁用未实现，requirements §7.18 验收第 5–6 条留待解锁。

第一轮（必须完成）：

- [x] **P7.T1 [MUST]** 软删除路径：`DELETE /api/media/:id` 设 `deleted_at`，先重置 `duplicate_groups.recommended_media_id`、清 `duplicate_group_items` 标记（2026-05-20 完成；`duplicate_group_items.user_decision` 保留以方便 P7.T2 恢复，UI 已通过 `media: null` 占位渲染；详见 `docs/progress.md`）
- [x] **P7.T2 [MUST]** 恢复路径：`POST /api/media/:id/restore`，事务内复位 `deleted_at`、`status`，重新参与去重评估但不覆盖已 `user_confirmed` 的组（2026-05-20 完成；事务内 reset，post-tx 入队 `quality_selector_run` trip-scope 由现有 handler 复用做 re-rank + auto-cover；client 仅加 `restoreMedia(id)` helper，UI 留 P7.T4；详见 `docs/progress.md`）
- [x] **P7.T3 [MUST]** 重复组批量删除：`POST /api/duplicate-groups/:id/delete-others` 走软删除路径（2026-05-20 完成；`DedupService.deleteOthers` 对组内 `recommendation = 'remove'` 成员逐个调 `MediaService.softDeleteMedia`，winner 保留；typed outcome `applied / no-winner` + 幂等；前端 DuplicateGroupDetailPage 加 "Delete N other photo(s)" 按钮 + modal；详见 `docs/progress.md`）
- [x] **P7.T4 [MUST]** 前端：回收站视图（列出 `deleted_at` 不为空的媒体）、恢复按钮、软删除二次确认提示“可恢复”（2026-05-20 完成；服务端最小侵入：`listMediaOptionsSchema` / `ListMediaOptions` / `listMediaQuerySchema` 增加 `onlyDeleted` 字段，`MediaRepository` 新增 `listByTripDeletedOnlyStmt`（`deleted_at DESC` 排序），`list()` 三档分支（`onlyDeleted` > `includeDeleted` > 默认 active-only）；`includeDeleted` 仍保留为内部管理 / 组合视图 API。客户端 `useTripMedia` 增加 `onlyDeleted` 第三参数；新增 `TripRecycleBinPage`（路由 `/trips/:id/recycle-bin`），每行带 Restore 按钮复用 P7.T2 `restoreMedia` API；trip 详情页 header 增加 "Recycle bin" 入口。无新增 API、无新增 migration。新增 `smoke:trip-media-recycle-bin`（17/17 PASS）+ media/soft-delete/restore/dedup-delete-others/dedup-api 回归全绿；详见 `docs/progress.md`）
- [x] **P7.T5 [MUST]** 自动化测试：
  - 删除推荐图后该重复组 `recommended_media_id` 被正确重置
  - 删除一张组内图片不会触发 `FOREIGN KEY constraint failed`
  - 删除后再恢复，状态字段、关联记录、`duplicate_groups` 评估都正确恢复
  - 跨表外键路径（media_analysis / duplicate_group_items / media_versions / video_segments / processing_jobs）遍历检查
  - （2026-05-20 完成；新增 `smoke:p7-recycle-bin-acceptance`（55/55 PASS）作为 P7 阶段端到端验收，单一 smoke 覆盖：4 个用户路径 A/B/C/D（默认 gallery 隐藏 deleted / 回收站只列 deleted / restore 状态切换 / restore 不动主流程）+ tasks.md 列出的 4 个交叉路径（recommended 重置 / FK 不抛错 / 状态字段恢复 / 跨表 FK 遍历）；每个用例都 seed 一个挂满所有引用关系的 media（media_analysis + media_versions + processing_jobs + duplicate_group_items + 可选 recommended_media_id），然后软删除 + 恢复，逐表断言行依然存在 + 内容未被覆盖（user_decision / user_confirmed / params / quality_score / is_blurry / reason / file_path 等）；并验证磁盘原始文件、type='video' 行、auto-cover 用户 pin 释放、processing_jobs.status 不被改写、两轮 delete→restore→delete→restore 循环稳定。video_segments 表 P9 才落地，注释说明跳过原因。回归 smoke：trip-media-recycle-bin 17/17 / media-soft-delete 32/32 / media-restore 28/28 / dedup-delete-others 28/28 / media 26/26 / dedup-api 27/27 全绿。详见 `docs/progress.md`）
- [x] **P7.T6 [MUST]** 第一轮阶段验收：requirements §7.18 验收前 4 条 + “删除图片不会出现 FOREIGN KEY 错误”（2026-05-20 完成；逐条对照 requirements §7.18 前 4 条验收标准均有显式 PASS 断言（FK 不抛错、重复组状态更新、推荐图被删后可重新推荐/取消推荐、软删除后可恢复），加上用户扩展项（gallery 默认不展示 deleted、回收站只展示 deleted、restore 后回 gallery、未引入永久删除/批量 restore/复杂筛选 UI/分页 UI）。验收来源：P7 阶段 5 个 smoke 共 160/160 PASS + 14 个其它回归 smoke 全绿；server/client `typecheck`/`lint`/`format:check`/`build` 全绿；代码审计确认 `permanentDeleteEnabled` 仅是 `/health` 元数据标记（默认 false，无路由消费）、无 `bulkRestore`/`batchRestore` 任何变体、`TripRecycleBinPage` 无 filter/sort/pagination UI。详见 `docs/progress.md`）

预留（**前置条件：P7.T1–T6 全部完成并通过测试，再执行**）：

- [ ] **P7.T7 [LATER]** 永久删除接口（事务 + 二次确认 token + `PERMANENT_DELETE_ENABLED=true` 才放开）：CASCADE 清关联、最后删文件、文件失败写补偿日志
- [ ] **P7.T8 [LATER]** 前端：永久删除入口（仅当 `/api/health` 返回 `permanentDeleteEnabled=true` 时显示）+ 二次确认弹窗（明确不可逆）
- [ ] **P7.T9 [LATER]** 永久删除阶段验收：requirements §7.18 验收第 5–6 条（“永久删除前需要二次确认”、“删除失败时能看到错误原因”）；孤儿文件清理任务可用

---

## 阶段 8：图片自动增强

> requirements §7.9 / §14 阶段 8。
>
> **状态：P8.T1–T6 已完成（2026-05-20）**。后端 + 前端闭环（enqueue → sharp handler → derived enhanced.jpg + media_versions → GET versions → POST select-version → 前端 compare / adopt / use-original / re-enhance）全部交付，requirements §7.9 验收前 5 条均通过；详见 `docs/progress.md` 的 P8.T6 阶段验收章节。

- [x] **P8.T1 [MUST]** `POST /api/media/:id/enhance` 入队 `image_enhance` 任务（2026-05-20 完成；新建 `server/src/jobs/imageEnhanceWorker.ts` 仅导出 `IMAGE_ENHANCE_JOB_TYPE = "image_enhance"` 常量（P8.T2 在同一文件追加 handler）；`MediaService.enhanceMedia(id)` 复用 `reprocessOneJobType` 的入队原语，单 slot 返回扁平 `EnhanceMediaResult { mediaId, jobType, outcome: 'created'|'reset'|'skipped', jobId, reason? }`；missing/soft-deleted 媒体 → 404、非 image 媒体 → 400（image-only per requirements §7.9）。路由 `POST /api/media/:id/enhance` 直接转发到 service。无新增 migration、无 media_versions 写入（P8.T3 territory）、无 sharp 调用（P8.T2 territory）、无前端改动（P8.T5）。新增 `smoke:media-enhance-trigger`（27/27 PASS），并跑 10 个回归 smoke 全绿。详见 `docs/progress.md`）
- [x] **P8.T2 [MUST]** sharp 增强管线：白平衡 / 曝光 / 对比度 / 锐化 / 降噪（参数走 config）（2026-05-20 完成；与 P8.T3 一起合并交付——见 P8.T3 行的说明）
- [x] **P8.T3 [MUST]** 输出 `derived/{mediaId}/enhanced.jpg`，写 `media_versions(version_type='enhanced')`（2026-05-20 完成；P8.T2 和 P8.T3 在执行时合并为单个 handler commit：sharp 管线和"写派生文件 + 写 media_versions"在工作流上不可分割（处理器若不写文件就无法标记 success），所有既有 image 通道 worker（thumbnail/metadata/hash/quality_*）也都是单文件包含全流程。落实：在 `server/src/jobs/imageEnhanceWorker.ts`（P8.T1 留下的常量文件）追加 `makeImageEnhanceHandler` + `ImageEnhanceHandlerDeps` + `EnhanceSettings`，使用 sharp 6 步管线（rotate → resize<=maxEdge → modulate(brightness, saturation) → linear(a, b) → gamma → sharpen → jpeg+mozjpeg）；输出写到 `trips/{tripId}/derived/{mediaId}/enhanced.jpg`，via storage.putDerived(overwrite=true) 保证幂等；UPSERT 一行到 `media_versions(version_type='enhanced')`，`params` 字段记录每个 sharp 调用 + sharpVersion + workerVersion 便于追溯；config 层新增 `quality.enhance.{maxEdge, brightness, saturation, gamma, linearA, linearB, sharpenSigma, sharpenM1, sharpenM2, jpegQuality, workerVersion}` 共 11 个 env 可调旋钮，全部带 superRefine 边界守卫（gamma ≥ 1.0、saturation/brightness ≤ 2.0、sharpenM2 ≤ 3.0 等防"过度饱和过度锐化"，对应 requirements §7.9 验收 #5）；index.ts 注册 handler；`media_versions.version_type='enhanced'` 早在 005/006 migration 已经在 enum 中，无需新 migration；新增 `smoke:image-enhance-worker`（34/34 PASS，覆盖 happy path + 原图未被覆盖 + 输出非原始 bytes + 维度上限 + ±10% 强度漂移 + media_versions 字段齐全 + idempotent bit-identical + P8.T1↔P8.T2 链路 + soft-deleted/video/unknown/missing-media 失败路径 + 不污染 media_items 字段）；跑了 15 个回归 smoke 全绿。详见 `docs/progress.md`）
- [x] **P8.T4 [MUST]** 版本切换 API：`GET /api/media/:id/versions`、`POST /api/media/:id/select-version`（2026-05-20 完成；新增 migration `010_add_media_items_active_version_type.sql`（12 步表重建为 STRICT 表加新 CHECK；新列 `media_items.active_version_type TEXT NOT NULL DEFAULT 'original'` + CHECK 限定 `('original','enhanced','ai_refined')`；老行 DEFAULT 自动覆盖，无回填）；`MediaService.listVersions(id)` 返回 `MediaVersionsView { mediaId, activeVersionType, versions[] }`，自动合成 'original' 入口（来自 media_items 列，`id=null`）+ 仅暴露用户可选 version_type（'enhanced'/'ai_refined'），过滤 'thumbnail'/'preview'/'metadata'/'video_*' 等运维派生；`MediaService.selectVersion(id, body)` 校验 zod `.strict()` 闭枚举 + 目标 version 行存在（原图要求 `original_path` 非空；'enhanced'/'ai_refined' 要求对应 media_versions 行存在），仅 UPDATE `active_version_type + updated_at`，幂等（重复选同 type 返回 `alreadyActive: true` 不写 DB），返回 `SelectVersionResult { mediaId, activeVersionType, previousVersionType, alreadyActive }`；不动 original_path / preview_path / thumbnail_path / status / user_decision / media_versions 行 / 磁盘文件。路由 `GET /api/media/:id/versions` + `POST /api/media/:id/select-version` 注册在现有 media router，复用 entityIdSchema + asyncHandler；missing/soft-deleted 媒体 → 404（P7 回收站契约），非法 body → 400 VALIDATION_FAILED。新增 `smoke:media-versions-api`（35/35 PASS，含 service 层 + HTTP 层 14 case：默认 active='original' / GET 合成 original / 过滤运维 type / enhanced 入口 / 切换 → 'enhanced' / 幂等 / 切换回 'original' / 无 enhanced 行报 400 / unknown 媒体报 400 / 各种 malformed body 报 400 / missing 404 / soft-deleted 404 / scope-guard 不污染其他列+文件 / HTTP 路由层 4 个端到端断言）。回归 20 个 smoke 全绿。详见 `docs/progress.md`）
- [x] **P8.T5 [MUST]** 前端：原图 vs 增强图对比、采用 / 放弃、重新增强（2026-05-20 完成；client 端 `api/media.ts` 新增 `MediaActiveVersionType` 类型 + `MediaItem.activeVersionType` 可选字段（向后兼容，缓存中可能缺失则视作 'original'） + `EnhanceMediaResult` / `MediaVersionView` / `MediaVersionsView` / `SelectVersionResult` 类型 + 3 个 helper：`enhanceMedia(id)` / `fetchMediaVersions(id)` / `selectMediaVersion(id, versionType)`，全部沿用现有 `readErrorMessage` 错误投影；新增 hook `useMediaVersions(id)`（与 `useMediaDetail` 同形：`{ data, loading, error, refetch }` + AbortController + stale-while-revalidate）；`MediaDetailPage.tsx` 在 hero 与 quality-analysis 之间插入 `<EnhancementSection>`：side-by-side 网格（auto-fit minmax(240px,1fr) 单列自动塌缩）展示 original / enhanced 缩略图，active cell 用绿色边框 + "✓ Active" pill 标记；动作行三按钮——"Adopt enhanced"（仅 enhanced 存在且非 active 时启用）/ "Use original"（仅非 active 时启用）/ "Re-enhance"（始终启用，调用 P8.T1）；aria-live banner 区分 `enhance-success` / `select-success`（含 alreadyActive 短路文案）/ error（按 op 区分文案）；media.type !== 'image' 时不渲染本区段；空 enhanced 时显示 "No enhanced version yet" 占位 + Enhance 按钮（仅渲染 placeholder ✨ 而非 broken <img>）；所有操作成功后并行 refetch 详情 + versions 让页面立即反映新状态。`client/src/index.css` 加 `.media-enhance-section` / `.media-enhance-grid` / `.media-enhance-cell[data-active]` / `.media-enhance-cell-img` / `.media-enhance-cell-placeholder` / `.media-enhance-actions` 共 6 个最小样式块。**未新增后端 API / migration**，仅消费 P8.T1 / P8.T4 端点；**未触碰** P7 soft-delete / restore / recycle-bin 行为（hook 复用 useMediaDetail 已经把 404 通过 `error` 字段冒泡）；**未引入** 永久删除 / 批量恢复 / 复杂 job 轮询 / UI 大改。client `typecheck` / `lint` / `format:check` / `build` 全绿；server 13 个回归 smoke 全绿（含 `smoke:media-versions-api` 35/35）。详见 `docs/progress.md`）
- [x] **P8.T6 [MUST]** 阶段验收：原图未被覆盖；失败可回退；不过度饱和锐化（2026-05-20 完成；逐条对照 requirements §7.9 前 5 条验收均有显式 PASS 断言，加上提示词扩展项（前端 adopt/use-original/re-enhance 可用、P7 行为不破坏、上传/处理/推荐/auto-cover/video 主流程不变）。验收来源：P8 阶段 3 个 smoke 共 96/96 PASS + 25 个其它回归 smoke 全绿（总 29/29 smoke）；server/client `typecheck`/`lint`/`format:check`/`build` 全绿；migration 010 跑通；代码审计 grep 0 匹配 hardDelete/permanentDelete/bulkRestore/batchRestore/ffmpeg/video_segment/ComfyUI/CLIP/DINO/FAISS/OpenAI/Anthropic 等任何禁用模式；P8 commit chain `a1970f3` → `505d254` → `c44aace` → `57fb5c5`；P7 + P8.T1-T5 已完成代码未被重构。详见 `docs/progress.md`）

---

## 阶段 9：视频基础处理

> requirements §7.11 / §7.12 / §14 阶段 9。第一版范围内项目均为 SHOULD（§6.2），但封面 / 元数据为 MUST。

- [x] **P9.T1 [MUST]** 迁移：`video_segments`（2026-05-21 完成；新增 migration `011_create_video_segments.sql` 落库 `video_segments` 表：16 列（id PK / media_id FK CASCADE / start_time / end_time / duration / thumbnail_path / preview_path / blur_score / stability_score / quality_score / waste_type / is_recommended / user_decision / reason / created_at / updated_at）+ 9 个 CHECK 约束（start_time≥0、end_time>start_time、duration>0、3 个 score [0,1] OR NULL、waste_type ∈ {'black','blurry','unstable','silence','none'} 默认 'none'、is_recommended 0/1、user_decision ∈ {'keep','remove','undecided'} 默认 'undecided'）+ 2 个索引（media_id、is_recommended）+ FK `media_id → media_items(id) ON DELETE CASCADE`。STRICT 表。无 worker / repository / service / route / 前端代码——纯 schema 落库；这些将随 P9.T2-T9 各自落地。新增 `smoke:migration-011`（39/39 PASS：fresh + upgrade scenarios + 16 列顺序 + 索引 + FK + 9 个 CHECK + 默认值落地 + CASCADE + FK 拒绝错 media_id + 幂等 + integrity_check + 兼容 P1-P8 表）。同步扩展 `p7-recycle-bin-acceptance-smoke.ts` 加 video_segments 跨表 FK case（5 个新断言：soft-delete 保留 / restore 保留 + 内容不变 / round-trip 两轮均保留），共 60/60 PASS（之前 55/55）。**关闭 R-78**：video_segments 表已落库且接入 P7 跨表 FK 验收 smoke。回归 30 个 smoke 全绿。详见 `docs/progress.md`）
- [x] **P9.T2 [MUST]** `video_metadata`：ffprobe 读时长 / 分辨率 / 帧率 / 码率 / 编码 / 音频（2026-05-21 完成；新增 `server/src/jobs/videoMetadataWorker.ts`：`VIDEO_METADATA_JOB_TYPE='video_metadata'` 常量 + `makeVideoMetadataHandler` + `VideoMetadataSettings` + `VideoMetadataProjection` 类型 + 纯函数 `projectFfprobe`；handler 通过 `node:child_process.spawn(settings.ffprobePath, ['-v','error','-print_format','json','-show_format','-show_streams', absolutePath])` 调 ffprobe，带 30s timeout + SIGKILL 兜底 + stderr 截断到 4KB；`projectFfprobe` 提取 10 个字段（duration / width / height / frameRate / bitrate / videoCodec / audioCodec / audioChannels / audioSampleRate / containerFormat）每个独立可空，audio-only 文件可正常返回 audio 三件套且 video 三件套为 null（handler 自己 reject 无可用视频流的情况），malformed `r_frame_rate` (`0/0`/`abc/def`/`/` 等) 全部映射为 null 而非 NaN；`MediaRepository.updateVideoMetadata({ mediaId, duration, width, height, updatedAt })` 新写入器（与 `updateImageDerivedPaths` 分离：仅写 duration/width/height，**不**写 preview_path/thumbnail_path——那是 P9.T3 `video_cover` 的领域）；写入两处：(a) `media_items.duration/width/height` 缓存到媒体行（active-only 过滤匹配 P7 契约），(b) `media_versions(version_type='metadata')` UPSERT 完整 projection + raw ffprobe JSON + workerVersion（per (media_id, version_type) UNIQUE 保证幂等 1 行），`file_path` 指向原始文件、`mime_type='application/json'` 描述 params 形态——与 `image_metadata` worker 同约定。`server/src/index.ts` 把 handler 注册到 **video** 通道（`config.workers.videoConcurrency=1`，与 design.md §6.10 一致）；config.ffmpeg.ffprobePath ?? "ffprobe" PATH fallback。**无新增 migration**（`media_items.duration` 002 就有；`media_versions.version_type='metadata'` 006 enum 已有）。失败模式：media 404 / 非 video / NULL original_path / ffprobe exit≠0（含 stderr 截断进 error_message）/ stdout 非 JSON / 无可用 video stream / SIGKILL 超时——全部清晰 throw。新增 `smoke:video-metadata-worker`（**39/39 PASS**：5 个纯函数 projectFfprobe 单测 + 28 个端到端 case 通过真 ffmpeg `-f lavfi` 动态生成测试 MP4：happy path + 视频 only + idempotent bit-identical + 非视频/soft-deleted/unknown/缺文件/broken-mp4 失败路径 + 无 preview/thumbnail 副作用 scope-guard；ffmpeg 缺席时优雅 SKIP）。回归 27 个 smoke 全绿（含 P7/P8 全套契约）。详见 `docs/progress.md`）
- [x] **P9.T3 [MUST]** `video_cover`：FFmpeg 抽封面帧（2026-05-21 完成；新增 `server/src/jobs/videoCoverWorker.ts`：`VIDEO_COVER_JOB_TYPE='video_cover'` 常量 + `makeVideoCoverHandler` factory + 纯函数 `chooseCoverSeekSeconds(duration, fallbackSeekSeconds)` + `VideoCoverSettings` 类型；handler spawn ffmpeg `-ss <seek> -i <abs> -frames:v 1 -vf scale='min(MAX_EDGE,iw)':'min(MAX_EDGE,ih)':force_original_aspect_ratio=decrease -q:v <quality> -f image2 -update 1 -y <tmp>`（input-side fast seek + 单帧输出）；30s timeout + SIGKILL + 4KB stderr 截断；seek 策略：duration null/0/负 → 0；duration<2s → 中点；duration≥2s → min(duration/2, fallbackSeekSeconds)（默认 5s cap）。写入 `derived/{mediaId}/video_cover.jpg`（per design.md §8.1）via `storage.putDerived(overwrite=true)`；写两处：(a) `media_items.thumbnail_path` 缓存到媒体行（新 repo 写入器 `updateVideoCoverPaths`，仅写 thumbnail_path 不动 preview_path——video V1 不需要分离的 preview），(b) UPSERT `media_versions(version_type='video_cover')` 含 width/height/file_size + params (sharpVersion, workerVersion, seekSeconds, sourceDuration, maxEdge, jpegQuality) for 审计追溯。`media_versions.version_type='video_cover'` 早在 005/006 enum 中，**无新增 migration**。config 层新增 `quality` 之外的 `video.cover.{maxEdge=1280, jpegQuality=2, fallbackSeekSeconds=5, timeoutMs=30000, workerVersion='1.0'}` 5 个 env 旋钮 + superRefine 守卫（jpegQuality ∈ [2,31]、maxEdge ≥ 64）。bootstrap 把 handler 注册到 video 通道（与 P9.T2 共享 VIDEO_WORKER_CONCURRENCY=1 budget）。失败模式：media missing/soft-deleted、非 video、NULL original_path、ffmpeg spawn fail/exit≠0/timeout、output 0 字节、sharp 解码失败——全部清晰 throw。新增 `smoke:video-cover-worker`（**41/41 PASS**：7 个 chooseCoverSeekSeconds 纯函数单测 + 10 个端到端 case 通过真 ffmpeg `-f lavfi testsrc` 动态生成测试 MP4：happy path 13 断言、原图 bytes 不变、idempotent、非视频/soft-deleted/unknown/缺文件/broken-mp4 失败路径、scope-guard 只动 thumbnail_path 不动其他 9 列、null-duration 仍能 seek=0 成功）。回归 27 个 smoke 全绿（含 P7/P8/P9.T1/T2 全套契约）。详见 `docs/progress.md`）
- [x] **P9.T4 [SHOULD]** `video_proxy`：720p 低清代理（2026-05-21 完成；新增 `server/src/jobs/videoProxyWorker.ts`：`VIDEO_PROXY_JOB_TYPE='video_proxy'` 常量 + `makeVideoProxyHandler` factory + `VideoProxySettings` 类型。Pipeline：spawn ffmpeg `-i <abs> -vf scale=-2:'min(ih,TARGET_HEIGHT)' -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -movflags +faststart -y <tmp>`（H.264 + AAC 720p MP4，源≤目标时不放大，`-2` 让 width auto-round 到偶数以满足 yuv420p 要求）；wall-clock cap 300s + SIGKILL + 4KB stderr 截断。写到 `derived/{mediaId}/video_proxy.mp4`（design.md §6.2.5 / §8.1 exactly）via `storage.putDerived(overwrite=true)`。ffprobe 校验 proxy 取权威 width/height/duration/codec 后 UPSERT `media_versions(version_type='video_proxy')`（`version_type='video_proxy'` 早在 005/006 enum 中 — **无新增 migration**）含 width/height/file_size/mime='video/mp4' + params (workerVersion + targetHeight + crf + preset + videoCodec + audioCodec + audioBitrateKbps + proxyDurationSec + proxyVideoCodec + proxyAudioCodec + proxyBitrate)。**不**触碰 `media_items.preview_path`（避免迫使 preview_path 读路径分支 image/video MIME；P9.T8 Video API 通过 media_versions 查询即可——R-101 记录）。config 层新增 `video.proxy.{targetHeight=720, crf=28, preset='veryfast', videoCodec='libx264', audioCodec='aac', audioBitrateKbps=128, timeoutMs=300000, workerVersion='1.0'}` 共 8 个 env 旋钮 + superRefine 守卫（CRF ≤ 51、targetHeight ≥ 144、preset 必须 x264 文档闭枚举）。bootstrap 把 handler 注册到 video 通道（与 P9.T2/T3 共享 VIDEO_WORKER_CONCURRENCY=1 budget）。失败模式：media missing/soft-deleted、非 video、NULL original_path、ffmpeg spawn fail/exit≠0/timeout、output 0 字节、ffprobe verify 失败——全部清晰 throw + 原视频从不被覆盖。新增 `smoke:video-proxy-worker`（**35/35 PASS**：10 个端到端 case 含 happy + 不放大 + 1080p→720p 下采样 + idempotent + 5 个失败路径 + scope-guard 双断言）。回归 28 个 smoke 全绿。详见 `docs/progress.md`）
- [x] **P9.T5 [SHOULD]** `video_keyframes`：固定间隔抽帧（2026-05-21 完成；新增 `server/src/jobs/videoKeyframesWorker.ts`：`VIDEO_KEYFRAMES_JOB_TYPE='video_keyframes'` 常量 + `makeVideoKeyframesHandler` factory + 纯函数 `computeEffectiveInterval(duration, configured, maxFrames)` + `VideoKeyframesSettings` + `KeyframeManifest` / `KeyframeManifestEntry` 类型。Pipeline：(1) 找媒体 + 类型守卫；(2) 优先选 video_proxy 作为 decode source（cheaper to decode 720p；fallback 到 original_path）；(3) 计算 effective interval（duration null/≤0/NaN/Inf → 配置；估算 ≤ maxFrames → 配置；否则 stretch `duration/maxFrames` 均匀分布）；(4) spawn ffmpeg `-vf fps=1/<eff> -q:v 2 -frames:v <maxFrames> -f image2 -y <tmpDir>/frame_%06d.jpg`（bounded 300s + SIGKILL + 4KB stderr 截断 + `-frames:v` 双重 cap）；(5) 读 tmp 目录 + sharp.metadata() 取每帧权威宽高；(6) `storage.putDerived({ relPath: 'frames/<filename>', overwrite: true })` 每帧落入 `derived/{mediaId}/frames/frame_NNNNNN.jpg`；(7) 写 `manifest.json` 同目录含 frameCount + intervalSec(effective) + configuredIntervalSec + decodeSource ('proxy'|'original') + decodeSourcePath + maxFrames + sourceDurationSec + frames[]（每帧 {index, timestampSec, filePath, width, height, fileSize}）+ generatedAt + workerVersion。**无新增 migration**：`video_keyframes` 不在 `media_versions.version_type` enum 中，本任务**不**写 media_versions（R-104 记录），manifest.json on disk 是发现层；P9.T7/T8 读它消费。**无 DB 任何写入**——media_items / media_versions 全部不动（scope-guard 显式断言）。config 层新增 `video.keyframes.{intervalSec=2, maxFrames=200, jpegQuality=2, timeoutMs=300000, workerVersion='1.0'}` 5 个 env 旋钮 + superRefine 守卫（jpegQuality ∈ [2,31]、intervalSec ≥ 0.5、maxFrames ≤ 10000）。bootstrap 注册到 video 通道（与 metadata/cover/proxy 共享 VIDEO_WORKER_CONCURRENCY=1）。失败模式：media missing/soft-deleted、非 video、无 decode source、ffmpeg spawn fail/exit≠0/timeout、0 帧、sharp 解码失败、storage 写入失败——全部清晰 throw + 原视频从不被覆盖。新增 `smoke:video-keyframes-worker`（**40/40 PASS**：9 个 pure-function 单测 + 12 个端到端 case：happy (6s @ 2s → 3 frames + manifest shape + 时间戳映射 + JPEG 验证 + 文件名模式) + 原视频不变 + decode-source proxy 优先 + 长视频 cap (6s @ 0.5s + cap=2 → stretch 到 3s = 2 frames) + idempotent + 5 个失败路径 + scope-guard 三断言 (media_items 不变 + 原视频字节不变 + media_versions 0 行)）。回归 29 个 smoke 全绿（含 P7/P8/P9.T1-T4 全套契约）。详见 `docs/progress.md`）
- [x] **P9.T6 [SHOULD]** `video_segments` 固定时长切片（默认 10s，可配置）（2026-05-21 完成；新增 `server/src/jobs/videoSegmentsWorker.ts`：`VIDEO_SEGMENTS_JOB_TYPE='video_segments'` 常量 + `makeVideoSegmentsHandler` factory + `VideoSegmentsSettings` + `DEFAULT_VIDEO_SEGMENTS_SETTINGS`；新增 `server/src/media/videoSegmentsRepository.ts`（带 `videoSegmentMp4Path()` helper：约定 `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4`）+ `server/src/media/videoSegmentTypes.ts`（`VideoSegment` / `VideoSegmentInsertData` / `VideoSegmentWasteType` / `VideoSegmentUserDecision`）。Pipeline：(1) 找媒体（active-only）+ 类型守卫（type='video' 否则 throw）+ originalPath 守卫；(2) `pickDecodeSource`（优先 video_proxy 文件存在 → fallback original_path）；(3) spawn ffmpeg `-i <src> -c copy -map 0 -f segment -segment_time <durationSec> -reset_timestamps 1 -segment_start_number 1 -y <tmpDir>/segment_%06d.mp4`（bounded 300s + SIGKILL + 4KB stderr 截断；`-c copy` 不重新编码，切点对齐 source keyframe）；(4) readdir + ffprobe 每个 segment 取 `format.duration`（slice 长度可能略偏离配置，以 ffprobe 为准；每个 ffprobe 15s 超时）；(5) 为每段生成 fresh UUID + `storage.putDerived({ relPath: 'segments/{uuid}.mp4', overwrite: true })` 写入 derived 树（路径不存数据库——`video_segments` 故意无 `file_path` 列，落地约定通过 `videoSegmentMp4Path()` 重建）；(6) 事务内 `replaceAllForMedia`：DELETE 旧行 + INSERT 新行（CHECK 约束兜底：duration ≤ 0 / endTime ≤ startTime 的脏段被丢弃；全空则 throw 不动 DB）；(7) 事务外 best-effort `storage.remove` 旧文件（不影响 job 成功），生成全新 UUID 保证 old/new id 集合不交，无误删。worker 接 video 通道（共享 `VIDEO_WORKER_CONCURRENCY=1` 预算，与 metadata/cover/proxy/keyframes 串行）。config 层用 `video.segments.{durationSec, timeoutMs=300000, workerVersion='1.0'}`，`durationSec` 复用 `VIDEO_SEGMENT_DURATION` env（P9.T1 已声明）+ 新增 `VIDEO_SEGMENTS_TIMEOUT_MS` / `VIDEO_SEGMENTS_WORKER_VERSION` 两旋钮。失败模式（全部 throw → JobQueue mark failed，原视频从不被覆盖，事务回滚保留旧行）：media missing/soft-deleted、非 video、无 decode source、ffmpeg spawn fail/exit≠0/timeout、0 segments、ffprobe fail、storage 写入失败。R-107（记录在 `docs/progress.md`）：每次 (re-)run 会清掉前一次保存在同 media 上的 P9.T7+ 评分（blur_score / stability_score / quality_score / waste_type / is_recommended / user_decision / reason）——V1 接受，因 P9.T7 尚未落地，风险此刻 dormant；P9.T7 时需重审。新增 `smoke:video-segments-worker`（**41/41 PASS**：12 个端到端 case：happy (12s @ 3s → 4 段、连续单调、startTime=0、总时长≈源、文件落盘且文件名为 UUID、audit 列默认值) + 非破坏性（原视频字节一致） + decode-source 偏好（删原片仅保留 proxy → 仍成功） + idempotent（重跑同段数 + UUID 全换 + 旧文件被清理） + 5 个失败路径（image、unknown、soft-deleted、ghost-file、broken）+ scope-guard（media_items 不变 + 原视频字节不变 + media_versions 0 行）+ FK ON DELETE CASCADE（hard-delete media_items 行 → 自动级联清除 segments）+ cleanup-tolerance（重跑时一个旧 segment 文件被预先删除，worker 不挂）。回归 35 个 smoke 全绿（含 P7/P8/P9.T1-T5 全套契约）；migration-006/008 的 2 个失败为 P9.T6 之前既有失败（已在 e7cbcae P9.T5 commit 复现），与本任务无关。详见 `docs/progress.md`）
- [x] **P9.T7 [SHOULD]** 片段质量：模糊评分（关键帧）+ FFmpeg `blackdetect`（2026-05-24 完成；新增 `server/src/jobs/videoSegmentQualityWorker.ts`：`VIDEO_SEGMENT_QUALITY_JOB_TYPE='video_segment_quality'` 常量 + `makeVideoSegmentQualityHandler` factory + 纯函数 `scoreOneSegment` / `parseBlackdetectStderr` / `runBlackdetect` + `VideoSegmentQualitySettings` + `SegmentScore` 类型。Pipeline：(1) 找媒体（active-only）+ type='video' 守卫；(2) `listByMediaId` 取 segments，0 行抛；(3) 读 `derived/{mediaId}/frames/manifest.json`（缺失/不可解析/空 frames[] 抛）；(4) 对每个 keyframe `readFile` + 复用 `computeLaplacianStats` + `normaliseSharpness(variance, BLUR_THRESHOLD_MAYBE)` 得 [0,1] sharpness；(5) `pickDecodeSource`（proxy 优先 fallback original）+ spawn ffmpeg `-hide_banner -nostats -v info -i <src> -vf "blackdetect=d=<min>:pic_th=<picTh>:pix_th=<pixTh>" -an -f null -`（bounded 300s + SIGKILL + 4KB stderr 截断 + 1MB stderr buffer cap）→ `parseBlackdetectStderr` 用正则 `/black_start:\s*([+-]?\d+(?:\.\d+)?)\s+black_end:\s*([+-]?\d+(?:\.\d+)?)/g` 提取 `[start, end)` 半开区间 + 排序 + drop 反向；(6) 对每个 segment：keyframes ∈ [start_time, end_time) 平均得 `blur_score`（无 keyframe → NULL）；black 区间 overlap 求和 / segment.duration = `blackRatio`；`waste_type` = blackRatio ≥ 0.5 → 'black' / blur_score ≤ 0.25 → 'blurry' / 'none'；`quality_score = blur_score × (1 - blackRatio)` 或 NULL；`is_recommended = waste='none' AND quality ≥ 0.5`；`reason` 含每轴 + keyframeCount；(7) per-row `videoSegmentsRepo.updateQuality(...)`（UPDATE blur_score/stability_score=NULL/quality_score/waste_type/is_recommended/reason/updated_at，**不动 user_decision**——CLAUDE.md §3.9）。**R-107 闭合**：修改 `replaceAllForMedia(mediaId, segments, options?: { force?: boolean })`：默认 force=false 时 SELECT 旧行 → time-overlap mapping（new_seg 与 old_seg 重叠 ≥ 0.5×new_duration AND old.user_decision ≠ 'undecided' → 继承）→ 事务内 DELETE+INSERT+UPDATE user_decision 重放；force=true 时无条件 wipe。P9.T6 worker 解析 `job.payload` JSON 的 `force` 字段（缺失/非 JSON/非对象 → false + warn log）传给 repo。新增 `mapUserDecisionsByOverlap` 纯函数 + 公开 `updateUserDecision()` + `updateQuality()` repo 方法。config 层新增 8 个 env：VIDEO_SEGMENT_QUALITY_BLUR_MAX_EDGE=512 / BLUR_WASTE_THRESHOLD=0.25 / BLACK_RATIO_THRESHOLD=0.5 / BLACKDETECT_PIC_TH=0.98 / BLACKDETECT_PIX_TH=0.1 / RECOMMEND_THRESHOLD=0.5 / TIMEOUT_MS=300000 / WORKER_VERSION='1.0'；复用既有 `BLACK_DETECT_DURATION` env（design.md §11.1）作为 blackdetect `d=`；复用 `BLUR_THRESHOLD_MAYBE` (image 配置) 作为 `normaliseSharpness` 分母让 image / video 评分可比；superRefine 守卫 5 个 [0,1] 阈值 + blurMaxEdge ≥ 4。bootstrap 注册到 video 通道（共享 VIDEO_WORKER_CONCURRENCY=1）。失败模式（全 throw → JobQueue mark failed，**不部分写**）：media missing/soft-deleted、非 video、0 segments、manifest 缺失/不可解析/空、keyframe 文件不可读/空、sharp 解码失败、无 decode source、ffmpeg spawn fail/exit≠0/timeout。新增 `smoke:video-segment-quality-worker`（**36/36 PASS**：3 个 parseBlackdetectStderr 单测（空/单/多区间 + 反向 drop + 排序）+ 5 个 scoreOneSegment 单测（无 keyframe NULL / 清晰 recommended / 全黑 black / 模糊 blurry / 40% 黑 < threshold 不 black）+ 1 个 mapUserDecisionsByOverlap R-107 单测（keep ≥50% 重叠继承 / undecided 跳过 / <50% 不继承）+ 10 个端到端：happy 4 段全打分 + scope-guard（media_items 不动 + media_versions 0 行 + 原视频不变 + segment 文件不动）+ 全黑 6s clip → segments 全 black 不推荐 + R-107 preservation（重跑 P9.T6 不带 force → keep 保留）+ R-107 force（payload `{"force":true}` → user_decision wipe）+ 5 个失败路径（无 segments / 无 manifest / 非 video / soft-deleted / 无 decode source））。回归 35 个 smoke 全绿（含 P7/P8/P9.T1-T6 全套契约）；migration-006/008 既有 2 个失败已在 P9.T6 commit 记录，与本任务无关。详见 `docs/progress.md`）
- [x] **P9.T8 [SHOULD]** Video API（§9.5 中 segments / process）（2026-05-24 完成；新增 `server/src/media/videoService.ts`（VideoService 类，4 个公开方法：`listSegments` / `getSegmentDetail` / `updateUserDecision` / `processVideoSegments`，公开类型 `VideoSegmentView` / `KeyframesSummary` / `ListVideoSegmentsResult` / `VideoSegmentDetailResult` / `UpdateUserDecisionResult` / `ProcessSlotOutcome` / `ProcessSlotResult` / `ProcessVideoSegmentsResult`）+ `server/src/media/videoSchemas.ts`（`updateUserDecisionBodySchema` 闭合枚举 keep|remove|undecided 镜像 migration 011 CHECK + `processVideoSegmentsBodySchema` `{ force?: boolean }`，两者均 `.strict()`）+ `server/src/routes/video.ts`（4 个 endpoint，下文）；修改 `server/src/media/videoSegmentsRepository.ts` 添加 `findByIdStmt` + 公开 `findById(id): VideoSegment | null`（单段查询不做 P7 跨表，由 Service 层用 mediaRepo 兜底）；修改 `server/src/media/index.ts` 重导出新 VideoService + schemas；修改 `server/src/app.ts` 加 `videoService` 到 `CreateAppOptions` + 挂载 `makeVideoRouter` 在 `/api`；修改 `server/src/index.ts` 构造 `VideoService(mediaRepo, videoSegmentsRepo, jobRepo, storage)` + 注入 createApp。**Endpoints**：(1) `GET /api/media/:mediaId/video-segments` → `{ mediaId, mediaDurationSec, segments: [{...VideoSegment, filePath}], keyframes: { workerVersion, intervalSec, frameCount, sourceDurationSec, generatedAt, frames[] } | null }`，每段补一个 canonical `filePath = trips/{tripId}/derived/{mediaId}/segments/{id}.mp4`（重建 P9.T1 故意无 file_path 列的约定）；keyframes 异步读 `derived/{mediaId}/frames/manifest.json`，ENOENT/corrupt JSON 优雅降级到 null（不挂整接口）。(2) `GET /api/media/:mediaId/video-segments/:segmentId` → `{ mediaId, segment }`，URL 路径里 :mediaId 与 segment.media_id 不匹配也返 404（防止跨 parent 枚举）。(3) `PATCH /api/video-segments/:segmentId/user-decision` body `{ userDecision: 'keep'|'remove'|'undecided' }` → `{ segmentId, mediaId, previousUserDecision, userDecision, alreadyApplied, updatedAt }`，复用 P9.T7 公开的 `videoSegmentsRepo.updateUserDecision(id, userDecision, now)`，仅写 user_decision 列**不动评分**（CLAUDE.md §3.9）；idempotent（旧值 === 新值 → 跳过 DB write，alreadyApplied=true，updatedAt 原样保留）。(4) `POST /api/media/:mediaId/process-video-segments` body 可选 `{ force?: boolean }` → `{ mediaId, force, results: [{ jobType, outcome, jobId, reason? }] × 3 }`，按 design.md §8.1 顺序入队 `video_segments` → `video_keyframes` → `video_segment_quality`；用 baseMs + i 的单调递增 createdAt 保证 JobQueue 按依赖顺序 claim；force=true 仅在 segments slot 的 payload 写入 `{"force":true}`，keyframes / quality slot 始终 payload=null（它们不动 user_decision，flag 对它们语义无意义）；R-107 兜底：force=false 默认重跑会被 P9.T7 的 `replaceAllForMedia` 通过时间重叠映射保留 user_decision，只有 force=true 才显式 wipe；force=true 在 terminal 状态时**插入新行**而不是 `resetToRetrying`（后者不动 payload），保证 worker 读到新 force flag。失败模式：list/detail/PATCH 在媒体缺失/软删/非 video 返 404；process 在缺失/软删返 404，非 video 返 400（与 enhanceMedia 的"工具用错"语义一致）；malformed body / 未知 key / 枚举越界一律 zod ValidationError → 400。**循环导入修复**：videoService.ts 故意把 3 个 job_type 字符串 inlined（不 import 自 worker），因 `media/index.js` 重导出 videoService 且 workers value-import `videoSegmentMp4Path` 自 media/index.js，会触发 ESM TDZ 循环初始化错误；这些字符串属 closed `processing_jobs.job_type` 词汇表 drift 由现有 smoke:video-* 验证。新增 `smoke:video-api`（**48/48 PASS**：16 个 case：CASE 1 happy list + filePath + scores + keyframes summary / CASE 2 empty segments + keyframes=null / CASE 3 corrupt manifest 优雅降级 / CASE 4 missing/non-video/soft-deleted 三类 404 / CASE 5 detail happy / CASE 6 detail missing 404 / CASE 7 PATCH happy + scope-guard 三段评分列不变 / CASE 8 PATCH idempotent updated_at 不动 / CASE 9 PATCH 三种 ValidationError / CASE 10 PATCH missing/soft-deleted 404 / CASE 11 process happy 3 slot created + 顺序 + 幂等 skipped / CASE 12 process force=true segments slot payload 正确 / CASE 13 process force=true after terminal 插新行 / CASE 14 process 三种 400（非 video / force 非 bool / extra key）/ CASE 15 process missing/soft-deleted 404 / CASE 16 HTTP layer 4 个 endpoint 真 HTTP 验证）。回归 44 个 smoke 全绿（含 video-segments/keyframes/cover/proxy/metadata + video-segment-quality + 全套 P7/P8 契约）。详见 `docs/progress.md`）
- [x] **P9.T9 [SHOULD]** 前端视频片段页（§10.7）（2026-05-24 完成；新增 `client/src/api/video.ts`（Video API 客户端：`fetchVideoSegments` / `fetchVideoSegmentDetail` / `updateSegmentUserDecision` / `processVideoSegments` 4 个函数 + 完整 wire 类型 `VideoSegment` / `KeyframesSummary` / `KeyframeEntry` / `ListVideoSegmentsResponse` / `VideoSegmentDetailResponse` / `UpdateUserDecisionResponse` / `ProcessVideoSegmentsResponse` / `VideoSegmentWasteType` / `VideoSegmentUserDecision` / `ProcessSlotOutcome` / `ProcessSlotResult`，沿用 `media.ts` 的 readErrorMessage envelope 处理）+ `client/src/hooks/useVideoSegments.ts`（stale-while-revalidate hook，AbortController 防 race，`useMediaDetail` 同构契约 `{ data, loading, error, refetch }`）+ `client/src/pages/VideoSegmentsPage.tsx`（挂在 `/videos/:mediaId/segments`，404/loading/empty/error 完整状态机；Header 含返回链接 + media 元信息 + 「Re-analyse」+「Re-analyse from scratch」按钮对；force=true 强制走 `modal-overlay` + `modal-card` 二次确认，文案明确警告会 wipe 所有 user_decision 并建议默认走"保留用户选择"的重跑；keyframe strip 横向滚动展示 P9.T5 manifest 内联摘要；segment 卡片含时间范围 + duration + waste_type pill（5 值闭合枚举映射 emoji + tone）+ Q/Blur/Stab 数值 pill（按分数自适应 tone）+ Recommended 星标 + 卡内 keyframes（按 `f.timestampSec ∈ [start, end)` 筛选）+ keep/remove/undecided 三按钮组（aria-pressed + active 状态切到 btn-primary）+ "Show details" 折叠面板 reveal segment id / canonical filePath（含 `/storage/...` 下载链接）/ updatedAt / reason；PATCH 走乐观更新：`decisionOverrides` map 让按钮立即反馈，失败则 banner 提示；process 调用清空 overrides 再 refetch，因 R-107 重映射结果不可前端预测；aria-live banner 区分 process success/error + decision success/error，error case 用 `form-error` role=alert 不会被静默；aria-live 状态包含 R-107 解释文案让用户理解 force=false 与 force=true 的区别）+ 修改 `client/src/App.tsx` 加 `Route path="/videos/:mediaId/segments"` 接 `VideoSegmentsPage`；修改 `client/src/pages/MediaDetailPage.tsx` 在 page-header-actions 加 `<Link to="/videos/:id/segments">` 仅 video 类型 media 渲染（image 不显示）；修改 `client/src/index.css` 加 ~180 行新样式（video-segments-list / video-segment-card 含 data-waste-type / data-user-decision / data-recommended attribute 选择器 + video-keyframe-strip 横向滚动 + video-segment-card-details 折叠面板 + 复用既有 .quality-pill / .modal-overlay / .modal-card / .btn-* 体系，无新颜色 token）。**用户交互**：(1) 从 MediaDetailPage 视频媒体点 "View segments" 进入；(2) 加载时显示骨架；(3) loaded 后看 keyframe strip + segment 列表 + 评分 pills；(4) 点 keep/remove/undecided 立即触发 PATCH，乐观更新按钮 + aria-live 反馈；(5) 点 Re-analyse 直接 POST process（force=false，R-107 保留 user_decision）；(6) 点 Re-analyse from scratch 弹 modal 二次确认 → POST process force=true → 清空 overrides 重新拉数据；(7) error / 失败 case 走 form-error role=alert 红色 banner 永不静默。**约束兑现**：不动后端核心；不改 schema；不重算 quality；不进入 P9.T10；不做视频剪辑 UI；纯前端复用现有 `.btn-*` / `.quality-pill` / `.modal-*` / `page-header-actions` / `trip-detail-meta` 类，不引入新色板；R-107 preservation 逻辑全部在 server P9.T7 的 `replaceAllForMedia` 里，前端只通过 force flag 透传选择。验证：`npm run lint` + `npm run typecheck` 干净（client）；`npm run build` (vite + tsc) 成功生成 dist；`npm run smoke:video-api` 48/48 PASS；server 全套 44 个 smoke 全绿（含 video-segments 41/41 + video-keyframes 40/40 + video-segment-quality 36/36 + 整套 P7/P8 契约）。详见 `docs/progress.md`）
- [x] **P9.T10 [MUST]** 阶段验收：§7.11 验收；§7.12 已实现部分验收（2026-05-25 完成；新增 `server/src/scripts/p9-acceptance-smoke.ts` 端到端验收 smoke：boot 真 SQLite + real LocalStorageProvider + 真 ffmpeg + 真 Express server，对一段 12s lavfi testsrc 视频跑完整 P9.T1~T9 链路：(stage 0) seed media row → (stage 1) video_metadata 成功 + media_items.duration=12 + media_versions 'metadata' row → (stage 2) video_cover 成功 + cover.jpg 落盘非空 → (stage 3) video_proxy 成功 + proxy.mp4 落盘非空 → (stage 4) video_keyframes 成功 + manifest.json on-disk + 12 帧 @ 1s interval + 帧文件存在 → (stage 5) video_segments 成功 + ≥1 段 + 连续单调 + 总长 ≈ 12s + 文件 canonical path → (stage 6) video_segment_quality 成功 + blur/quality 都在 [0,1] + user_decision 不动 (CLAUDE.md §3.9) + recommended ≥1。Cross-cut：原视频字节 byte-for-byte 不变。Video API (P9.T8) 全契约：GET list / detail / PATCH user_decision / POST process force=false / POST process force=true 全 200。R-107 preservation 端到端：PATCH user_decision='keep' 在某 segment → POST process force=false → drain workers → 按目标 midpoint 找新 segment → 验证 user_decision='keep' 保留；R-107 force wipe：PATCH 'remove' → process force=true → 全部回到 'undecided'。P7 软删除契约：softDeleteMedia → GET/PATCH/POST 全返 404 + restoreMedia → GET 又能访问。R-119：/storage 路由真 HTTP 取 canonical segment MP4 返 200 + 非空 bytes。R-117：POST process 1ms 内返回，证明 worker 是异步的。R-116：无 manifest 媒体的 list 返 200 + keyframes=null 优雅降级。**36/36 PASS**。注册 `smoke:p9-acceptance` 到 package.json。**揭示并记录 R-120**：P9.T6 的 `-c copy` 与 P9.T4 proxy 默认 x264 GOP 大约 10s（preset='ultrafast' 不设 `-g` 时 keyint=250 @ 25fps）交互后，12s 视频在 durationSec=3 配置下实际产出 **2 段（0-10s + 10-12s）** 而非朴素的 4 段——R-109 在生产流水线中的具体表现。Acceptance smoke 改为按"段数 ≥ 1 + 连续 + 总长 ≈ 源"验证（不硬编码 4）+ R-107 测试改为按目标 midpoint 查找新 segment（不假设具体段索引）。这是真实可观察的产品行为，不是 bug——`durationSec` 是"上限提示"而非硬保证。P9.T10 验收**通过**：所有 P9 子任务在端到端真实流水线下证明可用。运行的验证命令：`cd server && npm run smoke:p9-acceptance` (36/36 PASS) + `cd client && npm run lint/typecheck/build` 干净 + `npm run smoke:video-api` 48/48 + 完整 server 回归 45 个 smoke 全绿（含 P3/P4/P5/P6/P7/P8/P9.T1~T9 全套契约）。新增 R-120 已记录到 progress.md。详见 `docs/progress.md` P9.T10 章节）

---

## 阶段 10：AI 扩展（可插拔）

> requirements §7.10 / §14 阶段 10。AI 默认关闭。

- [x] **P10.T1 [MUST]** `AIProvider` 接口 + `NoopProvider`（默认）（2026-05-25 完成；新增 `server/src/ai/` 模块：`AIProvider.ts`（公开接口 `AIProvider { name / available / supports / invoke }` + 类型 `AIRequestType`（6 值闭合枚举 `image_ai_refine | ai_caption | ai_classify | aesthetic_score | video_plan | ranking`，镜像 migration 012 的 `request_type` CHECK enum）+ `AIInvocationStatus`（`pending | success | failed`）+ `AIRequest` / `AISuccessResponse` / `AIFailureResponse` / `AIResponse` 类型 + 两个 error 类 `AIProviderNotConfiguredError`（code='AI_NOT_CONFIGURED'）/ `AIProviderUnsupportedRequestError`（code='AI_REQUEST_TYPE_UNSUPPORTED'）；NoopProvider.ts（默认实现：name='noop' / available=false / supports=empty Set / invoke 始终 throw `AIProviderNotConfiguredError`，文件头注释明确"never returns failure response, never makes network call"）；index.ts barrel + `createAIProviderFromConfig({enabled, provider}, logger?)` 工厂：enabled=false → Noop + INFO 日志；enabled=true 且 provider 是空/'noop'/'disabled' → Noop + WARN；enabled=true 且 provider 未知 → Noop + WARN（不发任何真实网络调用，design.md §11.2 `AI_NOT_CONFIGURED` 错误码契合）。case-insensitive after trim。bootstrap (server/src/index.ts) 在 capabilities 检测后构造 `aiProvider = createAIProviderFromConfig(config.ai, logger)`，目前不挂 createApp（P10.T2~T6 时再 wire），但有 `void aiProvider` 保持引用使 TS 不删；CLAUDE.md §2.8 "未配置 AI 时基础功能必须仍可用" — 验证：P7/P8/P9 全套 smoke 在 AI 默认关闭下不回归（P9.T10 acceptance smoke 36/36 + video-api 48/48 + migration-011 39/39 + p7-recycle-bin-acceptance 60/60 + upload 30/30 全绿）。新增 `smoke:ai-provider` (**18/18 PASS**)：NoopProvider 构造形状 + invoke throws AIProviderNotConfiguredError 含 code='AI_NOT_CONFIGURED' + 8 个 factory 行为分支（default Noop+INFO / off+openai Noop+INFO / on+empty Noop+WARN / on+noop Noop+WARN / on+unknown Noop+WARN 含 "unknown id" 文案 / no-logger 不抛 / case-insensitive whitespace+大小写）+ AIProviderUnsupportedRequestError 形状 + cross-cut 无 node:http/https 网络依赖。详见 `docs/progress.md`）
- [x] **P10.T2 [MUST]** 迁移：`ai_invocations`（2026-05-25 与 P10.T1 同步落地；新增 `server/migrations/012_create_ai_invocations.sql`：14 列（id PK / media_id NULLABLE FK SET NULL / job_id NULLABLE FK SET NULL / provider NOT NULL / model_name NOT NULL / request_type NOT NULL / request_params TEXT / status NOT NULL DEFAULT 'pending' / response_summary TEXT / cost_estimate REAL / duration_ms INTEGER / error_message TEXT / created_at / updated_at），4 个 CHECK 约束（request_type ∈ 6 值闭合枚举 / status ∈ 3 值闭合枚举 / provider/model_name 非空 / duration_ms ≥ 0），FK SET NULL on `media_items` + `processing_jobs`（design.md §4.2 ai_invocations row "审计用，不参与业务流"——hard-delete parent 后审计行存活、FK 列 flip 到 NULL），4 个索引（created_at 日 / Trip 配额计数、media_id "这张图做过哪些 AI 调用"、job_id 回溯、(provider, model_name) 成本分析）。无数据写入（schema only），P10.T3~T7 时由 worker 写入。新增 `smoke:migration-012` (**31/31 PASS**)：A 组 fresh DB 跑通 000..012 + 14 列顺序 + NULL/NOT NULL 标志 + 默认值 + 4 个索引 + foreign_key_check / integrity_check 干净 + 6 个 request_type + 3 个 status 全收 + NULL media_id/job_id 接受 + 5 个 CHECK 越界拒绝 + FK SET NULL on media/job delete（行存活、外键置 NULL）+ no-op 重跑；B 组 upgrade-from-011 模拟 011-era DB → 012 单独 applied + 前置 media row 保留 + post-012 INSERT 工作 + no-op 重跑。详见 `docs/progress.md`）
- [x] **P10.T3 [MUST]** `POST /api/media/:id/ai-refine`：仅在 `AI_ENABLED=true` 时入队 `image_ai_refine` 任务（2026-05-25 完成；新增 `IMAGE_AI_REFINE_JOB_TYPE='image_ai_refine'` 常量导出在 `server/src/ai/index.ts`（统一来源；R-121 同步规则现在通过 lint-friendly TS const + SQL CHECK enum + AIRequestType union 三处对齐）；`MediaService.aiRefineMedia(mediaIdInput)` 新方法（与 `enhanceMedia` 对称：missing → NotFoundError、非 image → BadRequestError、复用 `reprocessOneJobType` 单 slot 入队，幂等 created/reset/skipped + reason），公开 `AiRefineMediaResult` 类型并从 media 桶重导出；route 新增 `POST /api/media/:id/ai-refine`：先读 `deps.aiProvider.available`，false → throw `AppError(AI_NOT_CONFIGURED, statusCode=501)`（design.md §11.2 "功能未启用" 鲁布里克），通过则调 `mediaService.aiRefineMedia(id)`；R-122 对齐——未知 / 未实现的 provider id 在 P10.T1 factory 中已经 fallback 到 NoopProvider，所以 `available=false` 一举覆盖"AI 显式关闭"与"AI 启用但 provider 未接入"两种状态。**R-123 闭合**：`CreateAppOptions.aiProvider: AIProvider` 加上、`bootstrap` 直接 `createApp({ ..., aiProvider })`、`makeMediaRouter` deps 增加 `aiProvider`、原先的 `void aiProvider` 占位删除。`media-versions-api-smoke.ts` 跟着把 `new NoopProvider()` 加进 mediaRouter 构造以满足新 deps 形状（向后兼容；现有 35/35 PASS 不动）。新增 `smoke:media-ai-refine-trigger` (**27/27 PASS**)：service 层 12 case（fresh created + pending/running skipped + failed/success/cancelled reset + 幂等 created→skipped + missing/soft-deleted 404 + video/unknown 400 + scope-guard 不写 media_versions 不动 media_items 列）+ HTTP 层 6 case（NoopProvider → 501 + body.error.code='AI_NOT_CONFIGURED' + 不入队、501 even for missing media (gate shadows 404)、AvailableTestProvider → 200 + 正确 envelope、HTTP 幂等 created→skipped 同 jobId 不重复入队、missing → 404 NOT_FOUND、video → 400 BAD_REQUEST、soft-deleted → 404 NOT_FOUND）。AvailableTestProvider stub 的 `invoke()` 故意抛错保证 P10.T3 路径不调真实 AI provider（P10.T5 worker territory）。回归 47 个 smoke 全绿（含完整 P3~P9 契约 + P10.T1+T2 基础 + 新 P10.T3）。详见 `docs/progress.md`）
- [x] **P10.T4 [MUST]** 调用上限：每日 / 每 Trip（2026-05-25 完成；新增 `server/src/ai/aiInvocationsRepository.ts`：`AiInvocationsRepository` 类含 `insert(data)` / `countSinceTimestamp(sinceIso)` / `countByTripId(tripId)` / `findById(id)`，daily quota 用全局 `created_at >= sinceIso` 计数，per-trip quota 用 INNER JOIN media_items（孤儿审计行自然 drop out，无法 charge 给已 hard-delete 的 trip）。`AiInvocationInsertData` + `AiInvocationRow` 公开类型；`server/src/ai/index.ts` 重导出。`MediaService` 加可选 `aiRefineDeps?: AiRefineDeps` 第 6 个构造参数（含 `aiInvocationsRepo` / `dailyLimit` / `tripLimit` / 可选 `now`），`aiRefineMedia` 重写为：(1) jobRepo / aiRefineDeps 装备检查；(2) 域 gate（404 missing / soft-deleted、400 非 image，**先 throw 不计入 quota**）；(3) **idempotency peek**——`jobRepo.findLatestByMediaIdAndType` 看是否 pending/running，是则直接返 'skipped' **不计 quota**（CLAUDE.md §3.9 友好：双击不扣额度）；(4) **quota gate**：dailyLimit > 0 时 `countSinceTimestamp(startOfUtcDay(now))` ≥ limit → throw `AppError(AI_QUOTA_EXCEEDED, statusCode=429, details: {kind:'daily', limit, used, sinceIso})`，tripLimit > 0 时 `countByTripId(media.tripId)` ≥ limit → 同上但 details.kind='trip' + tripId；(5) 入队 + 写 `ai_invocations(status='pending', provider=route 传入, model_name='pending')` 审计行（worker P10.T5 后续 UPDATE）。新增 `AiRefineOptions { providerName? }`、`AiRefineDeps`、`AiRefineMediaResult.aiInvocationId?` 字段。`startOfUtcDayIso(at: Date)` 辅助函数算 UTC 自然日边界（避免服务器跨时区跳动）。`bootstrap` 构造 `aiInvocationsRepo` + 传到 MediaService（用现有 `config.ai.dailyLimit` / `config.ai.tripLimit` env 旋钮，默认 0=不限）。route 层 `POST /api/media/:id/ai-refine` 增加 `providerName: deps.aiProvider.name` 传参让 audit 行记录实际 provider 名（"unknown" fallback 给 service-layer 直接调用）。`media-ai-refine-trigger-smoke` 升级：构造 MediaService 时传 `aiRefineDeps` (`dailyLimit=0, tripLimit=0` 不影响原 P10.T3 27/27 case）。新增 `smoke:ai-quota-trigger` (**24/24 PASS**)：8 个 case 涵盖 daily=0 不限（5 连发都通过）+ daily=3 第 4 次 429（含 code/statusCode/details.kind='daily'/limit/used/sinceIso）+ 跨自然日重置（pin `now()` 到第 2 天）+ trip=2 同 trip 第 3 次 429（不同 trip 不受影响）+ 同 media 双击 skipped 不扣 quota + 404 不扣 + 400 不扣 + HTTP 501 Noop 不扣 + HTTP 429 body shape 正确（details.kind='trip'/limit/used）+ 幂等 'skipped' 已在 quota full 时仍返 200（不返 429）。回归 48 个 smoke 全绿（含完整 P3-P9 契约 + P10.T1-T3 + 新 P10.T4）。详见 `docs/progress.md`）
- [x] **P10.T5 [MUST]** 写 `ai_invocations` + `media_versions(version_type='ai_refined', model_name=...)`（2026-05-25 完成；新增 `server/src/jobs/imageAiRefineWorker.ts`：`makeImageAiRefineHandler(deps)` 工厂返回 JobHandler，10 步执行流水（1.查 pending audit row by job_id → 2.media P7 active+image+originalPath 守卫 → 3.读 original bytes via storage.read → 4.provider.available 二次校验 → 5.aiProvider.invoke({requestType:'image_ai_refine', mediaId, jobId, inputBytes}) → 6.outputBytes 非空 + sharp.metadata 解析 → 7.storage.putDerived('ai_refined.jpg', overwrite:true) → 8.mediaVersionsRepo.upsert(version_type='ai_refined', model_name, params JSON of {workerVersion,provider,model,costEstimate,durationMs,responseSummary,raw}) → 9.aiInvocationsRepo.markSuccess(modelName, costEstimate, durationMs, responseSummary) → 10.handler 干净 return，JobQueue 自然 markSuccess processing_jobs 行）。`IMAGE_AI_REFINE_JOB_TYPE` 常量从 `ai/index.ts` re-export，整套 R-121 同步收敛到一行 TS import（worker / route / migration enum / AIRequestType 四处对齐都从这里源）。`makeImageAiRefineHandler({storage, mediaRepo, mediaVersionsRepo, aiInvocationsRepo, aiProvider, settings?, logger, now?})` 接口；`DEFAULT_IMAGE_AI_REFINE_SETTINGS` workerVersion='1.0'。bootstrap 加 import `IMAGE_AI_REFINE_JOB_TYPE` + `makeImageAiRefineHandler` 并注册到 imageHandlers map（image 通道，与 enhance/thumbnail/metadata 并列，不动 video 通道）。`AiInvocationsRepository` 增强：新增 `findPendingByJobId(jobId)` (status='pending' ORDER BY created_at DESC LIMIT 1) + `markSuccess({id, modelName, costEstimate, durationMs, responseSummary?, now})` (atomic-claim `WHERE status='pending'`，flip 到 success + 填 audit 列) + `markFailed({id, errorMessage, durationMs?, now})` (atomic-claim 同上 → failed)。**V1 决策：审计 status 跳过 `running` 中间态**——migration 012 的 CHECK enum 只允许 `{pending,success,failed}`，加 `running` 需要新 migration；改用 `WHERE status='pending'` 谓词做原子claim，效果等价于 running 中间态（first writer 赢，后续 race 看到 changes=0），channel concurrency=1 下 race 是理论级。**失败处理**funnel `markAuditFailed(err, durationMs)` 在 audit 行未 terminal 时记录 failed + duration_ms + error_message 再 throw（JobQueue 接管 processing_jobs.markFailed）；任何 mark 自身 throw 时 logger.error 但保留 original 错误。**幂等性**：UPSERT (media_id, version_type='ai_refined') 唯一约束保证 reset/retry 不产生重复 'ai_refined #2' row；同一 media 重跑时新文件按 `derived/{mediaId}/ai_refined.jpg` overwrite=true 落盘替换旧文件。**Scope-guard**：handler 完全不动 `media_items.user_decision` / `active_version_type` / `status` / `original_path` / `preview_path`；原图字节 byte-for-byte 不变。新增 `smoke:image-ai-refine-worker` (**34/34 PASS**)：14 case 覆盖 happy（SuccessMockProvider 返回 32×32 合成 JPEG → job/audit success + 1 行 ai_refined row + width/height/model_name 正确 + 原图字节不变 + media_items 列不动）+ rerun upsert（不产生重复 ai_refined 行 + per-attempt audit 都 success）+ provider unavailable (NoopProvider 中途 available=false) 失败 + provider AIFailureResponse rate-limit 失败 + provider throw 失败 + media soft-deleted 失败 + 非 image media 失败 + 无 pending audit row 失败（worker 拒绝 fabricate）+ empty outputBytes 失败 + AIProviderUnsupportedRequestError 失败 + AIProviderNotConfiguredError 内部 throw 失败 + race-safe（pre-existing 'failed' audit row 不被 worker 误用 + 行不被覆盖）+ FK foreign_key_check / integrity_check 全程干净。**回归 49 个 smoke 全绿**（含完整 P3-P9 契约 + P10.T1-T4 + 新 P10.T5；image-enhance-worker / image-thumbnail / image-metadata / image-quality-* 都不动证明 image 通道其他 worker 不受影响）。详见 `docs/progress.md`）
- [x] **P10.T6 [MUST]** 前端：未配置 AI 时按钮置灰并提示；配置后弹耗时 / 成本提示（2026-05-25 完成；新增 `client/src/api/health.ts` (`fetchHealth(signal?)` + 类型 `HealthResponse / HealthCapabilities / HealthStorage`，failure-soft 设计) + `client/src/hooks/useHealth.ts` (load on mount + `refetch()`，failure-soft 错误状态)；扩展 `client/src/api/media.ts`：新增 `aiRefineMedia(id)` + `AiRefineMediaResult / AiRefineOutcome` 类型，与 `enhanceMedia` 对称的 `created/reset/skipped` outcome + 可选 `aiInvocationId` 字段；扩展 `client/src/pages/MediaDetailPage.tsx`：(1) 在 image-only 的 EnhancementSection 内加入第 3 个 VersionCell `ai_refined`（active 标识 + 缺失时显示 "Not yet" 占位 + 🤖 emoji + 文案随 aiEnabledOnServer 动态变化）；(2) 新增 `Adopt AI refined` 按钮（仅当 ai_refined version 存在且未 active 时启用，与 enhance 按钮组共享 select pending 状态防并发）；(3) 新增 `AI Refine / Re-AI-refine` 按钮，title 文案与禁用规则三态：health loading → "Checking AI availability…"、`aiEnabled=false` → "AI provider is not configured on this server. Set AI_ENABLED=true + AI_PROVIDER to enable AI Refine."、pending → "Submitting…"、正常 → 描述成本/耗时；(4) 新增确认对话框 `aiRefineConfirmOpen` 复用 `modal-overlay` / `modal-card` 模式（Cancel + Run AI Refine 按钮、aria-modal、点 overlay 关闭、pending 时不可关闭），对话框 body 明确说明"counts against quota / async worker / 原图不变 / 可随时切回 original"；(5) 扩展 `EnhanceFeedback` 联合类型加入 `ai-refine-success` 变体（携带完整 `AiRefineMediaResult`）+ `error.op='ai-refine'`；(6) `EnhanceFeedbackBanner` 渲染 `ai-refine-success` 时展示 jobId 前 8 位 + aiInvocationId 前 8 位（mono 字体）+ outcome 自然语言（created/reset/skipped）+ 提示"Refresh to see ai_refined version"；error 时复用 form-error role=alert 红色 banner 含服务端错误 message（含 501 AI_NOT_CONFIGURED / 429 AI_QUOTA_EXCEEDED / 400 / 404 全部按服务端文案展示）；(7) refetchVersions 在确认 success 后触发让 P10.T5 worker 写入的 ai_refined 行通过 stale-while-revalidate hook 自动出现。**红线遵守**：image media only（非 image 不显示 AI Refine 按钮）；未配置 AI 时按钮置灰 + tooltip 解释；点击前必须经过 modal 二次确认；不调真实 provider；不改 P10.T5 worker / migration / quota 逻辑。验证：`npm run lint`（client） / `npm run typecheck`（client， tsc -b） / `npm run build`（client，vite + tsc 全 OK，61 modules transformed，gzip 72.10 kB JS + 4.27 kB CSS）全部干净；server smoke 抽检 5 个无回归（media-ai-refine-trigger 27/27、ai-quota-trigger 24/24、image-ai-refine-worker 34/34、media-versions-api 35/35、p9-acceptance 36/36）。详见 `docs/progress.md`）
- [x] **P10.T7 [MUST]** 阶段验收：§7.10 验收 5 条；未配置 AI 时基础功能不受影响（2026-05-25 完成；新增 `server/src/ai/LocalMockProvider.ts`：deterministic in-process provider（`name='local-mock'`, `available=true`, `supports={'image_ai_refine'}`, `LOCAL_MOCK_PROVIDER_NAME` + `LOCAL_MOCK_MODEL_NAME='local-mock-image-refine-v1'` 公开常量）。invoke() 用 sharp 做固定 `.modulate({brightness:1.02, saturation:0.92}).tint({r:240,g:235,b:220})` + `.jpeg({quality:85,mozjpeg:true})` 输出 deterministic JPEG（同输入产同输出）；空 inputBytes → `AIFailureResponse`（不抛）；sharp 抛错 → `AIFailureResponse` 包含 sharp 错误消息；**raw 字段刻意 omit**（R-134 闭合：写入 media_versions.params.raw 永远是 null）。AI factory 加 `local-mock` 分支（INFO 而非 WARN —— 这是 recognised 选择，日志含"do not use in production"提示）+ KNOWN_PROVIDER_IDS 加入 `'local-mock'`，case-insensitive after trim；扩展 `server/src/jobs/jobQueue.ts`：新增 `retryOverrides?: Readonly<Record<string, JobQueueRetryConfig>>` 可选构造参数，handleFailure / recoverZombies 都按 jobType 查表，命中则用 override 否则继承全局 retryConfig；boot 时 validate 每个 override 用与全局相同的轴；`server/src/index.ts` bootstrap 注入 `retryOverrides: { [IMAGE_AI_REFINE_JOB_TYPE]: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } }` 关闭 R-132（image_ai_refine retry 改为立即 terminal，user 显式 /ai-refine 触发新 audit 行）。新增 `smoke:p10-acceptance`（**37/37 PASS**）覆盖：(A) Factory 5 case（local-mock 选择、case-insensitive、AI 关闭时 Noop 优先）；(B) LocalMockProvider invoke 6 case（success / 输出非空且与输入不同 / outputBytes parse 为 JPEG / cost=0 + durationMs 有效 / responseSummary / **R-134 raw undefined**）+ 空输入返 AIFailureResponse；(C) 端到端 HTTP+worker 12 case（**R-135** /api/health.aiEnabled=true；POST /ai-refine 200 含 jobId+aiInvocationId；audit pending→success；media_versions.ai_refined row + width/height + model_name=local-mock-image-refine-v1；**R-134 闭合** params.raw=null + 无 sensitive keyword（api_key/token/secret/password/authorization/bearer）；ai_refined.jpg 落盘且 sharp parse 通过；**R-131 闭合** audit 直接 pending→success 跳过 running；scope-guard 原图不变 + media_items 列不变；GET /versions 含 ai_refined isActive=false；/storage 投递；400 video → no audit / 404 missing → no audit / 501 Noop → no audit / 429 quota gate 在 audit 之前 + **R-133** audit count 不变；**R-132 闭合** retryOverrides maxRetries=0 → tick1 claim+fail，tick2 claim 0，retry_count=0 永不 retry；**R-137** error.details 含 structured kind/limit/used 给未来 i18n；**R-136** response 含 jobId+aiInvocationId 给 UI；FK foreign_key_check + integrity_check 全程干净）。回归 51 个 server smoke 全绿（P3-P10 全套契约 + P10.T1-T7）。客户端 lint/typecheck/build 干净。**R-131 / R-132 / R-134 闭合**；**R-133 / R-135 / R-136 / R-137 disposition** 已在 progress.md 记录（V1 接受，可后续 polish）。详见 `docs/progress.md`）

---

## 阶段 11：视频智能剪辑（后续）

> requirements §7.13 / §7.14 / §14 阶段 11。LATER。

- [ ] **P11.T1 [LATER]** 视频基础优化（转码 / 防抖 / 音量归一化）
- [ ] **P11.T2 [LATER]** 剪辑方案生成（规则引擎 + 可选 AI）
- [ ] **P11.T3 [LATER]** `POST /api/videos/:id/generate-edit-plan`、`POST /api/videos/:id/render`
- [ ] **P11.T4 [LATER]** 前端：方案预览 / 调整 / 输出多时长版本
- [ ] **P11.T5 [LATER]** 阶段验收：§7.14 验收 5 条

---

## 横切任务（贯穿所有阶段）

- [ ] **X.T1 [MUST]** 自动化测试：每阶段为关键模块加单元测试，最小覆盖：classifier、dedup、quality_selector、queue 状态机、删除事务
- [ ] **X.T2 [MUST]** 集成测试：覆盖“上传 → 缩略图 → 去重 → 推荐 → 删除 → 恢复”主流程
- [ ] **X.T3 [SHOULD]** Lint / 格式化 / pre-commit 钩子
- [ ] **X.T4 [SHOULD]** CI（GitHub Actions 或本地脚本）：跑 build + test + lint
- [ ] **X.T5 [SHOULD]** 性能：100 张图片上传到全部缩略图完成的耗时基准（§15.1 验收 1）
- [ ] **X.T6 [LATER]** 文档：操作手册、运维 FAQ、故障排查指引

---

## 与需求的对应索引

| 需求章节 | 任务编号 |
|---|---|
| §7.1 Trip | P1.* |
| §7.2 上传 | P2.T4–T7 |
| §7.3 类型识别 | P2.T3 |
| §7.4 缩略图/元数据 | P3.* |
| §7.5 去重 | P5.* |
| §7.6 最佳质量 | P6.T5 / P6.T7 |
| §7.7 模糊检测 | P6.T2 |
| §7.8 曝光色彩 | P6.T3 / P6.T4 |
| §7.9 一键增强 | P8.* |
| §7.10 AI 精修 | P10.* |
| §7.11 视频上传 | P9.T2–T3 |
| §7.12 抽帧/切分 | P9.T5–T7 |
| §7.13 视频优化 | P11.T1 |
| §7.14 智能剪辑 | P11.T2–T4 |
| §7.15 相册展示 | P1.T6 / P2.T7 / P3.T6 / P5.T6 |
| §7.16 封面 | P6.T7 |
| §7.17 任务状态 | P4.* |
| §7.18 删除/恢复 | P7.* |

每完成一组任务后，回到 [design.md](design.md) §1 / §13 检查是否需要回填实际偏差。

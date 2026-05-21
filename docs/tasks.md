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

- [ ] **P9.T1 [MUST]** 迁移：`video_segments`
- [ ] **P9.T2 [MUST]** `video_metadata`：ffprobe 读时长 / 分辨率 / 帧率 / 码率 / 编码 / 音频
- [ ] **P9.T3 [MUST]** `video_cover`：FFmpeg 抽封面帧
- [ ] **P9.T4 [SHOULD]** `video_proxy`：720p 低清代理
- [ ] **P9.T5 [SHOULD]** `video_keyframes`：固定间隔抽帧
- [ ] **P9.T6 [SHOULD]** `video_segments` 固定时长切片（默认 10s，可配置）
- [ ] **P9.T7 [SHOULD]** 片段质量：模糊评分（关键帧）+ FFmpeg `blackdetect`
- [ ] **P9.T8 [SHOULD]** Video API（§9.5 中 segments / process）
- [ ] **P9.T9 [SHOULD]** 前端视频片段页（§10.7）
- [ ] **P9.T10 [MUST]** 阶段验收：§7.11 验收；§7.12 已实现部分验收

---

## 阶段 10：AI 扩展（可插拔）

> requirements §7.10 / §14 阶段 10。AI 默认关闭。

- [ ] **P10.T1 [MUST]** `AIProvider` 接口 + `NoopProvider`（默认）
- [ ] **P10.T2 [MUST]** 迁移：`ai_invocations`
- [ ] **P10.T3 [MUST]** `POST /api/media/:id/ai-refine`：仅在 `AI_ENABLED=true` 时入队 `image_ai_refine` 任务
- [ ] **P10.T4 [MUST]** 调用上限：每日 / 每 Trip
- [ ] **P10.T5 [MUST]** 写 `ai_invocations` + `media_versions(version_type='ai_refined', model_name=...)`
- [ ] **P10.T6 [MUST]** 前端：未配置 AI 时按钮置灰并提示；配置后弹耗时 / 成本提示
- [ ] **P10.T7 [MUST]** 阶段验收：§7.10 验收 5 条；未配置 AI 时基础功能不受影响

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

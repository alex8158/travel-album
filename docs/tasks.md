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

- [ ] **P4.T1 [MUST]** `JobQueue` 实现：抢占式拉取、按通道分组的并发控制、状态迁移、`started_at/finished_at`
  - 三类独立通道（实现层各自维护并发计数）：图片通道默认并发 `IMAGE_WORKER_CONCURRENCY=2`、视频通道默认 `VIDEO_WORKER_CONCURRENCY=1`、AI 通道默认 `AI_WORKER_CONCURRENCY=1`。
  - 严禁出现“所有任务共用一个并发上限”的实现；FFmpeg 子进程总数不得超过视频通道并发上限。
  - 视频任务出队执行前先检查 `ffmpegAvailable`，不可用直接以 `FFMPEG_NOT_AVAILABLE` 标记失败，不占用并发槽。
- [ ] **P4.T2 [MUST]** 失败重试与退避（max 3 次，指数退避，可配置）
- [ ] **P4.T3 [MUST]** 僵尸任务恢复（启动扫描 + 心跳超时阈值）
- [ ] **P4.T4 [MUST]** Job API：`GET /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/retry`、`POST /api/jobs/:id/cancel`
- [ ] **P4.T5 [MUST]** Media 状态联动：根据关键任务结果更新 `media_items.status`
- [ ] **P4.T6 [MUST]** 前端任务状态页（§10.8）
- [ ] **P4.T7 [MUST]** 阶段验收
  - 单文件失败不影响其他；重试后状态正确；僵尸任务可识别恢复。

---

## 阶段 5：图片去重

> requirements §7.5 / §14 阶段 5。

- [ ] **P5.T1 [MUST]** 迁移：`duplicate_groups`、`duplicate_group_items`
- [ ] **P5.T2 [MUST]** `image_hash` 任务：SHA256 + pHash + dHash
- [ ] **P5.T3 [MUST]** `Dedup_Engine.exact`：file_hash 相等聚合
- [ ] **P5.T4 [MUST]** `Dedup_Engine.similar`：pHash 海明距离 ≤ 阈值聚合（同 Trip 内）
- [ ] **P5.T5 [MUST]** Duplicate Group API（§9.4 全部）
- [ ] **P5.T6 [MUST]** 前端重复组列表 + 详情（§10.5）
- [ ] **P5.T7 [MUST]** 用户切换推荐图，写入 `user_confirmed`，自动流程不再覆盖
- [ ] **P5.T8 [MUST]** 阶段验收：§7.5 验收 7 条

---

## 阶段 6：图片质量评分

> requirements §7.6 / §7.7 / §7.8（曝光/色彩属 SHOULD）/ §14 阶段 6。

- [ ] **P6.T1 [MUST]** 迁移：`media_analysis`
- [ ] **P6.T2 [MUST]** `image_quality.blur`：Laplacian variance（缩放归一化），写 `blur_score / sharpness_score / is_blurry`，三档（clear / maybe_blurry / blurry）
- [ ] **P6.T3 [SHOULD]** `image_quality.exposure`：直方图判过曝/欠曝
- [ ] **P6.T4 [SHOULD]** `image_quality.color`：偏色检测
- [ ] **P6.T5 [MUST]** `Quality_Selector`：组内排序、生成 `recommended_media_id` 与 `reason`，跳过已被 `user_confirmed` 的组
- [ ] **P6.T6 [MUST]** 前端：模糊徽章、推荐徽章、推荐原因展示
- [ ] **P6.T7 [MUST]** 启用自动最佳封面选择
  - 策略：当用户未手动指定（`trips.cover_media_id` 为 `NULL` 或先前由系统写入）时，取该 Trip 中 quality_score 最高、未被软删除的图片，**写入** `trips.cover_media_id`。
  - 用户曾手动设置（通过 `POST /api/trips/:id/cover`）的 Trip 不得被自动覆盖；区分方式建议加 `trips.cover_set_by_user`（迁移补字段，或用单独标志位）。
  - 自动选择应在质量评分完成后异步触发（例如新增 `trip_cover_refresh` 任务），避免阻塞主流程；P3.T8 的响应层临时封面在 `cover_media_id` 写入后自动失效。
- [ ] **P6.T8 [MUST]** 阶段验收：§7.6 / §7.7 验收；上传足够图片后 Trip 封面会自动收敛到 quality_score 最高的图片，且用户手动设置不被覆盖。

---

## 阶段 7：安全删除与恢复

> requirements §7.18 / §14 阶段 7。
>
> **第一轮主流程仅做软删除 + 恢复（P7.T1–T6）**。永久删除（P7.T7–T9）作为预留，前置条件是 P7.T1–T6 全部完成且自动化测试通过；在此之前，永久删除接口默认禁用（`PERMANENT_DELETE_ENABLED=false`，返回 `PERMANENT_DELETE_DISABLED`）。

第一轮（必须完成）：

- [ ] **P7.T1 [MUST]** 软删除路径：`DELETE /api/media/:id` 设 `deleted_at`，先重置 `duplicate_groups.recommended_media_id`、清 `duplicate_group_items` 标记
- [ ] **P7.T2 [MUST]** 恢复路径：`POST /api/media/:id/restore`，事务内复位 `deleted_at`、`status`，重新参与去重评估但不覆盖已 `user_confirmed` 的组
- [ ] **P7.T3 [MUST]** 重复组批量删除：`POST /api/duplicate-groups/:id/delete-others` 走软删除路径
- [ ] **P7.T4 [MUST]** 前端：回收站视图（列出 `deleted_at` 不为空的媒体）、恢复按钮、软删除二次确认提示“可恢复”
- [ ] **P7.T5 [MUST]** 自动化测试：
  - 删除推荐图后该重复组 `recommended_media_id` 被正确重置
  - 删除一张组内图片不会触发 `FOREIGN KEY constraint failed`
  - 删除后再恢复，状态字段、关联记录、`duplicate_groups` 评估都正确恢复
  - 跨表外键路径（media_analysis / duplicate_group_items / media_versions / video_segments / processing_jobs）遍历检查
- [ ] **P7.T6 [MUST]** 第一轮阶段验收：requirements §7.18 验收前 4 条 + “删除图片不会出现 FOREIGN KEY 错误”

预留（**前置条件：P7.T1–T6 全部完成并通过测试，再执行**）：

- [ ] **P7.T7 [LATER]** 永久删除接口（事务 + 二次确认 token + `PERMANENT_DELETE_ENABLED=true` 才放开）：CASCADE 清关联、最后删文件、文件失败写补偿日志
- [ ] **P7.T8 [LATER]** 前端：永久删除入口（仅当 `/api/health` 返回 `permanentDeleteEnabled=true` 时显示）+ 二次确认弹窗（明确不可逆）
- [ ] **P7.T9 [LATER]** 永久删除阶段验收：requirements §7.18 验收第 5–6 条（“永久删除前需要二次确认”、“删除失败时能看到错误原因”）；孤儿文件清理任务可用

---

## 阶段 8：图片自动增强

> requirements §7.9 / §14 阶段 8。

- [ ] **P8.T1 [MUST]** `POST /api/media/:id/enhance` 入队 `image_enhance` 任务
- [ ] **P8.T2 [MUST]** sharp 增强管线：白平衡 / 曝光 / 对比度 / 锐化 / 降噪（参数走 config）
- [ ] **P8.T3 [MUST]** 输出 `derived/{mediaId}/enhanced.jpg`，写 `media_versions(version_type='enhanced')`
- [ ] **P8.T4 [MUST]** 版本切换 API：`GET /api/media/:id/versions`、`POST /api/media/:id/select-version`
- [ ] **P8.T5 [MUST]** 前端：原图 vs 增强图对比、采用 / 放弃、重新增强
- [ ] **P8.T6 [MUST]** 阶段验收：原图未被覆盖；失败可回退；不过度饱和锐化

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

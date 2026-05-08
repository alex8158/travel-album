# Travel Album Site V2

面向旅行图片与视频素材的智能相册系统。以 Trip 为组织维度，自动完成上传、分类、缩略图、去重、模糊检测、质量评分、视频抽帧与候选片段筛选；按需调用 AI 完成图片精修与视频智能剪辑；保留全部原始文件，仅给出删除建议而不自动永久删除。

## 当前状态

项目处于早期骨架阶段。已完成：

- [docs/requirements.md](docs/requirements.md)：需求规格说明书（不可改）。
- [docs/design.md](docs/design.md)：系统设计基线。
- [docs/tasks.md](docs/tasks.md)：可执行任务清单。
- [CLAUDE.md](CLAUDE.md)：AI 开发助手必须遵守的硬性规则与产品红线。

尚未初始化前后端 npm 工程、数据库、Worker。后续按 `docs/tasks.md` 中 P0–P11 的顺序逐项推进。

## 系统级依赖

本项目的视频处理路径强依赖宿主机上已安装的 `ffmpeg` 与 `ffprobe` 二进制（`fluent-ffmpeg` 仅是 Node 封装层，**不附带**这两个可执行文件）。

### 安装

| 平台 | 命令 |
|---|---|
| macOS (Homebrew) | `brew install ffmpeg` |
| Ubuntu / Debian | `sudo apt-get update && sudo apt-get install -y ffmpeg` |
| Fedora / RHEL | `sudo dnf install -y ffmpeg` |
| Arch | `sudo pacman -S ffmpeg` |
| Windows | 从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载并加入 `PATH` |

安装后可用 `ffmpeg -version` 与 `ffprobe -version` 验证。

### 缺失时的行为

按 [docs/design.md](docs/design.md) §8.4，服务启动会自动探测 `ffmpeg` / `ffprobe`：

- **未安装时**：服务**不退出**，仅在启动日志中输出明确警告。
- **图片处理路径**（缩略图、EXIF、hash、模糊检测、质量评分、增强等）**完全不受影响**。
- **视频处理任务**会以错误码 `FFMPEG_NOT_AVAILABLE` 直接失败，前端在视频媒体卡片上显示“视频处理不可用”徽章。
- 安装好 ffmpeg/ffprobe 并重启服务后，可在前端对失败的视频任务发起重试。

如需自定义二进制路径（如非标准安装位置），可在 `.env` 中设置 `FFMPEG_PATH` 与 `FFPROBE_PATH`（环境变量定义见 P0.T4）。

## 其他依赖

- **Node.js**：`>=20.11.0`（在 `server/package.json` 的 `engines` 中声明，覆盖 Node 20 LTS 与更新版本）。
- **SQLite**：第一版数据库，通过 `better-sqlite3`（npm 包，自带 SQLite 引擎，原生模块在 `npm install` 时下载预编译二进制）。无需在系统层安装 sqlite3。
- **磁盘空间**：原始图片 / 视频 + 派生文件均落盘到 `storage/`，请预留足够空间。

## 开发命令

> 后端启动会先加载 `.env`（先找 `server/.env`，再找仓库根 `.env`，先到先得），由 [`server/src/config/index.ts`](server/src/config/index.ts) 用 zod 校验。`.env.example` 已列出全部变量；只有 `NODE_ENV` 没有默认值，缺失时启动会以非零退出码报错。

首次拉取后请先准备 `.env`：

```bash
cp .env.example .env   # 仓库根；按需修改 NODE_ENV / PORT / 阈值等
# 或：cp .env.example server/.env
```

后端（`server/`，由 P0.T2 初始化、P0.T4 接入配置层）：

```bash
cd server
npm install            # 首次安装依赖
npm run build          # tsc 编译到 dist/
npm run typecheck      # 仅做类型检查，不输出
npm run dev            # tsx watch 热重载启动 src/index.ts
npm run start          # 运行已构建的 dist/index.js
npm run lint           # ESLint
npm run lint:fix       # ESLint 自动修复
npm run format         # Prettier 写入
npm run format:check   # Prettier 仅检查
```

> 当前 `server/src/index.ts` 启动时做：加载配置 → 打开 SQLite → 跑迁移 → 创建 Express → 监听端口 → 注册优雅关停。HTTP 真实业务路由、Worker、ffmpeg 检测等功能将在后续任务（P0.T7 起）逐步引入。

### 数据库与迁移（P0.T5）

- **位置**：默认 `<repo>/data/app.db`（由 `DATABASE_PATH` 控制）。`DATABASE_PATH` 写相对路径时以**仓库根**解析，绝对路径直通；启动时父目录会自动创建。WAL 模式会额外产生 `app.db-wal` / `app.db-shm` 两个旁路文件，已被 `.gitignore` 排除。
- **迁移目录**：`server/migrations/`，文件按文件名升序执行；当前只有一个 `000_init.sql`，仅设置持久 PRAGMA（`application_id` / `user_version`）和注释，不创建任何业务表。后续阶段（P1.T1 起）每个表用独立迁移文件。
- **迁移记录表**：`_schema_migrations(name PRIMARY KEY, applied_at)`，迁移已应用即跳过，不会重复执行。
- **PRAGMA**：连接级 `foreign_keys = ON` 与 `journal_mode = WAL` 在 `server/src/db/connection.ts` 中设置；启动摘要会打印实测值，可肉眼确认。
- **如何执行迁移**：`npm run dev` / `npm start` 启动时会自动执行所有未应用的迁移；目前没有独立的 `db:migrate` CLI（按需在后续任务中加入）。
- **如何验证**：
  ```bash
  cd server
  npm start
  # 摘要中应看到：
  #   PRAGMA foreign_keys       = 1
  #   PRAGMA journal_mode       = wal
  #   migrations applied now    = 000_init.sql   （首次启动）
  #   migrations applied now    = (none)         （再次启动）
  #   migrations already done   = 000_init.sql   （再次启动）
  ```
  也可以直接 `sqlite3 data/app.db ".tables"` 看到 `_schema_migrations` 表。

### 日志与错误响应（P0.T6）

- **日志**：`pino`（v9）。开发环境（`NODE_ENV=development`）走 `pino-pretty`，彩色单行可读输出；测试 / 生产输出 line-delimited JSON。日志级别默认 `debug`(dev) / `warn`(test) / `info`(prod)，可被 `LOG_LEVEL` 覆盖。
- **每个请求**一行结构化日志，字段：`requestId`、`method`、`path`、`statusCode`、`durationMs`；`5xx → error`，`4xx → warn`，其他 `info`。
- **requestId**：入站若带合理的 `x-request-id` 头（≤128 字符）则透传，否则用 `crypto.randomUUID()` 生成；同名头会回写到响应里。
- **错误响应统一格式**：

  ```json
  {
    "error": {
      "code": "BAD_REQUEST",
      "message": "demo bad request",
      "requestId": "8f3c…",
      "details": { "hint": "..." }
    }
  }
  ```

  `details` 仅在 `AppError` 携带时出现；未知错误固定回 `code=INTERNAL_ERROR` + `message="Internal server error"`，**永不外泄堆栈或内部信息**（堆栈只写日志）。
- **如何本地验证**（启动 `npm run dev` 后）：

  ```bash
  curl -i http://localhost:3000/api/ping                  # 200，{"status":"ok",...}
  curl -i http://localhost:3000/no-such-path              # 404, code=NOT_FOUND
  curl -i http://localhost:3000/__debug/app-error         # 400, code=BAD_REQUEST，含 details
  curl -i http://localhost:3000/__debug/throw             # 500, code=INTERNAL_ERROR，stack 不外泄
  ```

  `/__debug/*` 仅在 `NODE_ENV !== "production"` 注册，用于本任务及后续验证。

### 存储层（P0.T7）

- **抽象接口**：`StorageProvider`（[server/src/storage/StorageProvider.ts](server/src/storage/StorageProvider.ts)）。第一版只有 `LocalStorageProvider` 实现；S3 后续接入时只需新增实现类，业务代码无需改动。
- **目录布局**（按 [docs/design.md](docs/design.md) §5.2）：

  ```
  {STORAGE_LOCAL_ROOT}/
    trips/
      {tripId}/
        originals/
          {mediaId}.{ext}             # putOriginal —— 永不覆盖
        derived/
          {mediaId}/
            thumb.webp
            preview.webp
            enhanced.jpg
            video_cover.jpg
            frames/{name}.jpg          # putDerived 支持任意嵌套相对路径
            segments/{name}.mp4
  ```

  `STORAGE_LOCAL_ROOT` 默认 `./storage`，相对路径以仓库根解析；启动时 `LocalStorageProvider.create()` 会同步 `mkdirSync` 创建。
- **接口契约**：
  - `putOriginal({tripId, mediaId, extension, data})` → 拒绝覆盖，已存在抛 `STORAGE_ALREADY_EXISTS`。
  - `putDerived({tripId, mediaId, relPath, data, overwrite=false})` → 默认拒绝覆盖；显式 `overwrite: true` 才替换。
  - `read(logicalPath)` → 返回 Readable 流；不存在抛 `STORAGE_NOT_FOUND`。
  - `remove(logicalPath)` → 返回 `{removed: boolean}`；不存在不当作错误，`removed=false` 给出明确信号。
  - `exists(logicalPath)` → 布尔；IO/权限错误仍抛。
- **路径安全**：每个输入都过 `pathUtils.ts` 三层校验（每段正则 → POSIX 归一化 → `path.relative` 二次确认不出根）；`/`, `\`, `..`, null byte、绝对路径等全部拦截，统一抛 `STORAGE_INVALID_KEY` 或 `STORAGE_PATH_TRAVERSAL`。
- **错误模型**：`StorageError extends AppError`，可被全局 errorHandler 直接渲染成 P0.T6 的统一错误响应。
- **如何手动验证**：
  ```bash
  cd server
  npm run smoke:storage
  # 在临时目录里跑完 putOriginal / putDerived / read / remove / exists
  # + 8 个路径越权 / 非法键的负面用例，全部应输出 PASS。
  ```
  也可直接启动 server：
  ```bash
  cd server && npm start
  # 启动日志中应看到 "storage initialised"，含 resolvedRoot 绝对路径。
  ```

### 运行时能力检测 / `/api/health`（P0.T8）

- **启动一次性探测**：server 启动序列里在 storage 初始化之后并行 spawn `ffmpeg -version` 与 `ffprobe -version`（每个 3 秒超时，不走 shell，不可注入），结果冻结进 `Capabilities` 快照。后续 `/api/health` 与未来的视频 Worker（design §8.4）只读这个内存快照，不再 spawn。
- **缺失行为**：
  - ffmpeg 或 ffprobe 缺失时，server **正常启动**（不 exit），日志写一条 `warn`，含命令、错误原因（`ENOENT` / `timed out` 等）与安装提示。
  - 视频任务在出队时会按 `capabilities.ffmpegAvailable` 检查；失败用 `FFMPEG_NOT_AVAILABLE` 错误码（已在 P0.T6 errorCodes 中注册）。
  - 图片处理路径完全不受影响。
- **`/api/health` 响应示例**（默认环境，ffmpeg 已装）：

  ```json
  {
    "status": "ok",
    "requestId": "9b4f…",
    "capabilities": {
      "ffmpegAvailable": true,
      "ffmpegVersion": "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers",
      "ffprobeAvailable": true,
      "ffprobeVersion": "ffprobe version 8.1 Copyright (c) 2007-2026 the FFmpeg developers",
      "permanentDeleteEnabled": false,
      "aiEnabled": false
    },
    "storage": {
      "available": true,
      "resolvedRoot": "/abs/path/to/storage"
    }
  }
  ```

  > 不暴露 `ffmpegPath` / `ffprobePath` 与错误原文 — 这些只进启动日志。
- **如何手动验证**：

  ```bash
  cd server && npm start
  curl -s http://localhost:3000/api/health | jq

  # 强制 ffmpeg 缺失（路径打偏）：
  FFMPEG_PATH=/no/such/binary NODE_ENV=development npm start
  # 启动日志：[warn] ffmpeg not available + 安装提示
  # /api/health: ffmpegAvailable=false, ffmpegVersion=null
  # ffprobeAvailable 仍按 PATH 中 ffprobe 决定。
  ```
- **`/api/ping` 仍保留**：极轻量 liveness，不跑探测，适合编排器健康检查。

### Trip 领域层（P1.T2）

- **位置**：[server/src/trips/](server/src/trips/)。分四个文件：`tripTypes.ts`（类型）、`tripSchemas.ts`（zod 校验）、`tripRepository.ts`（DB 访问）、`tripService.ts`（业务规则与错误翻译）。`index.ts` 是 barrel。
- **接口**：
  - `TripService.createTrip(input)` — `crypto.randomUUID()` 生成 id，初始 `createdAt === updatedAt`。
  - `TripService.listTrips(options?)` — 默认仅返回 `deleted_at IS NULL`，按 `created_at DESC` 排序；`{ includeDeleted: true }` 才显示软删除项。
  - `TripService.getTripById(id)` — 不存在或已软删均抛 `NotFoundError(404)`。
  - `TripService.updateTrip(id, patch)` — 仅写出现的字段；`updated_at` 由 Repository 兜底刷新；DB CHECK 触发时翻译为 `ValidationError(400)`。
  - `TripService.softDeleteTrip(id)` — `UPDATE … WHERE deleted_at IS NULL`；命中 0 行抛 `NotFoundError`。
- **校验规则**：
  - id 格式 `/^[A-Za-z0-9_-]{1,128}$/`（与 storage 层完全一致，UUID 包含其中）。
  - 日期 `YYYY-MM-DD` 正则 + 日历有效性 refine（拒 `2024-02-30` 这种）。
  - 跨字段：两端都填时 `endDate >= startDate`；只填一端的更新由 DB CHECK 兜底，Service 翻译错误码。
  - `title` 自动 `trim()`，trim 后长度必须 ≥ 1。
  - 严格模式 `.strict()`：未知字段直接拒。
- **如何手动验证**：
  ```bash
  cd server
  npm run smoke:trips
  # 预期 22/22 PASS（含 11 项负面用例覆盖 zod 与 DB CHECK 翻译）
  ```

### Trip API 路由（P1.T3）

挂载在 `/api/trips`，由 [server/src/routes/trips.ts](server/src/routes/trips.ts) 实现。所有 handler 通过 `asyncHandler`（[server/src/middleware/asyncHandler.ts](server/src/middleware/asyncHandler.ts)）兜底 Promise rejection，错误统一走 P0.T6 的 errorHandler，响应都带 `requestId`。

| 方法 路径 | 状态码 | 成功响应 |
|---|---|---|
| `POST /api/trips` | 201 | `{ "trip": { ... } }` |
| `GET /api/trips` | 200 | `{ "trips": [ ... ] }` |
| `GET /api/trips/:id` | 200 | `{ "trip": { ... } }` |
| `PATCH /api/trips/:id` | 200 | `{ "trip": { ... } }` |
| `DELETE /api/trips/:id` | 200 | `{ "deleted": true }` |
| `POST /api/trips/:id/cover` | 200 | `{ "trip": { ... } }`，body `{ "coverMediaId": "..." }` |

校验在两层：

- **路由层**：id 不为空（`req.params.id`）、PATCH 非空 body、`POST /:id/cover` 必填且只接 `coverMediaId`。
- **Service 层**：通过 P1.T2 的 zod schemas 校验所有字段（标题、日期、跨字段顺序等）；UUID / 实体 id 格式与 storage 层完全一致。

错误一律返回统一形态：

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "requestId": "..." } }
```

`code` 取值：`VALIDATION_FAILED`(400)、`NOT_FOUND`(404)、`INTERNAL_ERROR`(500)。

`GET /api/trips` 支持两个 query 参数（路由层 zod 校验，超范围直接 400）：

| 参数 | 默认 | 范围 |
|---|---|---|
| `limit`  | 50 | 1 ≤ limit ≤ 100 |
| `offset` | 0  | offset ≥ 0 |

未知 query key 静默忽略，不会触发 400。

`POST /:id/cover` 仅做 `coverMediaId` 的格式校验，不验存在性（media_items 表在 P2.T1 才建）。返回的 trip 中 `coverMediaId` 直接是 path-safe 字符串，前端封面 URL 由后续阶段的 storage / 数据库连结实现。

curl 示例：

```bash
# 创建
curl -i -X POST http://localhost:3000/api/trips \
  -H "Content-Type: application/json" \
  -d '{"title":"Tokyo 2026","destination":"Tokyo"}'

# 列表
curl -s http://localhost:3000/api/trips | jq

# 获取
curl -s http://localhost:3000/api/trips/<UUID> | jq

# 更新
curl -i -X PATCH http://localhost:3000/api/trips/<UUID> \
  -H "Content-Type: application/json" \
  -d '{"description":"Spring break"}'

# 设置封面（仅格式校验）
curl -i -X POST http://localhost:3000/api/trips/<UUID>/cover \
  -H "Content-Type: application/json" \
  -d '{"coverMediaId":"some-media-id-001"}'

# 软删除
curl -i -X DELETE http://localhost:3000/api/trips/<UUID>
```

前端（`client/`，由 P0.T3 初始化）：

```bash
cd client
npm install            # 首次安装依赖
npm run dev            # Vite dev server，默认 http://localhost:5173
npm run build          # 类型检查 + 生产打包到 dist/
npm run preview        # 预览生产构建
npm run typecheck      # tsc -b（仅类型检查）
npm run lint           # ESLint
npm run lint:fix       # ESLint 自动修复
npm run format         # Prettier 写入
npm run format:check   # Prettier 仅检查
```

> 当前 `client/src/App.tsx` 只挂了 `/` 首页占位与 `*` 404 兜底；其余业务路由按 [docs/design.md](docs/design.md) §2.2 在各自任务中逐步引入。

## 开发执行规则

任何代码修改前请阅读 [CLAUDE.md](CLAUDE.md)，重点规则：

1. 一次只执行 [docs/tasks.md](docs/tasks.md) 中的一个任务。
2. 原始图片 / 视频不得被覆盖；派生文件全部走 `media_versions` / `video_segments` 等表关联。
3. 系统不得自动永久删除任何素材，第一轮主流程仅启用软删除 + 恢复。
4. 删除媒体前必须先处理外键关联（含 `duplicate_groups.recommended_media_id` 重置）。
5. AI 调用默认关闭；未配置 AI 时基础功能必须完全可用。
6. 不提交真实密钥；仅 `.env.example` 入库。

## 目录结构（计划态）

```
travel-album/
  CLAUDE.md            # AI 协作规则
  README.md            # 本文件
  .gitignore
  .editorconfig
  docs/
    requirements.md
    design.md
    tasks.md
  server/              # 待 P0.T2 初始化（Node + TS + Express）
  client/              # 待 P0.T3 初始化（React + TS + Vite）
  storage/             # 运行时文件（gitignore）
  data/                # SQLite 文件（gitignore）
```

## 许可证

暂未指定（后续在合适阶段补充）。

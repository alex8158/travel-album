# Travel Album Site V2 — 项目进度

本文件记录项目按 [docs/tasks.md](tasks.md) 推进的阶段性进度，作为 commit 历史与任务清单之上的高层视图。每个阶段汇总：状态、完成任务、主要成果、对应 commit、验证方式、剩余风险、下一阶段入口。

任务定义本身仍以 [docs/tasks.md](tasks.md) 为准；本文件只追加完成总结，不修改任务清单。

约定：

- 状态取值：`未开始` / `进行中` / `已完成` / `已暂停`。
- Commit 哈希以 7 字符短形式记录，对应 `git log --oneline`。
- 验证命令默认在 server / client 子工程目录下执行。

---

## 阶段 P0：项目骨架

- 状态：**已完成**
- 任务范围：P0.T1 – P0.T8（8 / 8）
- 提交范围：`9287d07` … `539edf0`
- 完成日期：2026-05-08

### 已完成任务

#### P0.T1 项目文档与 git 初始化

- Commit：`9287d07` chore: initialize project docs and git config
- 主要成果：
  - 创建 [CLAUDE.md](../CLAUDE.md)、[docs/design.md](design.md)、[docs/tasks.md](tasks.md)（在已有 [docs/requirements.md](requirements.md) 之上生成）
  - 加入 `.gitignore`（忽略 `node_modules/`、`storage/`、`data/`、`.env`、构建产物等）、`.editorconfig`
  - 初版 [README.md](../README.md) 含项目简介与系统级 `ffmpeg` / `ffprobe` 依赖说明
- 备注：未引入业务代码

#### P0.T2 后端 TypeScript 工程骨架

- Commit：`ffb6d8d` chore(server): scaffold backend TypeScript project (P0.T2)
- 主要成果：
  - `server/package.json`：脚本 `build / dev / start / typecheck / lint / lint:fix / format / format:check`，engines `node >=20.11.0`
  - `server/tsconfig.json`：strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`，`src/ → dist/`
  - ESLint 9 flat config（`@eslint/js` + `typescript-eslint` + `eslint-config-prettier`）+ Prettier
  - `server/src/index.ts` 占位入口
- 验证：`npm run build / typecheck / lint / format:check` 全通过

#### P0.T3 前端 React + Vite + TypeScript 工程骨架

- Commit：`cae986e` chore(client): scaffold frontend React + Vite + TS project (P0.T3)
- 主要成果：
  - `client/`：Vite 5 + React 18 + TypeScript + react-router-dom 6
  - 路由壳子：`/` 首页占位 + `*` 404；其余业务路由按 design §2.2 在 `App.tsx` 注释中预留
  - ESLint flat config（含 `react-hooks` / `react-refresh`）+ Prettier
- 验证：`npm run build / typecheck / lint / format:check` 全通过；`npm run dev` 可起 5173 端口

#### P0.T4 集中配置层 + `.env.example`

- Commit：`1e0b17e` feat(server): centralised config layer with zod validation (P0.T4)
- 主要成果：
  - `server/src/config/index.ts`：dotenv 加载（`server/.env` → `<repo>/.env`，先到先得）+ zod 校验，按分组导出 `Config`
  - 新增 25 个环境变量；`NODE_ENV` 必填，其余有默认值
  - superRefine 跨字段校验：`BLUR_THRESHOLD_MAYBE > BLUR_THRESHOLD_BLURRY`、四个 `QUALITY_WEIGHT_*` 之和约等于 1.0、`AI_ENABLED=true` 时 `AI_PROVIDER` 必填
  - 仓库根 [.env.example](../.env.example) 列出全部变量并标注 ffmpeg 系统依赖
- 验证：缺失 `NODE_ENV` 启动报错；多个非法值聚合输出；跨字段三条校验均命中

#### P0.T5 SQLite 连接 + migration runner

- Commit：`4495115` feat(server): SQLite connection + migration runner (P0.T5)
- 主要成果：
  - `server/src/db/connection.ts`：开 SQLite；相对路径以仓库根锚定（CWD 无关）；自动 mkdir 父目录；启用 `foreign_keys=ON`、`journal_mode=WAL`
  - `server/src/db/migrate.ts`：`_schema_migrations` 跟踪表（STRICT），按文件名升序执行未应用的 `*.sql`，每个迁移独立事务
  - `server/migrations/000_init.sql`：仅设置事务安全的持久 PRAGMA（`application_id`、`user_version`），不创建业务表
- 验证：首次启动创建 `data/app.db` 并 apply 1 个迁移；二次启动 alreadyApplied=1、applied=0；`sqlite3 data/app.db ".tables"` 可见 `_schema_migrations`

#### P0.T6 结构化日志 + 统一错误响应

- Commit：`4022c9b` feat(server): structured logging + unified error responses (P0.T6)
- 主要成果：
  - `pino` 日志：dev 走 `pino-pretty`，test/prod 走 line-delimited JSON；级别可被 `LOG_LEVEL` 覆盖
  - `requestId` 中间件：透传可信入站 `x-request-id`（≤128 字符），否则生成 UUID；写到 `req.requestId` 与响应头
  - request logger：每条完成响应记录 `method / path / statusCode / durationMs`，按状态选 level（5xx error / 4xx warn / 其他 info）
  - `AppError` 基类 + 便利子类（`NotFoundError` / `BadRequestError` / `ValidationError`）+ `ERROR_CODES` 常量（按 design §10.2）
  - 统一 errorHandler：404 转 `NotFoundError`；AppError 渲染自身 `code / message / requestId / details`；未知错误固定回 `INTERNAL_ERROR`，**堆栈不外泄**（仅写日志）
  - 优雅关停：SIGINT / SIGTERM / uncaughtException 走同一关停路径；10 秒强制退出兜底
- 验证：`/api/ping` 200、`/no-such-path` 404、`/__debug/app-error` 400、`/__debug/throw` 500（响应不含 stack）；客户端 `x-request-id` 透传；`kill -TERM <pid>` 优雅退出 0

#### P0.T7 StorageProvider 抽象 + LocalStorageProvider

- Commit：`50a0e9b` feat(server): StorageProvider abstraction + LocalStorageProvider (P0.T7)
- 主要成果：
  - 接口 `StorageProvider`：`putOriginal / putDerived / read / remove / exists`
  - `LocalStorageProvider`：相对路径以仓库根锚定；启动时同步 mkdir 根目录；`putOriginal` 永不覆盖；`putDerived` 默认拒绝覆盖（`overwrite=true` 才替换）
  - `storage/pathUtils.ts` 三道闸路径校验（每段正则 → POSIX 归一化 → `path.relative` 二次确认不出根）
  - `StorageError extends AppError` + 5 个新错误码（`STORAGE_INVALID_KEY` / `STORAGE_PATH_TRAVERSAL` / `STORAGE_ALREADY_EXISTS` / `STORAGE_NOT_FOUND` / `STORAGE_IO_ERROR`）
  - 手动 smoke 脚本 `npm run smoke:storage`：19 项用例，覆盖 5 个方法的正面路径与 8 项路径越权 / 非法键负面用例
  - `.gitignore` 改为 root-anchored（`/storage/` `/data/`），避免误伤 `server/src/storage/` 源码目录
- 验证：`npm run smoke:storage` → 19 / 19 PASS；启动日志含 `storage.resolvedRoot`

#### P0.T8 ffmpeg / ffprobe 启动检测 + `/api/health`

- Commit：`539edf0` feat(server): ffmpeg/ffprobe startup detection + /api/health (P0.T8)
- 主要成果：
  - `server/src/media/ffmpegProbe.ts`：`child_process.spawn`（不走 shell，不可注入），3 秒 SIGKILL 超时；永不抛错，错误化为字段
  - `server/src/runtime/capabilities.ts`：并行探测 ffmpeg / ffprobe，结果 `Object.freeze`；缺失打 `warn` + 安装提示，可用打 `info`
  - `server/src/routes/health.ts`：`GET /api/health` 投影 `Capabilities` 中的非敏感子集 + `storage.resolvedRoot`；不暴露 `ffmpegPath / ffprobePath / error` 原文
  - 缺失行为：server 不退出，HTTP 端口正常监听，`/api/health` 中对应字段为 `false` / `null`，图片处理路径不受影响
  - 一次性检测：`/api/health` 只读启动快照，不在每次请求时 spawn
- 验证：默认环境 → 两者 available + 版本字符串；`FFMPEG_PATH=/no/such` → ffmpegAvailable=false 但 ffprobe 仍可用；两者都缺失 → server 仍正常服务；连发 3 次 health 后启动日志中 probe 数仍为 2

### 阶段 P0 验证命令

每个任务完成后均跑过下列检查；阶段结束时集中复跑：

后端（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage         # P0.T7 引入，预期 19 / 19 PASS
```

前端（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

启动手动验证（后端构建之后）：

```bash
NODE_ENV=development node server/dist/index.js
curl -s http://localhost:3000/api/ping
curl -s http://localhost:3000/api/health
```

### 阶段 P0 剩余风险

下列风险均已知，**不在 P0 阻断范围**，按所列触发条件跟进：

| 编号 | 风险 | 触发跟进的时机 |
|---|---|---|
| R-01 | Vite 5 → esbuild 的 2 个 moderate 漏洞（GHSA-67mh-4wv8-2f99）暂不处理 | 后续统一评估升级 Vite |
| R-02 | `prebuild-install` deprecation 警告（better-sqlite3 传递依赖）不影响运行 | 上游修复或 better-sqlite3 替代时处理 |
| R-03 | Express 4 async route 错误捕获尚未统一封装 | 首次引入 async route 时补 `asyncHandler` 或 `express-async-errors` |
| R-04 | `/api/health` 未加鉴权与 IP 限流 | 公网部署前必须加 token / IP allowlist |
| R-05 | `storage.resolvedRoot` 在 health 响应中暴露绝对路径 | 生产模式建议隐藏或只返回短标识 |
| R-06 | `StorageProvider` 未做 symlink realpath 防护 | 开放写权限给外部前必须加固 |
| R-07 | `StorageProvider` 不做磁盘配额检查 | 上传层（P2.T4 起）需要限制文件大小 |
| R-08 | SQLite migration 无 checksum / down migration | 测试框架或迁移工具升级时补 |
| R-09 | `better-sqlite3` 为同步 API，大量查询时可能阻塞 event loop | Worker 拆出独立进程时再评估 |
| R-10 | `Capabilities` 是启动快照，运行中安装或移除 ffmpeg 不会自动刷新 | 后续若加 hot-reload 能力时处理 |
| R-11 | 未引入 Vitest / RTL 自动化测试 | 横切任务 X.T1 统一接入 |
| R-12 | CORS / rate limit / auth 暂未实现 | 公网部署前必须补 |

---

## 阶段 P1：Trip 管理 CRUD

- 状态：**已完成**（4 PASS + 2 PARTIAL，PARTIAL 项均明确依赖 P2）
- 任务范围：P1.T1 – P1.T8（8 / 8）
- 提交范围：`ccfa85f` … `90f7adb`
- 完成日期：2026-05-08

### 已完成任务

#### P1.T1 trips 表 migration（含软删除）

- Commit：`ccfa85f` feat(server): trips table migration with soft delete (P1.T1)
- 主要成果：
  - `server/migrations/001_create_trips.sql`：STRICT 表，按 [docs/requirements.md](requirements.md) §8.1 字段（`destination` 取代 `location` 以匹配前端表单措辞）
  - 约束 `trips_title_not_blank`（CHECK `length(trim(title)) > 0`）+ `trips_date_order`（CHECK `end >= start` when both set）
  - 索引：`idx_trips_created_at` / `idx_trips_deleted_at` / `idx_trips_destination`
  - `cover_media_id` 故意不加 FK（media_items 在 P2.T1 才建；SQLite 不支持 ALTER TABLE ADD CONSTRAINT，留作后续表重建迁移）
- 验证：清空 DB 后启动 → `appliedNow: ["000_init.sql", "001_create_trips.sql"]`；二次启动 → `alreadyApplied` 含两条；9 个 INSERT 测试用例（合法 / 空 title / 反序日期 / NULL title / 重复 PK 等）行为全部正确

#### P1.T2 Trip Repository + Service

- Commit：`a00fa8a` feat(server): Trip repository + service with zod validation (P1.T2)
- 主要成果：
  - `server/src/trips/`：`tripTypes.ts` / `tripSchemas.ts` / `tripRepository.ts` / `tripService.ts` / `index.ts`
  - Repository：5 个 prepared statements + dynamic `update` SET；`softDelete` 用 `WHERE deleted_at IS NULL`；不抛 AppError
  - Service：zod 验入参 → ValidationError；Repository 返回 null/false → NotFoundError；DB CHECK 触发翻译为 ValidationError；`crypto.randomUUID()` 生成 trip id
  - zod schema：`entityIdSchema`（与 storage 层正则对齐）、`isoDateSchema`（regex + Date.UTC 日历有效性 refine，拒 `2024-02-30`）；`createTripSchema` / `updateTripSchema` 用 `.strict()` 拒未知字段，superRefine 强制 `endDate >= startDate`
- 验证：`npm run smoke:trips` 22/22 PASS（11 项正面 + 11 项负面用例）；过程发现并修复正则缺 capture groups 的 bug

#### P1.T3 Trip API 路由

- Commits：`6e9dadc` feat(server): Trip CRUD API routes (P1.T3) + `ef64f9a` fix(server): validate GET /api/trips query at the route layer (P1.T3 follow-up)
- 主要成果：
  - `server/src/middleware/asyncHandler.ts` 兜底 Express 4 async route 的 unhandled rejection
  - `server/src/util/zodParse.ts` 共用 zod → ValidationError 翻译
  - `server/src/routes/trips.ts` 6 个端点：`POST/GET /api/trips`、`GET/PATCH/DELETE /api/trips/:id`、`POST /api/trips/:id/cover`
  - `ValidationError` 默认 statusCode 由 422 改为 400（用户 spec）
  - **后续 fix**：`GET /api/trips` query 增加路由层 `listQuerySchema`（limit 1-100 默认 50；offset ≥ 0 默认 0）
- 验证：18 项 curl 端到端用例（创建 / 列表 / 详情 / 更新 / 删除 / cover / 各类负面用例）全部 PASS；错误响应统一 `{error: {code, message, requestId, details?}}` 含堆栈不外泄

#### P1.T4 前端 Trip 列表页

- Commit：`3be2dd0` feat(client): Trip list page wired to /api/trips (P1.T4)
- 主要成果：
  - `client/src/api/trips.ts`：`Trip` 类型 + `fetchTrips(signal?)`
  - `client/src/hooks/useTrips.ts`：mount-on 拉取，`AbortController` 处理 strict-mode 双 mount
  - `client/src/pages/TripListPage.tsx`：四态守卫（loading / error / 空 / 网格）；CSS Grid `auto-fill, minmax(240px, 1fr)`；TripCard 整张可点击 link
  - `client/public/placeholder-cover.svg`（627 字节，role="img" + aria-label）
  - `client/vite.config.ts`：`/api` proxy 到 `http://localhost:3000`，dev 同源转发
- 验证：6 项端到端 smoke（HTML / SVG / proxy 三条路径）全部 PASS

#### P1.T5 前端 Trip 创建/编辑页

- Commit：`4948f24` feat(client): Trip create / edit form (P1.T5)
- 主要成果：
  - `client/src/api/trips.ts` 加 `CreateTripInput` / `UpdateTripInput` + `createTrip` / `getTripById` / `updateTrip`
  - `client/src/pages/TripFormPage.tsx`：`mode: "create" | "edit"` 切换；客户端轻量校验（required + endDate >= startDate）；`<input type="date">` 强制 YYYY-MM-DD
  - 路由 `/trips/new` 与 `/trips/:id/edit` 都指向同一组件
- 验证：build / typecheck / lint / format:check 一次过；P1.T6 闭合了"提交后 navigate 到 `/trips/:id`"和"edit cancel 回详情页"两个 TODO

#### P1.T6 前端 Trip 详情页骨架

- Commit：`a7658b6` feat(client): Trip detail page skeleton with refetch contract (P1.T6)（含 P1.T6 follow-up：useTrip 暴露 refetch + location.key 监听）
- 主要成果：
  - `client/src/hooks/useTrip.ts`：`useTrip(id)` → `{trip, loading, error, refetch}`；`useCallback` 包稳定引用；`previousIdRef` 区分换 id（清旧数据）vs 同 id refetch（保留旧数据，stale-while-revalidate）
  - `client/src/pages/TripDetailPage.tsx`：标题 / 描述 / 4 计数卡（dl/dt/dd 语义，硬编 0）/ Gallery 占位；back link + Edit + Upload 按钮
  - 监听 `useLocation().key`：首次挂载只记录、不触发 refetch；后续路径变化触发 refetch（防御未来同实例下的 mutation）
  - `getTripById(id, signal?)` 加 cancellation 支持
- 验证：build / typecheck / lint / format:check 一次过

#### P1.T7 Trip 删除二次确认

- Commit：`90f7adb` feat(client): Trip delete with confirmation modal (P1.T7)
- 主要成果：
  - `client/src/api/trips.ts` 加 `deleteTrip(id): Promise<void>`
  - `client/src/hooks/useTrips.ts` 加 `refetch`，与 `useTrip` 对称；顺手补 P1.T4 留下的 success-path `aborted` 检查
  - `client/src/pages/TripDetailPage.tsx`：header 加 btn-danger `Delete` 按钮；inline 确认 modal（`role="dialog"` + `aria-modal` + 标题/描述 aria-id），含可恢复说明文案
  - 关闭路径三条：Cancel 按钮 / Escape / 遮罩点击；提交中全部禁用
  - 成功后 `navigate("/", { replace: true })` 防 Back 进 404
  - `index.css` 加 `.btn-danger` + `.modal-*` 样式
- 验证：build / typecheck / lint / format:check 一次过

#### P1.T8 阶段验收

- 无代码改动；仅本文件 P1 小节追加 + 端到端验证。
- 6 条验收（[requirements §7.1](requirements.md)）结果如下：

| # | 验收项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 未填写 Trip 标题时不能创建 | **PASS** | curl 测试 3 个变体（空 body / `""` / `"   "`）全部 400 `VALIDATION_FAILED`；前端 button disabled |
| 2 | 创建 Trip 后可以进入上传页面 | **PARTIAL** | TripDetailPage UI 入口存在（"Upload media" 按钮 + Gallery 占位区底部 CTA）；目标路由 `/trips/:id/upload` 待 **P2.T6** 落地 |
| 3 | Trip 列表按创建时间或旅行时间倒序展示 | **PASS** | 后端 `ORDER BY created_at DESC, id DESC`；创建 3 个 trip 后列表顺序正确（最新在最上） |
| 4 | Trip 卡片显示标题、说明摘要、封面图和素材数量 | **PARTIAL** | 标题 ✓ / 说明摘要（line-clamp 2 行）✓ / 占位封面 ✓；**素材数量**等媒体表 + 聚合查询，待 **P2.T1 / P2.T2 / P2.T7** |
| 5 | Trip 可以修改标题和说明 | **PASS** | PATCH 200 OK，`updatedAt > createdAt` 正确刷新；前端 TripFormPage edit 模式联通 |
| 6 | 删除 Trip 不应造成数据库外键错误 | **PASS** | 软删除走 UPDATE 不走 DELETE；`PRAGMA foreign_key_check` 空输出（无 FK 错误）；DB 中行保留 `deleted_at` 非空，可恢复 |

### 阶段 P1 验证命令

后端集中复跑（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage         # 19 / 19 PASS（P0.T7 引入，仍有效）
npm run smoke:trips           # 22 / 22 PASS
```

前端集中复跑（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

P1.T8 端到端 curl 验收（后端构建 / 启动后跑 18 项，覆盖 6 条验收标准的 API 层）—— 详见 P1.T3 验证记录。

### 阶段 P1 PARTIAL 项与依赖

| 验收项 | 缺口 | 何时完成 |
|---|---|---|
| 验收 #2 上传页面 | `/trips/:id/upload` 路由 404 | P2.T6 |
| 验收 #4 素材数量 | 后端无 `media_items` 表与 count 聚合；前端硬编 0 | P2.T1（建表）+ P2.T2（job 状态机）+ P2.T7（前端拿数）；建议 P2 阶段验收时补 `GET /api/trips` 增强 `imageCount` / `videoCount` 字段 |

### 阶段 P1 剩余风险

下列风险均已知，**不阻断 P1 完成**：

| 编号 | 风险 | 触发跟进的时机 |
|---|---|---|
| R-13 | `cover_media_id` schema 层无 FK 约束 | P2.T1（建 media_items）后用表重建迁移加 FK |
| R-14 | 客户端 `Trip` 类型与服务端 `Trip` 手抄同步 | X.T1 / X.T2 引入 openapi-typescript 或共享 types 包 |
| R-15 | 没有 `useTrips` / `useTrip` 缓存共享，多页面之间会重复 fetch | 引入 React Query / SWR 时统一 |
| R-16 | 无 focus trap 与 body scroll lock：modal 期间键盘 Tab 可逃逸到背景 | X.T2 抽 `ConfirmDialog` 组件时统一 |
| R-17 | TripFormPage 的 inline edit-mode 拉数据未复用 `useTrip` | 引入 `useTrip` 时本可复用，留作后续 polish |
| R-18 | "未保存改动"离开提示缺失 | X.T1 / 后续 router blocker |
| R-19 | DB CHECK 翻译丢失约束名（统一回 `Validation failed at database layer`） | 后续可解析 `err.message` 抽 constraint name 进 `details` |
| R-20 | 列表页 Trip 卡片无素材数量字段（验收 #4 PARTIAL） | P2.T1+；阶段验收已记录 |
| R-21 | 详情页 Upload 入口指向的 `/trips/:id/upload` 当前 404（验收 #2 PARTIAL） | P2.T6 |
| R-22 | 详情页 Gallery 区仍是占位，真实媒体网格未渲染 | P2.T7（前端 Gallery 真实数据） + 上游媒体能力 P2 / P3 |
| R-23 | 删除路径仅做软删，前端无恢复入口 / 回收站视图 | P7.T2 恢复路径 + 回收站视图（按 design.md §4.3） |
| R-24 | 列表页 TripCard 暂无内联删除按钮，需先进入详情页才能删 | P1.T8 阶段验收明确接受；后续 polish（抽 ConfirmDialog 后可复用，给列表卡加 menu / 红色图标） |

承自 P0 的 R-01 … R-12 继续延续。

---

## 阶段 P2：媒体上传与文件识别

- 状态：**进行中**
- 任务范围：P2.T1 – P2.T8（参见 [docs/tasks.md](tasks.md) §阶段 2）

### P2.T2 完成记录

- Commit：待入库 — `feat(server): processing_jobs migration (P2.T2)`
- 主要成果：
  - 新增 `server/migrations/004_create_processing_jobs.sql`：单表 + 4 CHECK 约束 + 1 FK + 4 索引 + STRICT 模式
  - 字段按 R-32 决策（选项 A）合并 [requirements §8.8](requirements.md) 与 [design.md §9.1 / §9.2](design.md)：含 `payload TEXT nullable` 与 `next_run_at TEXT nullable`，向前兼容 P4 状态机与重试调度
  - FK `media_id → media_items(id) ON DELETE CASCADE` 按 R-33 决策（选项 A）落地，与 design §4.3 永久删除路径一致
  - status 枚举 CHECK 严格按 [CLAUDE.md §4.2](../CLAUDE.md)：`pending / running / success / failed / retrying / cancelled`（schema 不强制状态迁移路径，状态机由 P4.T1 落地）
  - job_type 不放 enum CHECK（类型清单跨 P3/P5/P9/P10 演进），仅 `length>0`
  - **明确不引入** Repository / Service / API / Worker / 调度 / 重试 / 僵尸恢复（属 P4 范围）
- 验证：
  - 干净 DB → 5 个 migration 全部 appliedNow，PRAGMA foreign_key_check 空，integrity_check ok
  - 升级场景：从 P2.T1 末态（含 1 trip + 1 media_items）放入 004 重启 → 仅 004 进 appliedNow，旧数据完整保留
  - idempotency：第二次启动 appliedNow=[]，5 个文件全在 alreadyApplied
  - sqlite3 实测 10 用例：3 个正面 INSERT（含默认值 / payload / next_run_at）+ 6 项 CHECK 拒绝（status 枚举 / progress 0-100 / retry_count 非负 / job_type 非空）+ 1 项 FK 拒绝（media_id 不存在）+ 1 项 PK 唯一拒绝；ON DELETE CASCADE 实测：删 media 后关联 jobs 从 5 → 3
  - smoke:trips 22/22 / smoke:storage 19/19 不回归
  - build / typecheck / lint / format:check 一次过

### P2.T1 后续风险记录

| 编号 | 风险 | 后续处理 |
|---|---|---|
| R-29 | 当前 migration runner 在特定重建场景下，`db.transaction` 内配合 `PRAGMA foreign_keys=OFF` 可能导致未来重建 trips 或 media_items 时无法安全推进。P2.T1 当前执行点安全，但未来涉及 trips/media_items 重建时需要重新设计 runner。 | X.T1 或未来 trips/media_items 重建任务中处理：给 runner 增加 pre/post PRAGMA hook，或采用 export-mutate-import 三段式方案。 |
| R-30 | 路由层暂未校验 `cover_media_id` 是否真实存在，P2.T1 后 SQLite FK 会拒绝非法值，但当前可能被翻译成 500，而不是业务友好的 400。 | P2.T5 媒体读取接口或 P5+ 封面真选落地时补：捕获 FK violation，返回 400 + 友好 message。 |
| R-31 | 003 在清理孤儿 `cover_media_id` 时静默置空，不通知用户。若用户曾通过接口设置过无效封面，升级后该字段会被清空。 | 当前阶段可接受；后续如关注审计，可在升级文档中说明，或增加 migration 日志。 |
| R-13 | `cover_media_id` schema 层 FK 约束风险已在本任务中消化。 | P2 阶段总结时移除此条。 |

---

## 下一阶段入口

进入阶段 2：媒体上传与文件识别（[docs/tasks.md](tasks.md) §阶段 2）。

第一项任务：

- **P2.T1 [MUST]**：迁移 `media_items` 表（含 `status`、`user_decision`、软删除）
  - 字段以 [docs/requirements.md](requirements.md) §8.2 为准
  - 同时承接补充迁移：给 `trips.cover_media_id` 加 FK → `media_items(id) ON DELETE SET NULL`（消化 R-13）

阶段完成后回填本文件对应小节（状态、commit 范围、每个任务的成果与验证、阶段剩余风险）。

---

## 维护说明

- 每完成一个阶段，在本文件追加一节并把状态从 `进行中` 改为 `已完成`。
- 每完成一个 task，在所属阶段小节里追加 commit 与主要成果条目；不在文件末尾堆叠。
- 风险一旦消化，从 `剩余风险` 表中移除并附 commit 引用，避免列表无限增长。
- 本文件不替代 `docs/tasks.md`：任务的范围、约束、验收以 tasks.md 为准；本文件只是回顾视图。

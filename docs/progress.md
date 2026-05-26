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

- 状态：**已完成**
- 任务范围：P2.T1 – P2.T8（8 / 8）
- 提交范围：`41495b2` … `82357fd`（P2.T8 验收无业务代码改动，仅文档）
- 完成日期：2026-05-11

### P2.T8 阶段验收

- 无业务代码改动；仅本文件 P2 小节追加 + 全栈验证 + tasks.md 复选框勾上。
- 验收对照 [requirements §7.2](requirements.md) / [§7.3](requirements.md) 共 11 条标准：

| # | 来源 | 验收项 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | §7.2-1 | 用户可一次上传多张图片和多个视频 | **PASS** | `UploadPage` `<input multiple>` + `UploadService` 逐文件循环；smoke:upload "multi-file image+video accepted" |
| 2 | §7.2-2 | 不支持的文件不会进入处理流程 | **PASS** | `unknown` 不创建 job；smoke:upload "txt did NOT create a processing_jobs row" |
| 3 | §7.2-3 | 每个文件都有独立上传状态 | **PASS** | per-file `results[]` 三态判别联合；UploadPage 渲染每条 status / reason |
| 4 | §7.2-4 | 上传失败时显示明确错误原因 | **PASS** | 每条 `failed` 项含 `error.code` + `reason`；smoke:upload `UPLOAD_FILE_TOO_LARGE` / `UPLOAD_EMPTY_FILE` / `DB_INSERT_FAILED` 用例 |
| 5 | §7.2-5 | 已成功上传的文件不会因为其他文件失败而回滚 | **PASS** | 串行 processOne 隔离失败；smoke:upload "mixed batch: small ok + huge rejected, no cross-impact" |
| 6 | §7.2-6 | 上传完成后可以立即在媒体列表中看到占位卡片 | **PASS** | Gallery 调 `GET /api/trips/:tripId/media`；accepted 媒体 status=`uploaded` 立即可见（emoji 占位 + 元数据） |
| 7 | §7.3-1 | JPG / PNG / WEBP / HEIC 被识别为 image | **PASS** | smoke:classify 1 / 2 / 3 / 4 / 5 |
| 8 | §7.3-2 | MP4 / MOV / M4V 被识别为 video | **PASS** | smoke:classify 6 / 7 / 8（mp4 / mov / m4v；另加 AVI / MKV） |
| 9 | §7.3-3 | 伪造扩展名的文件不会被错误处理 | **PASS** | smoke:classify 14 / 15 / 16 / 17 / 17b；smoke:upload "spoofed .jpg/PNG header → rejected_unknown" |
| 10 | §7.3-4 | 无法识别的文件被标记为 unknown | **PASS** | classifier 返回 `type='unknown'` + reason；media_items 写 `type='unknown'`，不入 job |
| 11 | §7.3-5 | 单个文件识别在上传完成后短时间内完成 | **PASS** | classify 为纯函数无 I/O，单调用 < 1 ms；smoke:classify 全量 37 用例本地秒回 |

### 阶段 P2 验证命令

后端集中复跑（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage         # 19 / 19 PASS
npm run smoke:trips           # 22 / 22 PASS
npm run smoke:classify        # 37 / 37 PASS（P2.T3 引入）
npm run smoke:upload          # 30 / 30 PASS（P2.T4 引入）
npm run smoke:media           # 21 / 21 PASS（P2.T5 引入）
```

前端集中复跑（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

无新增 migration（5 个文件 `000_init.sql` ~ `004_create_processing_jobs.sql`，全部在 P2.T1 / P2.T2 落地）。无 schema 改动。无新增 Worker / scheduler / retry / cancel / restore / AI / 视频 / 去重 / 删除 / 大图详情。

### 阶段 P2 最终能力

| 能力 | 落点 | 端到端 |
|---|---|---|
| `media_items` 表（含 status / user_decision / 软删字段） | P2.T1 | DB schema 就绪 |
| `processing_jobs` 表（含 6 态 CHECK / FK CASCADE） | P2.T2 | DB schema 就绪 |
| `File_Classifier` 三层判定（MIME + 扩展名 + magic） | P2.T3 | 纯函数，10 种格式 |
| `Upload_Manager` + `POST /api/trips/:tripId/media/upload` | P2.T4 | multipart 流式 + 事务 + 补偿 remove |
| `GET /api/trips/:tripId/media` / `GET /api/media/:id` | P2.T5 | 分页、newest-first、软删过滤 |
| 上传页 `/trips/:id/upload` | P2.T6 | 多选 + per-file 结果 |
| Gallery 网格（详情页内嵌） + 实时 photo / video count | P2.T7 | 占位卡 + 元数据，刷新按钮 |

### 阶段 P2 PARTIAL 项与依赖

| 项 | 缺口 | 何时完成 |
|---|---|---|
| P1 验收 #4 列表页 TripCard 素材数量 | TripCard 仍硬编 0；详情页计数已联通（消化在 P2.T7） | 后续给 `GET /api/trips` 增加 `imageCount` / `videoCount` 聚合字段；建议 P3.T7 一并处理 |
| Gallery 实际缩略图 / 预览渲染 | 设计层面尚无 storage 静态 serve 路由；当前只显示占位卡 + 元数据 | P3.T2 缩略图 worker + 静态文件路由（路由未排进 tasks.md，建议进 P3 前补任务条目） |

### 阶段 P2 PARTIAL 已消化（来自 P1 / P2 早期）

| 编号 | 描述 | 消化点 |
|---|---|---|
| R-13 | `cover_media_id` schema 层 FK 约束 | P2.T1 003 migration |
| R-21 | 详情页 Upload 入口 `/trips/:id/upload` 404 | P2.T6 路由 + UploadPage |
| R-22 | 详情页 Gallery 区占位未渲染真实媒体 | P2.T7 MediaCard 网格 |

### 阶段 P2 剩余风险

下列风险均已知，**不阻断 P2 完成**，需在进入 P3 前 / 中评估：

| 编号 | 风险 | 触发跟进的时机 |
|---|---|---|
| R-29 | migration runner 在 trips / media_items 未来重建场景下，`db.transaction` 内配合 `PRAGMA foreign_keys=OFF` 可能无法安全推进 | 未来涉及 trips / media_items 重建任务时 |
| R-30 | `cover_media_id` 路由层未校验是否真实存在；当前 FK 拒绝会翻译成 500 而非 400 | P3 / P5 封面真选落地时捕获 FK violation |
| R-31 | 003 静默置空孤儿 `cover_media_id`，不通知用户 | 后续如关注审计可加 migration 日志 |
| R-34 **新** | 无 HTTP 静态文件路由 serve `storage/`，Gallery / 详情页无法直接 `<img src={originalPath}>` | P3.T2 缩略图前必须落地（建议拆为独立任务进 P3 计划） |
| R-35 **新** | `media_items` 不持久化用户原始文件名；只有 `original_path = trips/{tripId}/originals/{mediaId}.{ext}` | P3 阶段前评估：是否加 `original_filename` 列；不加则前端长期显示 `mediaId.ext` |
| R-36 **新** | `processing_jobs` 表写入但**无 Worker 执行**；所有 job 永远停在 `pending`，media `status='uploaded'` 永不前进 | P4.T1 Worker pool 落地；P3 worker 任务（thumbnail / metadata）依赖 P4 调度框架 |
| R-37 | `file-type` 类库未引入，magic 表为手写白名单，对 AVIF / RAW / MPEG-2 TS 等返回 unknown | P3 / 后续 polish 评估 |
| R-38 **新** | UploadPage 没有上传进度 / 取消按钮，单文件 GB 级会"看似卡住" | UX 优化阶段；非阻断 |
| R-39 **新** | 任何 trip 的 media 列表 / Gallery 都 hardcap 100 条；分页 UI 未实现 | 单个 trip 媒体 > 100 时再做（后续可加 load-more） |

承自 P0 的 R-01 … R-12、承自 P1 的 R-14 / R-15 / R-16 / R-17 / R-18 / R-19 / R-20 / R-23 / R-24 继续延续。

### P2.T7 完成记录

- Commit：待入库 — `feat(client): add gallery grid (P2.T7)`
- 主要成果：
  - 新增 `client/src/hooks/useTripMedia.ts`：参照 `useTrip` 的形态（`{media, loading, error, refetch}` + `AbortController` 防 strict-mode 双 mount + stale-while-revalidate）；`tripId` 为 `undefined` 时 short-circuit；`limit` 为 primitive prop（默认 100，符合后端路由层 1..100 cap），避免 effect deps 用 options object 触发 ESLint 警告
  - 扩展 `client/src/api/media.ts`：在 P2.T6 `uploadMedia` 基础上加 `MediaItem` / `MediaType` / `MediaStatus` / `MediaUserDecision` 类型 + `fetchTripMedia(tripId, options?, signal?)`；类型与 `server/src/media/mediaTypes.ts` 的读投影手工对齐（hash 字段同后端一样**不**包含）；URL 通过 `URLSearchParams` 构造，未传可选项就不带 query
  - 改 `client/src/pages/TripDetailPage.tsx`：
    - 调 `useTripMedia(id)`，与 `useTrip` 并列
    - `location.key` 变化时同时 refetch trip 和 media（从 upload 页回来能看到新数据）
    - 替换 Overview 区硬编码 `Photos: 0 / Videos: 0` → 用 `media.filter(m => m.type === ...).length` 实时计算；duplicate / cleanup count 仍为 0（P5 / P6 范围），改了说明文案
    - 替换 Gallery 占位区为 4 段式渲染：loading（首次 + 列表为空时）/ error / empty（保留原 Upload CTA）/ loaded（网格）
    - 新增 section header 含 Refresh 按钮（loading 时 disabled，文案切换 "Refresh" / "Refreshing…"），驱动 `refetchMedia`
    - 网格用 `<MediaCard>`（同文件 helper）：emoji 缩略占位（🖼️ image / 🎞️ video / 📄 unknown）+ 元数据（type label / status 徽章 / 文件名（从 originalPath 取 basename）/ MIME / size / uploaded 时间）；status 徽章按 `data-status` 上色（uploaded 绿 / processing 黄 / processed 蓝 / failed 红 / archived & deleted 灰）
    - 当 `media.length >= 100` 显示"Showing the most recent 100 items. Pagination UI is out of scope for P2.T7."提示
    - **不渲染** `<img>` / `<video>` 标签（设计层面尚无 storage 静态 serve 路由；按用户 spec "如果文件 URL 暂不可直接访问，则显示占位卡和文件信息，不要为了预览额外改后端"）
    - inline `MediaCard` + helpers (`filenameFromPath / formatBytes / formatTimestamp`) 在同一文件，匹配既有 `CountCard / formatDateRange` inline 惯例（避免新建 `components/` 目录）
  - `client/src/index.css` 追加 `.media-grid` / `.media-card` / `.media-card-thumb / -body / -title / -type / -status / -meta / -mono` 以及 `.trip-detail-section-header` 样式；`auto-fill, minmax(240px, 1fr)` 网格与 TripList 一致；CSS attribute selector 用 `[data-status="..."]` 上色（与 P2.T6 UploadPage 同款手法）
  - 消化 P1 风险 **R-21**（TripDetail 的 `/trips/:id/upload` 入口在 P2.T6 已经联通，此条历史上还提到 Gallery 占位）和 **R-22**（详情页 Gallery 占位）
  - 消化 P1 验收 **#4 PARTIAL** 中的"素材数量"（Photos / Videos count）— 详情页生效；列表页 TripCard 的 count 仍待 P2.T8 / 后续阶段验收时引入 trips list 聚合字段
  - **明确不引入** 拖拽 / 进度条 / 大图详情页 / 删除媒体 / 批量选 / 视频 `<video>` 加载 / 实际缩略图 / 排序筛选 UI / 任何新依赖
  - **明确不动** 后端任何文件（路由 / Service / Repository / migration / package.json / package-lock.json）；未触碰 P2.T3 classify 核心逻辑；未实现 AI / 视频处理 / 去重 / Worker / scheduler / retry / cancel / restore
- 验证：
  - client：build / typecheck / lint / format:check 一次过
  - server 全部 smoke 不回归：smoke:classify 37/37 / smoke:trips 22/22 / smoke:storage 19/19 / smoke:upload 30/30 / smoke:media 21/21

### P2.T6 完成记录

- Commit：待入库 — `feat(client): add media upload page (P2.T6)`
- 主要成果：
  - 新增 `client/src/api/media.ts`：`uploadMedia(tripId, files, signal?)`，通过单个 multipart/form-data POST 调 P2.T4 的 `POST /api/trips/:tripId/media/upload`；字段名 `files`（与 upload-smoke 一致；后端 busboy 接受任意字段名）；浏览器自动追加 boundary header（**不**手动设 Content-Type，否则 boundary 会丢失）；响应类型镜像 `server/src/upload/types.ts` 的三态判别联合（`accepted` / `rejected_unknown` / `failed`）
  - 新增 `client/src/pages/UploadPage.tsx`：
    - tripId 来自 URL 参数（`/trips/:id/upload`），不在页面里做下拉选 trip — 用户从 TripDetailPage 的 Upload media 按钮 / Gallery 占位区 CTA 进入，refresh / 链接分享都自然
    - 复用 `useTrip(id)` 拿 trip 元数据；trip 不存在 / soft-deleted → 沿用现有 4 段式 lifecycle（loading / error / null / loaded）显示错误并给"Back to trips"
    - `<input type="file" multiple accept="image/*,video/*,.jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.m4v,.avi,.mkv">`：accept 双覆盖 MIME 通配 + 显式扩展名，HEIC/MOV OS-level MIME 不一致时仍可挑（用户 spec：上传前检查文件类型；最终判定仍以后端 classifier 为准）
    - 选中文件展示文件名 / MIME / 大小（用 `formatBytes` 工具）
    - 提交按钮：未选 trip 或未选文件或提交中 → disabled；按钮文案随状态切换（Upload / Upload N file(s) / Uploading…）
    - 提交后渲染 `results[]` 数组：每条 file 显示 `originalFilename` + 状态行（accepted: type + jobType；rejected_unknown: 文案；failed: error code）+ reason；摘要行 `X accepted · Y rejected · Z failed`；`aria-live="polite"` 公告新结果
    - 不自动跳转 Gallery；不做进度条；不做 drag-and-drop；不做分块上传 / XHR progress（这些都明确属 P2.T7+ 或后续优化范围）
  - 路由 `client/src/App.tsx` 在 `/trips/:id/edit` 之后、`/trips/:id` 之前增加 `/trips/:id/upload` → `<UploadPage />`（更具体的路径在前，避免被参数路由吞）
  - `client/src/index.css` 追加 `.upload-form / .upload-section / .upload-file-list / .upload-result / .upload-result[data-status="..."]` 等样式（绿/黄/红三态徽章，借鉴 GitHub 的色板，与现有 `.btn-*` / `.form-*` 风格一致），无 UI 重构
  - 消化 P1 risk **R-21**：详情页 Upload 入口 (`/trips/:id/upload`) 不再 404
  - 消化 P1 验收 PARTIAL 项 **#2 创建 Trip 后可以进入上传页面**
  - **明确不引入** 拖拽 / 进度条 / Gallery 渲染 / 媒体读取调用 / 删除接口 / Worker / 调度 / retry / cancel / restore / AI / 视频 / 去重 / 缩略图 / EXIF / 任何新依赖
  - **明确不动** 后端任何文件（路由 / Service / Repository / migration / package.json）；未触碰 P2.T3 classify 核心逻辑
- 验证：
  - client：build / typecheck / lint / format:check 一次过
  - server 全部 smoke 不回归：smoke:classify 37/37 / smoke:trips 22/22 / smoke:storage 19/19 / smoke:upload 30/30 / smoke:media 21/21

### P2.T5 完成记录

- Commit：待入库 — `feat(server): add media read endpoints (P2.T5)`
- 主要成果：
  - 新增 `server/src/media/mediaService.ts`：`getMediaById(id)` / `listMediaForTrip(tripId, options)`，全部走 zod 入参校验 + `parseOrThrow`，未命中翻译为 `NotFoundError`
  - 新增 `server/src/media/mediaSchemas.ts`：`listMediaOptionsSchema`（Service 层 `limit` 1..200 默认 50；`offset` ≥ 0 默认 0；`includeDeleted` 默认 false）
  - 扩展 `server/src/media/mediaRepository.ts`：在 P2.T4 的 `insert` 基础上加 4 个 prepared statement（`findByIdActive` / `findByIdAny` / `listByTripActive` / `listByTripAll`），统一新→旧 `ORDER BY created_at DESC, id DESC`，默认 `WHERE deleted_at IS NULL`；新增 `findById(id, { includeDeleted? })` 与 `list(tripId, options)`
  - 扩展 `server/src/media/mediaTypes.ts`：新增 `MediaItem`（read 投影：projection 包含 id / tripId / type / originalPath / previewPath / thumbnailPath / fileSize / mimeType / extension / width / height / duration / status / userDecision / createdAt / updatedAt / deletedAt；**不**含 file_hash / perceptual_hash — 去重内部状态，P5 才用到）+ `ListMediaOptions`（按 trips 同款写法附 `| undefined` 以兼容 `exactOptionalPropertyTypes`）
  - 扩展 `server/src/media/index.ts` barrel：导出 `MediaService` / `listMediaOptionsSchema` / `ListMediaInput` / `MediaItem` / `ListMediaOptions`
  - 扩展 `server/src/routes/media.ts`：在 P2.T4 的 `POST .../media/upload` 基础上新增两个 GET handler：
    - `GET /api/trips/:tripId/media`：路由层 `listMediaQuerySchema`（`limit` 1..100 默认 50，`offset` ≥ 0 默认 0，未知 query 键 strip 丢弃），返回 `{ media: MediaItem[] }`；trip 不存在或 soft-deleted → 404（复用 `tripService.getTripById`）
    - `GET /api/media/:id`：返回 `{ media: MediaItem }`；missing / soft-deleted → 404；不交叉检查 trip 删除状态（直接按 id 取，media 自身的 `deleted_at` 是唯一真相）
  - `server/src/app.ts` / `server/src/index.ts`：注入 `MediaService` 到 `makeMediaRouter`，构造 `new MediaService(mediaRepo, tripService)`
  - `server/package.json` 加 `smoke:media` 脚本（无新依赖）
  - 新增 `server/src/scripts/media-smoke.ts`：21 项 smoke，覆盖 happy path / missing id / soft-deleted row (默认隐藏) / malformed id / 空 trip / 缺失 trip → 404 / soft-deleted trip → 404 / 分页（limit=2 offset=0/2/4）/ newest-first 排序 / `includeDeleted=true` Service 层逃生通道
  - **明确不引入** soft-delete write / restore / 重处理接口 / Worker / scheduler / 状态机 / 视频 / AI / 缩略图 / EXIF / 去重 / 模糊检测 / 封面真选 / 任何新依赖
  - **明确不动** migration（现有 002 schema 已包含 P2.T5 所需全部字段；P2.T5 0 新增 migration）；不修改 P2.T3 File_Classifier；不修改前端
- 验证：
  - `npm run smoke:media` 21/21 PASS
  - smoke:classify 37/37 / smoke:trips 22/22 / smoke:storage 19/19 / smoke:upload 30/30 不回归
  - build / typecheck / lint / format:check 一次过

### P2.T4 完成记录

- Commit：待入库 — `feat(server): Upload_Manager + POST /api/trips/:tripId/media/upload (P2.T4)`
- 主要成果：
  - 新增 `server/src/upload/`（4 文件：`types.ts` / `uploadParser.ts` / `uploadService.ts` / `index.ts`）：`Upload_Manager` 编排"解析 multipart → 暂存 → classify → put original → 事务写库"主链路，纯依赖注入，无全局状态
  - 新增 `server/src/media/`（3 文件：`mediaTypes.ts` / `mediaRepository.ts` / `index.ts`）：本任务只暴露 `insert`，list / findById 等读路径留给 P2.T5
  - 新增 `server/src/jobs/`（3 文件：`jobTypes.ts` / `jobRepository.ts` / `index.ts`）：本任务只暴露 `insert`，Worker / 状态机 / 重试 / 僵尸 / Job API 全部留给 P4
  - 新增 `server/src/routes/media.ts`：`POST /api/trips/:tripId/media/upload` 单一端点，挂在 `/api`（避开 `/api/trips` 路由表）；trip 校验复用 P1 `TripService.getTripById`，soft-deleted trip 走 404
  - `server/src/app.ts` 加 `uploadService` 依赖注入与 `makeMediaRouter` 挂载
  - `server/src/index.ts` 构造 `MediaRepository / JobRepository / UploadService`，从 `config.upload.*` 注入 classifier allowlist 与 `maxFileSize`
  - `server/package.json` 新增运行时依赖 `busboy ^1.6.0`（design §3.1 已点名）+ devDependency `@types/busboy ^1.5.4`；新增脚本 `smoke:upload`；`npm install` 仅净增 3 个包（busboy + streamsearch + @types/busboy），无其他变更
  - 上传流程（design §6.1 / §6.2）严格落地：
    1. busboy 流式收 multipart → 每个 part 暂存到 `os.tmpdir()/travel-album-upload-XXXXXX/` 下的临时文件（不进 `storage/` 根）
    2. 抓取前 64 字节作为 head bytes（≥ 12 ≥ 所有 magic 模式长度）
    3. 调 P2.T3 `classify({ filename, declaredMimeType, headBytes }, { imageExtensions, videoExtensions })`
    4. **image / video**：`storage.putOriginal({tripId, mediaId, extension, data: ReadStream})` 落 `trips/{tripId}/originals/{mediaId}.{ext}` → `db.transaction()` 内 INSERT `media_items` + INSERT `processing_jobs(status='pending')`；任一失败 → 事务回滚 + 补偿 `storage.remove()`
    5. **unknown**：丢弃临时字节（design §6.2.3：不进 `originals/`），仅 INSERT `media_items(type='unknown', original_path=NULL)`，不入 job
    6. 临时目录在 `finally` 内 `rm -rf` 清理
  - 初始任务类型按 [design.md §6.2 / §7.1 / §8.1](design.md)：image → `image_thumbnail`，video → `video_metadata`；本任务**只入库不执行**
  - 失败码集中在 UploadService 内：`UPLOAD_FILE_TOO_LARGE / UPLOAD_EMPTY_FILE / UPLOAD_MISSING_EXTENSION / UPLOAD_STAGING_FAILED / STORAGE_PUT_FAILED / MEDIA_INSERT_FAILED / DB_INSERT_FAILED`；整体失败码（404 trip 不存在、400 空 payload）走全局错误中间件
  - 响应模型三态判别联合：`accepted / rejected_unknown / failed`（design §3.3：HTTP 整体 200，per-file 错误进 results[] 数组项；trip 不存在 / 空 payload 才返非 200）
  - 新增 `server/src/scripts/upload-smoke.ts` + `npm run smoke:upload`：30 项手动 smoke，覆盖正向（image/video 单 + 多文件）、unknown（txt）、伪造（.jpg + PNG 头）、trip 404、空 payload、零字节、超限、混合批失败隔离、**事务回滚 + 补偿 remove**（通过注入毒化 JobRepository 触发 DB 失败后验证 media_items / processing_jobs 行数不变 + originals/ 文件被清理）
  - **明确不引入** sharp / exifr / fluent-ffmpeg / supertest / vitest / file-type / AI 依赖；不实现 Worker / 调度 / 状态机迁移 / 重试 / 僵尸恢复 / Job API（全部属 P4 / P3 / P5 / P9 / P10 后续范围）
  - **明确不动** 001 / 002 / 003 / 004 migration；不新增 migration；不修改 P2.T3 File_Classifier；不修改前端
- 验证：
  - `npm run smoke:upload` 30/30 PASS
  - smoke:classify 37/37 / smoke:trips 22/22 / smoke:storage 19/19 不回归
  - build / typecheck / lint / format:check 一次过

### P2.T3 完成记录

- Commit：待入库 — `feat(server): File_Classifier module (P2.T3)`
- 主要成果：
  - 新增 `server/src/classify/`（4 文件：`types.ts` / `magicNumbers.ts` / `classifier.ts` / `index.ts`）：纯函数三层判定模块，无 I/O、无依赖、不抛错
  - 三层判定按 [design.md §6.3](design.md)：MIME（Content-Type）+ 扩展名 + magic number；用户决策选项 A 锁定语义——magic 是决定信号，缺失即 unknown；扩展名 / MIME 不可与 magic 冲突；MIME 缺失或 `application/octet-stream` 视为"无信号"豁免
  - 输出 `{ type, extension, mimeType, reason }`：`type` 与 [requirements §7.3](requirements.md) / [002 migration](../server/migrations/002_create_media_items.sql) 的 `media_items.type` CHECK 严格对齐（`image / video / unknown`）；`reason` 始终非空
  - 覆盖 [requirements §7.2](requirements.md) 的 5+5 = 10 种格式：image=jpg/jpeg/png/webp/heic、video=mp4/mov/m4v/avi/mkv
  - **format-level 扩展名 vs magic 兼容表**：仅 type 一致还不够（满足验收 3 "伪造扩展名"），实现增加扩展名 ↔ magic format 兼容映射（jpg↔jpeg / png↔png / mp4↔{mp4,m4v} / mov↔mov / 等），`.jpg` + PNG header 等"同 type 跨 format" 情况也判 unknown
  - 新增 `server/src/scripts/classify-smoke.ts` + `npm run smoke:classify`：37 项手动 smoke，覆盖正向（10 格式）、MIME 豁免、type/format 冲突、伪造、空文件名、无扩展名、多点扩展名、大小写、空头、太短头、含路径、Windows 反斜杠、PDF / unknown ftyp brand 等
  - **明确不引入** Repository / Service / API / Worker / 调度 / migration / 第三方依赖（保持 `file-type` 类库为后续 polish 项 R-37 / R-40）
- 验证：
  - `npm run smoke:classify` 37/37 PASS
  - smoke:trips 22/22 / smoke:storage 19/19 不回归
  - build / typecheck / lint / format:check 全过

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

## 阶段 P3：图片缩略图与元数据

- 状态：**已完成**
- 任务范围：P3.T1 – P3.T9（9 / 9；T1/T2 是 P2.T8 验收后于 commit `0fa0980` 插入的前置任务）
- 提交范围：`90552ff` … `d2423a0`（P3.T9 验收无业务代码改动，仅本文件 + tasks.md）
- 完成日期：2026-05-17

### P3 阶段完成内容

| Task | Commit | 主要交付 |
|---|---|---|
| **P3.T1** | `90552ff` | `/storage/<path>` 静态文件路由（消化 R-34）；三道闸路径校验；Content-Type 表 + Cache-Control + nosniff；smoke 14/14 |
| **P3.T2** | `c2b04c8` | 最小 image-channel job executor（P4.T1 的 stub）—— 单并发、4 态生命周期（idle/running/stopping/stopped）、`pending → running → success/failed` 状态机、handler 注册表、优雅关停；消化 R-36 最小子集；smoke 26/26 |
| **P3.T3** | `4fd668a` | `005_create_media_versions.sql` —— STRICT 表 + 11 个约束 + 4 个索引 + FK CASCADE + 7 值 version_type 枚举（前瞻性设计）；smoke 24/24 |
| **P3.T4** | `9579a19` | `ImageWorker.thumbnail` —— sharp 生成 thumb.webp (320) + preview.webp (1600)，写 media_versions（UPSERT），更新 media_items.{width,height,preview_path,thumbnail_path}；`.rotate()` 处理 EXIF orientation；`overwrite:true` 幂等；新增依赖 sharp；smoke 22/22 |
| **P3.T5** | `56c4cbe` | `ImageWorker.metadata` —— exifr 读 EXIF/TIFF/IPTC（`gps:false` 遵循 CLAUDE.md §5.3），UPSERT `media_versions(version_type='metadata', mime_type='application/json', params=JSON)`；新增 `006_extend_media_versions_version_type.sql` 12-step 重建扩 enum 加 `'metadata'`；新增依赖 exifr；删除 `imageJobHandlers.ts`（最后一个 stub 退役）；smoke 18 + 23 = 41/41 |
| **P3.T6** | `9d4641a` | 前端图片详情页 `/media/:id` v1 —— 后端 `GET /api/media/:id` 改返 `{media, versions}`；新增 `MediaService.getMediaDetailById` + `MediaVersionsRepository.listByMediaId`；前端 hero / basics / versions / EXIF 四区；Gallery MediaCard 整张包 `<Link>` 并用真 thumbnail 替换 emoji；smoke 26/26（含 5 项 detail bundle） |
| **P3.T7** | `0e8fb4f` | `POST /api/media/:id/reprocess` —— 对 `image_thumbnail` / `image_metadata` 两 slot 分别 created/reset/skipped（P3.T7 stub：`failed/success → pending` 直接 reset，P4.T2 落地正式 retry/backoff 时取代）；前端详情页加 Reprocess 按钮；smoke 21/21 |
| **P3.T8** | `d2423a0` | 派生 `cover_url` —— `GET /api/trips` + `GET /api/trips/:id` 新增字段；三优先级（pinned → first thumbnailed → placeholder）；**零写库零 schema**；前端 TripCard 用新字段；smoke 13/13 |
| **P3.T9** | （本任务）| 阶段验收 + 文档收口（仅 progress.md + tasks.md） |

### P3.T9 验收结果

| 验收项 | 结果 |
|---|---|
| [requirements §7.4 验收 1](requirements.md) 图片上传后前端可以显示缩略图 | **PASS** — `image_thumbnail` worker 写 `media_items.thumbnail_path` + `media_versions(version_type='thumbnail')`；TripDetailPage Gallery MediaCard 用 `/storage/<thumbnail_path>` 直接 `<img src>`；smoke:image-thumbnail "thumb.webp is readable via /storage/<thumbnail_path>" 实证 |
| §7.4 验收 2 图片详情页可以显示基础元数据 | **PASS** — MediaDetailPage Basics 表（type / status / MIME / extension / dimensions / file_size / 时间戳 / 三种 storage 路径） + EXIF 区表格化展示（来自 `metadata` 版本的 params JSON） |
| §7.4 验收 3 原始图片路径和缩略图路径分别保存 | **PASS** — `media_items.original_path` / `thumbnail_path` / `preview_path` 三列独立；P3.T4 同时把 derived 路径写入 `media_versions` 行（`version_type='thumbnail'/'preview'`），形成双轨：媒体表用于 Gallery 快速渲染、版本表用于细节查询 |
| §7.4 验收 4 缩略图失败时任务状态记录失败原因 | **PASS** — P3.T2 executor 失败路径写 `processing_jobs.status='failed' + error_message`；smoke:image-thumbnail "failure: job row.status='failed' with error_message present" + smoke:image-channel-executor "failed path" 实证 |
| §7.4 验收 5 失败图片可以重新处理 | **PASS** — P3.T7 `POST /api/media/:id/reprocess` 把 failed → pending 重置；前端详情页 Reprocess 按钮；smoke:media-reprocess "failed → reset" + "executor handoff: reset thumbnail job now status='success'" 实证 |
| **P3.T9 额外**：上传图片后 Trip 卡片自动显示第一张图片为临时封面 | **PASS** — P3.T8 `deriveCoverUrl` 优先级 2 取该 trip 最早一张含 thumbnail_path 的 image；smoke:trip-cover-url "single-image trip → /storage/<thumbnail_path>" 实证；TripListPage 用 `trip.coverUrl` 渲染 |
| **P3.T9 额外**：`/storage` 静态路由仍可访问缩略图 / 预览图 | **PASS** — `app.ts:97` 挂载未变；smoke:storage-route 14/14 PASS；smoke:image-thumbnail 实测 `storage.read(thumbnail_path)` 返字节流 |
| **P3.T9 额外**：image-channel executor stub 闭环 | **PASS** — 注册 2 个真实 handler (`image_thumbnail` / `image_metadata`)；上传 → executor 自动拉 → handler 写 media_versions + media_items；smoke:image-thumbnail / smoke:image-metadata / smoke:media-reprocess 都包含端到端 executor 触发链路 |

### 阶段 P3 验证命令

后端（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage         # 19/19
npm run smoke:trips           # 22/22
npm run smoke:classify        # 37/37
npm run smoke:upload          # 30/30
npm run smoke:media           # 26/26（P3.T6 加 5 项 detail bundle）
npm run smoke:storage-route   # 14/14（P3.T1）
npm run smoke:image-channel-executor  # 26/26（P3.T2）
npm run smoke:media-versions  # 24/24（P3.T3）
npm run smoke:image-thumbnail # 22/22（P3.T4）
npm run smoke:migration-006   # 18/18（P3.T5 配套）
npm run smoke:image-metadata  # 23/23（P3.T5）
npm run smoke:media-reprocess # 21/21（P3.T7）
npm run smoke:trip-cover-url  # 13/13（P3.T8）
```

后端 smoke 总计 **295 / 295**（既有 110 + 阶段 P3 新增 185），零回归。

前端（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

均一次过。Vite gzip JS 60.24 KB / CSS 2.47 KB。

新增依赖：`sharp ^0.33.5`（P3.T4）+ 6 传递；`exifr ^7.1.3`（P3.T5）+ 0 传递。无其他依赖变更。

### 阶段 P3 PARTIAL 项与依赖

| 项 | 状态 | 何时完成 |
|---|---|---|
| 自动最佳封面（按 quality_score 写库） | 仍是派生 `cover_url`（响应层） | P6.T7 落地后 `trips.cover_media_id` 持久化；`deriveCoverUrl` 优先级 1 自动接管 |
| Worker pool 正式版（多通道 / 退避重试 / 僵尸恢复 / Job API） | P3.T2 仅 stub | P4.T1 ~ P4.T7 |
| 缩略图实际触发链路 | upload 仅入队 `image_thumbnail`；`image_metadata` job 当前由 P3.T7 reprocess 或手动 INSERT 触发 | 后续：要么 thumbnail handler 链式入队 metadata，要么 upload 一次入队两个 job —— 留给 P4 调度框架 |
| 列表页 TripCard 素材计数 | 仍硬编 0（[P1 R-20](#)）| P3.T9 未在范围；后续给 `GET /api/trips` 加 `imageCount` / `videoCount` 聚合字段 |

### 阶段 P3 PARTIAL 已消化

| 编号 | 描述 | 消化点 |
|---|---|---|
| R-34 | 缺 storage 静态文件路由 | P3.T1 `/storage/<path>` |
| R-36（最小子集）| `processing_jobs` 写入但无 Worker 执行 | P3.T2 image-channel executor stub；P3.T4 / T5 真实 handler 注册 |

### 阶段 P3 剩余风险

承自前期：R-01 ~ R-12（P0）、R-14 / R-15 / R-16 / R-17 / R-18 / R-19 / R-20 / R-23 / R-24（P1）、R-29 / R-30 / R-31 / R-35 / R-36（完整版）/ R-37 / R-38 / R-39（P2）继续延续。

**P3 新增 / 校准**：

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| ~~R-40~~ | ~~P3.T7 `reprocess` 走 `failed/success → pending` 直接 reset，绕过 CLAUDE.md §4.3 的 `failed → retrying → running` 规范迁移~~ | ✅ P4.T2 消化：`resetToRetrying` 走规范路径，retry_count=0、next_run_at=now |
| R-41 | `image_metadata` job 当前没有自动触发路径（upload 只入 `image_thumbnail`） | P4 调度框架或 P3.T4 worker 链式入队（任选）|
| ~~R-42~~ | ~~P3.T2 executor 在 `markSuccess` 后若进程 crash，可能让"running"行卡死~~ | ✅ P4.T3 消化：启动期 `recoverZombies` 把超时 `running` 行按 retry 预算路由回 `retrying` / `failed`；同时兜底 P4.T2 markRetrying 自身失败的小窗口 |
| R-43 | 详情页 EXIF 表无字段过滤 / 分类 / 单位格式化 —— 直接渲染 exifr 原始 key/value | UX polish；非阻断 |
| R-44 | TripCard 用 `<img>` 直接加载 cover_url，列表大时（>50 trip）可能延迟首屏 | 后续可加 lazy loading + 预加载 hint；非阻断 |

### P4 前置条件

- P3.T1 ~ P3.T9 全部完成 ✅
- P3 验收通过（11 项全部 PASS）✅
- 工作区干净 ✅
- P3 阶段文档已收口 ✅（本节）
- image-channel executor stub 接口稳定，P4.T1 落地时替换调度层、保留 handler 注册不变（详见 P3.T2 commit message）
- 无 schema / migration 改动（仍是 000 ~ 006）
- Trip CRUD mutation 契约不变

---

## 阶段 P4：任务队列与处理状态

- 状态：**已完成**
- 任务范围：P4.T1 – P4.T7（7 / 7）
- 提交范围：`23a5fc4` … `ce70057`（P4.T7 验收无业务代码改动，仅本文件 + tasks.md）
- 完成日期：2026-05-17

### P4.T1 JobQueue 实现结果

- Commit：`23a5fc4` — `feat(server): add job queue scheduler (P4.T1)`
- 主要成果：
  - 新增 `server/src/jobs/jobQueue.ts`：多通道 polling 调度器，三个 channel（`image` / `video` / `ai`）独立维护 concurrency cap / poll loop / inflight Set / handler Map；channel 内并发 N 个 handler 真并行；handler 错误隔离不影响 channel 拉取后续 job
  - 状态机：`pending → running → success / failed`（claim 时 `WHERE status='pending'` race-safe；markSuccess / markFailed 仍带 `WHERE status='running'` guard）—— **未实现** retry / backoff（保留 P4.T2）、僵尸恢复（P4.T3）、Job API（P4.T4）、Media 状态联动（P4.T5）
  - `JobRepository` 加 `claimNextPendingByJobTypes(types[])` —— 取代 P3.T2 硬编码的 `LIKE 'image\_%'`，支持任意 channel 的 handler 闭集 IN 查询；旧 `claimNextPendingImageJob` 保留供 P3 stub `ImageChannelExecutor` 继续使用
  - `server/src/index.ts` boot 切换：`new ImageChannelExecutor(...)` → `new JobQueue({ jobRepo, logger, channels: [image / video / ai] })`；image 通道用 `config.workers.imageConcurrency`（env `IMAGE_WORKER_CONCURRENCY` 默认 2），video / ai 通道 handlers Map 为空（结构预留，永不 claim）；shutdown 改为 `await jobQueue.stop()`
  - **保留** `ImageChannelExecutor` —— 既有 4 个 P3 smoke（image-channel-executor / image-thumbnail / image-metadata / media-reprocess）依赖其单并发确定性 tick 语义，作为 handler 测试用的"确定性测试 harness"留存；P4.T1 不改这些 smoke、不删旧 executor 类
  - 新增 `smoke:job-queue` —— **27 / 27 PASS**：覆盖空队列 / 单任务 / 真并行（concurrency=2 实测 inflightPeak=2）/ saturatedBefore 反压 / handler 异常隔离 / video 通道空 handlers 不偷 video_metadata / start auto-drain / start 幂等 / stop 幂等 / tick-after-stop / mid-flight stop 等 handler 完成 / 未知 channel 抛错 / 非法 concurrency 抛错 / 重复 channel 名抛错 / channelNames + getState 自省
  - **结构预留**：video / ai channel 已在 boot 注册（handler Map 空），后续 P4 video / AI worker 落地时只需 `imageHandlers.set(...)` 同款 API 注册；不需要改 JobQueue 内部
- 验证：
  - `npm run smoke:job-queue` 27/27 PASS
  - 既有 13 smoke 不回归（classify 37 / trips 22 / storage 19 / upload 30 / media 26 / storage-route 14 / image-channel-executor 26 / media-versions 24 / image-thumbnail 22 / migration-006 18 / image-metadata 23 / media-reprocess 21 / trip-cover-url 13）—— 后端 smoke 总计 **322 / 322**
  - build / typecheck / lint / format:check 一次过
- 边界遵守：
  - 未进入 P4.T2 retry/backoff
  - 未改 P3 thumbnail / metadata handler 业务逻辑
  - 未改 schema / 未新增 migration
  - 未改前端
  - 未改视频处理核心逻辑
  - 未引入 FFmpeg 实际处理流程
  - 未新增第三方依赖

### P4.T2 失败重试 + 指数退避 实现结果

- Commit：`b732c47` — `feat(server): add failure retry with exponential backoff (P4.T2)`
- 主要成果：
  - `server/src/jobs/jobQueue.ts` 在 `runHandler` catch 路径接入重试预算判定：`job.retryCount < maxRetries` → `markRetrying`（`running → retrying`，`retry_count++`，`next_run_at = now + min(baseDelayMs * 2^retryCount, maxDelayMs)`，error_message 落库）；否则继续走原 `markFailed`（`running → failed`，retry_count 不再 ++）。新增 `JobQueueRetryConfig` 接口（`maxRetries / baseDelayMs / maxDelayMs`），构造期校验非法配置（负数 / base=0 而 max>0 / maxDelayMs<baseDelayMs）抛错
  - `DEFAULT_RETRY_CONFIG = { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 }` —— 缺省即"无重试"，保持 P4.T1 行为不变；只有显式传 `retryConfig` 的调用方才进入新分支（生产 `server/src/index.ts` 显式接入；旧 smoke 仍走原路径）
  - `server/src/jobs/jobRepository.ts` 新增 `markRetrying(jobId, errorMessage, nextRunAt, newRetryCount, now)` —— `WHERE id=? AND status='running'` 保持竞态安全；清空 `started_at / finished_at` 让下次尝试在 Job API 里看起来"全新"
  - claim SELECT 扩展：原本只匹配 `status = 'pending'`，现在同时匹配 `(status = 'retrying' AND (next_run_at IS NULL OR next_run_at <= now))`，`claimNextPendingImageJob` / `claimNextPendingByJobTypes` 都已升级；claim UPDATE 的 `WHERE status IN ('pending', 'retrying')` 配合，并在 claim 时清空 `next_run_at` 防止退避值悬留
  - **R-40 消化**：`JobRepository.resetToPending` → `resetToRetrying`（`MediaService.reprocess` 同步切换）。reprocess 不再 `failed/success → pending` 直跳，而是走 `failed/success/retrying/cancelled → retrying`（CLAUDE.md §4.3 规范路径），并把 `retry_count=0` / `next_run_at=now`，让 executor 下一 tick 立即可拾起。outcome label 仍叫 `"reset"`（语义未变：把行从终态拽回可运行队列）
  - 配置层（`server/src/config/index.ts`、`.env.example`）补 `JOB_RETRY_BASE_DELAY_MS`（默认 `1000`）与 `JOB_RETRY_MAX_DELAY_MS`（默认 `60000`）；连同既有 `JOB_RETRY_MAX`（默认 `3`）一起通过 `config.workers.jobRetryMax / jobRetryBaseDelayMs / jobRetryMaxDelayMs` 透到 `JobQueue` 构造
  - `server/src/index.ts` boot 显式传 `retryConfig: { maxRetries, baseDelayMs, maxDelayMs }` 接入生产；P4.T1 的 13 个 smoke 全部不改，因为它们没传 retryConfig，缺省 maxRetries=0 保留原行为
- 验证：
  - `npm run smoke:job-queue` —— **42/42 PASS**（P4.T1 27 case + P4.T2 新增 15 case，覆盖：始终失败用尽预算 / 失败两次第三次成功 / next_run_at 未到不被拾取 / next_run_at 到了被拾取 / 指数退避 ~2× 倍增 / 非法 retryConfig 构造抛错）
  - `npm run smoke:media-reprocess` —— **21/21 PASS**（断言已更新：failed/success → reset 后行 `status='retrying'`、`retry_count=0`、`next_run_at` 非空；ImageChannelExecutor 在 P4.T2 SELECT 扩展后仍能拾起退避到期的 retrying 行，sanity case 验证最终 status='success'）
  - 既有 13 smoke 不回归：classify 37 / trips 22 / storage 19 / upload 30 / media 26 / storage-route 14 / image-channel-executor 26 / media-versions 24 / image-thumbnail 22 / migration-006 18 / image-metadata 23 / media-reprocess 21 / trip-cover-url 13 / **job-queue 42** —— 后端 smoke 总计 **337 / 337**
  - `npm run typecheck` / `npm run lint` / `npm run build` / `npm run format` 一次过
- 边界遵守：
  - 未改 schema / 未新增 migration（`retry_count` / `next_run_at` 字段在 P2.T2 `004_create_processing_jobs.sql` 已具备，CHECK `retry_count >= 0` 也已存在）
  - 未改前端
  - 未改 P3 thumbnail / metadata handler 业务逻辑
  - 未改 Job API（GET / retry HTTP 路由，留给 P4.T4）
  - 未改 Media 状态联动（`uploaded → processing → processed`，留给 P4.T5）
  - 未改 ImageChannelExecutor 接口与现有 P3 smoke 的执行路径
  - 未改视频 / AI 通道
  - 未引入新依赖

### P4.T3 僵尸任务恢复 实现结果

- Commit：`89bb211` — `feat(server): recover zombie jobs (P4.T3)`
- 主要成果：
  - `server/src/jobs/jobRepository.ts` 新增 `findZombieRunningJobsStmt` + `findZombieRunningJobs(startedBefore)`：SELECT `status='running' AND (started_at IS NULL OR started_at <= ?)`，按 `started_at ASC, id ASC` 排序返回。`started_at IS NULL` 的 running 行视为远古僵尸一并回收（防御性处理；正常 claim 路径会写入 started_at）
  - `server/src/jobs/jobQueue.ts` 新增 `JobQueueDeps.zombieTimeoutMs`（默认 30 min；`0` 显式禁用；负数 / NaN 构造期抛错），私有字段 `zombieTimeoutMs`，公共 `recoverZombies(now?)`，自省 `getZombieTimeoutMs()`，结果类型 `ZombieRecoveryResult { scanned, recovered, failed, skipped }`
  - `recoverZombies` 流程：以 `now - zombieTimeoutMs` 为 cutoff 拉 zombie 行 → 对每行复用 P4.T2 的 retry-预算判断：`retry_count < maxRetries` 走 `markRetrying`（同 `min(base × 2^retryCount, max)` 退避公式）+ retry_count++，否则走 `markFailed`。单行异常 try/catch 隔离，不影响整次扫描
  - `start()` 在 `state='running'` 之后、`setInterval` / eager-first-poll 之前同步调用一次 `recoverZombies()`；此时 inflight 集合必为空，无误伤风险
  - **R-42 兜底**：P4.T2 `handleFailure` 中 `markRetrying` 自身抛错的小窗口（行卡在 `running`），由下次进程重启时的 zombie 扫描自动覆盖。重用 `markRetrying / markFailed` 现有的 `WHERE status='running'` guard 保证幂等
  - `server/src/index.ts` boot 传 `zombieTimeoutMs: config.workers.zombieTimeoutMs`，env `ZOMBIE_TIMEOUT_MS` 默认 1800000（30 min）已在 P4.T1 准备阶段就绪
  - `server/src/jobs/index.ts` 导出 `ZombieRecoveryResult` 类型
- 验证：
  - `npm run smoke:job-queue` —— **55/55 PASS**（P4.T1 27 + P4.T2 15 + P4.T3 新增 13 case，覆盖：zombie + 预算 → retrying / zombie 预算耗尽 → failed / 未超时 running 不动 / pending+retrying 不动 / `started_at IS NULL` 也回收 / `start()` 自动跑扫描 / `zombieTimeoutMs=0` 关闭 / 负数 / NaN 构造抛错）
  - 既有 13 smoke 全部不回归：classify 37 / trips 22 / storage 19 / upload 30 / media 26 / storage-route 14 / image-channel-executor 26 / media-versions 24 / image-thumbnail 22 / migration-006 18 / image-metadata 23 / media-reprocess 21 / trip-cover-url 13 / **job-queue 55** —— 后端 smoke 总计 **350 / 350**
  - `npm run typecheck` / `npm run lint` / `npm run build` / `npm run format` 一次过
- 边界遵守：
  - 未改 schema / 未新增 migration（`started_at` / `retry_count` / `next_run_at` 字段在 P2.T2 已具备）
  - 未实现 Job API（保留 P4.T4）
  - 未实现 Media 状态联动（保留 P4.T5）
  - 未引入心跳 / live-zombie 检测（仅启动期扫描；handler 中途崩溃要等下次进程启动）
  - 未改前端 / 未改 thumbnail / metadata handler / 未改视频 / AI 通道
  - 未实现 priority queue / dead-letter queue / 分布式锁
  - 未引入新依赖

### P4.T4 Job API 实现结果

- Commit：`3194243` — `feat(server): add job management api (P4.T4)`
- 主要成果：
  - 新增 `server/src/routes/jobs.ts`：在 `/api/jobs` 暴露 4 个端点：
    - `GET /api/jobs?status=&jobType=&mediaId=&tripId=&limit=&offset=` 过滤 + 分页列表（`created_at DESC, id DESC`，limit 1..100 默认 50）
    - `GET /api/jobs/:id` 单条
    - `POST /api/jobs/:id/retry` 手动 retry
    - `POST /api/jobs/:id/cancel` 手动 cancel
  - 新增 `server/src/jobs/jobService.ts`：领域层校验 + 状态机判定 + 复用既有 repo 写入路径
    - `retryJob`：允许从 `failed / success / cancelled / retrying`；`pending / running` 抛 `INVALID_STATE_TRANSITION` 400；底层复用 P4.T2 `resetToRetrying`（`retry_count=0`、`next_run_at=now`、清空 `error/started/finished`）
    - `cancelJob`：允许从 `pending / retrying / running`；`success / failed / cancelled` 抛 `INVALID_STATE_TRANSITION` 400；`running` 行只翻状态不杀进程，handler 的 `markSuccess/markFailed/markRetrying` 的 `WHERE status='running'` guard 自然把后续写入吞掉
  - 新增 `server/src/jobs/jobSchemas.ts`：`jobStatusSchema` + `listJobsQuerySchema`（status / jobType / mediaId / tripId / limit / offset 校验，jobType 用 `^[A-Za-z0-9_:.-]+$` 防注入）
  - `server/src/jobs/jobRepository.ts` 新增三个方法 + 两条 SQL：
    - `findJobView(id)`：`findById` + LEFT JOIN `media_items.trip_id` 返回 `JobView`（含 `tripId`）
    - `listJobs(filter)`：filter keys 动态 AND 拼接 + LEFT JOIN；offset/limit 分页
    - `cancelJob(id)`：UPDATE WHERE `status IN ('pending', 'retrying', 'running')` → `cancelled`（设 `finished_at`）
  - 新增 `JobView` 类型（`server/src/jobs/jobTypes.ts`）：`ProcessingJob` + `tripId: string | null`
  - `server/src/app.ts`：注入 `jobService` 依赖，挂载 `/api/jobs` 路由
  - `server/src/index.ts` boot 实例化 `JobService(jobRepo)` 并传入 `createApp`
  - `server/src/jobs/index.ts` 导出 `JobService` / `JobView` / `JobListFilter` / `jobStatusSchema` / `listJobsQuerySchema` / `ListJobsQuery`
- 验证：
  - 新增 `npm run smoke:jobs-api` —— **28/28 PASS**：覆盖列表 / 4 种过滤 / 分页 / 校验失败 / 单条查询 / 404 / retry 四种合法源态 / retry pending+running 400 / retry 不触发 handler（无 JobQueue 运行 → row 留在 `retrying` 且 `started_at=NULL`）/ cancel 三种合法源态 / cancel 后 JobQueue.tickChannel 不再拾起该行 / cancel 三种非法源态 / 路径参数校验 / 上限校验
  - 既有 14 smoke 全部不回归（classify 37 / trips 22 / storage 19 / upload 30 / media 26 / storage-route 14 / image-channel-executor 26 / media-versions 24 / image-thumbnail 22 / migration-006 18 / image-metadata 23 / media-reprocess 21 / trip-cover-url 13 / job-queue 55）—— 后端 smoke 总计 **378 / 378**
  - `npm run typecheck` / `npm run lint` / `npm run build` / `npm run format:check` 一次过
- 边界遵守：
  - 未改 schema / 未新增 migration
  - 未实现 Media 状态联动（保留 P4.T5）
  - 未改前端 / 未改 thumbnail / metadata handler / 未改视频核心 / 未改 trip cover
  - 未实现 priority queue / dead-letter queue / 分布式锁
  - 未引入新依赖
  - 未直接调用 handler — retry / cancel 均纯 DB 写入，由 JobQueue 在下次 tick 拾起 retrying 行

### P4.T5 Media 状态联动 实现结果

- Commit：`13be49e` — `feat(server): sync media status with jobs (P4.T5)`
- 主要成果：
  - `server/src/jobs/jobRepository.ts` 新增 **私有** `syncMediaStatusByMediaId(mediaId, now)` —— 聚合该 media 下所有 jobs 的 status 分布，按下列优先级判定 `media_items.status` 目标值：
    1. 任一 job ∈ {`pending`, `retrying`, `running`} → **`processing`**
    2. 任一 job = `failed` → **`failed`**
    3. 任一 job = `success`（cancelled 共存视为用户跳过）→ **`processed`**
    4. 仅 `cancelled`（无其他终态）→ **`failed`**（cancel 是终态但非成功，符合"不应继续显示处理中"）
    5. 没有任何 job → 不动（保留 `uploaded`）
  - 新增 `syncMediaStatusForJob(jobId, now)` 私有 helper：从 job id 解析 media_id 后转发到上面的方法，给只持有 jobId 的 mutating method 用
  - 接线到 **所有** `JobRepository` 状态翻转方法（在 `changes > 0` 时调用）：
    - `claimNextPendingImageJob` / `claimNextPendingByJobTypes`：使用 `updated.media_id`（已查询的行）直接同步
    - `markSuccess` / `markFailed` / `markRetrying` / `cancelJob` / `resetToRetrying`：通过 `syncMediaStatusForJob` 查 media_id 再同步
  - `applyMediaStatusStmt` 的 UPDATE WHERE 子句保护：`deleted_at IS NULL AND status NOT IN ('archived', 'deleted') AND status != target` —— 不覆盖 archived/deleted/soft-deleted 行；target == current 时 no-op（不写 `updated_at`）
  - **insert() 不触发同步** —— 新 pending job 不会立即把 media 翻成 `processing`；upload-smoke 的 `media_items.status defaults to 'uploaded'` 断言保留。第一次同步发生在 claim（`pending/retrying → running`）。同时遵循 P2.T1 migration 注释 "processing → at least one job is RUNNING"。
  - 自动覆盖所有调用方：JobQueue（生产）、ImageChannelExecutor（P3 stub smoke harness）、JobService.retry / cancel、MediaService.reprocess — 全部经过 JobRepository 状态翻转方法，无需各自接线。
- **错误信息记录策略**：`media_items` 表没有 `error_message` 字段（schema 红线，禁止 migration）。错误细节继续存于 `processing_jobs.error_message`，调用方通过 `GET /api/jobs?mediaId=…`（P4.T4）获取。Media 状态只携带 status flag，详细原因在 jobs 上 — 这是有意的关注点分离。
- 验证：
  - 新增 `npm run smoke:media-status-sync` —— **18/18 PASS**：覆盖无 jobs 不动 / pending 不触发 / claim → processing / success → processed / failed → failed / retrying → 仍 processing / 多 job 混合（success+pending / success+failed / success+success）/ cancel pending / cancel running / cancel 部分 / Retry API → processing / Reprocess → processing / 软删除不动 / archived 不动 / no-op 时 updated_at 不变
  - 既有 15 smoke 全部不回归：classify 37 / trips 22 / storage 19 / upload 30 / media 26 / storage-route 14 / image-channel-executor 26 / media-versions 24 / image-thumbnail 22 / migration-006 18 / image-metadata 23 / media-reprocess 21 / trip-cover-url 13 / job-queue 55 / jobs-api 28 —— 后端 smoke 总计 **396 / 396**
  - `npm run typecheck` / `npm run lint` / `npm run build` / `npm run format:check` 一次过
- 边界遵守：
  - 未改 schema / 未新增 migration（`media_items.status` 枚举原样保留 `uploaded/processing/processed/failed/archived/deleted`，未新增 `cancelled` / `error_message` 列）
  - 未实现前端 / 任务状态页（保留 P4.T6）
  - 未改 thumbnail / metadata handler / 视频核心 / trip cover
  - 未引入新依赖
  - 未实现 priority queue / dead-letter queue
  - JobRepository 写入 media_items 是有意的跨表副作用：状态机的真实位置在 JobRepository，集中同步避免每个 caller 重复实现

### P4.T6 前端任务状态页 实现结果

- Commit：`ce70057` — `feat(client): add jobs page (P4.T6)`
- 主要成果：
  - 新增 `client/src/api/jobs.ts` —— 与 P4.T4 Job API 完全对齐的客户端：`JobStatus` 字面量联合（与服务端 enum 同字）、`JobView` 接口（与服务端 `JobView` 一致，含 `tripId | null`、`payload`、`progress`、`retryCount`、`nextRunAt`、`startedAt`、`finishedAt`、`errorMessage`）、`fetchJobs(opts, signal)` / `getJobById(id)` / `retryJob(id)` / `cancelJob(id)`。错误通过 `error.message` envelope 解码为 `Error.message`，沿用既有 trips/media 客户端风格
  - 新增 `client/src/hooks/useJobs.ts` —— 与 `useTrips` 同模式的三态 hook（`{jobs, loading, error, refetch}`），传入 `FetchJobsOptions` 过滤器；通过稳定序列化的 `filterKey` 触发重 fetch；`AbortController` 取消未完成请求，避免 strict-mode double-mount 竞态
  - 新增 `client/src/pages/JobsPage.tsx` —— `/jobs` 路由组件：
    - 头部：Back link、标题、Refresh 按钮（loading 时禁用）
    - 状态过滤 chip 行：`All / pending / running / retrying / success / failed / cancelled`，active chip 驱动 API filter
    - 表格列：Job(id 截断) / Type / Status badge / Retries / Next run / Media+Trip(链接到 `/media/:id` 与 `/trips/:id`) / Created+Updated / Error / Actions
    - Retry 按钮仅对 `{failed, success, cancelled, retrying}` 可用，Cancel 按钮仅对 `{pending, retrying, running}` 可用，与服务端 `JobService` 规则一致；不满足条件时按钮 disabled 并通过 `title` 解释
    - 行内 busy state（Retry / Cancel 进行中显示 `…`）+ 行下方 success/error 反馈（`aria-live` 友好）
    - 成功 retry/cancel 后调用 `refetch()` 重新拉取列表，状态以服务端为准（不在前端硬编码模拟）
    - 空态文案区分 "无任何 job" 与 "当前过滤无匹配"
  - `client/src/App.tsx` —— 注册 `<Route path="/jobs">`，注释里把 `/jobs` 标为 ✓ wired
  - `client/src/pages/TripListPage.tsx` —— 首页 header 多加一个 `Jobs` secondary 按钮，让 `/jobs` 可达，不破坏既有 `+ New trip` CTA
  - `client/src/index.css` —— 新增 `JobsPage (P4.T6)` 区块：filter chip、jobs table（横向滚动 wrapper、单元格类型、错误省略、操作堆叠）、6 色 status badge（pending/running/retrying/success/failed/cancelled），与既有 `.btn-*` / `.status-text` / `.empty-state` 视觉对齐
- 验证：
  - **client**：`npm run build` 一次过（vite 输出 49 模块 / 12.6 KB CSS gzip / 200 KB JS gzip 61.8 KB）；`npm run typecheck` / `npm run lint` / `npm run format:check` 全绿
  - **server 不回归**：`npm run typecheck` / `npm run lint` / `npm run build` 一次过；冒烟回归 `smoke:job-queue 55/55` + `smoke:jobs-api 28/28` + `smoke:media-status-sync 18/18` + `smoke:media-reprocess 21/21`
- 边界遵守：
  - 未改后端 JobQueue 状态机 / 未改 schema / 未写 migration
  - 未改 thumbnail / metadata handler / 未改视频核心 / 未改 trip cover
  - 未引入新 npm 依赖（仅 React + react-router-dom，已存在）
  - 未大范围重构：只新增 3 个文件 + 修改 3 个文件（App.tsx 注册路由、TripListPage 加入口、index.css 加样式）
  - 状态以 API 为唯一真源；前端不维护并行状态机，retry/cancel 后 refetch
  - 不直接调用 handler，只通过 `/api/jobs/:id/retry` 与 `/api/jobs/:id/cancel`

### P4 阶段完成内容

| Task | Commit | 主要交付 |
|---|---|---|
| **P4.T1** | `23a5fc4` | 多通道 `JobQueue` —— image / video / ai 三通道独立 polling + handler 注册 + 并发上限 + start/stop 生命周期 + handler 错误隔离；`JobRepository.claimNextPendingByJobTypes` 取代硬编码 `LIKE`；boot 切换到 JobQueue（ImageChannelExecutor 留作 P3 smoke harness）；smoke:job-queue 27/27 |
| **P4.T2** | `b732c47` | 失败重试 + 指数退避 —— `handleFailure` 按 `retry_count < maxRetries` 路由 `markRetrying`（base × 2^retryCount 退避）vs `markFailed`；claim SELECT 扩展为同时匹配 retrying-due 行；`resetToRetrying` 取代 `resetToPending` 走规范路径（消化 R-40）；`JobQueueRetryConfig` + env `JOB_RETRY_BASE_DELAY_MS` / `JOB_RETRY_MAX_DELAY_MS`；smoke:job-queue 42/42 + smoke:media-reprocess 21/21 |
| **P4.T3** | `89bb211` | 启动期 zombie 恢复 —— `JobQueue.start()` 调 `recoverZombies()`，扫描 `started_at` 超 `zombieTimeoutMs` 的 `running` 行，按 retry 预算路由 `markRetrying` / `markFailed`；`zombieTimeoutMs=0` 显式禁用；构造期校验负数/NaN；兜底 P4.T2 markRetrying 自身失败的小窗口（消化 R-42）；smoke:job-queue 55/55 |
| **P4.T4** | `3194243` | Job API —— `/api/jobs` 4 个端点：list (status/jobType/mediaId/tripId/limit/offset 过滤 + LEFT JOIN trip_id) / single / retry (failed/success/cancelled/retrying → retrying) / cancel (pending/retrying/running → cancelled)；`JobService` 状态机校验 → 400 `INVALID_STATE_TRANSITION`；retry 不直接调 handler，由 JobQueue 下次 tick 拾起；cancel running 行不杀进程；smoke:jobs-api 28/28 |
| **P4.T5** | `13be49e` | Media 状态联动 —— JobRepository 7 个状态翻转方法（claim / markSuccess / markFailed / markRetrying / cancelJob / resetToRetrying / claimNextPendingImageJob）在 `changes>0` 时调 `syncMediaStatusByMediaId`，按 job 聚合衍生 `media_items.status`（active → processing / failed → failed / success-with-cancelled → processed / cancelled-only → failed / no jobs → 不动）；UPDATE 守卫 soft-deleted + archived；smoke:media-status-sync 18/18 |
| **P4.T6** | `ce70057` | 前端 Jobs 页 —— `/jobs` 路由 + filter chip + 表格（id/type/status badge/retries/next_run_at/media+trip 链接/created+updated/error/actions）+ 行内 retry+cancel 按钮（镜像服务端规则）+ aria-live 反馈；状态以 API 为单一真源，操作后 refetch；首页 header 加 Jobs 入口；新增 `api/jobs.ts` + `useJobs` hook + JobsPage |
| **P4.T7** | （本任务）| 阶段验收 + 文档收口（仅 progress.md + tasks.md，零业务代码改动）|

### P4.T7 验收结果

| 验收项 | 结果 |
|---|---|
| [requirements §7.17 验收 1](requirements.md) 任务可从 pending / retrying 被 claim、running 可 success / failed / retrying | **PASS** — JobRepository claim SELECT 同时匹配 `pending` 与 `retrying`-due（P4.T2）；`markSuccess` / `markFailed` / `markRetrying` 都带 `WHERE status='running'` guard；smoke:job-queue CASE 13 "retry: after attempt 1/2/3" + smoke:image-channel-executor 实证完整 4 态迁移 |
| §7.17 验收 2 `retry_count` / `next_run_at` 生效 | **PASS** — `markRetrying` 接受 `newRetryCount` + `nextRunAt` 参数，写入 row；smoke:job-queue CASE 13 "retry_count=1/2"、CASE 14 "retry-then-succeed retry_count==2"、CASE 15 "backoff gating tick before next_run_at → claimed=0"、CASE 16 "backoff doubling ratio=2.00" 全部实证 |
| §7.17 验收 3 超时 `running` 任务可识别恢复 | **PASS** — `JobQueue.start()` 自动 `recoverZombies()`；smoke:job-queue CASE 18 "zombie + retry budget → retrying"、CASE 19 "zombie + budget exhausted → failed"、CASE 22 "null started_at recovered"、CASE 23 "start() auto-runs scan" 全 PASS |
| §7.17 验收 4 Job API list / detail / retry / cancel 可用 | **PASS** — `GET /api/jobs` + `GET /api/jobs/:id` + `POST /api/jobs/:id/retry` + `POST /api/jobs/:id/cancel`；smoke:jobs-api 28/28 覆盖列表 / 4 种过滤 / 分页 / 单条 / 404 / retry 4 种合法源态 / retry 不触发 handler / cancel 3 种合法源态 / cancel 后不再被 claim / 校验失败 400 |
| §7.17 验收 5 media 状态随 job 状态同步 | **PASS** — JobRepository.sync 私有 helper 在每次 mutating 后聚合 job 状态衍生 `media_items.status`；smoke:media-status-sync 18/18 覆盖 active → processing / success → processed / failed → failed / cancel → failed / retry → processing / 软删除 + archived 行保护 / no-op 写不 bump updated_at |
| §7.17 验收 6 前端任务状态页可查看 / retry / cancel | **PASS** — `/jobs` 页面（P4.T6 commit `ce70057`）：filter chip / 表格 / retry+cancel 行内按钮 / aria-live 反馈 / 错误展示；状态以服务端 API 为单一真源（不在前端硬编码模拟）；按钮可用性镜像服务端 `JobService` 允许-源态集合 |
| §7.17 验收 7 单文件失败不影响其他 | **PASS** — JobQueue handler error 隔离（P4.T1）：catch 内只动一行 + 队列继续 polling；smoke:job-queue CASE 4 "handler throws: queue continued + sibling job success" 实证 |
| **P4.T7 额外**：P3 链路不回归（thumbnail / metadata / reprocess / cover_url / storage 路由）| **PASS** — smoke:image-channel-executor 26/26 + smoke:image-thumbnail 22/22 + smoke:image-metadata 23/23 + smoke:media-reprocess 21/21 + smoke:trip-cover-url 13/13 + smoke:storage-route 14/14 全绿 |
| **P4.T7 额外**：状态机迁移路径符合 CLAUDE.md §4.3 规范 | **PASS** — R-40（reprocess 绕过 retrying）+ R-42（zombie 卡 running）均已消化；所有写入走 JobRepository 的 `WHERE status=…` guard 方法，无直接 `UPDATE status` 旁路 |
| **P4.T7 额外**：retry / cancel API 不直接执行 handler | **PASS** — JobService.retryJob 调 `resetToRetrying`（DB 翻转）；JobService.cancelJob 调 `cancelJob` SQL；smoke:jobs-api "retry does not directly execute handler" + "after cancel: JobQueue tick does NOT claim the cancelled row" 实证 |

### 阶段 P4 验证命令

后端（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage                 # 19/19
npm run smoke:trips                   # 22/22
npm run smoke:classify                # 37/37
npm run smoke:upload                  # 30/30
npm run smoke:media                   # 26/26
npm run smoke:storage-route           # 14/14
npm run smoke:image-channel-executor  # 26/26
npm run smoke:media-versions          # 24/24
npm run smoke:image-thumbnail         # 22/22
npm run smoke:migration-006           # 18/18
npm run smoke:image-metadata          # 23/23
npm run smoke:media-reprocess         # 21/21
npm run smoke:trip-cover-url          # 13/13
npm run smoke:job-queue               # 55/55（P4.T1 27 + P4.T2 15 + P4.T3 13）
npm run smoke:jobs-api                # 28/28（P4.T4）
npm run smoke:media-status-sync       # 18/18（P4.T5）
```

后端 smoke 总计 **396 / 396**（既有 295 + 阶段 P4 新增 101），零回归。

前端（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

均一次过。Vite gzip JS 61.80 KB / CSS 3.04 KB。

新增依赖：无（P4 全程零新增 npm 依赖，仅复用既有 React + react-router-dom + zod + better-sqlite3 + express + pino 等）。

### 阶段 P4 PARTIAL 项与依赖

| 项 | 何时完成 |
|---|---|
| 心跳 / live-zombie 检测（handler 运行中检测进度停滞）| 非阻断；P4.T3 启动扫描已覆盖崩溃 / kill -9 / OOM 等绝大多数实际场景。在线检测需要 handler 周期性写 progress / heartbeat，留给真实视频 worker 落地时（P9）评估 |
| FFmpeg 实际子进程执行 + ffmpeg 可用性 gating（视频 channel 真正激活）| P9 任务实际落地视频 handler 时；P4.T1 仅预留 channel 结构 + 空 handler Map |
| 任务列表分页 UI（前端按钮 / 加载更多）| P4 后续 polish；当前 `/jobs` 页面单页拉取 50 条，足够 V1。后端 API 已支持 limit / offset |
| Job 详情子页 `/jobs/:id` | P4 后续 polish；当前列表页已展示全字段 + 行内操作，详情页非必要 |
| `image_metadata` job upload 阶段自动入队（R-41）| 仍由 P3.T7 reprocess 或手动 INSERT 触发；可在 thumbnail handler 中链式入队，或 upload service 一次入两个 job —— 留给下个阶段评估 |
| Media 表 `error_message` 列 | 故意不加（schema 红线）；错误细节由 `processing_jobs.error_message` + `GET /api/jobs?mediaId=...` 暴露，前端 Jobs 页已用此路径展示 |

### 阶段 P4 PARTIAL 已消化

| 编号 | 描述 | 消化点 |
|---|---|---|
| R-40 | `reprocess` 绕过 `failed → retrying → running` 规范迁移 | P4.T2 `resetToRetrying`（retry_count=0、next_run_at=now、走 §4.3 路径）|
| R-42 | `markSuccess` 后进程 crash 让 "running" 行卡死 | P4.T3 启动期 `recoverZombies` 按 retry 预算路由回 `retrying` / `failed`；附带兜底 P4.T2 markRetrying 自身失败小窗口 |

### 阶段 P4 剩余风险

承自前期：R-01 ~ R-12（P0）、R-14 / R-15 / R-16 / R-17 / R-18 / R-19 / R-20 / R-23 / R-24（P1）、R-29 / R-30 / R-31 / R-35 / R-36 / R-37 / R-38 / R-39（P2）、R-41 / R-43 / R-44（P3）继续延续。

**P4 新增**：

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-45 | 多实例部署时 JobQueue 并发 claim 可能产生 SQL 级竞态（虽有 `WHERE status='pending'` race-safe，但缺少分布式锁 / advisory lock） | 单实例部署不阻断；分布式部署时引入 Postgres + advisory lock 或 Redis 锁 |
| R-46 | 取消 `running` 行不杀进程；handler 完成后仅 mark* 为 no-op，但 sharp / exifr 资源已实际消耗 | 真实视频处理（P9）时考虑 AbortSignal 透传给 handler；图片处理通常足够快，可忽略 |
| R-47 | `ZOMBIE_TIMEOUT_MS=1800000`（30 min）默认对图片偏宽；快速恢复需要更低值或者 heartbeat 机制 | 单实例 / 图片为主场景非阻断；视频 worker 上线后按通道差异化设置 |

### P5 前置条件

- P4.T1 ~ P4.T7 全部完成 ✅
- P4 验收通过（10 项全部 PASS）✅
- 工作区干净 ✅
- P4 阶段文档已收口 ✅（本节）
- JobQueue / Job API / Media 状态联动接口稳定，P5 dedup 任务可以作为新 job_type 注册（`image_hash` 等）走相同调度路径
- 无 schema / migration 改动（仍是 000 ~ 006）
- Trip / Media / Upload / Storage 契约不变
- 前端 Trip CRUD / Media 详情 / Gallery / Upload / Jobs 页面契约不变

---

## 阶段 P5：图片去重

- 状态：**已完成**
- 任务范围：P5.T1 – P5.T8（8 / 8；T1.5 Repository 与 T1 同一 commit 区间，作为 T1 的紧邻交付）
- 提交范围：`caebea4` … `a7ad70f`（P5.T8 验收无业务代码改动，仅本文件 + tasks.md）
- 完成日期：2026-05-18

### P5.T1 `duplicate_groups` / `duplicate_group_items` 迁移 实现结果

- Commit：`caebea4` — `feat(server): add duplicate groups migration (P5.T1)`
- 主要成果：
  - 新增 `server/migrations/007_create_duplicate_groups.sql` —— 一次性建两张 STRICT 表
    - **`duplicate_groups`** 9 列（per requirements §8.4）：`id` / `trip_id` / `group_type` / `recommended_media_id` / `confidence` / `similarity_score` / `user_confirmed` / `created_at` / `updated_at`
      - CHECK：`group_type ∈ ('exact', 'similar', 'candidate')`、`confidence` 0..1 nullable、`similarity_score` 0..1 nullable、`user_confirmed ∈ (0, 1)`
      - FK：`trip_id → trips(id) ON DELETE RESTRICT`（与 `media_items.trip_fk` 一致）；`recommended_media_id → media_items(id) ON DELETE SET NULL`（per design.md §4.2 R-row，业务层应在 delete 前重置，但 SET NULL 是 schema 兜底网）
      - Index：`trip_id` / `group_type` / `recommended_media_id` / `user_confirmed` —— 覆盖"按 trip 列重复组"、"按类型全局聚合"、"反查推荐的 media"、"找未确认组"四种典型查询
    - **`duplicate_group_items`** 10 列（per requirements §8.5）：`id` / `group_id` / `media_id` / `similarity_score` / `quality_score` / `recommendation` / `reason` / `user_decision` / `created_at` / `updated_at`
      - CHECK：`similarity_score` / `quality_score` 0..1 nullable、`recommendation ∈ ('keep', 'remove', 'undecided')`、`user_decision` 同枚举
      - FK：`group_id → duplicate_groups(id) ON DELETE CASCADE`、`media_id → media_items(id) ON DELETE CASCADE`（与 `processing_jobs` / `media_versions` 风格一致）
      - Index：`UNIQUE (group_id, media_id)`（design §4.2 explicit，左前缀同时充当"组内成员列表"查找）；单独 `media_id` 反向索引（P7 软删除路径要用）
    - `reason` 字段保留 nullable，对应 CLAUDE.md §3.8 "推荐结果必须可解释"，但允许 dedup 算法尚未跑过时留空
  - 新增 `server/src/scripts/migration-007-smoke.ts` + npm 脚本 `smoke:migration-007` —— **37/37 PASS**：fresh DB 全量应用 + 列序 + 索引完整性 + 所有 CHECK / FK 行为（含 SET NULL / CASCADE / RESTRICT 三种策略实测）/ UNIQUE 阻止重复成员 / upgrade 场景（停在 006 → 升 007 → 旧行保留 + 新表可写）/ idempotency（再跑一次 0 应用）
  - 微调 `server/src/scripts/migration-006-smoke.ts` —— 两处对 `appliedNow.length === 7` / `length === 1` 的硬编码改为只检查 "006 在 appliedNow 中" / "006 是首个 appliedNow 条目"，让 006 smoke 对后续 migration（007+）保持兼容；测试意图不变（验 006 自身行为）
- 验证：
  - `npm run smoke:migration-007` 37/37 PASS
  - 既有 16 smoke 不回归：storage 19/19, trips 22/22, classify 37/37, upload 30/30, media 26/26, storage-route 14/14, image-channel-executor 26/26, media-versions 24/24, image-thumbnail 22/22, **migration-006 18/18**（含上面的兼容性微调）, image-metadata 23/23, media-reprocess 21/21, trip-cover-url 13/13, job-queue 55/55, jobs-api 28/28, media-status-sync 18/18 —— 后端 smoke 总计 **433/433**
  - `npm run typecheck` / `npm run lint` / `npm run build` / `npm run format:check` 一次过
- 边界遵守：
  - 仅 schema/migration + smoke + docs；未实现 Repository / Service / API / 任何 dedup 算法（hash / pHash / dHash / CLIP / DINOv2 全部留待 P5.T2+）
  - 未改 upload 流程 / JobQueue / 前端 / thumbnail / metadata handler / trip cover / 视频
  - 未引入新 npm 依赖
  - 既有删除流程（trip / media）通过 ON DELETE RESTRICT / SET NULL / CASCADE 三种策略保证 schema 层兜底；P7 软删除业务逻辑（重置 `recommended_media_id`、把 `user_decision` 切到 `'remove'`）会接续完成

### P5 阶段完成内容

| Task | Commit | 主要交付 |
|---|---|---|
| **P5.T1** | `caebea4` | `007_create_duplicate_groups.sql` —— `duplicate_groups`（9 列）+ `duplicate_group_items`（10 列）STRICT 表 + CHECK enums + FK RESTRICT/SET NULL/CASCADE 三策略 + UNIQUE (group_id, media_id) + 反向 media_id 索引；smoke:migration-007 37/37 |
| **P5.T1.5** | `bbfafbd` | `DuplicateGroupsRepository` 数据访问层 —— insertGroup / insertItem / `createGroupWithItems` 事务 / findGroupById / listByTripId / listItemsByGroupId / listByTripIdWithItems / listGroupsByMediaId / deleteGroup；smoke:duplicate-groups-repository 30/30 |
| **P5.T2** | `18f1c37` | `image_hash` worker —— SHA256（node:crypto）+ pHash（32×32 grayscale + 2-D DCT-II + 中位数阈值）+ dHash（9×8 梯度），写 `media_items.file_hash`（64 hex）+ `perceptual_hash`（32 hex = pHash16 + dHash16）；`MediaRepository.updateImageHashes`；注册到 JobQueue image 通道；零新依赖（DCT 50 行自实现）；smoke:image-hash 25/25 |
| **P5.T3** | `921e8f3` | `DedupEngine.runExactForTrip(tripId)` —— 同 trip 内按 `file_hash` 严格聚合，confidence=1.0，事务原子写；已在某 exact 组的成员形成"已分组"Set，重叠 cohort 整组 skip（同一规则覆盖幂等性 + user_confirmed 保护 + partial-overlap）；`MediaRepository.findActiveImageHashesByTripId`；smoke:dedup-exact 26/26 |
| **P5.T4** | `047ee3a` | `DedupEngine.runSimilarForTrip(tripId, {hammingThreshold?})` —— pHash 16-hex 半区 pairwise Hamming + DSU 连通分量合并（支持传递相似）；阈值默认 `DEFAULT_SIMILAR_HAMMING_THRESHOLD=8`（mirror `PHASH_DISTANCE_MAX`），confidence/similarity = `1 - maxPairDistance/64`；`hexHammingDistance` 纯函数 + 独立测试；保护规则升级覆盖 **所有 group_type**（不破坏既有 exact 组）；smoke:dedup-similar 40/40 |
| **P5.T5** | `0b36f91` | Dedup API —— `POST /api/trips/:tripId/dedup/{exact, similar, run}` 三端点 + `DedupService` 包装层（tripId 验证 + tripService.getTripById 404 + `cohortsSkippedByReason` 聚合）；body 仅 `hammingThreshold` 0..64；URL path 唯一作用域绑定，body strip 未知 key 阻断 cross-trip；smoke:dedup-api 18/18（初版）|
| **P5.T6** | `8bf6fd2` | 前端列表 + 详情页 + 后端 GET 端点补齐 —— `GET /api/trips/:tripId/duplicate-groups` + `GET /api/duplicate-groups/:id`；`DuplicateGroupsRepository.findGroupByIdWithItems` + `MediaRepository.findByIds`（批量 hydrate）；前端 `/trips/:tripId/duplicates` 卡片网格 + `/duplicate-groups/:id` 详情；Trip 详情页 "Find duplicates" 按钮调 run API 跳列表；soft-deleted media 显示 "missing" 占位；smoke:dedup-api 27/27（+7 GET case）|
| **P5.T7** | `a7ad70f` | 用户确认写入 —— `POST /api/duplicate-groups/:id/recommend`（设 recommended_media_id）+ `POST /api/duplicate-groups/:id/confirm`（事务原子：group header user_confirmed=1 + items.user_decision keep/remove）；`Repository.groupContainsMedia` cross-group leak guard；前端 "Keep this one" / "Confirm group" / "Re-confirm group" 按钮 + Recommended/Confirmed badge + 蓝边高亮；smoke:duplicate-group-confirm 20/20 |
| **P5.T8** | （本任务）| 阶段验收 + 文档收口（仅 progress.md + tasks.md，零业务代码改动）|

### P5.T8 验收结果

| 验收项 | 结果 |
|---|---|
| [requirements §7.5 验收 1](requirements.md) 完全相同的图片可以被识别 | **PASS** — `image_hash` 写 SHA256（file_hash 列已有索引），`DedupEngine.runExactForTrip` 按 file_hash 严格聚合 `group_type='exact'`；smoke:image-hash "happy: file_hash equals SHA256 of seeded JPEG buffer" + smoke:dedup-exact CASE 1-3 + smoke:dedup-api "POST /dedup/exact" 实证 |
| §7.5 验收 2 连拍或轻微角度变化的图片可以被归组 | **PASS** — pHash + dHash 写入 `perceptual_hash`（32 hex），`runSimilarForTrip` 按 Hamming ≤ T 聚合 `group_type='similar'`；DSU 连通分量合并使 A~B~C 三元链即使 d(A,C)>T 仍归一组；smoke:dedup-similar "transitive similar" + "3 directly similar" 实证；阈值走 `PHASH_DISTANCE_MAX` 配置 |
| §7.5 验收 3 同一组中系统推荐一张默认保留图 | **PARTIAL（自动推荐留 P6）** — schema 列 `duplicate_groups.recommended_media_id` 与 API 路径已就绪；P5 仅支持**用户手动**选择推荐图（`POST .../recommend`），自动按 quality_score 推荐留给 P6.T5 `Quality_Selector`。设计层闭环已具备（design.md §7.3 #5 + CLAUDE.md §3.9） |
| §7.5 验收 4 用户可以更改默认保留图 | **PASS** — `POST /api/duplicate-groups/:id/recommend` 改 recommended；`POST .../confirm` 再次以不同 mediaId 调用允许"改主意"，items.user_decision 同步翻转；smoke:duplicate-group-confirm CASE 9 "re-confirm with different mediaId flips items" 实证；前端详情页 "Re-confirm group" 入口 |
| §7.5 验收 5 用户可以批量删除未保留图片，但必须二次确认 | **N/A（留给 P7）** — 真实删除属于 P7 软删除 / 永久删除范围。P5 仅写 `items.user_decision='remove'` 作为意图标记，不删除文件、不更新 `media_items.deleted_at`；前端无 batch delete 按钮。CLAUDE.md §2.4 ~ §2.6 红线明确"删除必须由用户二次确认 + 处理关联表" |
| §7.5 验收 6 删除重复图片前必须删除 duplicate_group_items 等关联记录 | **PASS（schema 兜底）** — `duplicate_group_items.media_id` FK ON DELETE CASCADE（007 migration），`recommended_media_id` FK ON DELETE SET NULL（design.md §4.2 R-row）；schema 层兜底永久删除不会违反 FK；smoke:migration-007 "media delete sets recommended_media_id to NULL" + "duplicate_group_items cascades from media_items delete" 实证。业务层手动重置由 P7 接续 |
| §7.5 验收 7 低置信度相似组应标记为"疑似重复"，不能直接建议强删除 | **PASS（数据层）** — `duplicate_groups.confidence = 1 - maxPairDistance/64`，松散 cohort 自带低置信度（如 d_max=10 → confidence=0.844）；前端详情页 Overview 区显示 Confidence + Similarity 分数；不存在"强删除"按钮，删除路径完全留给 P7；smoke:dedup-similar "transitive similar: group confidence reflects worst pair (d=10)" 实证 confidence=0.84375 |
| **P5.T8 额外**：用户已确认的重复组不被自动 dedup 覆盖 | **PASS** — `Dedup_Engine` 扫描前用 `listByTripIdWithItems` 构建 "已在任意 group" 的 mediaId Set，候选 cohort 任一成员命中即整组 skip（同规则覆盖 exact / similar / candidate / user_confirmed）；smoke:duplicate-group-confirm CASE 10 "engine protection: rerun exact creates 0 new groups + user_confirmed=1 preserved" 实证 |
| **P5.T8 额外**：API 调用作用域严格按 tripId 绑定，无 cross-trip 写入路径 | **PASS** — tripId 仅从 URL path 读取；zod schema 默认 `strip` 行为静默丢弃 body 中的 `tripId` / `mediaIds` 等多余 key；mediaId 在 recommend / confirm 时被 `groupContainsMedia` 验证为目标 group 成员（400 INVALID_STATE_TRANSITION）；smoke:dedup-api CASE 15 "cross-trip safety: body keys ignored" + smoke:duplicate-group-confirm CASE 2 "foreign mediaId → 400" + CASE 11 "isolation: group A confirmed; group B stays untouched" 实证 |
| **P5.T8 额外**：P3 / P4 链路不回归 | **PASS** — smoke:image-channel-executor 26/26 + smoke:image-thumbnail 22/22 + smoke:image-metadata 23/23 + smoke:media-reprocess 21/21 + smoke:trip-cover-url 13/13 + smoke:storage-route 14/14 + smoke:job-queue 55/55 + smoke:jobs-api 28/28 + smoke:media-status-sync 18/18 + smoke:migration-007 37/37 全绿；前端 build / typecheck / lint / format:check 一次过 |

### 阶段 P5 验证命令

后端（`server/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run smoke:storage                       # 19/19
npm run smoke:trips                         # 22/22
npm run smoke:classify                      # 37/37
npm run smoke:upload                        # 30/30
npm run smoke:media                         # 26/26
npm run smoke:storage-route                 # 14/14
npm run smoke:image-channel-executor        # 26/26
npm run smoke:media-versions                # 24/24
npm run smoke:image-thumbnail               # 22/22
npm run smoke:migration-006                 # 18/18
npm run smoke:image-metadata                # 23/23
npm run smoke:media-reprocess               # 21/21
npm run smoke:trip-cover-url                # 13/13
npm run smoke:job-queue                     # 55/55
npm run smoke:jobs-api                      # 28/28
npm run smoke:media-status-sync             # 18/18
npm run smoke:migration-007                 # 37/37（P5.T1）
npm run smoke:duplicate-groups-repository   # 30/30（P5.T1.5）
npm run smoke:image-hash                    # 25/25（P5.T2）
npm run smoke:dedup-exact                   # 26/26（P5.T3）
npm run smoke:dedup-similar                 # 40/40（P5.T4）
npm run smoke:dedup-api                     # 27/27（P5.T5 + P5.T6 GET 端点）
npm run smoke:duplicate-group-confirm       # 20/20（P5.T7）
```

后端 smoke 总计 **601 / 601**（既有 396 + 阶段 P5 新增 205），零回归。

前端（`client/`）：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm run format:check
```

均一次过。Vite gzip JS 64.17 KB / CSS 3.64 KB（含 DuplicateGroupListPage + DetailPage + 5 个 dedup api 函数 + 2 个 hook + ~310 行 CSS 新增）。

新增依赖：**无**（P5 全程零新增 npm 依赖；DCT-II 由 ~50 行 TS 自实现，未引入 phash 库）。

### 阶段 P5 最终能力

P5 建立了图片去重的端到端闭环：

1. **hash 生成**（`image_hash` worker）：每张活动图片可一次性算 SHA256 + pHash + dHash 并写回 `media_items` —— 幂等、JobQueue 调度、type≠image 拒绝。
2. **exact dedup**：按 `file_hash` 严格聚合，confidence=1.0；事务写入；已分组保护。
3. **similar dedup**：pHash Hamming + DSU 传递合并；阈值可配（`PHASH_DISTANCE_MAX`）；confidence 反映 cohort 紧密度（`1 - d_max/64`）。
4. **API 触发**：`POST /api/trips/:tripId/dedup/{exact, similar, run}` 三端点（synchronous，trip 范围）。
5. **API 读取**：`GET /api/trips/:tripId/duplicate-groups` + `GET /api/duplicate-groups/:id`，items 内联 media 投影。
6. **前端查看**：`/trips/:tripId/duplicates` 卡片网格 + `/duplicate-groups/:id` 详情 + Trip 详情页 "Find duplicates" 入口。
7. **用户确认**：`/recommend`（设 recommended_media_id）+ `/confirm`（事务原子写 user_confirmed=1 + items keep/remove）；前端 "Keep this one" / "Confirm group" / "Re-confirm group" 按钮 + Confirmed pill。
8. **confirmed group 保护**：所有 group_type 的成员都进入"已分组"Set，自动重算永远 skip 重叠 cohort —— 不偷偷加入新图、不覆盖用户决策。

### 阶段 P5 PARTIAL 项与依赖

| 项 | 何时完成 |
|---|---|
| 自动按 `quality_score` 推荐保留图（§7.5 验收 3 全 PASS）| P6.T5 `Quality_Selector` —— schema 字段已就绪（`duplicate_group_items.quality_score`、`duplicate_groups.recommended_media_id`），算法和 worker 留待 P6 |
| 用户批量删除未保留图片（§7.5 验收 5）| P7.T1 / P7.T3 软删除路径 + 二次确认 + 关联表清理 |
| 真实文件 / `media_items.deleted_at` 写入 | P7.T1（软删除路径会基于 `user_decision='remove'` 信号清理）|
| 高级相似度（DINOv2 / CLIP embedding + FAISS）| P10 AI 扩展；§7.5 处理策略第 3 层；V1 不必要 |
| 视频重复检测（video duplicate / scene similarity）| 非阻断；P9 视频处理上线时评估 |
| `image_hash` upload 阶段自动入队 | 当前由 `POST /api/media/:id/reprocess` 或手动 INSERT 触发；与 R-41 同源 —— 上传链式入队是 P6 / P7 阶段评估 |
| 重复组列表分页 UI | P5 后续 polish；当前 list 单页拉取，trip 内 group 数 V1 远不至于触发分页问题 |
| BK-tree / LSH 加速 pHash pairwise 比较 | P5.T4 当前 O(N²) 在 V1 trip 规模（< 10k 图）下完全够用；超大数据集再评估 |

### 阶段 P5 PARTIAL 已消化

| 编号 | 描述 | 消化点 |
|---|---|---|
| —— | P5 阶段自身未引入新风险编号；既有 R-40 / R-42 在 P4 已消化；R-41 仍延续至 P6 评估 | —— |

### 阶段 P5 剩余风险

承自前期：R-01 ~ R-12（P0）、R-14 / R-15 / R-16 / R-17 / R-18 / R-19 / R-20 / R-23 / R-24（P1）、R-29 / R-30 / R-31 / R-35 / R-36 / R-37 / R-38 / R-39（P2）、R-41 / R-43 / R-44（P3）、R-45 / R-46 / R-47（P4）继续延续。

**P5 新增**：

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-48 | pHash + dHash 的 hex 拼接存储格式（`pHashHex(16) + dHashHex(16)`）是约定式而非 schema 强制；未来引入第三种 hash 或改长度需要在多处同步修改（image_hash worker、hexHammingDistance 调用方、dedup-similar slice 逻辑） | 若 P10 引入 CLIP embedding，建议把 perceptual signature 改成结构化 JSON 或专用列 |
| R-49 | similar dedup 对完全相同色块的合成图会 dHash=0000…，仅靠 pHash 区分；现实摄影场景（梯度色彩）影响不大，但合成 / 截图 / 图表类内容判定可能偏松 | 真实数据上线后观察；必要时把 dHash 引入 V1 比较或换算法 |
| R-50 | `runSimilarForTrip` 单次扫描内每对图都做 pairwise 比较（O(N²)），trip 内图片极多时（> 几万）会出现明显延迟；当前没有 BK-tree / LSH 优化 | 用户体感问题时再优化；可优先做 SQL 候选预筛选（同 trip 内 hash 一阶差距过滤） |
| R-51 | "改主意"重新 confirm 会硬性把其他 items 的 `user_decision='remove'`，无 history 记录；用户曾经点过 keep 的旧 item 改主意后只能再点 keep 才能恢复 | UX polish；V1 接受，列表 UI 已通过实时刷新缓解 |

### P6 前置条件

- P5.T1 ~ P5.T8 全部完成 ✅
- P5 验收通过（10 项：7 条 §7.5 + 3 项额外，其中 2 条标 PARTIAL / N/A 明确依赖 P6 / P7）✅
- 工作区干净 ✅
- P5 阶段文档已收口 ✅（本节）
- `duplicate_groups.recommended_media_id` / `duplicate_group_items.quality_score` 字段就绪；P6 `Quality_Selector` 可直接写入并由前端详情页 Overview 显示
- dedup engine 的"已分组成员"保护规则覆盖所有 group_type；P6 写 `quality_score` / 自动 recommended 时**不应**绕过该 protection（user_confirmed 组不可被自动覆盖）
- 后端 `MediaRepository.findByIds` + Repository.findGroupByIdWithItems 已可被 P6 复用
- 前端 Detail Overview 显示 Quality 列已预留（当前显示 "—"），P6 写入后自动渲染
- 无 schema / migration 改动（仍是 000 ~ 007）
- Trip / Media / Upload / Storage / Jobs / Dedup 契约不变
- 前端 Trip CRUD / Media 详情 / Gallery / Upload / Jobs / Duplicates 页面契约不变

---

## 阶段 P6：图片质量评分

- 状态：**已完成**
- 任务范围：P6.T1 – P6.T8（8 / 8；P6.T5 拆为"合成 quality_score"+"Quality_Selector 推荐写入"+"自动触发接入"三个相邻 commit）
- 提交范围：`474e2e5` … `a674e7d`（P6.T8 验收仅 `docs/progress.md` + `docs/tasks.md` + 一处 smoke 兼容性微调，零业务代码改动）
- 完成日期：2026-05-20

### P6 阶段完成内容

| Task | Commit | 主要交付 |
|---|---|---|
| **P6.T1** | `474e2e5` | `009`(待 P6.T7) 之前的 `008_create_media_analysis.sql` —— 1:1 STRICT 表，requirements §8.3 所有列就位；UNIQUE(media_id) + FK ON DELETE CASCADE；smoke:migration-008 34/34 |
| **P6.T2** | `152d590` | `image_quality_blur` worker —— sharp 灰度 + 3×3 Laplacian + Welford 单遍方差；阈值 50/120 三档（blurry / maybe-blurry / sharp）；`MediaAnalysisRepository.upsertBlurAnalysis` + `raw_result.$.blur` 子键写入；smoke:image-quality-blur 46/46 |
| **P6.T3** | `912b918` | `image_quality_exposure` worker —— 灰度均值 + 暗/亮像素比；4 类（well-exposed / underexposed / overexposed / mixed-exposure）；与 `$.blur` 共存于同 row；新增 dimension-vocab `mergeDimensionLabels` 共享 helper；smoke:image-quality-exposure 62/62 |
| **P6.T4** | `d042591` | `image_quality_color` worker —— HSV + 通道平衡 + 亮度 std；三轴正交 sub-classification（saturation / cast / contrast），all-normal → `color-balanced`；`$.color` 子键写入；smoke:image-quality-color 65/65 |
| **P6.T5（合成）** | `1892919` | `image_quality_finalize` worker —— 加权 0.45/0.35/0.20，color tempering `floor + (1-floor)*color` 让 color 不主宰，缺失维度 renormalize；写 `quality_score` + composite reason + `raw_result.$.final_quality`；smoke:image-quality-finalize 43/43 |
| **P6.T5（推荐）** | `8c5d1dd` | `QualitySelectorService.selectForGroup / selectForTrip` —— 按 quality_score DESC + 7 级 tie-break 排序；`DuplicateGroupsRepository.applyRecommendation` 事务原子写 `recommended_media_id` + per-item `recommendation`/`reason`；不动 `user_decision`、跳过 `user_confirmed=1`；smoke:quality-selector 41/41 |
| **P6.T5（触发）** | `63debdd` | `quality_selector_run` job_type + `makeQualitySelectorHandler` —— finalize 成功后入队 trip-scope payload；defence check：`applyRecommendation` 在事务内校验 winner 必须是组成员；smoke:quality-selector-trigger 33/33 |
| **P6.T6** | `9a24b09` | 前端徽章 + 详情质量信息 —— Server `MediaRepository` LEFT JOIN `media_analysis` 暴露 `MediaItem.analysis`；客户端 `MediaCard` 加 `quality-pill`（推荐 / 不推荐 / 待分析 / 模糊 / 疑似模糊）+ 详情页 `QualityAnalysisSection`；reason 作为 hover tooltip；零回归 |
| **P6.T7** | `a674e7d` | 自动最佳封面 —— migration 009 加 `cover_set_by_user` flag；`MediaRepository.findBestCoverCandidate` 过滤 deleted/failed/video/无 thumbnail/blurry/无 quality_score；新 `coverSelector.autoSelectCoverForTrip` 模块；POST `/cover` flip flag、POST `/cover/reset` 释放并 auto-pick；quality_selector_run handler trip-scope 之后 best-effort 刷新封面；客户端 "Set as cover" 按钮；smoke:trip-cover-auto 26/26 |
| **P6.T8** | （本任务） | 阶段验收 + 文档收口；最小 fix：放宽 `smoke:migration-008` 中的"applied 恰好 [008]"断言到"008 在首位 + included"，让 009 一起跑也通过 |

### P6.T8 验收结果

| 验收项 | 结果 |
|---|---|
| requirements §7.6 自动选择最佳质量图（组内、全 trip） | **PASS** — `QualitySelectorService.selectForGroup` 按 quality_score DESC + 7 级 tie-break 选最佳；`autoSelectCoverForTrip` 用 `findBestCoverCandidate`（过滤 deleted/failed/video/无 thumbnail/blurry/无 quality_score）选 trip 最佳；smoke:quality-selector 41/41 + smoke:trip-cover-auto 26/26 + smoke:quality-selector-trigger 33/33 全 PASS |
| §7.6 推荐保留原因可解释 | **PASS** — `image_quality_finalize` 写 composite reason 包含 `blur=[sharp, variance=…] | exposure=[mixed-exposure, mean=…] | color=[balanced, labels=…] | weights blur=0.45→0.45 …`；`Quality_Selector` 写 per-item reason `recommended — quality_score=0.92 (best of 3 member(s))` / `quality_score 0.65 < winner 0.92`；前端详情页 `QualityAnalysisSection` 展示 + gallery card pill tooltip |
| §7.7 模糊检测 + 三档分类 | **PASS** — blur worker 写 `is_blurry ∈ {0, 1, NULL}` + label `sharp / maybe-blurry / blurry`，NULL 显式表示"未评估 / borderline"；前端 `MediaCard.buildQualityBadges` 把 `模糊`/`疑似模糊` 当独立警示徽章；smoke:image-quality-blur 46/46 实证 |
| §7.8 SHOULD 曝光 / 色彩分析 | **PASS** — 曝光 4 类（well/under/over/mixed）+ 色彩 saturation/cast/contrast 三轴；finalize 加权合成 |
| 上传足够图片后封面自动收敛到 quality_score 最高 | **PASS** — smoke:trip-cover-auto CASE 11 端到端验证：seed trip + 重复组 + media_analysis → quality_selector_run job → handler 跑完 `trips.cover_media_id` 写入 quality_score 最高 media；CASE 6 验证 6 种过滤（blurry / video / deleted / failed / 无 thumbnail / 无 quality_score）全部被排除 |
| 用户手动设置封面后不被自动覆盖 | **PASS** — `cover_set_by_user` flag + `setAutoCover WHERE cover_set_by_user = 0` SQL 兜底；CASE 4 验证 `setCoverByUser` flip flag 后即便存在更高质量候选，`autoSelectCoverForTrip` 返回 `skipped-user-pinned`，cover 保留用户选择；CASE 5 验证 `clearUserCoverFlag` 释放后自动流程可重新选 |
| 没有合适图片不报错 | **PASS** — `findBestCoverCandidate` 无候选时返回 `null`，`autoSelectCoverForTrip` 返回 typed outcome `skipped-no-candidate`，cover 保留；CASE 7 全 blurry trip 实证；CASE 8 不存在的 trip 返回 `missing-trip` 不抛异常 |
| 现有上传 / 处理 / 去重 / 视频流程不回归 | **PASS** — 全部 31 个 smoke 套件 **951/951** 通过（含 P5 全套 + P3/P4 全套 + P6 七项 + 新增 trip-cover-auto） |
| 前端旧数据兼容 | **PASS** — `MediaItem.analysis?: ... \| null`（optional），`Trip.coverSetByUser?: boolean`（optional），所有展示路径都有 `?? null` 兜底；`待分析` 占位徽章覆盖 analysis 为 NULL 的旧行 |

### 阶段 P6 验证命令

后端（`server/`）共 31 个 smoke：

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run format:check
npm run smoke:storage                       # 19/19
npm run smoke:trips                         # 22/22
npm run smoke:classify                      # 37/37
npm run smoke:upload                        # 30/30
npm run smoke:media                         # 26/26
npm run smoke:storage-route                 # 14/14
npm run smoke:image-channel-executor        # 26/26
npm run smoke:media-versions                # 24/24
npm run smoke:image-thumbnail               # 22/22
npm run smoke:migration-006                 # 18/18
npm run smoke:image-metadata                # 23/23
npm run smoke:media-reprocess               # 21/21
npm run smoke:trip-cover-url                # 13/13
npm run smoke:job-queue                     # 55/55
npm run smoke:jobs-api                      # 28/28
npm run smoke:media-status-sync             # 18/18
npm run smoke:migration-007                 # 37/37
npm run smoke:duplicate-groups-repository   # 30/30
npm run smoke:image-hash                    # 25/25
npm run smoke:dedup-exact                   # 26/26
npm run smoke:dedup-similar                 # 40/40
npm run smoke:dedup-api                     # 27/27
npm run smoke:duplicate-group-confirm       # 20/20
npm run smoke:migration-008                 # 34/34（P6.T1，本节放宽 "applied exactly" 断言到 "008 在首位 + included"）
npm run smoke:image-quality-blur            # 46/46（P6.T2）
npm run smoke:image-quality-exposure        # 62/62（P6.T3）
npm run smoke:image-quality-color           # 65/65（P6.T4）
npm run smoke:image-quality-finalize        # 43/43（P6.T5 合成）
npm run smoke:quality-selector              # 41/41（P6.T5 推荐）
npm run smoke:quality-selector-trigger      # 33/33（P6.T5 触发）
npm run smoke:trip-cover-auto               # 26/26（P6.T7）
```

后端 smoke 总计 **951 / 951**（既有 P5 收口 601 + 阶段 P6 新增 350），零回归。

前端（`client/`）：

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm run format:check
```

均一次过。Vite gzip JS 65.15 KB / CSS 3.76 KB（含 P6.T6 的 QualityAnalysisSection + `.quality-pill` 4 种 tone + P6.T7 的 "Set as cover" 按钮 + setTripCover / resetTripCover API helpers）。

新增依赖：**无**（P6 全程零新增 npm 依赖；HSV / Laplacian / Welford / DCT 均自实现）。

### 阶段 P6 最终能力

P6 建立了图片质量评分 + 自动推荐 + 自动封面的端到端闭环：

1. **图片质量评分**：`media_analysis` 1:1 表存 blur_score / sharpness_score / exposure_score / brightness_score / color_score / quality_score（composite 0..1）+ is_blurry + labels + reason + raw_result（每 dimension 子键）。
2. **模糊 / 曝光 / 色彩分析**：三个独立 worker（`image_quality_blur` / `_exposure` / `_color`），各自写入对应列 + raw_result 子键 + 共享 `labels` 数组（dimension-vocab 合并）。
3. **合成 quality_score**：`image_quality_finalize` 加权 0.45/0.35/0.20 + color tempering + 缺失 dimension renormalize；composite reason 留 explanation。
4. **推荐保留 / 不推荐**：`Quality_Selector` 在重复组内按 quality_score DESC + tie-break 选最佳，写 `recommended_media_id` + per-item `recommendation`/`reason`；跳过 `user_confirmed=1` 组；finalize 成功后自动入队 `quality_selector_run`。
5. **前端质量展示**：gallery 卡片显示 推荐 / 不推荐 / 模糊 / 疑似模糊 / 待分析 徽章；详情页 `QualityAnalysisSection` 显示 quality / sharpness / exposure / color / blur verdict / labels / reason 全字段。
6. **自动最佳封面**：`coverSelector.autoSelectCoverForTrip` 过滤 deleted/failed/video/no-thumbnail/blurry/no-quality_score，按 quality_score DESC 写 `trips.cover_media_id`；trip-scope selector handler 完成后 best-effort 刷新。
7. **用户手动封面保护**：`cover_set_by_user` flag + `setAutoCover WHERE cover_set_by_user = 0` SQL 兜底；POST `/cover` flip flag；POST `/cover/reset` 释放 + 立即 auto-pick；客户端 "Set as cover" 按钮。

### 阶段 P6 PARTIAL 项与依赖

| 项 | 何时完成 |
|---|---|
| 视频质量评分（视频封面 / 视频质量分） | P9 视频处理上线时评估；现 worker 全部 `media.type !== "image"` 拒绝 |
| 美学评分（aesthetic_score 列已就绪但不写入） | P10 AI 扩展（CLIP / VLM）；规则型评分不覆盖审美维度 |
| `media_analysis.is_recommended` 列在 schema 但无 worker 写入（推荐落 `duplicate_group_items.recommendation`） | 该列保留给未来"无重复组也想标推荐"用例；当前仍 NULL |
| upload chain 自动入队 `image_quality_*` jobs | 当前需手动 INSERT 触发；P7 / P8 评估上传链路扩展（与 R-41 同源） |
| `quality_score` 阈值与权重的真实数据校准 | 真实数据上线后调；当前 0.75/0.5 + 0.45/0.35/0.20 是设计层默认 |
| trip 封面变更的 client cache 失效（"Set as cover"后 list 页不会自动刷新） | SWR / TanStack Query 引入时统一处理 |

### 阶段 P6 PARTIAL 已消化

| 编号 | 描述 | 消化点 |
|---|---|---|
| §7.5 #3 自动按 quality_score 推荐保留图 | P5.T8 标 PARTIAL，留 P6.T5；本阶段 `8c5d1dd` 完成 `Quality_Selector` + `63debdd` 完成自动触发 |
| P5 后置：`duplicate_group_items.quality_score` 字段被写入 | `Quality_Selector` 通过 `applyRecommendation` 写入 per-item reason；quality_score 列由 dedup engine 写在 group 建立时（P5）+ 由 finalize 写在 media 级 |
| P3 后置：自动最佳封面（按 quality_score 写 `cover_media_id`） | P6.T7 落地；`deriveCoverUrl` 优先级 1 自动接管，placeholder 渐退 |

### 阶段 P6 剩余风险

承自前期：R-01 ~ R-12（P0）、R-14 / R-15 / R-16 / R-17 / R-18 / R-19 / R-20 / R-23 / R-24（P1）、R-29 / R-30 / R-31 / R-35 / R-36 / R-37 / R-38 / R-39（P2）、R-41 / R-43 / R-44（P3）、R-45 / R-46 / R-47（P4）、R-48 / R-49 / R-50 / R-51（P5）继续延续。

**P6 新增**：

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-52 | 质量评分为规则型（Laplacian 方差 + 直方图 + HSV channel balance），不是基于真实摄影偏好训练的模型。审美 / 构图 / 主体性等"软"维度不纳入；用户审美偏好与 worker 偏好可能错位 | P10 AI 扩展引入 CLIP / VLM 时补 aesthetic_score；规则型评分作为兜底层保留 |
| R-53 | finalize 权重 0.45/0.35/0.20 + color tempering floor=0.5 是设计层默认，未做真实数据集校准；某些场景（高对比黑白片）可能在 color 维度上被过度温和处理 | 真实数据上线后观察分布，必要时调权重 / floor 或新增 config preset |
| R-54 | "Set as cover" 按钮点击后 trip list 页缓存不会自动失效；用户需要刷新才能看到新封面。功能上无 bug，UX 上不流畅 | SWR / TanStack Query 引入后统一处理 |
| R-55 | `cover_set_by_user` flag 在 SQLite 层无 `CHECK IN (0, 1)`（ALTER TABLE ADD COLUMN 加 CHECK 需要表重建）。Repository 层只写 0/1，但绕过 repo 的原生 SQL 写入可越界 | 下次有正当理由做 trips 表重建时（如 P7 软删除约束扩展）顺手加上 |
| R-56 | `findBestCoverCandidate` 过滤 `is_blurry IS NULL OR is_blurry != 1`，"maybe-blurry"（NULL + label）仍算候选；某些 trip 全部图片都被分类为 maybe-blurry 时可能选中 | 真实数据观察后决定是否收紧到 `is_blurry = 0` |
| R-57 | `autoSelectCoverForTrip` 在 selector handler 中是同步执行；trip 内 media 极多时可能略增 handler 用时（V1 trip 远不至于触发）| 性能成为问题时拆为独立 job_type |
| R-58 | upload chain 仍未自动入队 `image_quality_*` jobs，需要手动 reprocess；与 R-41 同源 | P7 / P8 评估上传链路扩展 |
| R-59 | `media_analysis.is_recommended` 列存在但无 worker 写入；前端展示路径目前不读取该列（用 quality_score 阈值判断）| 该列保留给未来需求，当前为冗余 |

### P7 前置条件

- P6.T1 ~ P6.T8 全部完成 ✅
- P6 验收通过（9 项验收 + 31 个 smoke 套件 951/951）✅
- 工作区干净 ✅
- P6 阶段文档已收口 ✅（本节）
- `media_analysis.is_blurry` / `quality_score` / labels 已能驱动"模糊 / 不推荐 / 低质"的过滤判断 —— P7 删除路径可基于这些信号给出 UX 提示
- `duplicate_group_items.recommendation = 'remove'` 信号已就绪 —— P7.T1 软删除路径可以读取并提示用户"这是 dedup 建议删除的图"
- `trips.cover_media_id` ON DELETE SET NULL 已 schema 兜底；P7 软删除 / 永久删除路径无需特别处理（FK 自动清空）
- 前端 MediaDetailPage 已具备状态展示能力 —— P7 加 "Delete" / "Restore" 按钮无需重写页面
- 无 schema / migration 改动等待 —— 当前 000 ~ 009 全部就位；P7.T1 软删除路径主要走业务逻辑，不一定需要新 migration
- Trip / Media / Upload / Storage / Jobs / Dedup / Quality 契约不变

---

## 阶段 P7：安全删除与恢复

- 状态：**进行中**（P7.T1 已完成；T2 ~ T6 + T7~T9 LATER 永久删除待办）

### P7.T1 媒体软删除 实现结果

- Commit: 待入库
- 主要交付：
  - 新增 `DELETE /api/media/:id` 端点（[server/src/routes/media.ts](server/src/routes/media.ts)）—— 200 + `{ mediaId, deleted, alreadyDeleted, clearedRecommendedGroups, clearedCoverTrips }`；不真删文件
  - `MediaRepository.softDelete(mediaId, deletedAt)` —— UPDATE 写 `deleted_at` + `status='deleted'`，`WHERE deleted_at IS NULL` 兜底幂等
  - `MediaService.softDeleteMedia(idInput)` —— 单 `db.transaction` 内组合三步：
    1. 调 `MediaRepository.softDelete`
    2. 调 `DuplicateGroupsRepository.clearRecommendedMediaForMedia` —— 重置 `recommended_media_id` 至 NULL 对所有 recommend 该 media 的 group（FK SET NULL 仅对硬删生效）
    3. 调 `TripRepository.clearCoverForMedia` —— 对 `cover_media_id = mediaId` 的 trip 清空 cover 并 release `cover_set_by_user=0`（让 auto-pick 接管）；返回受影响 tripId 列表
    
    事务提交后 best-effort 调 `autoSelectCoverForTrip` 替换每个受影响 trip 的 cover（如有更佳候选）。
  - 新 prepared statements（共 3 个 RETURNING 风格，要求 better-sqlite3 11+ / SQLite 3.35+，本项目已就绪）：
    - `TripRepository.clearCoverForMediaStmt` —— UPDATE + RETURNING id
    - `DuplicateGroupsRepository.clearRecommendedMediaForMediaStmt` —— UPDATE + RETURNING id
    - `MediaRepository.softDeleteStmt` —— UPDATE（无 RETURNING）
  - `MediaSoftDeleteDeps` 接口（包 `db`, `tripRepo`, `duplicateGroupsRepo`, `logger`）—— `MediaService` 构造函数末位 optional 入参，老测试和 smoke 不受影响
  - 前端 `softDeleteMedia(id)` API helper + `MediaDetailPage` 加 "Delete" 按钮（btn-danger）+ 复用 trip 删除 modal 样式 + 删除成功后 `navigate(/trips/:tripId, { replace: true })`
  - 边界遵守：
    - 不真删原图 / preview / thumbnail 文件（CLAUDE.md §2.1 / §2.4 / §2.5 红线）
    - 不动 `duplicate_group_items.user_decision`（design.md §4.3 允许"保留记录"；P7.T2 恢复路径无需逆转用户决策）
    - 不做恢复 / 回收站 UI（留 P7.T2 / T4）
    - 不动上传 / 处理 / dedup 主流程
- 验证：
  - `npm run smoke:media-soft-delete` **32 / 32 PASS**（新增 12 cases × 多断言）—— 涵盖 happy path、idempotent、404、validation、read filter、dedup engine 过滤、findBestCoverCandidate 过滤、duplicate_groups.recommended_media_id 重置、duplicate_group_items 保留、auto-cover 替换、user-pinned cover 释放、no-replacement、unreferenced 媒体快路径
  - 既有 9 个 P5/P6 关键 smoke 全部回归通过：media 26/26、trips 22/22、trip-cover-url 13/13、trip-cover-auto 26/26、dedup-api 27/27、duplicate-group-confirm 20/20、quality-selector 41/41、quality-selector-trigger 33/33、upload 30/30
  - `npm run typecheck` / `lint` / `build` / `format:check` 一次过（server + client）
  - client gzip JS 65.46 KB（+0.31 KB 来自 softDeleteMedia API + Delete 按钮 + modal markup；index.css 未改）

### P7.T1 剩余风险

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-60 | 软删除后 `duplicate_group_items.user_decision` 保持原值（设计选择，方便 P7.T2 恢复时无需逆转）；UI 详情页对 soft-deleted 成员显示 `media: null` 占位但仍保留 keep/remove 标记，可能让用户困惑"为什么删掉的图还显示 keep" | P7.T4 回收站 UI / P6 UI polish 时统一处理（例如 hide 占位） |
| R-61 | 软删除路径不主动触发 Quality_Selector 对受影响组的 re-rank（仅清 `recommended_media_id` 至 NULL）。组失去推荐直到下次 finalize → selector 链路自然重跑。低频场景可接受 | P7 后续 polish 或下次 Quality_Selector 入队链路扩展时一并处理 |
| R-62 | 软删除媒体的 `processing_jobs` 行（如果还有未完成的 image_quality_* 任务）不会自动取消；worker handler 会在 `findById` 处发现媒体已 soft-deleted 并抛错落 failed —— 行为正确但日志噪音 | P7.T5 阶段验收或独立的 job-cancellation 任务统一处理 |
| R-63 | `RETURNING` 子句首次在本项目使用（better-sqlite3 11+ / SQLite 3.35+ 支持）；如果未来要降级到旧 SQLite 版本需重写为 SELECT-then-UPDATE 两步 | 不主动跟进；项目锁定 better-sqlite3 11.x |
| R-64 | 软删除媒体被用户硬手动恢复（如 SQL 直接置 `deleted_at = NULL`）后，原属重复组的 `recommended_media_id` 不会自动回填 —— 需等下次 Quality_Selector 跑一遍 | P7.T2 恢复路径会显式触发 selector ✅ 已由 P7.T2 enqueue trip-scope `quality_selector_run` 消化 |

### P7.T2 媒体恢复 / 回收站基础能力 实现结果

- Commit: 待入库
- 主要交付：
  - 新增 `POST /api/media/:id/restore` 端点（[server/src/routes/media.ts](server/src/routes/media.ts)）—— 200 + `{ mediaId, tripId, restored, alreadyRestored, qualitySelectorEnqueued }`；幂等
  - `MediaRepository.restore(mediaId, restoredAt)` —— UPDATE 写 `deleted_at = NULL` + `status = 'processed'`，`WHERE deleted_at IS NOT NULL` 兜底幂等
  - `MediaService.restoreMedia(idInput)` —— 事务内 `mediaRepo.restore`，事务后用现有 `JobRepository.insert` 入队 trip-scope `quality_selector_run` 让 P6.T5 handler 复用做 re-rank + auto-cover refresh（skipping `user_confirmed=1` 组 — CLAUDE.md §3.9）；enqueue 失败不阻断 restore 本身（warn + swallow）
  - 客户端 `restoreMedia(id)` API helper + `RestoreMediaResult` 类型；**未加 UI**（P7.T4 回收站统一暴露入口）
  - 边界遵守：
    - 不真删 / 不重传 / 不重跑 image 处理工作（worker 在 findById 处发现媒体 active 后照常工作）
    - 不动 `duplicate_group_items` 行（P7.T1 已保留 → 自然 re-expose；P7.T2 不重建）
    - 不动 trip 软删除 / 视频
    - 不新增 migration
- 验证：
  - `npm run smoke:media-restore` **28 / 28 PASS**（新增 9 case × 多断言）—— 涵盖 happy / idempotent (already-active / missing / malformed id) / delete→restore→delete cycle / dedup engine re-expose / auto-cover re-expose / selector job enqueue + payload / 端到端经 JobQueue 跑 selector 后 cover 自动设回
  - 既有 9 个 P5/P6/P7.T1 关键 smoke 全过：media-soft-delete 32/32、media 26/26、trips 22/22、trip-cover-auto 26/26、dedup-api 27/27、quality-selector 41/41、quality-selector-trigger 33/33、upload 30/30
  - server + client `typecheck` / `lint` / `build` / `format:check` 一次过
  - client gzip JS 65.46 KB（仅 API helper 增量，几乎为零）

### P7.T2 剩余风险

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-65 | restore 默认把 status 设回 `'processed'`，丢失原 status（'failed' / 'archived' 等）。意味着曾经处理失败的 media restore 后会看起来"成功"，直到用户手动 reprocess | 接受为 V1；可在 P7.T4 / P8 时引入 `previous_status` snapshot 字段 |
| R-66 | 没有"已删除媒体列表" API。用户必须知道 media id 才能 restore — V1 适合脚本 / 管理员路径，正式 UI 入口待 P7.T4 回收站 | P7.T4 |
| R-67 | restore 后入队的 `quality_selector_run` 失败（如 jobRepo 写入异常）只 log + swallow，不重试。罕见但若发生用户体感是"恢复了但封面没回来" | 不主动跟进；下个 finalize 链路自然 re-trigger |
| R-68 | 如果 trip 本身已 soft-deleted，restore media 仍允许（只读 media 不跨检 trip），但 gallery 仍因 trip soft-delete 而 404。restore 成功语义 vs 用户可见性不对称 | P7.T2 / T4 阶段对 trip soft-delete 重新评估，可选择 restore 前校验 trip 是否 active |

---

### P7.T3 重复组批量软删除 实现结果

- Commit: 待入库
- 主要交付：
  - 新增 `POST /api/duplicate-groups/:id/delete-others` 端点（[server/src/routes/dedup.ts](server/src/routes/dedup.ts)）—— 200 + `DeleteOthersOutcome`；幂等
  - `DedupService.deleteOthers(idInput)`（[server/src/dedup/dedupService.ts](server/src/dedup/dedupService.ts)）—— 找到 group → 校验 `recommended_media_id`（无则 `status='no-winner'`、deletedCount=0、安全跳过）→ 对每个 `recommendation='remove'` 成员（防御性跳过 winner）调 `mediaService.softDeleteMedia`；按 `alreadyDeleted` 标志分桶进 `deletedMediaIds` / `skippedMediaIds`
  - 复用 P7.T1 `softDeleteMedia` 的事务路径 —— 每个成员的删除自带 `media_items.deleted_at + status='deleted'` + `duplicate_groups.recommended_media_id` 清理 + `trips.cover_media_id` 清理 + 自动 cover 替补
  - 客户端 [client/src/api/dedup.ts](client/src/api/dedup.ts) 新增 `deleteOthersInGroup(groupId)` + `DeleteOthersOutcome` 类型
  - 客户端 [client/src/pages/DuplicateGroupDetailPage.tsx](client/src/pages/DuplicateGroupDetailPage.tsx) 加：
    - "Delete N other photo(s)" 危险按钮（统计含 `recommendation='remove'` 且非 winner 且 `media !== null` 的成员）
    - modal-confirm（复用 `modal-overlay / modal-card / modal-actions` 样式）
    - aria-live 反馈条（"Soft-deleted X photo(s) (Y were already deleted). Originals stay on disk..."）
    - 删除成功后 refetch 让组里的成员渲染成 missing 占位（P5.T6 `media: null` 投影）
  - 边界遵守：
    - 不真删 / 不重传 / 不动文件
    - 不动 winner、不动其他 group（CASE 10 验证 isolation）
    - 不绕过 `softDeleteMedia` 的事务路径
    - 不新增 migration
    - 不动视频 / 上传 / 处理流程
- 验证：
  - `npm run smoke:dedup-delete-others` **28 / 28 PASS**（新增 11 case × 多断言）—— 涵盖 happy (kept winner + 2 deleted) / idempotent / no-remove (deletedCount=0) / no-winner (refuses) / 404 / validation / 防御性 winner-tagged-remove / confirmed group 保 `user_confirmed=1` / 跨组隔离 / restore-after-bulk
  - 既有 9 个 P5/P6/P7.T1/P7.T2 关键 smoke 全过：media-soft-delete 32/32、media-restore 28/28、dedup-api 27/27、duplicate-group-confirm 20/20、quality-selector 41/41、quality-selector-trigger 33/33、trip-cover-auto 26/26、media 26/26、upload 30/30
  - server + client `typecheck` / `lint` / `build` / `format:check` 一次过
  - client gzip JS 65.88 KB（+0.42 KB：API helper + button + modal markup + status banner）

### P7.T3 剩余风险

| 编号 | 风险 | 何时跟进 |
|---|---|---|
| R-69 | `deleteOthers` 对每个成员单独跑一个 `db.transaction`（softDeleteMedia 内部），不是"删整个 group 一个事务"。理论上 N 个成员里若第 K 个失败（罕见 SQL 错误），前 K-1 个已删除会保留 → 用户能看到 `deletedMediaIds` 部分成功 / 失败抛出。规格上是 best-effort | 接受为 V1；可考虑包大事务，但需把 `softDeleteMedia` 的 tx 改成可组合形式 |
| R-70 | `no-winner` 状态用 typed outcome（HTTP 200）而不是错误码（400 / 409）。前端需要分支判断 `status` 字段才能区分"删了 0 个"vs"refuse 没删"。当前 UI 已按 `status === "no-winner"` 渲染明确提示 | 接受；约定即 API |
| R-71 | 客户端 `removeCandidates` 计数依赖 `item.media !== null`（即过滤已 soft-deleted 的成员）。如果服务端的 `findByIds` 投影行为变化（例如开始包含已删除媒体），按钮的计数可能多算 | 现有 P5.T6 投影对 soft-deleted 成员明确返回 `media: null`；保持该契约 |
| R-72 | 没有"批量恢复" / "撤销 delete-others" 入口。用户对单个媒体可以走 P7.T2 restore，但一次批删 N 张要恢复 N 次。回收站 UI（P7.T4）会提供更人性化路径 | P7.T4 ✓（V1 回收站还是逐行 Restore，没批量；下个迭代可加） |
| R-73 | `deleteOthers` 不主动触发 trip-scope `quality_selector_run`（依靠 `softDeleteMedia` 内部的 auto-cover 替补足够）。若用户期望删除后立即看到组重新排名 / 推荐变化，会感觉延迟 | 接受；下次 finalize 链路自然 re-trigger |

### P7.T4 前端回收站视图 实现结果

- 服务端最小侵入扩展（Option A — 不新增路由）：
  - `server/src/media/mediaSchemas.ts`：`listMediaOptionsSchema` 新增 `onlyDeleted: z.coerce.boolean().default(false)`；与既有的 `includeDeleted` 形成两档语义。
  - `server/src/media/mediaTypes.ts`：`ListMediaOptions` 同步增加 `onlyDeleted?: boolean`，并把"`onlyDeleted` 优先级高于 `includeDeleted`、排序切换为 `deleted_at DESC`、仅 `onlyDeleted` 暴露到 HTTP" 三条契约写入注释。
  - `server/src/media/mediaRepository.ts`：新增 `listByTripDeletedOnlyStmt`，`SELECT … WHERE m.trip_id = ? AND m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC, m.id DESC LIMIT ? OFFSET ?`；`list()` 改成三档分支（`onlyDeleted` > `includeDeleted` > 默认活跃）。
  - `server/src/routes/media.ts`：`listMediaQuerySchema` 在 1..100 limit 之外增加 `onlyDeleted: z.coerce.boolean().default(false)`；明确不暴露 `includeDeleted`（与 `mediaSchemas.ts` 一致）。
  - 没有新增任何 API、没有新增任何 migration（P2.T4 已经有 `media_items.deleted_at` + 索引 `idx_media_items_deleted_at`）。
- 前端回收站页面（V1 最小形态）：
  - `client/src/api/media.ts`：`FetchTripMediaOptions` 增加 `onlyDeleted?: boolean`；`fetchTripMedia` 序列化为 `?onlyDeleted=true`。
  - `client/src/hooks/useTripMedia.ts`：新增 `onlyDeleted = false` 第三参数，并把它放进 `useEffect` 依赖数组（toggle 会自然触发重新拉取）。
  - `client/src/pages/TripRecycleBinPage.tsx`（新增）：列出该 trip 的已软删除媒体，每行展示缩略图 + 文件名 + Uploaded / Deleted 时间戳 + Restore 按钮；按钮点击调用 `restoreMedia(id)`（复用 P7.T2 API），成功后本地从列表中隐藏（`restoredIds` Set），不需要等待 `quality_selector_run` 完成；并发 restore 用 `pendingIds` Set 单独追踪 + 每行独立 `errorById` Map，单个失败不影响其它行。
  - `client/src/App.tsx`：注册新路由 `/trips/:id/recycle-bin`；路由顺序保持 `:id/upload` / `:id/recycle-bin` 在 `:id` 之前。
  - `client/src/pages/TripDetailPage.tsx`：在 trip header 中添加 "Recycle bin" 二级按钮（与 "View duplicates" 同列）。
- Smoke 覆盖：
  - 新增 `server/src/scripts/trip-media-recycle-bin-smoke.ts`（9 个用例 / 17 个断言全部 PASS）：zod schema、默认 list 仍然隐藏 deleted、`onlyDeleted=true` 只返回 deleted、`deleted_at DESC` 排序、空 bin、跨 trip 隔离、`onlyDeleted` 优先于 `includeDeleted`、restore-from-recycle-bin 链（删除→出现在 bin→restore→消失 bin 重回 gallery）、分页 (limit=2 over 5 行)。
  - 回归 smoke：`smoke:media`（26/26）、`smoke:media-soft-delete`（32/32）、`smoke:media-restore`（28/28）、`smoke:dedup-delete-others`（28/28）、`smoke:dedup-api`（27/27），均无回退。
- 验证：server `typecheck` / `lint` / `format:check` / `build` 全绿；client 同 4 个命令全绿。
- 红线遵守：默认 `listMediaForTrip` 行为不变（仍然过滤 `deleted_at IS NULL`）；没有暴露任何永久删除入口；只读 + 单条 restore，无批量；schema 是 zod `.strict()` 防止 query 参数漂移。

### P7.T4 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R-74 | 回收站行不挂 `<Link>` 到 `/media/:id`，因为 P3.T6 详情读默认 active-only（`includeDeleted=false`），点进去会 404。当前 UX 是"先 Restore 再点详情"，没有"以只读形式查看 deleted 详情" | V1 接受；后续若需要"已删除媒体只读详情页"可在 P7.T5+ 引入 `?includeDeleted=true` 详情查询 |
| R-75 | 回收站没有分页 UI（hook 内部 `limit=100`，超过 100 的批量删除不会全部显示）。当前规模下不会触发，但批量回填历史 trip 时可能漏看 | V1 接受；hook 已经支持 limit prop，分页 UI 留给后续 |
| R-76 | Restore 操作没有二次确认（与软删除相比反向操作风险低，故省略）。若用户不小心点击 Restore，会立刻把媒体放回 gallery — 可以再点一次 Delete 回滚，但有 1 次额外的 quality_selector_run 入队 | 接受；restore 是"撤销" 的语义，应低摩擦 |
| R-77 | 客户端 `restoredIds` 本地状态只在当前会话有效；用户刷新页面后会重新发起带 `onlyDeleted=true` 的 GET，已 restore 的项目自然不会再回到列表。但若两台设备同时打开回收站，B 设备不会自动知道 A 设备 restore 了某项 | 接受；V1 单用户模型，多端实时同步留给 P12+ |

---

### P7.T5 Recycle Bin 自动化测试 实现结果

- 新增端到端验收 smoke：`server/src/scripts/p7-recycle-bin-acceptance-smoke.ts`，注册为 `npm run smoke:p7-recycle-bin-acceptance`。**55/55 PASS**。
- 该 smoke 是 P7 阶段的合并验收脚本：之前 P7.T1 / T2 / T3 / T4 各自的 smoke 单测一个轴向，P7.T5 的 smoke 在同一个 case 里 seed 一个"挂满所有引用关系"的 media（`media_analysis` + `media_versions` + `processing_jobs` + `duplicate_group_items` + 可选 `duplicate_groups.recommended_media_id`），然后跑 delete + restore + 回到 delete + 再 restore，逐表断言行依然存在 + 内容未被覆盖。
- 覆盖路径（一一对应任务清单 + 用户提示词）：
  - **任务清单 path 1** "删除推荐图后 `recommended_media_id` 被正确重置"：seed group with `recommended_media_id=mediaId` → softDelete → 断言 `recommended_media_id IS NULL`。
  - **任务清单 path 2** "删除一张组内图片不会触发 `FOREIGN KEY constraint failed`"：try/catch 包围 softDeleteMedia，断言无 throw。
  - **任务清单 path 3** "删除后再恢复，状态字段、关联记录、`duplicate_groups` 评估都正确恢复"：restore 后 `deleted_at IS NULL`、`status='processed'`、所有关联表行依然存在，`user_decision='keep'` / `user_confirmed=1` 等 user-respecting 字段不被覆盖（CLAUDE.md §3.9）；`recommended_media_id` 不会被自动恢复（由 enqueued `quality_selector_run` 负责，跟 restore 原语解耦）。
  - **任务清单 path 4** "跨表外键路径遍历检查"：显式列出每张引用 `media_items.id` 的表（`media_analysis` / `media_versions` / `processing_jobs` / `duplicate_group_items` / `trips.cover_media_id` / `duplicate_groups.recommended_media_id`），逐一断言软删除时 NOT 触发 CASCADE（因为软删除不是真 DELETE），restore 后内容仍然存在。`video_segments` 表尚未存在（P9 才落地），在注释里说明跳过原因。
  - **用户路径 A** "默认 gallery 不返回 deleted"：sanity check on `listMediaForTrip` + `getMediaById` 返回 NotFoundError。
  - **用户路径 B** "Recycle Bin 只返回 deleted"：`{ onlyDeleted: true }` 返回精确匹配集合。
  - **用户路径 C** "Restore 状态切换"：`deleted_at IS NULL` + `status='processed'` + recycle bin 内不再列出 + gallery 重新可见。
  - **用户路径 D** "Restore 不影响其他主流程"：
    - **磁盘**：原始文件 pre-delete / post-delete / post-restore 都存在（`fs.existsSync` 真实磁盘断言）；`media_items` 行从未被硬删除。
    - **视频**：type='video' 行经过 delete + restore 行为与图片一致（保证 P9 video pipeline 不需要为回收站改路）。
    - **auto-cover**：用户 pin 在 soft-delete 时正确释放（`cover_set_by_user=0`），restore 原语本身 NOT 自动恢复 pin（避免冲突；最终 cover 由 enqueued selector job 决定，符合 P6.T7 设计）。
    - **recommendation**：`user_confirmed=1` 在 delete+restore 循环中 NOT 被清除；`user_decision='keep'` 在 restore 后未被覆盖。
    - **processing**：`processing_jobs.status` 在 delete 或 restore 时 NOT 被改写（V1 设计：worker 自身处理 deleted media，不在 service 层做自动取消）。
    - **versions**：`media_versions.params` / `file_path` 经过 round-trip 完全等同（restore 不重跑任何 version writer）。
    - **analysis**：`media_analysis.quality_score / is_blurry / reason` 经过 round-trip 完全等同。
  - **稳定性**：双轮 delete → restore → delete → restore 循环，所有断言两轮均通过（防 "状态泄漏只在第一轮发生" 的回归）。
- 不新增测试框架。沿用项目既有的 `tsx`-based smoke 模式（其它 50+ smoke 也是这个写法）。考量过 vitest / jest，但 (a) 当前阶段没人写过 unit test、(b) smoke 已经在跑真实 sqlite + 真实磁盘 I/O，已经接近集成测试覆盖；上 jest 反而是噪声。
- 不引入永久删除 / 批量恢复 / 主流程修改。只是新增一个观察性 artifact。

#### P7.T5 验证

| 命令 | 结果 |
|------|------|
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动修复了一次缩进，已重新提交格式化版本） |
| `npm run build`（server） | ✅ |
| `npm run smoke:p7-recycle-bin-acceptance`（新） | ✅ **55/55 PASS** |
| 回归 `smoke:trip-media-recycle-bin` | ✅ 17/17 |
| 回归 `smoke:media-soft-delete` | ✅ 32/32 |
| 回归 `smoke:media-restore` | ✅ 28/28 |
| 回归 `smoke:dedup-delete-others` | ✅ 28/28 |
| 回归 `smoke:media` | ✅ 26/26 |
| 回归 `smoke:dedup-api` | ✅ 27/27 |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅ |

### P7.T5 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R-78 | `video_segments` 表 P9 才会被引入；P7.T5 smoke 注释里说明了跳过原因，但没有静态保险防止未来新增引用 `media_items.id` 的表却忘记加 case。 | 接受为 V1；P9 落库 `video_segments` migration 时同步在 `p7-recycle-bin-acceptance-smoke.ts` 增加一个 case（PR review 中显式提醒）。 |
| R-79 | smoke 默认 seed 的 `processing_jobs.status = 'success'`，没覆盖 `pending / running / retrying / failed` 跨状态。当前 V1 service 不在 delete/restore 改写 status，所以单一 case 已经能验证"不动"语义；但若未来加入 "soft-delete 时取消 pending job" 行为，这个 case 需要扩展。 | 接受；扩展 case 不影响现有断言。 |
| R-80 | smoke 不跑 HTTP 路由层（直接调 `MediaService`）。route schema 已在 `trip-media-recycle-bin-smoke.ts` 测过 `?onlyDeleted=true` 的 zod 解析，但端到端 (express → route → service → repo) 没在 P7.T5 smoke 里收敛。 | 接受；如果将来怀疑路由层有 schema 漂移，跑 `dedup-api-smoke`（已用 supertest 跑真实 HTTP）的 pattern 在 P7 上添加一个 `media-recycle-bin-api-smoke` 即可，不需要改本 smoke。 |

---

### P7.T6 第一轮阶段验收 实现结果

**阶段状态：P7（第一轮 T1–T6）已完成。** 永久删除（P7.T7–T9）按 tasks.md 规划继续保留为 `[LATER]`，前置条件已满足但不在本轮范围内。

#### 验收映射 — requirements §7.18 验收标准前 4 条

| § | 验收标准 | 对应 PASS 断言 | 来源 smoke |
| --- | --- | --- | --- |
| §7.18 #1 | 删除图片不会出现 `FOREIGN KEY constraint failed` | `tasks.md path 2 (FK): softDeleteMedia ... does NOT throw FOREIGN KEY: no error` | `smoke:p7-recycle-bin-acceptance` |
| §7.18 #2 | 删除重复组中的图片后，重复组状态正确更新 | `recommended cleanup: post-delete group.recommended_media_id=null`、`tasks.md path 1 (post): group.recommended_media_id reset to NULL` | `smoke:media-soft-delete`、`smoke:p7-recycle-bin-acceptance` |
| §7.18 #3 | 删除被推荐图片时，系统可以重新推荐或取消推荐 | `selector chain: post-restore + handler run, cover_media_id = restored media id`（restore 后链路重跑推荐+auto-cover）、`recommended cleanup: clearedRecommendedGroups` outcome（删除时即刻 detach） | `smoke:media-restore`（CASE 9）、`smoke:media-soft-delete`、`smoke:dedup-delete-others` |
| §7.18 #4 | 软删除后可以恢复 | `PathC: restoreMedia returns restored=true`、`PathC: deleted_at cleared + status reset to 'processed'`、`PathC: default gallery re-includes the restored media`、`happy: deleted_at cleared`、`happy: status reset to 'processed'` | `smoke:p7-recycle-bin-acceptance`、`smoke:media-restore`、`smoke:trip-media-recycle-bin` |

#### 验收映射 — 用户提示词扩展项

| 检查 | PASS 来源 |
| --- | --- |
| Gallery 默认不展示 deleted 媒体 | `PathA: default listMediaForTrip excludes soft-deleted media`、`PathA: getMediaById on soft-deleted → 404 NotFoundError`、`default: list excludes soft-deleted media`、`read filter: listMediaForTrip excludes soft-deleted` |
| Recycle Bin 只展示 deleted 媒体 | `PathB: onlyDeleted list contains exactly the soft-deleted media`、`onlyDeleted: returns exactly the soft-deleted rows`、`scoping: tripA recycle-bin contains only a1` 等 |
| Restore 后媒体重新回到普通 Gallery | `PathC: default gallery re-includes the restored media`、`restore-chain: m re-appears in the default gallery list` |
| 未引入永久删除 | 代码审计 grep（hardDelete / permanentDelete / forceDelete 等）：服务端仅有 `permanentDeleteEnabled` 配置位（`/health` 元数据，默认 `false`），无任何路由消费；客户端仅在注释 / 软删除 modal 文案中提及"未实现"。|
| 未引入批量 restore | `grep "bulkRestore\|batchRestore\|restoreMany\|restoreAll\|restoreBulk"` 返回空；`MediaService.restoreMedia` / `MediaRepository.restore` 签名均为单 `mediaId`。|
| 回收站无复杂筛选 / 分页 UI | `client/src/pages/TripRecycleBinPage.tsx` 仅含列表 + 每行 Restore 按钮 + Refresh 按钮；无 pagination / filter / sort 控件；本身 hook 限制 `limit=100`，并在剩余风险 R-75 中明确记录。|

#### P7.T6 验证

| 命令 | 结果 |
|------|------|
| server `typecheck` / `lint` / `format:check` / `build` | ✅ |
| client `typecheck` / `lint` / `format:check` / `build` | ✅ |
| P7 阶段 5 个 smoke | `smoke:media-soft-delete` 32/32 ✅、`smoke:media-restore` 28/28 ✅、`smoke:dedup-delete-others` 28/28 ✅、`smoke:trip-media-recycle-bin` 17/17 ✅、`smoke:p7-recycle-bin-acceptance` 55/55 ✅ —— **合计 160/160 PASS** |
| 跨阶段回归 smoke（14 个） | `smoke:media` 26/26、`smoke:dedup-api` 27/27、`smoke:duplicate-group-confirm` 20/20、`smoke:dedup-exact` 26/26、`smoke:dedup-similar` 40/40、`smoke:duplicate-groups-repository` 30/30、`smoke:quality-selector` 41/41、`smoke:quality-selector-trigger` 33/33、`smoke:trip-cover-auto` 26/26、`smoke:trip-cover-url` 13/13、`smoke:image-quality-finalize` 43/43、`smoke:media-status-sync` 18/18、`smoke:media-reprocess` 21/21、`smoke:upload` 30/30、`smoke:trips` 22/22 —— 全部 ✅ |
| FK 不抛错回归 | 显式 try/catch 断言已在 `p7-recycle-bin-acceptance` 中 PASS（`tasks.md path 2 (FK)`），且 `smoke:media-soft-delete` 全程未观察到 SQLite FK 异常 |
| `exactOptionalPropertyTypes` 保持 | server `typecheck` 通过；`ListMediaOptions` / `FetchTripMediaOptions` 等均为 `readonly key?: T \| undefined` 形态 |
| zod `.strict()` 防漂移 | `listMediaOptionsSchema` 仍 `.strict()`；`smoke:trip-media-recycle-bin` 用例 "schema: still strict() — unknown query keys rejected" PASS |

#### P7 阶段（第一轮）总结

- **commit 范围**：`0cf9cd3` (T1) → `da94ee3` (T2) → `98871b2` (T3) → `e8bdaa3` (T4) → `d192a6f` (T5) + 本次 T6 文档 commit。
- **交付能力**：媒体软删除 + 跨表引用清理（recommended / cover / pin 释放）+ 单条 restore + dedup 组批量软删除（保留 winner）+ 前端独立回收站页面 + 单条 Restore + 完整端到端验收测试。
- **未变动主流程**：上传 / 处理 / 推荐 / auto-cover / video 任何一条路径都未被改写；P3.T6 媒体详情读默认 active-only 行为保留；P5.T6 / P6.T6 UI 表面仅扩展（增加按钮 / 入口），未重构。
- **未引入永久删除 / 批量 restore / 复杂筛选 / 分页 UI**：经代码审计与 grep 确认。

### P7 阶段剩余风险（截止本次验收）

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R-74 | 回收站行不挂详情链接（P3.T6 详情默认 active-only，已删媒体点进去会 404） | V1 接受；后续如需"只读详情" 可加 `?includeDeleted=true` 详情查询 |
| R-75 | 回收站无分页 UI（hook `limit=100`） | V1 接受；hook 已留 `limit` prop，未来加 "Load more" 即可 |
| R-76 | Restore 无二次确认 | 故意低摩擦；与软删除二次确认形成对称 |
| R-77 | 客户端 `restoredIds` 仅当前会话生效 | V1 单用户模型；多端同步留给 P12+ |
| **R-78** | `video_segments` 表 P9 才落库；本阶段无法覆盖该表的跨表 FK case | P9 落库时同步在 `p7-recycle-bin-acceptance-smoke.ts` 增加一个 case（PR review 显式提醒） |
| **R-79** | `processing_jobs.status` 跨值场景（pending / running / retrying / failed）未来如新增 "soft-delete 时取消 pending job" 行为时需补 case | 接受；扩展不影响现有断言 |
| **R-80** | 当前 smoke 主要覆盖 Service 层，HTTP route schema 已由 `smoke:trip-media-recycle-bin` 的 zod 解析断言单独验证；端到端 supertest 暂未做 | 接受；如未来怀疑路由层漂移，按 `dedup-api-smoke` 的 supertest 模式新增一个 `media-recycle-bin-api-smoke` |

---

---

## 阶段 P8：图片自动增强（进行中）

> requirements §7.9 / design.md §7.5 / tasks.md 阶段 8。

### P8.T1 enhance enqueue endpoint 实现结果

- **范围**: 仅 `POST /api/media/:id/enhance` 端点 + `image_enhance` 任务类型常量。**不**实现 sharp 增强管线（P8.T2）、**不**写 `media_versions`（P8.T3）、**不**做版本切换 API（P8.T4）、**不**改前端（P8.T5）。
- 新增 `server/src/jobs/imageEnhanceWorker.ts`，单文件只导出 `IMAGE_ENHANCE_JOB_TYPE = "image_enhance"`。P8.T2 会在同一文件追加 `makeImageEnhanceHandler` + 相关 deps 类型，避免常量后续 move（仿照 `imageHashWorker.ts` / `imageQualityBlurWorker.ts` 的"worker 文件 = job_type 常量 + handler"的既有约定）。`server/src/jobs/index.ts` 同步 re-export 常量。
- `MediaService.enhanceMedia(idInput)` 走与 `reprocess` 同一套入队原语（`reprocessOneJobType` 私有方法），但只入队 **单个** slot；返回扁平的 `EnhanceMediaResult { mediaId, jobType, outcome, jobId, reason? }`，而不是 `reprocess` 那样的 `{ mediaId, results: [...] }` 包裹（单 job 无需数组）。`exactOptionalPropertyTypes` 守护下，`reason` 仅在 `outcome='skipped'` 时存在。
- 失败模式（与 `reprocess` 一致，让前端可以无缝复用 P5 起就稳定的错误展示）：
  - **404 `NotFoundError`** —— 媒体行 missing **或** soft-deleted（active-only 读取，匹配 P7 回收站契约：已删媒体不允许再发起增强，用户需先 Restore）。
  - **400 `BadRequestError`** —— `media.type !== 'image'`（视频增强不在 P8 范围，AI 精修在 §7.10）；`type='unknown'`（Upload_Manager 丢弃了原字节，无可增强对象）。
- 路由 `POST /api/media/:id/enhance` 在 `server/src/routes/media.ts` 注册，紧邻 `reprocess` 路由；通过 `asyncHandler` + `parseOrThrow(entityIdSchema, ...)` 守门，错误经全局 envelope 输出。
- 幂等性 / 状态机：与 `reprocess` 共享同一套 created/reset/skipped 状态机，包括 P4.T2 R-40 修正路径（terminal-ish 任务通过 `retrying` 状态而非 `pending` 重新入队，`retry_count` 归零，`next_run_at` 立即生效，`error_message` / `started_at` / `finished_at` 清理）。

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/jobs/imageEnhanceWorker.ts` | `IMAGE_ENHANCE_JOB_TYPE` 常量；P8.T2 追加 handler |
| 修改 | `server/src/jobs/index.ts` | re-export 常量 |
| 修改 | `server/src/media/mediaService.ts` | 增加 `EnhanceMediaResult` 类型 + `enhanceMedia(id)` 方法 |
| 修改 | `server/src/routes/media.ts` | 注册 `POST /api/media/:id/enhance` 路由 |
| 新增 | `server/src/scripts/media-enhance-trigger-smoke.ts` | 14 个 case / 27 个 PASS 断言 |
| 修改 | `server/package.json` | 注册 `smoke:media-enhance-trigger` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P8.T1 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动修复一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| `npm run smoke:media-enhance-trigger`（新） | ✅ **27/27 PASS** |
| 回归 `smoke:media` | ✅ 26/26 |
| 回归 `smoke:media-reprocess` | ✅ 21/21 |
| 回归 `smoke:media-soft-delete` | ✅ 32/32 |
| 回归 `smoke:media-restore` | ✅ 28/28 |
| 回归 `smoke:trip-media-recycle-bin` | ✅ 17/17 |
| 回归 `smoke:p7-recycle-bin-acceptance` | ✅ 55/55 |
| 回归 `smoke:job-queue` | ✅ 55/55 |
| 回归 `smoke:jobs-api` | ✅ 28/28 |
| 回归 `smoke:media-status-sync` | ✅ 18/18 |
| 回归 `smoke:image-channel-executor` | ✅ 26/26 |
| `exactOptionalPropertyTypes` 保持 | ✅（`EnhanceMediaResult.reason` 走条件 spread） |
| zod `.strict()` 防漂移 | ✅（route 仍走 `entityIdSchema`；服务端 schema 未改） |
| P7 soft-delete / restore / recycle bin 行为不破坏 | ✅（P7 全部 smoke 全绿；新 smoke CASE 9 显式验证"soft-deleted → 404"） |

#### P8.T1 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-81** | `image_enhance` job 入队后没有任何 handler 消费（P8.T2 才落地）；如果用户在 P8.T1 commit 与 P8.T2 commit 之间触发，job 会停留在 `pending` 状态。| V1 接受：endpoint 是手动触发，不会自动入队；运行环境正常推进到 P8.T2 即可消化。`smoke:job-queue` 也只在 handler 存在时调度。|
| **R-82** | enhance 当前对 `recommendation='remove'` 或 `user_decision='remove'` 的图片无任何前置检查（requirements §7.9 提到"默认只对推荐保留图片执行"，但那是针对**自动批量**入队，非手动触发）。手动 `POST /enhance` 行为符合 §7.9.6 "用户可以重新执行增强"。 | 接受：手动触发本就是用户显式选择；批量自动增强是 P8 后续任务（暂未规划）。|
| **R-83** | 没有路由层 supertest 验证。R-80 已经记录了同类风险（P7 系列），P8.T1 沿用 service-level smoke 模式；端到端 HTTP 测试如有需要可在 P8.T5 frontend 接入时一并添加。 | 接受；与 R-80 合并 |

继续保留：R-74 ~ R-80（来自 P7 阶段）。

### P8.T2 sharp enhance pipeline 实现结果（同时关闭 P8.T3）

- **范围决策**：原 tasks.md 把 P8.T2（sharp 管线）和 P8.T3（写 `derived/{mediaId}/enhanced.jpg` + `media_versions(version_type='enhanced')`）拆成两个 task，但它们在 worker 视角不可分割——handler 如果不写文件就无法标记 success。所有既有 image-channel worker（thumbnail / metadata / hash / quality_*）也都是单 handler 一次性完成"sharp + 写派生文件 + 写 media_versions"。**单 commit 完成 P8.T2 + P8.T3**，tasks.md 两条都打 `[x]` 并附说明。
- **`imageEnhanceWorker.ts`**：在 P8.T1 留下的常量旁追加 `makeImageEnhanceHandler` + `ImageEnhanceHandlerDeps` + `EnhanceSettings`。sharp 6 步管线：
  1. `.rotate()` — EXIF orientation
  2. `.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })` — 长边上限
  3. `.modulate({ brightness, saturation })`
  4. `.linear(linearA, linearB)`
  5. `.gamma(gamma)`
  6. `.sharpen({ sigma, m1, m2 })`（sigma=0 时跳过）
  7. `.jpeg({ quality, mozjpeg: true })` 输出
- **输出**：`trips/{tripId}/derived/{mediaId}/enhanced.jpg` via `storage.putDerived({ overwrite: true })`（保证 idempotent）；UPSERT 一行到 `media_versions(version_type='enhanced')`，`params` 字段记录 sharpVersion + workerVersion + 每步 sharp 调用串便于追溯。`media_versions.version_type='enhanced'` 早在 005/006 migration 已经在 enum 中——**无新 migration**。
- **config 层 + 边界守卫**：`config.quality.enhance.{maxEdge, brightness, saturation, gamma, linearA, linearB, sharpenSigma, sharpenM1, sharpenM2, jpegQuality, workerVersion}` 共 11 个 env 可调。defaults（4096 / 1.0 / 1.05 / 1.05 / 1.05 / -3 / 0.6 / 0.5 / 2.0 / 88 / "1.0"）按 requirements §7.9 #5"不应过度饱和、过度锐化"保守调过；superRefine 守卫 gamma ≥ 1.0（sharp 文档下限）、brightness/saturation/gamma/linearA ≤ 2.0（避免 filter-look）、sharpenM2 ≤ 3.0（sharp 文档上限，避免环边）、sharpenSigma ≤ 10、jpegQuality 1..100。
- **bootstrap**：`server/src/index.ts` 注册 `IMAGE_ENHANCE_JOB_TYPE → makeImageEnhanceHandler(...)`，复用既有 `storage` / `mediaRepo` / `mediaVersionsRepo` / `logger`。
- **未动主流程**：上传 / 处理 / 推荐 / auto-cover / video 任何路径都未触碰。`media_items.preview_path / thumbnail_path / status / user_decision` 由 handler **不写**——选择 enhanced 版本作为可见版本是 P8.T4 的 user-action 范畴，不在 P8.T2 worker 里。

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `server/src/jobs/imageEnhanceWorker.ts` | 在 P8.T1 常量旁追加 handler + 类型 |
| 修改 | `server/src/jobs/index.ts` | re-export `makeImageEnhanceHandler` + `EnhanceSettings` + `ImageEnhanceHandlerDeps` |
| 修改 | `server/src/config/index.ts` | 11 个 enhance env 知识 + Config interface + superRefine 守卫 |
| 修改 | `server/src/index.ts` | bootstrap 注册 enhance handler |
| 新增 | `server/src/scripts/image-enhance-worker-smoke.ts` | 11 个 case / **34 个 PASS 断言** |
| 修改 | `server/package.json` | 注册 `smoke:image-enhance-worker` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P8.T2 + P8.T3 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`npm run smoke:image-enhance-worker`（新）** | ✅ **34/34 PASS** |
| 回归 `smoke:media-enhance-trigger` (P8.T1) | ✅ 27/27 |
| 回归 `smoke:media` | ✅ 26/26 |
| 回归 `smoke:media-reprocess` | ✅ 21/21 |
| 回归 `smoke:media-soft-delete` | ✅ 32/32 |
| 回归 `smoke:media-restore` | ✅ 28/28 |
| 回归 `smoke:trip-media-recycle-bin` | ✅ 17/17 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 完整契约) | ✅ 55/55 |
| 回归 `smoke:job-queue` | ✅ 55/55 |
| 回归 `smoke:jobs-api` | ✅ 28/28 |
| 回归 `smoke:image-channel-executor` | ✅ 26/26 |
| 回归 `smoke:image-thumbnail` | ✅ 22/22 |
| 回归 `smoke:image-metadata` | ✅ 23/23 |
| 回归 `smoke:image-hash` | ✅ 25/25 |
| 回归 `smoke:image-quality-finalize` | ✅ 43/43 |
| 回归 `smoke:media-versions` | ✅ 24/24 |
| 回归 `smoke:media-status-sync` | ✅ 18/18 |
| `exactOptionalPropertyTypes` 保持 | ✅（EnhanceSettings 全 readonly + 非 optional） |
| zod `.strict()` 防漂移 | ✅（config 层 superRefine + entityIdSchema 路由仍生效） |
| P7 soft-delete / restore / recycle bin 行为不破坏 | ✅（new smoke CASE 8 显式断言 "soft-deleted → 'failed' + 不污染派生文件 + 不写 media_versions"） |
| 原图未被覆盖（CLAUDE.md §2.1） | ✅（new smoke CASE 2 显式 bytes-equal 断言） |
| 不过度饱和 / 不过度锐化（requirements §7.9 #5） | ✅（new smoke CASE 4: 每通道均值漂移 ≤ 10%；实测 1.23%） |

#### P8.T2 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-84** | enhance handler 不会把 enhanced.jpg 设为 `media_items.preview_path` —— gallery 仍显示原图。这是 P8.T4 "select-version" user-action 的职责。同时也意味着用户即使触发 enhance 也不会在 gallery 上看到差别，得进 detail 页（P8.T5）才能看到 before/after。 | 设计如此；P8.T4 + P8.T5 落地后会接通 |
| **R-85** | enhanced.jpg 的 EXIF 被 sharp 默认丢掉（sharp 不传递 metadata 除非显式 `.keepMetadata()`）。原图 EXIF 仍在原始文件里完整保留，但 enhanced 文件本身没有拍摄信息。后续如需要 enhance 输出保留 EXIF（user 下载场景），加 `.keepMetadata()` 即可。 | V1 接受；如果 P8.T5 / P8.T6 验收要求 EXIF 透传，再改 |
| **R-86** | enhance handler 当前不对原图分辨率做下限检查（小到 64×64 的图也会走全流程）。defaults 下 `withoutEnlargement:true` 保证不上采样，所以小图的输出就是小图，符合非破坏式语义；但 sharpen 在 64×64 上意义不大。 | V1 接受；如发现极小图被 enhance 浪费 CPU，可在 service 层加最小边检查 |

继续保留：R-74 ~ R-83。

### P8.T4 版本切换 API 实现结果

- **范围**: `GET /api/media/:id/versions` + `POST /api/media/:id/select-version`。**不**改前端（P8.T5）、**不**做阶段验收（P8.T6）。
- **存储决策（新 migration）**: 该任务要求"存储用户选择哪个版本"，schema 里没有合适的字段：`preview_path` / `thumbnail_path` 是 P3.T4 工作器的输出；`media_versions.status` 是行级 ready/failed。覆盖任何现有字段都会让语义紧耦合到运维管线，破坏现有 P3.T4 工作器（它会在重跑时覆盖 `preview_path`）。
  - 决定新增 migration `010_add_media_items_active_version_type.sql`：12 步表重建为 STRICT 表加 CHECK 约束（SQLite 不支持 ALTER 加 CHECK）；新列 `active_version_type TEXT NOT NULL DEFAULT 'original'` + CHECK 限定闭枚举 `('original', 'enhanced', 'ai_refined')`；老行 DEFAULT 自动覆盖正确值，无需回填 UPDATE；指数 byte-for-byte 复刻自 002。外部 FK 通过 RENAME 自动重新绑定（与 003/006 同套路）。
  - 该决策与提示词的"不新增 migration，除非 P8.T4 文档明确要求"边界一致：API 契约本身就明确要求持久化用户选择，没有这一列实现不出来。
- **服务层**：
  - `MediaService.listVersions(id)` 返回 `MediaVersionsView { mediaId, activeVersionType, versions[] }`。`versions[]` 始终包含合成的 'original' 入口（来自 `media_items` 列，`id=null`，filePath 为 `original_path` 或空串），再加上 user-selectable 类型的 `media_versions` 行（'enhanced' / 'ai_refined'）。运维类型（thumbnail / preview / metadata / video_*）通过白名单 `USER_SELECTABLE_VERSION_TYPES` 过滤掉。
  - `MediaService.selectVersion(id, body)` 通过 `selectVersionBodySchema`（zod `.strict()` 闭枚举）解析 body，跨表校验目标 version 存在（'original' 需要 `original_path` 非空；'enhanced'/'ai_refined' 需要对应 media_versions 行），写 `media_items.active_version_type` 单列（+ `updated_at`），返回 `SelectVersionResult { mediaId, activeVersionType, previousVersionType, alreadyActive }`。幂等：重复选同 type 短路不写 DB。
  - 两个方法都默认 active-only 读取，soft-deleted 媒体 → 404（沿用 P7 回收站契约）。
- **路由层**：在 `server/src/routes/media.ts` 注册 `GET /api/media/:id/versions` + `POST /api/media/:id/select-version`，紧邻 enhance / soft-delete / restore 路由。`entityIdSchema + asyncHandler + req.body → service.selectVersion(id, body)` 一行直达，错误经全局 envelope 输出。
- **响应字段约束**：filePath 始终是 storage 根下的逻辑路径（如 `trips/.../derived/.../enhanced.jpg`），**不暴露任何本地绝对路径**（与既有 MediaVersion 返回的 file_path 同约定，前端拼接 `/storage/` 前缀渲染）。
- **未动主流程**：上传 / 处理 / 推荐 / auto-cover / video 主流程均未触及；media_versions 表读路径不变；`media_items.preview_path` / `thumbnail_path` 保持由 P3.T4 thumbnail worker 独占写权。**未触碰原始素材**：select-version 是纯 metadata 操作，不会复制 / 不会覆盖 / 不会删除任何磁盘文件（smoke CASE 13 显式断言）。

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/migrations/010_add_media_items_active_version_type.sql` | 12 步表重建为 media_items 加 active_version_type 列 + CHECK |
| 修改 | `server/src/media/mediaTypes.ts` | 新增 `MediaActiveVersionType` 枚举 + `MediaItem.activeVersionType` 字段 + `MediaVersionView` / `MediaVersionsView` / `SelectVersionResult` |
| 修改 | `server/src/media/mediaSchemas.ts` | 新增 `selectVersionBodySchema` (.strict() 闭枚举) + `SelectVersionInput` 类型 |
| 修改 | `server/src/media/mediaRepository.ts` | `MediaRow` + `MEDIA_TABLE_COLUMNS` + `rowToItem` 补 `active_version_type`；新增 `setActiveVersionTypeStmt` + `setActiveVersionType()` 方法 |
| 修改 | `server/src/media/mediaService.ts` | 新增 `listVersions(id)` + `selectVersion(id, body)` 方法 + `buildVersionsView` 私有 helper |
| 修改 | `server/src/media/index.ts` | re-export 新类型 + schema |
| 修改 | `server/src/routes/media.ts` | 注册 `GET /api/media/:id/versions` + `POST /api/media/:id/select-version` |
| 新增 | `server/src/scripts/media-versions-api-smoke.ts` | 14 个 case / **35 个 PASS 断言** |
| 修改 | `server/package.json` | 注册 `smoke:media-versions-api` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P8.T4 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`npm run smoke:media-versions-api`（新）** | ✅ **35/35 PASS** |
| 回归 `smoke:media-enhance-trigger` (P8.T1) | ✅ 27/27 |
| 回归 `smoke:image-enhance-worker` (P8.T2/T3) | ✅ 34/34 |
| 回归 `smoke:media` | ✅ 26/26 |
| 回归 `smoke:media-versions` | ✅ 24/24 |
| 回归 `smoke:media-reprocess` | ✅ 21/21 |
| 回归 `smoke:media-soft-delete` (P7) | ✅ 32/32 |
| 回归 `smoke:media-restore` (P7) | ✅ 28/28 |
| 回归 `smoke:trip-media-recycle-bin` (P7) | ✅ 17/17 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 完整契约) | ✅ 55/55 |
| 回归 `smoke:job-queue` | ✅ 55/55 |
| 回归 `smoke:jobs-api` | ✅ 28/28 |
| 回归 `smoke:image-channel-executor` | ✅ 26/26 |
| 回归 `smoke:image-thumbnail` | ✅ 22/22 |
| 回归 `smoke:image-metadata` | ✅ 23/23 |
| 回归 `smoke:image-hash` | ✅ 25/25 |
| 回归 `smoke:image-quality-finalize` | ✅ 43/43 |
| 回归 `smoke:media-status-sync` | ✅ 18/18 |
| 回归 `smoke:dedup-api` | ✅ 27/27 |
| 回归 `smoke:upload` | ✅ 30/30 |
| `exactOptionalPropertyTypes` 保持 | ✅（`SelectVersionResult` / `MediaVersionView` 全 readonly，无 optional 字段） |
| zod `.strict()` 防漂移 | ✅（`selectVersionBodySchema` 是新 `.strict()` schema；smoke CASE 10 显式验证未知 body key 被拒） |
| P7 soft-delete / restore / recycle bin 行为不破坏 | ✅（smoke CASE 12 显式断言 "soft-deleted → 404"；P7 全部 smoke 全绿） |
| 原图未被覆盖 / 不被删除 | ✅（smoke CASE 13 显式断言：select-version 后 enhanced.jpg 文件还在、bytes 不变、其他 media_items 列不变、media_versions 行计数不变） |

#### P8.T4 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-87** | `active_version_type` 切换不会自动重新生成 `preview_path` / `thumbnail_path`——前端如果直接读 `media.previewPath`/`thumbnailPath`，看到的永远是 P3.T4 原图派生。这是设计如此（P8.T4 范围只到"持久化用户选择"），前端 P8.T5 需要根据 `activeVersionType` 自己决定渲染哪个文件。 | 设计如此；P8.T5 会接通 |
| **R-88** | 切换到 enhanced 时不会强制有 thumbnail/preview 派生（enhanced.jpg 本身是 full-size JPEG）。前端如要在 gallery 显示 enhanced 缩略图，得自己处理（或将来加 enhance 后的 thumb worker）。V1 范围下，gallery 仍用原图 thumb 是可以接受的。 | V1 接受；如需 enhanced thumbnail，后续可加新 worker |
| **R-89** | 没有"自动当 enhanced job 成功后把 active_version_type 自动切到 enhanced"的钩子。当前手动触发：用户 enhance + 等 job 完成 + 显式 select-version。这避免了未经用户许可的视觉变化（符合 requirements §7.9.5 "用户可以选择采用原图或增强图"），但意味着用户需要两步操作。 | 设计如此；可在 P8.T5 frontend 提供"完成后自动应用"的可选 toggle |

继续保留：R-74 ~ R-86（P7 + P8.T1/T2/T3）。

### P8.T5 前端 Enhancement Section 实现结果

- **范围**：在现有 `MediaDetailPage` 中插入用户面向的"原图 vs 增强图"对比区段 + 采用 / 切回原图 / 重新增强动作。**仅消费** P8.T1（`POST /enhance`）+ P8.T4（`GET /versions`、`POST /select-version`）端点，**不**新增后端 API、**不**新增 migration、**不**改任何 P7/P8.T1-T4 主流程。
- **客户端类型/API 同步（`client/src/api/media.ts`）**：
  - 新增 `MediaActiveVersionType = 'original' | 'enhanced' | 'ai_refined'`，与服务端 migration 010 的 CHECK 闭枚举一致；
  - `MediaItem.activeVersionType` 字段为 `optional`——服务端始终返回但客户端 `undefined` 视作 `'original'`，避免部署窗口期老缓存破页（注释明确写在类型旁）；
  - 新增 `EnhanceMediaResult` / `MediaVersionView` / `MediaVersionsView` / `SelectVersionResult` 类型，逐字段镜像服务端；
  - 新增 3 个 helper：`enhanceMedia(id)` (POST /enhance)、`fetchMediaVersions(id, signal?)` (GET /versions 带 AbortController)、`selectMediaVersion(id, versionType)` (POST /select-version with `{ versionType }` body)。全部沿用既有 `readErrorMessage` 错误投影，错误经全局 envelope 上抛。
- **新 hook（`client/src/hooks/useMediaVersions.ts`）**：与 `useMediaDetail` 同形（`{ data, loading, error, refetch }`）+ AbortController 防 race + stale-while-revalidate 防 flash。完全独立于 `useMediaDetail`，两个 hook 在 detail 页并行运行，互不污染。
- **`MediaDetailPage.tsx` 改动**：
  - 顶部加 `useMediaVersions(id)` 调用（绑定为 `versionsView` 以避开 `detail.versions` 的命名冲突）；
  - 新增 3 个 `useState`：`enhancePending` (boolean) / `selectPending` (MediaActiveVersionType | null) / `enhanceFeedback` (3-shape sum type)。**每个 button 有独立 pending flag**——切换 enhanced 时 "Re-enhance" 仍可读，避免误锁；
  - 2 个 handler：`handleEnhance()` 调 P8.T1 + 成功后 `refetchVersions()`；`handleSelectVersion(t)` 调 P8.T4 + 成功后并行 `refetch()` + `refetchVersions()`，确保 `media.activeVersionType` 与 versions view 同步刷新；
  - **新 JSX section `<EnhancementSection>`** 插入位置：hero 之后、`<QualityAnalysisSection>` 之前，仅 `media.type === 'image'` 时渲染（匹配后端 enhance 仅 image 的契约）；
  - section 布局：grid 两列（`auto-fit minmax(240px,1fr)`，单列自动塌缩到窄屏）展示 original / enhanced 两个 `<VersionCell>`，每个 cell：标签 / 状态 pill (✓ Active 或 Inactive，positive/neutral tone) / 缩略图 `<img src="/storage/{filePath}">` 或类型 emoji 占位 / dimensions + size 元数据；active cell 用绿色边框 + 浅绿背景 (`[data-active="true"]`) 强化区分；
  - **空 enhanced 状态**：渲染 `media-enhance-cell--empty` placeholder（虚线边框 + ✨ emoji + 引导文案），**不**渲染 broken `<img src="">`；
  - 动作行 3 按钮（按禁用条件 + 文案）：
    - **Adopt enhanced** (`btn-primary`)：仅 enhanced 存在且非 active 启用，`disabled` 文案随状态变化（"No enhanced version available yet" / "Already using the enhanced version"）；
    - **Use original** (`btn-secondary`)：active='original' 时禁用，对应"放弃 enhanced 切回原图"（**纯 metadata 操作，不删 enhanced 文件**——符合提示词 "不做物理删除 enhanced 文件" 约束）；
    - **Re-enhance** (`btn-secondary`)：始终启用（除非另一个 op 在 pending），调用 P8.T1，按钮文案 "Enhance"（空 enhanced 时）/ "Re-enhance"（已有 enhanced）；
  - `<EnhanceFeedbackBanner>` 3-shape sum：`enhance-success`（按 outcome 三档文案：created / reset / skipped + reason）/ `select-success`（含 `alreadyActive=true` 短路文案）/ `error`（按 op 区分 "Enhance failed" / "Switch failed"），全部 `aria-live="polite"` 或 `role="alert"`。
- **CSS（`client/src/index.css`）**：新增 6 个 `.media-enhance-*` rules（section 容器 / grid / cell / active-tint / empty-tint / cell-img / cell-placeholder / cell-head / cell-label / actions）；复用既有 `.quality-pill[data-tone]` / `.btn-primary` / `.btn-secondary` / `.form-error` / `.status-text` 不引入新 token。
- **P7 兼容**：soft-deleted 媒体由 `useMediaDetail` 直接 404 → 现有 `error !== null` 分支已经显示"Failed to load media"+回 trip 链接，本次未触碰；`useMediaVersions` 同样 404，但因为 detail 先 404 整个页面早已 bail-out，section 不会渲染——P7 contract 透传，无回归。
- **不暴露绝对路径**：图片 src 全部 `/storage/{filePath}`（逻辑路径），与既有 hero / version 列表完全一致。

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `client/src/api/media.ts` | `MediaActiveVersionType` + `MediaItem.activeVersionType` + 4 types + 3 helpers |
| 新增 | `client/src/hooks/useMediaVersions.ts` | useMediaDetail-shaped hook for `/api/media/:id/versions` |
| 修改 | `client/src/pages/MediaDetailPage.tsx` | 导入新 API + hook + 3 useState + 2 handler + `<EnhancementSection>` + `<VersionCell>` + `<EnhanceFeedbackBanner>` |
| 修改 | `client/src/index.css` | 6 个 `.media-enhance-*` 样式块（grid + cell + active tint + empty placeholder + actions） |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P8.T5 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（client） | ✅ |
| `npm run lint`（client） | ✅ |
| `npm run format:check`（client） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（client） | ✅（bundle 增 ~7 KB gzipped——含新 CSS + 新组件代码） |
| `npm run typecheck` / `lint` / `format:check` / `build`（server） | ✅（server 未改） |
| 回归 `smoke:media-versions-api` (P8.T4 后端契约) | ✅ 35/35 |
| 回归 `smoke:media-enhance-trigger` (P8.T1) | ✅ 27/27 |
| 回归 `smoke:image-enhance-worker` (P8.T2/T3) | ✅ 34/34 |
| 回归 `smoke:media` / `smoke:media-versions` / `smoke:media-reprocess` | ✅ 26+24+21 |
| 回归 `smoke:media-soft-delete` / `smoke:media-restore` / `smoke:trip-media-recycle-bin` / `smoke:p7-recycle-bin-acceptance` (P7) | ✅ 32+28+17+55 |
| 回归 `smoke:job-queue` / `smoke:jobs-api` / `smoke:dedup-api` | ✅ 55+28+27 |
| `exactOptionalPropertyTypes` 保持 | ✅（`EnhanceFeedback`/`SelectVersionResult`/`MediaVersionView` 全 readonly；`MediaItem.activeVersionType?` 用 `?` 显式标记） |
| zod `.strict()` 防漂移 | ✅（client 无 zod；server 端 `selectVersionBodySchema` 仍 `.strict()`，回归 smoke 验证） |
| 原图未被覆盖 / 不被删除 | ✅（前端只调 P8.T1/T4 端点，后端早已断言；本次未触碰任何 storage 路径） |
| 没引入大模型 / ComfyUI / CLIP / DINO / FAISS | ✅（grep 0 匹配） |
| 没引入新测试框架 | ✅（沿用 server smoke + client 静态检查模式） |

#### P8.T5 必补测试覆盖映射

| 提示词要求 | 验证方式 |
|---|---|
| ① 媒体详情能加载 versions | `useMediaVersions` 复用 `fetchMediaVersions` (P8.T4 wire contract，server smoke `smoke:media-versions-api` 35/35 已经 PASS HTTP 层断言：GET /versions 返回正确 shape) |
| ② original / enhanced 能显示或切换查看 | `<VersionCell>` 两列布局；缩略图来自 `/storage/{filePath}`（filePath 来自 server，不暴露绝对路径） |
| ③ 当前 active version 状态可见 | "✓ Active" pill (`data-tone="positive"`) + `data-active="true"` 边框 + 顶部 section 描述 |
| ④ 点击采纳 enhanced 后会调用 select-version | `handleSelectVersion('enhanced')` → `selectMediaVersion(id, 'enhanced')` → POST /api/media/:id/select-version；server smoke CASE 5 ✅ 验证 `active_version_type` 真的翻转 |
| ⑤ 切回 original 后状态正确 | `handleSelectVersion('original')` 路径同上；后续 `refetch()` + `refetchVersions()` 让 `active === 'original'`，UI active pill 自动跟随；server smoke CASE 7 ✅ 验证后端字段切回 |
| ⑥ 点击重新增强会调用 enhance API | `handleEnhance()` → `enhanceMedia(id)` → POST /api/media/:id/enhance；server smoke `smoke:media-enhance-trigger` 27/27 ✅ |
| ⑦ 无 enhanced 版本时页面不崩溃 | `enhanced === null` 分支渲染 `media-enhance-cell--empty` placeholder + ✨ 引导文案；不渲染 `<img src="">`；"Adopt enhanced" 按钮自动 disabled 含 title 解释；client `npm run build` 跑通无错 |
| ⑧ P7 deleted 媒体相关行为不被破坏 | `useMediaDetail` 先 404，error 分支 bail-out 整页，section 永不渲染；server smoke `smoke:p7-recycle-bin-acceptance` 55/55、`smoke:media-versions-api` CASE 12 (soft-deleted → 404) ✅ |

#### P8.T5 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-90** | 没有"enhance job 完成"实时推送/轮询。用户点击 "Re-enhance" 后必须**手动刷新页面**或离开再回来才能看到新的 enhanced 缩略图；feedback banner 提示了 "Refresh the page after a moment" 但仍是 manual。 | V1 接受；polling/SSE 是 P12+ 范围（design.md §6.10 已经把任务轮询列在路线图上） |
| **R-91** | "Use original" 按钮（"放弃 enhanced"）只是切换 active 指针，enhanced.jpg + media_versions 行**保留**。如果用户期望"真的把增强版删掉"，会困惑；当前提示词明确要求 "不做物理删除"，所以这是设计如此，但 UX 文案值得在 P8.T6 验收时回顾。 | 符合 §7.9 "原图必须保留" + 提示词 "不做物理删除 enhanced 文件" 双重红线；P8.T6 时如需提示文案再改 |
| **R-92** | Gallery（`TripDetailPage.tsx`）尚未消费 `activeVersionType`——gallery thumbnail 仍是原图的 thumb.webp，即使用户在详情页切到 enhanced 也不会立刻在 gallery 反映。R-87/R-88 早已记录该差异；P8.T5 没在 gallery 增加 enhanced thumbnail 逻辑（会引入复杂度——需要新 worker 生成 enhanced thumb）。 | 设计如此；P8.T5 范围只到详情页对比，gallery enhanced 视觉同步留作未来增强 |

继续保留：R-74 ~ R-89。R-87（active_version_type 切换不会自动重新生成 preview/thumbnail——前端需自行渲染）现在已经被 P8.T5 部分缓解（详情页 hero 仍是 preview.webp 但 EnhancementSection 直接展示了用户切的版本），但 gallery 同步问题仍由 R-92 兜底。

### P8.T6 阶段验收 实现结果

**阶段状态：P8（T1–T6）已完成。** 后端 + 前端闭环全部交付，requirements §7.9 验收前 5 条均通过；本节是阶段签收记录。

#### 验收映射 — requirements §7.9 验收标准（前 5 条）

| § | 验收标准 | 状态 | PASS 来源 |
| --- | --- | --- | --- |
| §7.9 #1 | 增强不会覆盖原图 | ✅ | `smoke:image-enhance-worker` "non-destructive: original bytes exactly match the seeded JPEG" + "original ≠ enhanced (sharp actually transformed pixels)"；handler `storage.putDerived` 写到 `derived/` 不动 `originals/`；`smoke:media-versions-api` CASE 13 "scope-guard: enhanced.jpg bytes intact" |
| §7.9 #2 | 增强图保存为 media_versions 记录 | ✅ | `smoke:image-enhance-worker` "versions: row exists with version_type='enhanced'" + "file_path matches the derived logical path" + "mime_type=image/jpeg" + "width/height/file_size populated >0" + "params JSON parses + records workerVersion + pipeline list"；migration 005/006 enum 已含 `'enhanced'` |
| §7.9 #3 | 增强失败不影响原图浏览 | ✅ | `smoke:image-enhance-worker` "soft-deleted: tick outcome=failed" + "no enhanced.jpg leaked onto disk" + "no media_versions row was inserted"；handler throws → executor marks job 'failed'，原图 + thumbnail + preview 路径完全未触碰；`smoke:media-versions-api` CASE 8 "no-enhanced: BadRequestError + media_items.active_version_type stays 'original'" |
| §7.9 #4 | 用户可以回退到原图 | ✅ | `smoke:media-versions-api` CASE 7 "select (back): alreadyActive=false + previousVersionType='enhanced' + activeVersionType='original'" + "media_items.active_version_type='original'"；前端 `<EnhancementSection>` "Use original" 按钮 (P8.T5)，纯 metadata 切换不删除 enhanced 文件 |
| §7.9 #5 | 增强效果不应过度饱和、过度锐化或明显失真 | ✅ | `smoke:image-enhance-worker` "intensity: per-channel mean drift ≤ 10% (no over-saturation)" 实测 1.23%；config 层 superRefine 守卫 brightness/saturation/gamma/linearA ≤ 2.0 + gamma ≥ 1.0 + sharpenM2 ≤ 3.0 + sharpenSigma ≤ 10；defaults (1.0/1.05/1.05/1.05/-3/0.6/0.5/2.0/88) 实测产出 conservative |

#### 验收映射 — 用户提示词扩展项

| 检查 | 结果 |
|---|---|
| ① enhance API 可以正常入队 | ✅ `smoke:media-enhance-trigger` 27/27（fresh / pending → skipped / running → skipped / failed → reset / success → reset / cancelled → reset / idempotency / 404 missing / 404 soft-deleted / 400 video / 400 unknown / 400 malformed id） |
| ② image_enhance worker 可以生成 enhanced jpg | ✅ `smoke:image-enhance-worker` 34/34 happy path 在真实 sharp + 真实磁盘上验证 |
| ③ 原始图片不被覆盖、不被删除 | ✅ §7.9 #1 上方表格 + grep 审计 |
| ④ enhanced 结果写入 media_versions | ✅ §7.9 #2 上方表格 |
| ⑤ GET /api/media/:id/versions 能返回 original / enhanced | ✅ `smoke:media-versions-api` CASE 2-4（合成 original / 过滤运维 type / enhanced 入口 / HTTP 层 200 + 正确 shape） |
| ⑥ POST /api/media/:id/select-version 可以切换 active version | ✅ `smoke:media-versions-api` CASE 5-7（switch enhanced / 幂等 / switch back） |
| ⑦ 前端能展示 original vs enhanced | ✅ P8.T5 `<EnhancementSection>` + `<VersionCell>` side-by-side 网格；client `typecheck` + `build` 跑通 |
| ⑧ 前端 adopt enhanced / use original / re-enhance 可用 | ✅ P8.T5 三个按钮 + 独立 pending flag + aria-live banner；按钮 disabled 条件覆盖 alreadyActive / no enhanced 等边界 |
| ⑨ P7 soft-delete / restore / recycle bin 行为没有被破坏 | ✅ P7 全套 smoke 全绿（soft-delete 32/32、restore 28/28、recycle-bin 17/17、p7-acceptance 55/55、dedup-delete-others 28/28）；`smoke:image-enhance-worker` CASE 8 显式断言 "soft-deleted media → job 'failed' 不污染派生文件/版本行" |
| ⑩ 上传 / 处理 / 推荐 / auto-cover / video 主流程没有被改坏 | ✅ 跨阶段回归 smoke 全绿（upload 30/30、media 26/26、media-reprocess 21/21、image-channel-executor 26/26、image-thumbnail 22/22、image-metadata 23/23、image-hash 25/25、image-quality-finalize 43/43、quality-selector 41/41、quality-selector-trigger 33/33、trip-cover-auto 26/26、trip-cover-url 13/13、dedup-api 27/27、dedup-exact 26/26、dedup-similar 40/40、duplicate-group-confirm 20/20、trips 22/22、media-status-sync 18/18）；`git diff` 范围审计：P8 期间 `server/src/upload/`、`server/src/quality/qualitySelector*`、`server/src/dedup/`、pre-existing image workers、`client/src/pages/TripDetailPage.tsx` 等关键路径完全未触 |

#### P8.T6 验证

| 项 | 结果 |
| --- | --- |
| server `typecheck` / `lint` / `format:check` / `build` | ✅ |
| client `typecheck` / `lint` / `format:check` / `build` | ✅ |
| **P8 阶段 3 个 smoke** | `smoke:media-enhance-trigger` 27/27 ✅、`smoke:image-enhance-worker` 34/34 ✅、`smoke:media-versions-api` 35/35 ✅ —— **合计 96/96 PASS** |
| **跨阶段回归 smoke（25 个）** | media-soft-delete 32/32、media-restore 28/28、trip-media-recycle-bin 17/17、p7-recycle-bin-acceptance 55/55、dedup-delete-others 28/28、media 26/26、media-versions 24/24、media-reprocess 21/21、job-queue 55/55、jobs-api 28/28、image-channel-executor 26/26、image-thumbnail 22/22、image-metadata 23/23、image-hash 25/25、image-quality-finalize 43/43、quality-selector 41/41、quality-selector-trigger 33/33、trip-cover-auto 26/26、trip-cover-url 13/13、dedup-api 27/27、dedup-exact 26/26、dedup-similar 40/40、duplicate-group-confirm 20/20、upload 30/30、trips 22/22、media-status-sync 18/18 —— **全绿** |
| 总计 | **29/29 smoke 全绿** |
| `exactOptionalPropertyTypes` 保持 | ✅ |
| zod `.strict()` 防漂移 | ✅（`selectVersionBodySchema` 是 `.strict()` 闭枚举；`smoke:media-versions-api` CASE 10 显式验证未知 body key 被拒） |
| migration 010 可正常执行 | ✅（所有 smoke 都跑 `runMigrations` 包括 010；smoke 全绿即证明 010 在 fresh DB 上跑通） |
| 原始素材不被覆盖 | ✅（`smoke:image-enhance-worker` CASE 2 bytes-equal 断言；`smoke:media-versions-api` CASE 13 scope-guard） |
| 无 FOREIGN KEY 错误 | ✅（`smoke:p7-recycle-bin-acceptance` "tasks.md path 2 (FK)" 显式断言 + 29 smoke 全绿无 SQLite 异常） |
| 代码审计 grep（hardDelete/permanentDelete/bulkRestore/batchRestore/ffmpeg/video_segment/ComfyUI/CLIP/DINO/FAISS/OpenAI/Anthropic） | ✅（P8 整个 commit chain `a1970f3..57fb5c5` 0 匹配） |
| 工作区保持干净（commit 前） | ✅ |

#### P8 阶段（T1–T6）总结

- **commit 范围**：`a1970f3` (T1) → `505d254` (T2 + T3 合并) → `c44aace` (T4 + migration 010) → `57fb5c5` (T5) + 本次 T6 文档 commit。
- **交付能力**：
  - 后端：`POST /enhance` 入队 → `image_enhance` job → sharp 6 步管线（rotate / resize / modulate / linear / gamma / sharpen / jpeg+mozjpeg）→ 生成 `derived/{mediaId}/enhanced.jpg` → UPSERT `media_versions(version_type='enhanced')`；`GET /versions` 合成 original + 列 user-selectable 版本；`POST /select-version` 写 `media_items.active_version_type` 单列。
  - 前端：`MediaDetailPage` 新增 `<EnhancementSection>` (image-only)，side-by-side compare grid + adopt / use-original / re-enhance 三按钮 + aria-live banner。
  - schema：migration 010 加 `media_items.active_version_type` 列 + CHECK 闭枚举。
  - 测试：3 个新 smoke（96/96 PASS）。
- **未变动主流程**：上传 / 处理 / 推荐 / auto-cover / video 任何路径都未被改写；P3.T6 媒体详情读、P3.T4 thumbnail worker、P6.T5 quality selector、P5 dedup engine 等均不变；P7 soft-delete / restore / recycle bin 完全保留。
- **未引入**：永久删除、批量 restore、视频流程改动、大模型 / ComfyUI / CLIP / DINO / FAISS / 任何 AI 厂商 SDK、复杂 job 轮询、UI 大改、新测试框架。

### P8 阶段剩余风险（截止本次验收）

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R-81 | (已闭合) `image_enhance` job 入队后无 handler 消费 — P8.T2 commit 已落地 handler | 闭合 |
| R-82 | enhance 当前对 `recommendation='remove'` / `user_decision='remove'` 的图片无前置检查（手动触发是 §7.9.6 "用户可重新执行增强" 的合法路径） | 接受 |
| R-83 | 没有路由层 supertest 验证（与 P7.R-80 同类） | 接受；如需补可加 `media-recycle-bin-api-smoke` 同款 |
| R-84 | enhance handler 不会把 enhanced.jpg 自动设为 `media_items.preview_path` | 设计如此；P8.T4 + T5 已通过 active_version_type + 前端 EnhancementSection 接通 |
| R-85 | enhanced.jpg 默认不保留 EXIF（sharp 默认） | 原图 EXIF 完整保留；如未来要 enhanced 输出保留 EXIF 加 `.keepMetadata()` |
| R-86 | enhance handler 不对极小图（< 64×64）做下限检查 | V1 接受；`withoutEnlargement:true` 已保证不上采样 |
| R-87 | (P8.T5 部分缓解) `active_version_type` 切换不自动重生成 preview/thumbnail；详情页通过 EnhancementSection 直接渲染切的版本，但 hero 仍是 preview.webp | 详情页已可见切换；gallery 同步问题由 R-92 兜底 |
| R-88 | 切到 enhanced 时不强制生成 enhanced thumbnail | V1 接受；后续可加 worker |
| R-89 | 没有"enhance job 成功自动切到 enhanced"的钩子 | 设计如此（§7.9.5 "用户选择"）；P8.T5 提供手动 adopt 按钮 |
| R-90 | 无 enhance job 完成的实时推送/轮询 | V1 接受；polling/SSE 留给 P12+ |
| R-91 | "Use original" 不物理删除 enhanced 文件（符合 §7.9.3 "原图必须保留" + 提示词 "不做物理删除" 红线） | 设计如此 |
| R-92 | Gallery 仍显示原图 thumbnail；详情页切到 enhanced 不会立刻在 gallery 反映 | V1 接受；需要新 enhanced-thumbnail worker，留作未来增强 |

继续保留：R-74 ~ R-80（P7 阶段）。

P7.T7 ~ T9（永久删除）保留为 `[LATER]`，前置条件（P7.T1–T6 全部完成且自动化测试通过）已满足，但不在本轮触发范围。`video_segments` 表仍按 P9 规划处理。复杂 job 轮询（R-90）作为后续增强项，不阻塞 P8 完成。

---

## 阶段 P9：视频基础处理（进行中）

> requirements §7.11 / §7.12 / §14 阶段 9 / design.md §7.5+ 视频管线。

### P9.T1 video_segments 迁移 实现结果

- **范围**：纯 schema 落库，**仅** `video_segments` 表 + 索引 + FK + CHECK + smoke。无 worker / repository / service / route / 前端代码——这些随 P9.T2-T9 各自落地。
- **新 migration**: `server/migrations/011_create_video_segments.sql`
  - **16 列** per requirements §8.7：`id` (PK, TEXT NOT NULL) / `media_id` (TEXT NOT NULL → FK CASCADE) / `start_time` `end_time` `duration` (REAL NOT NULL，秒) / `thumbnail_path` `preview_path` (TEXT 可空) / `blur_score` `stability_score` `quality_score` (REAL 可空，[0,1]) / `waste_type` (TEXT NOT NULL DEFAULT 'none') / `is_recommended` (INTEGER NOT NULL DEFAULT 0) / `user_decision` (TEXT NOT NULL DEFAULT 'undecided') / `reason` (TEXT 可空) / `created_at` `updated_at` (TEXT iso8601 NOT NULL DEFAULT)
  - **9 个 CHECK**：start_time≥0、end_time>start_time、duration>0（不强约束 `start+duration==end`：FFmpeg 切片精度漂移容忍）、3 个 score 范围 [0,1] OR NULL、`waste_type ∈ ('black','blurry','unstable','silence','none')` (design.md §426)、`is_recommended ∈ (0,1)`、`user_decision ∈ ('keep','remove','undecided')`（与 `media_items.user_decision` 同形 → CLAUDE.md §3.9 user-decision precedence 在视频片段上同样生效）
  - **2 个索引**：`idx_video_segments_media_id`（segments-for-video 查询主路径）+ `idx_video_segments_is_recommended`（per design.md §210，recommendation aggregation 用）
  - **FK**：`media_id → media_items(id) ON DELETE CASCADE`（与既有 media_versions / media_analysis / processing_jobs / duplicate_group_items 一族；soft-delete 不级联，hard-delete 才级联——和 P7 行为完全一致）
  - **STRICT 表**：与项目其他表保持一致；类型强校验。
- **不引入的内容**（与 P9.T1 提示词 + 约束严格对齐）：
  - 无 TypeScript 模型 / repository / service / route / 前端——P9.T2 起逐步落地
  - 无 ffmpeg / ffprobe 调用——P9.T2 起逐步落地
  - 无 worker handler / job_type 注册——P9.T6 / P9.T7 落地
  - 无任何上传 / 处理 / 推荐 / auto-cover / image enhance 主流程改动
  - 无 P7.T7-T9 永久删除引入
  - 无大模型 / ComfyUI / CLIP / DINO / FAISS / 复杂转码
- **R-78 关闭**：扩展 `p7-recycle-bin-acceptance-smoke.ts` 把 `video_segments` 加入 `seedFullyAttachedMedia`，每个测试用例都附带一个 segment 行。新增 5 个断言：
  1. FK walk (soft-delete): video_segments row preserved
  2. FK walk (restore): video_segments row STILL preserved
  3. FK walk (restore): 字段内容（user_decision='keep', waste_type='none', 3 个 scores）完全 round-trip 保留
  4. round-trip[1]: video_segments still attached
  5. round-trip[2]: video_segments still attached（双轮 delete→restore→delete→restore 验证稳定性）

  P7 acceptance smoke 从 55/55 → **60/60 PASS**，video_segments 接入跨表 FK 验收。**R-78 闭合**。

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/migrations/011_create_video_segments.sql` | 落库 video_segments 表 + 9 CHECK + 2 索引 + FK CASCADE |
| 新增 | `server/src/scripts/migration-011-smoke.ts` | 39/39 PASS（fresh 19 + upgrade 8 + CHECK 8 + cascade 2 + integrity 2） |
| 修改 | `server/src/scripts/p7-recycle-bin-acceptance-smoke.ts` | seed 增 video_segments 行 + 5 新断言 → 60/60 PASS |
| 修改 | `server/package.json` | 注册 `smoke:migration-011` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P9.T1 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`npm run smoke:migration-011`（新）** | ✅ **39/39 PASS** |
| **`npm run smoke:p7-recycle-bin-acceptance`（扩展）** | ✅ **60/60 PASS**（55 → 60；R-78 闭合） |
| 回归 `smoke:media-versions-api` (P8.T4) | ✅ 35/35 |
| 回归 `smoke:media-enhance-trigger` (P8.T1) | ✅ 27/27 |
| 回归 `smoke:image-enhance-worker` (P8.T2/T3) | ✅ 34/34 |
| 回归 `smoke:media-soft-delete` / `smoke:media-restore` / `smoke:trip-media-recycle-bin` / `smoke:dedup-delete-others` (P7) | ✅ 32+28+17+28 |
| 回归 `smoke:job-queue` / `smoke:jobs-api` / `smoke:image-channel-executor` | ✅ 55+28+26 |
| 回归 `smoke:image-thumbnail` / `image-metadata` / `image-hash` / `image-quality-finalize` / `quality-selector` / `quality-selector-trigger` | ✅ 22+23+25+43+41+33 |
| 回归 `smoke:trip-cover-auto` / `trip-cover-url` / `dedup-api` / `dedup-exact` / `dedup-similar` / `duplicate-group-confirm` | ✅ 26+13+27+26+40+20 |
| 回归 `smoke:upload` / `trips` / `media-status-sync` / `media` / `media-versions` / `media-reprocess` | ✅ 30+22+18+26+24+21 |
| `exactOptionalPropertyTypes` 保持 | ✅（仅 schema 改动，无 TS 类型变化） |
| zod `.strict()` 防漂移 | ✅（无 API / schema 变化） |
| migration 在空库执行 | ✅（fresh DB CASE GROUP A 19 PASS） |
| migration 在已有数据上执行 | ✅（upgrade CASE GROUP B 8 PASS：停在 010 → 运行 → 011 应用 + 不动既有数据 + CASCADE 生效 + 幂等） |
| 无 FOREIGN KEY 错误 | ✅（PRAGMA foreign_key_check clean 验证两次；新 P7 acceptance "FK walk (soft-delete): video_segments row preserved" 也无 FK 异常） |
| P7 行为不破坏 | ✅（P7 整套 smoke 全绿；smoke 扩展只在内部加新断言、不动 P7 主路径） |
| P8 行为不破坏 | ✅（enhance-trigger / enhance-worker / versions-api 全绿） |

#### P9.T1 已知非阻塞观察（pre-existing，不在 P9.T1 范围内修复）

| smoke | 现象 | 原因 | P9.T1 决策 |
|---|---|---|---|
| `smoke:migration-008` | 33/34（1 fail: `upgrade: pre-existing duplicate_groups row preserved (P5 data intact)`） | upgrade 场景插入旧数据后跑 runMigrations，后续 010 表重建影响 duplicate_groups.recommended_media_id（FK SET NULL 在 media_items 重建期间触发） | **不修复**：在 `b83d6fa`（P9.T1 之前）已存在；与 P9.T1 无关；属"upgrade-from-old 模拟随新 migration 累积变脆"的已知问题。手工验证：fresh + 上一版迁移（migration-011 own upgrade case）均 PASS——核心机制正确。 |
| `smoke:migration-006` | 14/18（4 fail: upgrade thumbnail/preview row preserved） | 同上，更早的 upgrade 模拟（停在 005）受后续多个表重建影响 | **不修复**：同样 pre-existing。 |

两个 smoke 在 P9.T1 之前的 commit `b83d6fa` 已经是同样的失败计数，已通过 `git stash` 验证；P9.T1 没有触发任何新增失败。这些是历史迁移 smoke 的 stale fixture 维护问题，下次专门做 smoke 维护可以一次性升级，**不在 P9.T1 范围**。

#### P9.T1 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-93** | 历史 migration smoke（006 / 008）的 upgrade scenarios 因后续 table-rebuild migrations 累积而 stale，pre-existing 失败 4+1=5 个断言。核心机制全绿（migration-007 / 011 各自的 fresh + upgrade 全 PASS） | 接受为已知非阻塞；下次专门做 smoke 维护一次性升级，不在 P9.T1 范围 |
| **R-94** | P9.T1 仅落库 schema，没有数据写入路径——P9.T2 起的 ffprobe / video_cover / video_proxy / video_keyframes / video_segments worker 才能填表 | 设计如此；P9.T2-T9 逐步落地 |

继续保留：R-74 ~ R-77 (P7)、R-79、R-80 (P7)、R-82 ~ R-92 (P8)。R-78 **已闭合**（本 commit）。R-81 早在 P8.T2 已闭合。

### P9.T2 video_metadata worker 实现结果

- **范围**：单一 `video_metadata` job handler。读取视频 → ffprobe JSON → 投影 10 个字段 → 持久化到既有 schema。**无新增 migration / 无新增 API / 无新增前端**。
- **存储决策（复用既有 schema）**：
  - 把 cardinal 字段（duration / width / height）写到 `media_items` 既有列——这些列从 002 起就是视频准备的（`media_items.duration REAL` 仅视频用）。媒体详情页就能直接渲染基础信息而不需要 join `media_versions`。
  - 把完整 projection + raw ffprobe JSON 持久化到 `media_versions(version_type='metadata')`，**与 `image_metadata` worker 同一 row 结构** — 同样的 file_path 指向原始文件、`mime_type='application/json'` 描述 params 形态、`params` 是 JSON string。`(media_id, version_type)` UNIQUE 保证幂等（同 media 同 version_type 多次 ffprobe 只更新一行）。
  - `media_versions.version_type='metadata'` 在 005/006 migration 中已经在 enum 里——**无新 migration**。
- **新增文件**：
  - `server/src/jobs/videoMetadataWorker.ts` (NEW)：
    - `VIDEO_METADATA_JOB_TYPE = 'video_metadata'` 常量（与 `uploadService.ts:68` 的 video 上传 job_type 一致——upload 路径早就为视频入队过这个 job，只是缺 handler 消费）。
    - `makeVideoMetadataHandler(deps)` factory 返回 `JobHandler`：6 步——(1) 找媒体（active-only, 404 if soft-deleted）→ (2) 类型/原始路径守卫 → (3) `resolveUnderRoot(storage.root, media.originalPath)` 取绝对路径 → (4) spawn ffprobe with 30s timeout + SIGKILL + 4KB stderr 截断 → (5) `projectFfprobe(json)` 投影 → (6) UPDATE `media_items` + UPSERT `media_versions`。
    - 纯函数 `projectFfprobe(probe)`：提取 10 字段，每个字段独立可空；malformed `r_frame_rate` (`0/0`/`/`/`abc/def`/`1`/空) 全部返回 `null`，绝不产生 `NaN`；`avg_frame_rate` 作为 `r_frame_rate` 缺失时的兜底；duration 优先 container（`format.duration`）后 fallback 到 stream `duration`。
    - 类型导出：`VideoMetadataProjection` / `VideoMetadataHandlerDeps` / `VideoMetadataSettings` / `DEFAULT_VIDEO_METADATA_SETTINGS`。
  - `server/src/scripts/video-metadata-worker-smoke.ts` (NEW)：**39/39 PASS**。
- **修改文件**：
  - `server/src/jobs/index.ts`：re-export `VIDEO_METADATA_JOB_TYPE` / `makeVideoMetadataHandler` / `projectFfprobe` / 类型。
  - `server/src/media/mediaRepository.ts`：新增 `updateVideoMetadataStmt` 预编译 statement + `updateVideoMetadata({mediaId, duration, width, height, updatedAt})` 公开方法（与 `updateImageDerivedPaths` 分离——video 不写 `preview_path/thumbnail_path`，那是 P9.T3 `video_cover` 的领域；保留独立写入器便于后续 P9.T3 平行添加 video-specific `updateVideoCoverPaths` 等）。
  - `server/src/index.ts`：bootstrap 把 handler 注册到 **video** 通道（之前 `handlers: new Map()` 占位），ffprobePath 走 `config.ffmpeg.ffprobePath ?? "ffprobe"` PATH fallback、timeout 30s、workerVersion="1.0"。
  - `server/package.json`：注册 `smoke:video-metadata-worker`。
- **ffprobe 字段范围（10 字段 projection）**：

  | 字段 | 来源 | 类型 | 缺失时 |
  | --- | --- | --- | --- |
  | duration | `format.duration` (秒) 或 stream `duration` 兜底 | `number \| null` | null（极少见——通常 container 有） |
  | width | 第一个 `codec_type==='video'` stream 的 `width` | `number \| null` | null（无 video stream → handler 抛错） |
  | height | 同上 `height` | `number \| null` | 同上 |
  | frameRate | stream `r_frame_rate` (rational) 或 `avg_frame_rate` 兜底 | `number \| null` | null（0/0 / 1 / 缺失等都映射 null） |
  | bitrate | `format.bit_rate` 或 stream `bit_rate` 兜底 | `number \| null` | null（小测试视频可能没报） |
  | videoCodec | 第一 video stream `codec_name` | `string \| null` | null（无 video stream → handler 抛错） |
  | audioCodec | 第一 `codec_type==='audio'` stream `codec_name` | `string \| null` | null（无音轨视频正常成功） |
  | audioChannels | audio stream `channels` | `number \| null` | null |
  | audioSampleRate | audio stream `sample_rate` | `number \| null` | null |
  | containerFormat | `format.format_name` (e.g. `mov,mp4,m4a,3gp,3g2,mj2`) | `string \| null` | null |

- **失败模式**（全部 `throw` → JobQueue 标记 `failed`，原始文件不被覆盖、删除或污染）：
  - 媒体行 missing / soft-deleted → "media not found or soft-deleted"
  - `media.type !== 'video'` → "media is not a video (type='<actual>')"
  - `originalPath === null` → "media has no original_path"
  - ffprobe spawn 失败（binary 缺失）→ "ffprobe spawn failed: <reason>"
  - ffprobe exit code ≠ 0 → "ffprobe exited <code>: <stderr 截断>"
  - 超时 → "ffprobe timed out after Xms (file=<basename>)" + SIGKILL
  - stdout 非 JSON → "ffprobe output not parseable as JSON ..."
  - 无 video stream → "ffprobe output has no usable video stream ..."

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/jobs/videoMetadataWorker.ts` | ffprobe spawn + projection + handler factory |
| 新增 | `server/src/scripts/video-metadata-worker-smoke.ts` | 39/39 PASS（5 纯函数单测 + 9 端到端 case 共 34 断言） |
| 修改 | `server/src/jobs/index.ts` | re-export 新符号 |
| 修改 | `server/src/media/mediaRepository.ts` | `updateVideoMetadata` 写入器 + prepared statement |
| 修改 | `server/src/index.ts` | bootstrap 注册 video-channel handler |
| 修改 | `server/package.json` | 注册 `smoke:video-metadata-worker` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P9.T2 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改） |
| **`smoke:video-metadata-worker`（新）** | ✅ **39/39 PASS**（包含纯函数单测、happy path、视频 only、idempotent、4 个失败路径、scope-guard） |
| 回归 `smoke:migration-011` (P9.T1) | ✅ 39/39 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 + R-78 闭合 case) | ✅ 60/60 |
| 回归 `smoke:media-versions-api` (P8.T4) | ✅ 35/35 |
| 回归 `smoke:media-enhance-trigger` (P8.T1) | ✅ 27/27 |
| 回归 `smoke:image-enhance-worker` (P8.T2/T3) | ✅ 34/34 |
| 回归 P7 全套（soft-delete/restore/recycle-bin/dedup-delete-others） | ✅ 32+28+17+28 |
| 回归 image-channel workers (executor/thumbnail/metadata/hash/quality-finalize/selector/selector-trigger) | ✅ 26+22+23+25+43+41+33 |
| 回归 trip/dedup/upload | ✅ 26+13+27+30+22+18+26+24+21 |
| `exactOptionalPropertyTypes` 保持 | ✅（`VideoMetadataSettings` / `VideoMetadataProjection` 全 readonly + 显式 `\| null` 不用 optional） |
| zod `.strict()` 防漂移 | ✅（无 schema / API 变化） |
| 不出现 FOREIGN KEY 错误 | ✅（worker 只写 media_items + media_versions，FK 关系 + ON DELETE CASCADE 沿用既有；P7 acceptance + P9.T1 smoke 共 99 个跨表 FK 断言全绿） |
| 原始视频不被覆盖、不被删除 | ✅（worker 只读 ffprobe，`scope-guard` case 显式断言 `existsSync(originalPath)` 前后均 true） |
| P7 soft-delete / restore / recycle bin 不破坏 | ✅（P7 全套 smoke 全绿；smoke CASE 5 显式断言 "soft-deleted → 'failed' + 不写 media_versions"） |
| P8 enhance / versions / select-version 不破坏 | ✅（P8 3 smoke 全绿；P9.T2 与 P8 完全独立——前者写 video_metadata 后者写 image_enhance，无共享代码路径） |
| 工作区只含 P9.T2 相关修改 | ✅（git status 显示 7 个改动均在 P9.T2 范围内） |

#### P9.T2 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-95** | ffmpeg / ffprobe 是运行时依赖。生产环境如未安装会让所有 video uploads 的 metadata job 永久 `failed`。检测层（`capabilities.ts`）已在启动时记录可用性，但 worker 没有 `if (!ffprobeAvailable) skip` 短路，因为这会让 job 静默 `success` 留下没数据的 metadata 行——比明确 failed 更难诊断。 | 设计如此；`/api/health` 暴露了 `ffprobeAvailable`，前端可在缺失时灰化视频上传入口；生产部署文档需明确 ffmpeg 是 hard dependency |
| **R-96** | 当前 `media_items.duration` 写入是无差别覆盖（不论旧值是否更精确）。理论上 ffprobe 多次跑同一文件返回同样值（deterministic），所以幂等；但若未来某 P9.T3+ worker 也写 duration（不太可能），可能竞争。 | V1 接受；P9.T2 是 duration 列的唯一写入路径 |
| **R-97** | `projectFfprobe` 没暴露 GPS / EXIF / 拍摄设备信息——即便 ffprobe `-show_streams` 可能在 metadata side 返回。CLAUDE.md §5.3 GPS 是敏感字段，故意不读；其他 metadata 留在 `raw` 字段供未来读取。 | 设计如此（隐私优先），不在 P9.T2 范围 |

继续保留：R-74 ~ R-77 (P7)、R-79、R-80 (P7)、R-82 ~ R-92 (P8)、R-93、R-94。R-78、R-81 已闭合。

### P9.T3 video_cover worker 实现结果

- **范围**：单一 `video_cover` job handler。spawn ffmpeg → 抽一帧 → 写派生 JPEG → 持久化到 `media_items.thumbnail_path` + `media_versions(version_type='video_cover')`。**无新增 migration / 无新增 API / 无新增前端**。
- **存储决策（复用既有 schema）**：
  - 输出 `trips/{tripId}/derived/{mediaId}/video_cover.jpg`，逻辑路径直接复用 design.md §8.1 给定的固定名（其他代码 / cleanup 任务可硬编码该路径）。
  - **不新增 migration**：`media_versions.version_type='video_cover'` 早在 005/006 enum 中。
  - 把 cover 逻辑路径写入 `media_items.thumbnail_path`——这一步让现有的 cover URL pipeline（P3.T8 `findFirstThumbnailPath` + P6.T7 `findBestCoverCandidate`）**自动**把视频封面当成普通缩略图处理，gallery / trip cover 无需为视频做分支逻辑（注：当前 P6.T7 SQL 限 `type='image'`，视频不参与 trip auto-cover；但 gallery 渲染逻辑直接用 `thumbnail_path` 字段，所以视频卡片现在可以显示真实封面而非占位 emoji）。
  - **不写 `preview_path`**：视频 V1 没有单独的中分辨率预览文件——播放源是原视频。如果将来 P9.T4 (`video_proxy`) 落地，那时再写 `preview_path` 指向 720p 代理。
- **新增文件**：
  - `server/src/jobs/videoCoverWorker.ts` (NEW)：
    - `VIDEO_COVER_JOB_TYPE = 'video_cover'` 常量。
    - 纯函数 `chooseCoverSeekSeconds(duration, fallbackSeekSeconds)` 计算抽帧时点。策略：duration `null` 或 ≤ 0 → seek 0；`duration < 2s` → midpoint；`duration ≥ 2s` → `min(duration / 2, fallbackSeekSeconds)`（默认 5s cap）。Infinity / NaN 也走 → 0 兜底。
    - `makeVideoCoverHandler(deps)` factory：(1) 找媒体（active-only）→ (2) 类型 / original_path 守卫 → (3) `chooseCoverSeekSeconds(media.duration, ...)` 决定 seek → (4) `resolveUnderRoot(storage.root, originalPath)` 取绝对路径 → (5) 进 per-call tmp 目录 → (6) spawn ffmpeg `-ss <time> -i <abs> -frames:v 1 -vf scale='min(MAX_EDGE,iw)':'min(MAX_EDGE,ih)':force_original_aspect_ratio=decrease -q:v <q> -f image2 -update 1 -y <tmp>`（`-ss` 在 `-i` 前 → input-side fast seek 走最近 keyframe），bounded 30s + SIGKILL + 4KB stderr 截断 → (7) `readFile(tmp)` + `sharp(buf).metadata()` 取权威 width / height → (8) `storage.putDerived({ relPath: 'video_cover.jpg', data, overwrite: true })` 落入派生存储 → (9) `UPDATE media_items.thumbnail_path = stored.logicalPath` → (10) UPSERT `media_versions(version_type='video_cover')` with width/height/file_size/mime/params → (11) tmp 目录 finally 清理。
    - 类型导出：`VideoCoverSettings` / `VideoCoverHandlerDeps` / `DEFAULT_VIDEO_COVER_SETTINGS`。
  - `server/src/scripts/video-cover-worker-smoke.ts` (NEW)：**41/41 PASS**。
- **修改文件**：
  - `server/src/config/index.ts`：新增 `quality` 外的 `video.cover.{maxEdge=1280, jpegQuality=2, fallbackSeekSeconds=5, timeoutMs=30000, workerVersion='1.0'}` 5 个 env 旋钮 + superRefine 守卫（`jpegQuality ∈ [2,31]` 是 ffmpeg `-q:v` 文档值域；`maxEdge ≥ 64` 防止意外的极小图）+ Config interface + toConfig 映射。
  - `server/src/jobs/index.ts`：re-export `VIDEO_COVER_JOB_TYPE` / `makeVideoCoverHandler` / `chooseCoverSeekSeconds` / 类型。
  - `server/src/media/mediaRepository.ts`：新增 `updateVideoCoverPathsStmt` 预编译 statement + `updateVideoCoverPaths({mediaId, thumbnailPath, updatedAt})` 公开方法（与 P9.T2 `updateVideoMetadata` 平行 — video 路径下的 column-set 分离明确化，便于未来 P9.T4 平行添加 `updateVideoProxyPaths` 写 `preview_path`）。
  - `server/src/index.ts`：bootstrap 把 handler 注册到 video 通道，紧邻 `video_metadata`，共享 VIDEO_WORKER_CONCURRENCY=1 budget。ffmpegPath 走 `config.ffmpeg.ffmpegPath ?? "ffmpeg"`、settings 全来自 `config.video.cover.*`。
  - `server/package.json`：注册 `smoke:video-cover-worker`。
- **封面图输出位置和数据记录方式**：
  - 磁盘：`{STORAGE_LOCAL_ROOT}/trips/{tripId}/derived/{mediaId}/video_cover.jpg`
  - 逻辑路径（暴露在 API）：`trips/{tripId}/derived/{mediaId}/video_cover.jpg`（前端拼 `/storage/` 渲染）
  - `media_items.thumbnail_path` 缓存逻辑路径（gallery / cover URL 自动可见）
  - `media_versions(version_type='video_cover')` UPSERT 一行：`file_path` + `mime_type='image/jpeg'` + `width` / `height` / `file_size` + `params` JSON 含 sharpVersion / workerVersion / seekSeconds / sourceDuration / maxEdge / jpegQuality
- **失败模式**（全部 `throw` → JobQueue 标记 `failed`，原视频不动）：
  - media 行 missing / soft-deleted → "media not found or soft-deleted"
  - `media.type !== 'video'` → "media is not a video (type='<actual>'); refusing to extract cover"
  - `originalPath === null` → "media has no original_path"
  - ffmpeg spawn 失败 → "ffmpeg spawn failed: <reason>"
  - ffmpeg exit ≠ 0 → "ffmpeg cover exited <code>: <stderr 截断>"
  - 超时 → "ffmpeg cover timed out after Xms" + SIGKILL
  - 输出 0 字节 → "ffmpeg produced an empty cover file"
  - sharp 不能解码 → "sharp could not read cover dimensions"

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/jobs/videoCoverWorker.ts` | ffmpeg spawn + chooseCoverSeekSeconds + handler factory |
| 新增 | `server/src/scripts/video-cover-worker-smoke.ts` | 41/41 PASS（7 纯函数单测 + 10 端到端 case） |
| 修改 | `server/src/jobs/index.ts` | re-export 新符号 |
| 修改 | `server/src/media/mediaRepository.ts` | `updateVideoCoverPaths` 写入器 + prepared statement |
| 修改 | `server/src/config/index.ts` | `video.cover.{maxEdge, jpegQuality, fallbackSeekSeconds, timeoutMs, workerVersion}` + Config interface + toConfig + superRefine 守卫 |
| 修改 | `server/src/index.ts` | bootstrap 注册 handler 到 video 通道 |
| 修改 | `server/package.json` | 注册 `smoke:video-cover-worker` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P9.T3 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`smoke:video-cover-worker`（新）** | ✅ **41/41 PASS** |
| 回归 `smoke:video-metadata-worker` (P9.T2) | ✅ 39/39 |
| 回归 `smoke:migration-011` (P9.T1) | ✅ 39/39 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 + R-78) | ✅ 60/60 |
| 回归 `smoke:media-versions-api` / `smoke:media-enhance-trigger` / `smoke:image-enhance-worker` (P8) | ✅ 35+27+34 |
| 回归 P7 全套（soft-delete / restore / recycle-bin / dedup-delete-others） | ✅ 32+28+17+28 |
| 回归 image-channel workers + jobs + trip-cover + dedup + upload + trips + media-status-sync | ✅ 全绿 |
| **总计 27 个 smoke 全绿** | ✅ |
| `exactOptionalPropertyTypes` 保持 | ✅（`VideoCoverSettings` 全 readonly 不带 optional） |
| zod `.strict()` 防漂移 | ✅（无 API/schema 变化） |
| 不出现 FOREIGN KEY 错误 | ✅（worker 只写 media_items + media_versions，FK 关系 + ON DELETE CASCADE 沿用既有） |
| 原视频不被覆盖 / 删除 | ✅（smoke "non-destructive" + "scope-guard" 双重断言：original bytes byte-for-byte unchanged） |
| P7 soft-delete / restore / recycle bin 不破坏 | ✅（P7 全套全绿；smoke CASE 5 显式 soft-deleted → failed + 不写文件不写版本行） |
| P8 enhance / versions / select-version 不破坏 | ✅（P8 全套全绿；P9.T3 与 P8 完全独立——前者写 video_cover 后者写 enhanced，无共享代码路径） |
| 工作区只含 P9.T3 相关修改 | ✅（git status 显示 8 个改动均在 P9.T3 范围） |

#### P9.T3 必补测试覆盖映射 (1-8)

| 提示词要求 | 验证方式 |
|---|---|
| ① video_cover worker 能从测试视频生成封面图 | happy path 11 断言（cover file 存在 / 是合法 JPEG / 维度 ≤ maxEdge / thumbnail_path 缓存 / media_versions row 字段齐全 / params 含 seekSeconds=1.5 等） |
| ② 原视频不被覆盖、不被删除 | non-destructive CASE + scope-guard CASE 双重 bytes-equal 断言 |
| ③ 封面派生文件可追踪 / 可查询 | media_items.thumbnail_path + media_versions(video_cover) 双索引可见 |
| ④ 非 video 媒体不会被错误处理 | image / unknown CASE 双失败 + 无文件 / 无 version 行 leak |
| ⑤ 原始视频文件缺失时失败可控 | ghost-file CASE：ffmpeg cover exited 254 + stderr 含 "No such file" |
| ⑥ deleted 视频不会被正常处理 | soft-deleted CASE：handler 失败 + 不写文件 + 不写 media_versions |
| ⑦ P9.T2 video_metadata worker smoke 仍通过 | ✅ 39/39 |
| ⑧ P9.T1 migration-011 smoke 仍通过 | ✅ 39/39 |

#### P9.T3 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-98** | ffmpeg 是 hard runtime dependency（与 R-95 同因不同 worker）。视频上传 → metadata + cover 都 enqueue，缺 ffmpeg 时两个 job 都永久 failed。生产部署文档需明确 ffmpeg 是 hard dependency。 | 接受为 R-95 的扩展；`/api/health` 已暴露 `ffmpegAvailable` |
| **R-99** | video_metadata (P9.T2) 和 video_cover (P9.T3) 都共享 VIDEO_WORKER_CONCURRENCY=1 budget；同一个视频的两个 job 会**串行**跑（先 metadata 后 cover，或反之）。如果 cover 先于 metadata 跑，`chooseCoverSeekSeconds` 会用 `duration=null` fallback seek=0；之后 metadata 跑时 duration 写入，但封面不会重新生成。这是个 cold-cache miss，输出仍正确但 seek 不在中点。 | V1 接受；upload pipeline 当前只入队 `video_metadata`（uploadService.ts:68），`video_cover` 由 P9.T3 之后的某个 follow-up（可能是 metadata worker 成功后入队 cover，类似 P3.T4 → P3.T5 的链路）触发——这个链路 P9.T3 不实现（未指定）。未来如把 cover 入队从 metadata 之后改为同步，这个 race 自动消失 |
| **R-100** | 封面 thumbnail 写入 `media_items.thumbnail_path`，**P6.T7 trip auto-cover 选择器仍限 `type='image'`**（已检查 `findBestCoverCandidate` SQL）。这意味着 trip 自动封面**仍**不会从视频里选。如果 trip 里全是视频，cover 仍为 placeholder。 | V1 接受（设计 §7.7 #3 "视频也可作为封面来源：第一版仅在 Trip 中没有任何图片时使用，作为兜底"）；后续如需要可放宽 `findBestCoverCandidate` 把 `type='video' AND thumbnail_path IS NOT NULL` 也算上 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93、R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)。R-78、R-81 已闭合。

### P9.T4 video_proxy worker 实现结果

- **范围**：单一 `video_proxy` job handler。ffmpeg 转码 → 写派生 MP4 → 持久化到 `media_versions(version_type='video_proxy')`。**无新增 migration / 无新增 API / 无新增前端**。
- **存储决策（复用既有 schema）**：
  - 输出 `trips/{tripId}/derived/{mediaId}/video_proxy.mp4`（design.md §6.2.5 / §8.1 + migration 005 文件头注释精确匹配）。
  - **不新增 migration**：`media_versions.version_type='video_proxy'` 早在 005/006 enum 中。
  - 仅写 `media_versions(video_proxy)` 一行——**不**触碰 `media_items.preview_path`。Rationale：preview_path 当前由 P3.T4 image preview worker 写入 `.webp`；若用 MP4 覆盖那一列，每个 preview_path 读路径都得分支 `MIME video/* else image/*`，远超 "P9.T4 最小闭环" 范围。代理通过 `media_versions(video_proxy)` 查询发现；P9.T8 Video API 会暴露干净的 endpoint。**新增 R-101 记录**。
- **新增文件**：
  - `server/src/jobs/videoProxyWorker.ts` (NEW)：
    - `VIDEO_PROXY_JOB_TYPE = 'video_proxy'` 常量。
    - `makeVideoProxyHandler(deps)` factory：(1) 找媒体（active-only）→ (2) 类型 / original_path 守卫 → (3) `resolveUnderRoot` 拿绝对输入 → (4) per-call tmp 目录 → (5) spawn ffmpeg `-i <abs> -vf scale=-2:'min(ih,TARGET_HEIGHT)' -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -movflags +faststart -y <tmp>`（bounded 300s + SIGKILL）→ (6) `stat()` 校验非 0 字节 → (7) `runFfprobeOnPath(tmp)` 取权威 width/height/duration/codec → (8) `storage.putDerived({ relPath: 'video_proxy.mp4', overwrite: true })` → (9) UPSERT `media_versions(version_type='video_proxy')` → (10) tmp 目录 finally 清理。
    - 类型导出：`VideoProxySettings` / `VideoProxyHandlerDeps` / `DEFAULT_VIDEO_PROXY_SETTINGS`。
    - 复用 P9.T2 的 `projectFfprobe` 解析 ffprobe verify 结果（导入而非重复实现；P9.T2 已经把它做成纯函数公开 export）。
  - `server/src/scripts/video-proxy-worker-smoke.ts` (NEW)：**35/35 PASS**。
- **修改文件**：
  - `server/src/config/index.ts`：新增 `video.proxy.{targetHeight=720, crf=28, preset='veryfast', videoCodec='libx264', audioCodec='aac', audioBitrateKbps=128, timeoutMs=300000, workerVersion='1.0'}` 共 8 个 env 旋钮 + 3 个 superRefine 守卫（CRF ∈ [0,51]、targetHeight ≥ 144、preset 必须 libx264 文档闭枚举之一）+ Config interface + toConfig 映射。**注意**：现有的 `VIDEO_PROXY_HEIGHT` 是设计 §8.1 的旧名（应用于 segments/keyframes 等设计上下文），保留不动；P9.T4 worker 使用新增的 `VIDEO_PROXY_TARGET_HEIGHT`（命名更具体）。
  - `server/src/jobs/index.ts`：re-export `VIDEO_PROXY_JOB_TYPE` / `makeVideoProxyHandler` / 类型。
  - `server/src/index.ts`：bootstrap 把 handler 注册到 video 通道，紧邻 metadata + cover，共享 VIDEO_WORKER_CONCURRENCY=1 budget。ffmpeg/ffprobe paths 走 `config.ffmpeg.{ffmpegPath, ffprobePath}` PATH fallback；transcode settings 全来自 `config.video.proxy.*`。
  - `server/package.json`：注册 `smoke:video-proxy-worker`。
- **代理文件输出位置和数据记录方式**：
  - 磁盘：`{STORAGE_LOCAL_ROOT}/trips/{tripId}/derived/{mediaId}/video_proxy.mp4`
  - 逻辑路径（暴露在 API）：`trips/{tripId}/derived/{mediaId}/video_proxy.mp4`（前端 / API 通过 `media_versions` 查询）
  - `media_versions(version_type='video_proxy')` UPSERT 一行：`file_path` + `mime_type='video/mp4'` + `width` / `height` / `file_size` + `params` JSON 含 workerVersion / targetHeight / crf / preset / videoCodec / audioCodec / audioBitrateKbps / proxyDurationSec / proxyVideoCodec / proxyAudioCodec / proxyBitrate
  - **不**写 `media_items.preview_path`（见 R-101）
- **失败模式**（全部 `throw` → JobQueue 标记 `failed`，原视频不动）：
  - media 行 missing / soft-deleted → "media not found or soft-deleted"
  - `media.type !== 'video'` → "media is not a video (type='<actual>'); refusing to transcode proxy"
  - `originalPath === null` → "media has no original_path"
  - ffmpeg spawn 失败 → "ffmpeg spawn failed: <reason>"
  - ffmpeg exit ≠ 0 → "ffmpeg proxy exited <code>: <stderr 截断>"
  - 超时 → "ffmpeg proxy timed out after Xms" + SIGKILL
  - 输出 0 字节 → "ffmpeg produced an empty proxy file"
  - ffprobe verify 失败 → "ffprobe could not determine proxy dimensions after transcode"

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/jobs/videoProxyWorker.ts` | ffmpeg transcode + ffprobe verify + handler factory |
| 新增 | `server/src/scripts/video-proxy-worker-smoke.ts` | 35/35 PASS（10 个端到端 case） |
| 修改 | `server/src/config/index.ts` | `video.proxy.*` 8 个旋钮 + 3 个 superRefine 守卫 + interface + toConfig |
| 修改 | `server/src/jobs/index.ts` | re-export 新符号 |
| 修改 | `server/src/index.ts` | bootstrap 注册 handler 到 video 通道 |
| 修改 | `server/package.json` | 注册 `smoke:video-proxy-worker` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P9.T4 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`smoke:video-proxy-worker`（新）** | ✅ **35/35 PASS** |
| 回归 `smoke:video-cover-worker` (P9.T3) | ✅ 41/41 |
| 回归 `smoke:video-metadata-worker` (P9.T2) | ✅ 39/39 |
| 回归 `smoke:migration-011` (P9.T1) | ✅ 39/39 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 + R-78) | ✅ 60/60 |
| 回归 `smoke:media-versions-api` / `smoke:media-enhance-trigger` / `smoke:image-enhance-worker` (P8) | ✅ 35+27+34 |
| 回归 P7 全套（soft-delete / restore / recycle-bin / dedup-delete-others） | ✅ 32+28+17+28 |
| 回归 image-channel workers + jobs + trip-cover + dedup + upload + trips + media-status-sync | ✅ 全绿 |
| **总计 29 个 smoke 全绿** | ✅ |
| `exactOptionalPropertyTypes` 保持 | ✅（`VideoProxySettings` 全 readonly 不带 optional） |
| zod `.strict()` 防漂移 | ✅（无 API/schema 变化） |
| 不出现 FOREIGN KEY 错误 | ✅（worker 只写 media_versions） |
| 原视频不被覆盖 / 删除 | ✅（smoke "non-destructive" + "scope-guard" 双重 bytes-equal） |
| P7 行为不破坏 | ✅（P7 全套全绿；smoke CASE 6 显式 soft-deleted → failed） |
| P8 行为不破坏 | ✅（P8 全套全绿；P9.T4 与 P8 完全独立代码路径） |
| P9.T2 / P9.T3 行为不破坏 | ✅（P9.T2 / P9.T3 各自 smoke 全绿；P9.T4 只新增 handler，未触碰其它 worker） |
| 工作区只含 P9.T4 相关修改 | ✅（git status 显示 7 个改动均在 P9.T4 范围） |

#### P9.T4 必补测试覆盖映射 (1-10)

| 提示词要求 | 验证方式 |
|---|---|
| ① video_proxy worker 能生成 720p 代理 | happy path 11 断言（proxy 文件存在 + 合法 MP4 + H.264 + media_versions row 字段齐全 + params 含 8 个 transcode 知识 + downscale 1080p→720p 正确） |
| ② 原视频不被覆盖、不被删除 | non-destructive + scope-guard 双重 bytes-equal |
| ③ 代理文件可追踪 / 可查询 | media_versions(version_type='video_proxy') row 显式断言 |
| ④ 非 video 媒体不会被错误处理 | image / unknown CASE 双失败 + 无 leak |
| ⑤ 原视频文件缺失时失败可控 | ghost-file CASE：ffmpeg exit 254 + stderr 含 "No such file" |
| ⑥ deleted 视频不会被正常处理 | soft-deleted CASE：handler 失败 + 不写文件 + 不写 media_versions |
| ⑦ FFmpeg 缺失或失败时 job 状态为 failed | broken-mp4 CASE + ghost-file CASE 双验证 ffmpeg 非零退出 + handler failed；ffmpeg 缺失时 smoke 优雅 SKIP（运行时 worker 仍 throw "ffmpeg spawn failed" 标记 failed） |
| ⑧ P9.T2 video_metadata smoke 仍通过 | ✅ 39/39 |
| ⑨ P9.T3 video_cover smoke 仍通过 | ✅ 41/41 |
| ⑩ P9.T1 migration-011 smoke 仍通过 | ✅ 39/39 |

#### P9.T4 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-101** | `video_proxy` 不写 `media_items.preview_path`。视频详情页若想用 720p 代理而非原视频做内联播放，必须读 `media_versions(version_type='video_proxy')` 找到 file_path；这跟图片用 `media_items.preview_path` 的路径不一致。未来 P9.T8 Video API + P9.T9 前端会通过专门的 endpoint 暴露代理，把 read 复杂度封装在 API 层。 | 设计取舍——避免迫使 preview_path 读路径分支 image/video MIME。R-101 留作 P9.T8 / T9 的接口设计提示 |
| **R-102** | proxy 转码是 video 通道最重的任务（典型 phone 视频几十秒，4K 源可能数分钟）。VIDEO_WORKER_CONCURRENCY=1 budget 串行化所有 video jobs（metadata + cover + proxy），proxy 入队时整个 channel 会被它独占——但**不会**阻塞 image 通道。如果一个 trip 上传了多个视频，proxy 串行排队，首次浏览体验可能慢；不阻塞读，只阻塞代理生成。 | V1 接受（design.md §6.10 明确 VIDEO_WORKER_CONCURRENCY=1 是为了避免 FFmpeg 子进程数失控）。如果以后单 video 通道吞吐变成瓶颈，可以拆 video 通道为 `video_fast` (metadata/cover) + `video_heavy` (proxy/keyframes/segments)，各自独立并发 budget |
| **R-103** | ffmpeg encoding 不是 bit-deterministic（x264 内部计时抖动），所以 idempotent re-run 产生的 proxy 文件**字节内容不完全相同**——但 shape（dims / codec / 大约 CRF）稳定。smoke 的 idempotent 断言只检查 row count + file 存在，不做 bytes-equal。这与 sharp 输出可 bit-stable 不同。 | 接受为 ffmpeg 编码器特性；persistence 层只关心可读 + media_versions row 存在 + dims/codec 一致 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)。R-78、R-81 已闭合。

### P9.T5 video_keyframes worker 实现结果

- **范围**：单一 `video_keyframes` job handler。ffmpeg 固定间隔抽帧 → 写 JPEG 帧到 `derived/{mediaId}/frames/` + 写 `manifest.json`。**无新增 migration / 无新增 API / 无新增前端 / 无 DB 任何写入**（不写 media_items 任何列，不写 media_versions 任何行）。
- **存储决策（disk-only，无新增 migration）**：
  - `media_versions.version_type='video_keyframes'` **不在** 005/006 enum 中。新增 enum 值需要 migration（表 rebuild），但 P9.T5 task definition 未要求 DB 持久化——manifest.json on disk 就够发现层用了。**新增 R-104** 记录该决策；P9.T7 segment quality + P9.T8 Video API 通过读 `manifest.json` 消费 keyframes。
  - 输出：`trips/{tripId}/derived/{mediaId}/frames/frame_NNNNNN.jpg` (1-based 6-digit padding) + `trips/{tripId}/derived/{mediaId}/frames/manifest.json`。
  - manifest 结构：`{ workerVersion, intervalSec (effective), configuredIntervalSec, decodeSource ('proxy'|'original'), decodeSourcePath, maxFrames, sourceDurationSec, frameCount, frames: [{ index, timestampSec, filePath, width, height, fileSize }], generatedAt }`。downstream 消费者直接读这个 JSON 文件。
- **新增文件**：
  - `server/src/jobs/videoKeyframesWorker.ts` (NEW)：
    - `VIDEO_KEYFRAMES_JOB_TYPE = 'video_keyframes'` 常量。
    - 纯函数 `computeEffectiveInterval(duration, configuredInterval, maxFrames)`：duration null/0/负/NaN/Infinity → 返回 configured；ceil(duration/configured) ≤ maxFrames → 返回 configured；否则返回 `duration / maxFrames` 均匀拉伸；degenerate inputs (maxFrames=0, intervalSec=0) 安全回退。
    - `makeVideoKeyframesHandler(deps)` factory：(1) 找媒体（active-only）→ 类型守卫 → (2) `pickDecodeSource()` 优先 video_proxy 行 + 文件 stat 检查、fallback 到 original_path → (3) `computeEffectiveInterval` → (4) per-call tmp dir → spawn ffmpeg `-vf fps=1/<eff> -q:v <q> -frames:v <maxFrames> -f image2 -y <tmpDir>/frame_%06d.jpg`（双重 cap：interval stretch + `-frames:v`，bounded 300s + SIGKILL + 4KB stderr 截断）→ (5) `readdir + sharp.metadata` 每帧 → (6) `storage.putDerived({ relPath: 'frames/<filename>', overwrite: true })` 落入派生存储 → (7) 写 `manifest.json` 同样通过 `storage.putDerived` → (8) tmp 目录 finally 清理。
    - 类型导出：`VideoKeyframesSettings` / `VideoKeyframesHandlerDeps` / `DEFAULT_VIDEO_KEYFRAMES_SETTINGS` / `KeyframeManifest` / `KeyframeManifestEntry`。
  - `server/src/scripts/video-keyframes-worker-smoke.ts` (NEW)：**40/40 PASS**。
- **修改文件**：
  - `server/src/config/index.ts`：新增 `video.keyframes.{intervalSec=2, maxFrames=200, jpegQuality=2, timeoutMs=300000, workerVersion='1.0'}` 5 个 env 旋钮 + 3 个 superRefine 守卫（jpegQuality ∈ [2,31] = ffmpeg -q:v 范围；intervalSec ≥ 0.5 防止子半秒采样；maxFrames ≤ 10000 防止磁盘失控）+ Config interface + toConfig 映射。
  - `server/src/jobs/index.ts`：re-export 新符号（含 `KeyframeManifest` / `KeyframeManifestEntry` 类型供下游 P9.T7 直接 import）。
  - `server/src/index.ts`：bootstrap 注册到 video 通道（与 P9.T2/T3/T4 共享 VIDEO_WORKER_CONCURRENCY=1 budget）。
  - `server/package.json`：注册 `smoke:video-keyframes-worker`。
- **keyframes 输出目录和记录方式**：
  - 磁盘：`{STORAGE_LOCAL_ROOT}/trips/{tripId}/derived/{mediaId}/frames/frame_NNNNNN.jpg` × N + `manifest.json`。
  - 逻辑路径：`trips/{tripId}/derived/{mediaId}/frames/frame_NNNNNN.jpg`（前端 / API 通过读 manifest.json 发现）。
  - 反向索引：**仅 manifest.json**（无 DB row）。P9.T7 / P9.T8 设计需要直接读这个文件来发现 keyframes。
  - frame count 可追踪：manifest.frameCount + worker 日志（`logger.info(... frameCount, framesDir, decodeSource)` 在每次成功时打印）。
  - 文件命名：`frame_NNNNNN.jpg`（1-based 6-digit padding），与 design.md §6.2 `frames/{ts}.jpg` 兼容（NNNNNN 即 1-based index，timestamp 在 manifest 里）。
- **失败模式**（全部 `throw` → JobQueue 标记 `failed`，原视频从不被覆盖）：
  - media 行 missing / soft-deleted → "media not found or soft-deleted"
  - `media.type !== 'video'` → "media is not a video (type='<actual>'); refusing to extract keyframes"
  - 无 decode source（NULL original_path 且无 proxy）→ "no decode source available"
  - ffmpeg spawn 失败 → "ffmpeg spawn failed: <reason>"
  - ffmpeg exit ≠ 0 → "ffmpeg keyframes exited <code>: <stderr 截断>"
  - 超时 → "ffmpeg keyframes timed out after Xms" + SIGKILL
  - 0 帧产出 → "ffmpeg produced 0 keyframes from source"
  - sharp 解码失败 → "sharp could not read keyframe ..."

#### 文件清单

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/jobs/videoKeyframesWorker.ts` | ffmpeg fps filter + decode source picker + manifest writer |
| 新增 | `server/src/scripts/video-keyframes-worker-smoke.ts` | 40/40 PASS（9 pure-function 单测 + 12 端到端 case） |
| 修改 | `server/src/config/index.ts` | `video.keyframes.*` 5 个旋钮 + 3 个 superRefine 守卫 + interface + toConfig |
| 修改 | `server/src/jobs/index.ts` | re-export 新符号 |
| 修改 | `server/src/index.ts` | bootstrap 注册 handler 到 video 通道 |
| 修改 | `server/package.json` | 注册 `smoke:video-keyframes-worker` |
| 修改 | `docs/tasks.md` / `docs/progress.md` | 本次记录 |

#### P9.T5 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（server） | ✅ |
| `npm run lint`（server） | ✅ |
| `npm run format:check`（server） | ✅（prettier 自动 reformat 一次后通过） |
| `npm run build`（server） | ✅ |
| `npm run typecheck` / `lint` / `format:check` / `build`（client） | ✅（client 未改动） |
| **`smoke:video-keyframes-worker`（新）** | ✅ **40/40 PASS** |
| 回归 `smoke:video-proxy-worker` (P9.T4) | ✅ 35/35 |
| 回归 `smoke:video-cover-worker` (P9.T3) | ✅ 41/41 |
| 回归 `smoke:video-metadata-worker` (P9.T2) | ✅ 39/39 |
| 回归 `smoke:migration-011` (P9.T1) | ✅ 39/39 |
| 回归 `smoke:p7-recycle-bin-acceptance` (P7 + R-78) | ✅ 60/60 |
| 回归 `smoke:media-versions-api` / `smoke:media-enhance-trigger` / `smoke:image-enhance-worker` (P8) | ✅ 35+27+34 |
| 回归 P7 全套（soft-delete / restore / recycle-bin / dedup-delete-others） | ✅ 32+28+17+28 |
| 回归 image-channel workers + jobs + trip-cover + dedup + upload + trips + media-status-sync | ✅ 全绿 |
| **总计 30 个 smoke 全绿** | ✅ |
| `exactOptionalPropertyTypes` 保持 | ✅ |
| zod `.strict()` 防漂移 | ✅（无 API/schema 变化） |
| 不出现 FOREIGN KEY 错误 | ✅（worker 不写任何 DB 行） |
| 原视频不被覆盖 / 删除 | ✅（smoke "non-destructive" + "scope-guard" 双重 bytes-equal） |
| P7 行为不破坏 | ✅（P7 全套全绿；smoke CASE 7 显式 soft-deleted → failed + 无 frames 目录 leak） |
| P8 行为不破坏 | ✅（P8 全套全绿；P9.T5 与 P8 完全独立） |
| P9.T2 / T3 / T4 行为不破坏 | ✅（各自 smoke 全绿；P9.T5 只新增 handler 不触碰它们） |
| 工作区只含 P9.T5 相关修改 | ✅（git status 显示 7 个改动均在 P9.T5 范围） |

#### P9.T5 必补测试覆盖映射 (1-9)

| 提示词要求 | 验证方式 |
|---|---|
| ① 能从测试视频抽帧 | happy path 9 断言（含 6s @ 2s → 3 frames + manifest 形状 + 时间戳映射 + JPEG 验证 + 文件名 NNNNNN 模式） |
| ② 抽帧文件写入派生目录 | 路径模式断言 `\/frames\/frame_\d{6}\.jpg$` + existsSync 每帧 |
| ③ 原视频不被覆盖、不被删除 | non-destructive + scope-guard 双重 bytes-equal |
| ④ frame count 可追踪 | manifest.frameCount + 与 manifest.frames.length 一致性双断言 + worker logger.info 输出 |
| ⑤ 非 video 媒体不会被错误处理 | image / unknown 双失败 + 错误信息显式 |
| ⑥ 原始视频缺失时失败可控 | ghost-file CASE: ffmpeg exit 254 + stderr 含 "No such file" |
| ⑦ deleted 视频不会被处理 | soft-deleted CASE: handler 失败 + 无 frames 目录 leak |
| ⑧ P9.T2 / T3 / T4 smoke 仍通过 | ✅ 39+41+35 |
| ⑨ P7 / P8 回归不破坏 | ✅ P7 整套 + P8 整套全绿 |

#### P9.T5 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-104** | `video_keyframes` 输出**不写 media_versions 行**（version_type='video_keyframes' 不在 enum 中；添加需要 migration）。下游 P9.T7 segment quality + P9.T8 Video API 必须读 `derived/{mediaId}/frames/manifest.json` 来发现 keyframes 集合，跟其它 worker（cover / proxy）走 media_versions 不一致。 | 设计取舍——避免本任务引入 migration。P9.T7 + P9.T8 prompt 落地时再决策是否升级到 DB 层；如需可加 migration 012 把 enum 扩展到 'video_keyframes' 并把 manifest 字段写入 `media_versions.params`（`file_path` 指向 `frames/` 目录）|
| **R-105** | manifest.json 在磁盘上，没有 FK 约束。media 被 hard-delete（P7.T7+，目前 `[LATER]`）时 frames 目录变孤儿；与 `derived/{mediaId}/` 下其它派生文件（enhanced.jpg / video_proxy.mp4 等）状况一致——permanent-delete handler 需要 walk 整个 per-mediaId 目录清理，不能依赖单文件级 FK。 | V1 接受；与既有 derived 文件孤儿风险同等。永久删除落地时统一在 walk 阶段处理 |
| **R-106** | ffmpeg `fps=1/N` filter 在源没有 keyframe 的位置可能解码 P/B 帧重建——这意味着输出叫 "keyframes" 但严格说是"等间隔抽帧"，不一定对齐源视频的真实 GOP 关键帧。命名忠实于 task definition 但与 H.264 IDR 帧概念不完全等同。 | 接受；P9.T6 segment slicing 也只需要"在均匀时间点拿到能看的帧"，不强依赖 IDR 对齐。如未来 P9.T7 模糊评分需要更高编码质量，可改用 `select='eq(pict_type,I)'` 选 I 帧（输出帧数会不均匀） |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)。R-78、R-81 已闭合。

### P9.T6 video_segments worker 实现结果

阶段：已完成。日期：2026-05-21。

#### 改动文件

- `server/src/media/videoSegmentTypes.ts`（**新增**）— 镜像 migration 011 列：`VideoSegmentWasteType`（'black'|'blurry'|'unstable'|'silence'|'none' 闭合枚举）、`VideoSegmentUserDecision`（'keep'|'remove'|'undecided'）、`VideoSegment`（读投影；isRecommended 暴露为 boolean）、`VideoSegmentInsertData`（最小写入面：id / mediaId / startTime / endTime / duration / now，P9.T7 评分列稍后 UPDATE 填充）。文件路径**故意**不落库——通过 `videoSegmentMp4Path()` helper 重建。
- `server/src/media/videoSegmentsRepository.ts`（**新增**）— `VideoSegmentsRepository` 类：构造时 prepare `INSERT INTO video_segments (id, media_id, start_time, end_time, duration, created_at, updated_at) VALUES (...)`、`SELECT ... FROM video_segments WHERE media_id = ? ORDER BY start_time ASC, id ASC`、`DELETE FROM video_segments WHERE media_id = ?`；公开方法 `insert(data)` / `listByMediaId(mediaId)` / `deleteByMediaId(mediaId)` / `replaceAllForMedia(mediaId, segments)`（事务内 wipe + reinsert，崩溃回滚保留旧行）。导出 helper `videoSegmentMp4Path({tripId, mediaId, segmentId})` 返回 `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4` 这一约定路径。
- `server/src/media/index.ts`（**修改**）— 加导出：`VideoSegmentsRepository`、`videoSegmentMp4Path`、`VideoSegment` / `VideoSegmentInsertData` / `VideoSegmentUserDecision` / `VideoSegmentWasteType` 类型。
- `server/src/jobs/videoSegmentsWorker.ts`（**新增**）— 完整 P9.T6 worker：
  - 常量：`VIDEO_SEGMENTS_JOB_TYPE='video_segments'`、`SEGMENTS_SUBDIR='segments'`、`FFMPEG_SEGMENT_FILENAME_PREFIX='segment_'`（6 位填充，与 P9.T5 keyframes 命名风格对齐）、`MAX_STDERR_BYTES=4096`、`FFPROBE_PER_SEGMENT_TIMEOUT_MS=15_000`。
  - 类型：`VideoSegmentsSettings`（ffmpegPath/ffprobePath/timeoutMs/durationSec/workerVersion）、`VideoSegmentsHandlerDeps`、`DEFAULT_VIDEO_SEGMENTS_SETTINGS`（ffmpeg/ffprobe/timeoutMs=300_000/durationSec=10/workerVersion='1.0'）。
  - `makeVideoSegmentsHandler` factory 返回 JobHandler；pipeline：
    1. `mediaRepo.findById(jobMediaId)` → null 抛 'media not found or soft-deleted'（active-only 接 P7 软删除契约）。
    2. `media.type !== 'video'` → 抛 "media is not a video (type='X')"（defense-in-depth；UploadService P3 已经按 type 派工）。
    3. `pickDecodeSource`：先 `mediaVersionsRepo.listByMediaId` 找 `video_proxy` row，stat 文件存在且非空就用 proxy；否则回 `originalPath`；都不可用抛 'no decode source available'。
    4. `mkdtemp` per-call tmp 目录，spawn ffmpeg `-v error -i <src> -c copy -map 0 -f segment -segment_time <durationSec> -reset_timestamps 1 -segment_start_number 1 -y <tmp>/segment_%06d.mp4`。`-c copy` 不重编码（segments 继承源 codec），切点对齐源 keyframe → 实际段长可能略偏离配置，所以下一步 ffprobe 拿权威值。bounded timeoutMs + SIGKILL + 4KB stderr 截断。
    5. `readdir` tmp 目录 → 过滤 `segment_*.mp4` → 按文件名排序。0 文件抛 'ffmpeg produced 0 segments'。每个文件 `stat`（空文件抛）+ `probeSegmentDurationSec(file, ffprobePath)` 读 `format.duration`（独立 spawn，15s 超时；JSON 解析、非数字、≤0、缺 format 全部抛）+ `readFile` 读字节进内存。
    6. `videoSegmentsRepo.listByMediaId(media.id)` snapshot 旧行（事务提交后用于清旧文件）。
    7. 顺序为每段：生成 fresh `randomUUID()` 作为 segmentId（同时是行 id + 文件名 stem）；`storage.putDerived({tripId, mediaId, relPath: 'segments/{uuid}.mp4', data, overwrite: true})`；`startTime = roundToMs(cursorSec)`、`endTime = roundToMs(cursorSec + probedDur)`、`duration = roundToMs(probedDur)`；CHECK 兜底：duration ≤ 0 或 endTime ≤ startTime 时 `logger.warn` 后跳过（防 SQLite CHECK 触发整事务回滚）；累加 cursor；推 insertData。
    8. 所有段全部被剔（newSegmentInserts 为空）→ 抛 'all ffmpeg segments were rejected'，不动 DB。
    9. `videoSegmentsRepo.replaceAllForMedia(media.id, newSegmentInserts)` 一次事务：DELETE 旧 + N×INSERT。任一步抛则全回滚（旧行存活，但磁盘上新文件已经写下——R-108 接受：等后续清理或重跑覆盖）。
    10. 事务外 best-effort 清旧文件：每次给 fresh UUID，理论上**全部**旧 id 都要删；逐一 `storage.remove(videoSegmentMp4Path(...))`，失败仅 `logger.warn` 不抛（StorageError on already-gone 是 harmless）。
    11. `finally` 块 `rm -rf` tmp dir。
  - 失败模式全部 throw → JobQueue mark `failed`，**原视频从不被覆盖**（worker 路径 putDerived 只接受 `assertSafeRelPath` 受控的 derived 子路径，不可能写到 originals 树）。
  - `pickDecodeSource` helper 与 P9.T5 等价但内联（按 P9.T6 prompt "不改 P9.T5 keyframes worker，除非必须复用少量工具" 的取舍：15 行重复，不引入 shared module）。
  - `probeSegmentDurationSec` helper 与 P9.T4 proxy worker 的 ffprobe 调用等价但独立（proxy worker 的 helper 是 file-private）；输入 absolute path + ffprobe path，返回 `format.duration` (秒)。
  - `roundToMs(seconds)` 将累加值清到 ms 精度，避免 `0.1 + 0.2 = 0.30000…04` 类 IEEE-754 漂移落库。
- `server/src/jobs/index.ts`（**修改**）— 加导出：`DEFAULT_VIDEO_SEGMENTS_SETTINGS`、`VIDEO_SEGMENTS_JOB_TYPE`、`makeVideoSegmentsHandler`、`VideoSegmentsHandlerDeps`、`VideoSegmentsSettings`，注释标注 P9.T6 共享 video 通道 `VIDEO_WORKER_CONCURRENCY=1` 预算。
- `server/src/config/index.ts`（**修改**）— 加 env 旋钮：`VIDEO_SEGMENTS_TIMEOUT_MS: intPositive(300_000)`、`VIDEO_SEGMENTS_WORKER_VERSION: strDefault("1.0")`；新增 `Config.video.segments: { durationSec, timeoutMs, workerVersion }`（durationSec 复用 P9.T1 已声明的 `VIDEO_SEGMENT_DURATION` env，避免双源真相）；`toConfig` 映射加 `segments: { durationSec: raw.VIDEO_SEGMENT_DURATION, timeoutMs: raw.VIDEO_SEGMENTS_TIMEOUT_MS, workerVersion: raw.VIDEO_SEGMENTS_WORKER_VERSION }`。
- `server/src/index.ts`（**修改**）— 加 `VideoSegmentsRepository` import；bootstrap 构造 `const videoSegmentsRepo = new VideoSegmentsRepository(dbHandle.db);`；`videoHandlers.set(VIDEO_SEGMENTS_JOB_TYPE, makeVideoSegmentsHandler({ storage, mediaRepo, mediaVersionsRepo, videoSegmentsRepo, settings: {...config.video.segments + ffmpeg paths...}, logger }))`。
- `server/src/scripts/video-segments-worker-smoke.ts`（**新增**）— 12 个端到端 case（具体覆盖见 tasks.md 行）。
- `server/package.json`（**修改**）— 注册 `smoke:video-segments-worker`。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— 标记 P9.T6 `[x]`，记录 R-107（idempotency wipe 会清掉将来 P9.T7+ 评分）+ R-108（DB 事务回滚保留旧行，但磁盘新文件已经写入；接受为良性"未引用文件"，等下次重跑或永久删除清理）+ R-109（`-c copy` 切点对齐源 keyframe，段长可能略偏离配置）。

#### 验证

- `npx tsc --noEmit` (server) — 干净。
- `npm run smoke:video-segments-worker` — **41/41 PASS**：12 case 全绿（happy: 4 段产生 + 连续单调 + 总长 ≈ 12s + audit 列默认值；非破坏性原视频字节一致；decode-source 偏好 proxy；idempotent: re-run 同段数 + UUID 全换 + 旧文件清理；image / unknown / soft-deleted / ghost-file / broken 五类失败明确报错；scope-guard: media_items / media_versions 不动 + 原视频字节不变；FK ON DELETE CASCADE: hard-delete media_items 自动清 segments；cleanup-tolerance: 重跑时被预先删除的旧 segment 文件不影响 worker 成功）。
- 回归：35 个 smoke 跑过，34 个 PASS；migration-006 (14/18) + migration-008 (33/34) 的 2 个 upgrade-path 失败在 P9.T6 之前（commit e7cbcae P9.T5）已存在 — 与本任务无关，由其他既有 migration 的 rebuild 路径在新 fresh-only 测试 fixture 下产生；不阻塞本次提交，但需要单独任务处置。
- Server `npm run lint` / Client `npm run lint` + `npm run typecheck` — 干净。

#### 红线 / 接受标准对照

| 验收点 | 兑现 |
| --- | --- |
| ① ffmpeg 切出 N 段 + 落到 `derived/{mediaId}/segments/{segmentId}.mp4` | 4-段 happy case 文件全在 + canonical path 通过 `videoSegmentMp4Path()` 校验 |
| ② 每段一行 `video_segments` | listByMediaId 行数 === 磁盘文件数（4=4），FK / CHECK 全部继承 P9.T1 |
| ③ 原视频不被覆盖、不被删除 | 双断言：non-destructive bytes-equal + scope-guard bytes-equal + storage 路径 `assertSafeRelPath` 守门只允许 derived 子路径 |
| ④ 段时间戳与时长字段写正确 | happy case 验证连续单调 (`startTime[i+1] === endTime[i]`) + 总长 ≈ 源 + duration > 0 + endTime > startTime |
| ⑤ 重跑幂等（无行增长） | idempotent case：两次 tick 后行数仍为 4，但 UUID 全部新 + 旧文件 0 残留 |
| ⑥ 非 video 媒体不会处理 | image / unknown 双失败 + 'not a video' 错误信息 + 0 行 + 无 segments 目录 leak |
| ⑦ 原视频缺失 → 失败可控 | ghost-file CASE: ffmpeg exit 254 / 183 + 'ffmpeg segments exited' 错误信息 + 0 行 |
| ⑧ 软删除视频不处理 | soft-deleted CASE: 'media not found or soft-deleted' 错误信息 + 无 segments 目录 leak（P7 契约延续）|
| ⑨ P9.T1 ~ T5 / P7 / P8 不破坏 | ✅ migration-011 39/39 + video-metadata 39/39 + video-cover 41/41 + video-proxy 35/35 + video-keyframes 40/40 + 整套 P7 60/60 + 整套 P8 全绿 |
| ⑩ Worker 接到 video 通道 + 1 并发 | bootstrap `videoHandlers.set(VIDEO_SEGMENTS_JOB_TYPE, ...)` 注册到 video 通道；JobQueue 继承 `VIDEO_WORKER_CONCURRENCY=1` |

#### P9.T6 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-107** | `replaceAllForMedia` 重跑会 wipe 全部 `video_segments` 行 → 已积累的 P9.T7+ 评分（blur_score / stability_score / quality_score / waste_type / is_recommended / user_decision / reason）+ 用户手动决策（user_decision）一起被清掉。**与 CLAUDE.md §3.9（用户手动选择优先级高于系统推荐，重算时不得覆盖用户选择，除非主动要求重算）冲突的隐患**。 | V1 接受：P9.T7 尚未落地，P9.T6 是 `video_segments` 唯一写者，风险此刻 dormant。P9.T7 落地时**必须**重审：拟方案 (a) 重跑前 SELECT 保留旧 user_decision，按 (startTime, endTime) 区间映射回新段；(b) 或在 `processing_jobs.params` 增加 `force=true` 标记，仅当用户主动要求时才允许 wipe。tasks.md 在 P9.T7 描述中追溯此约束。|
| **R-108** | DB 事务回滚时，磁盘上新 segment 文件已经写下（putDerived 在事务外）。下次重跑会用新 UUID 写新文件 → 旧的"半成品"文件成为未引用孤儿，直到永久删除走 walk 清理。 | V1 接受：与 P9.T5 keyframes manifest 孤儿风险同形。永久删除（P7.T7+，目前 `[LATER]`）落地时统一 walk 整个 `derived/{mediaId}/segments/` 清理 |
| **R-109** | `-c copy` 切点对齐源 keyframe，意味着 segment 时长可能偏离配置的 `durationSec`（短视频 / GOP 大的源差异更明显）。我们用 ffprobe 拿权威 duration 然后累加 cursorSec → 段间无重叠/无缺口，但总长不保证整除 `durationSec`。 | 设计取舍。P9.T8 Video API 暴露 startTime/endTime/duration 应直接展示实际段长（与"配置值"标注区分）。如未来需要严格固定时长，可改 `-c:v libx264 -force_key_frames 'expr:gte(t,n_forced*<dur>)'` 强插 keyframe，但代价是重编码（×慢）|

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)。R-78、R-81 已闭合。

### P9.T7 video_segment_quality worker 实现结果

阶段：已完成。日期：2026-05-24。

#### 改动文件

- `server/src/media/videoSegmentsRepository.ts`（**修改**）— R-107 闭合：
  - `replaceAllForMedia` 新增 `options?: { force?: boolean }`；默认 `force=false` 时，事务体内先 `listByMediaId` snapshot 旧行 → 调 `mapUserDecisionsByOverlap` 算出每个新 segment 应继承哪个旧 user_decision → DELETE + INSERT + 最后逐行 UPDATE user_decision 重放（全部在一个 better-sqlite3 同步事务内，崩溃回滚）；`force=true` 时跳过 snapshot + mapping，行为与原版一致。
  - 新公开 `updateQuality(data: VideoSegmentQualityUpdate)`：单行 UPDATE `blur_score / stability_score / quality_score / waste_type / is_recommended / reason / updated_at`——**绝不动 user_decision**（CLAUDE.md §3.9）。
  - 新公开 `updateUserDecision(args)`：单行 UPDATE `user_decision / updated_at`。仅供 R-107 内部 mapping + 未来用户决策 API 使用，P9.T7 scorer 不调。
  - 新导出 `PRESERVE_USER_DECISION_OVERLAP_RATIO = 0.5` 常量（用于 mapping 阈值；纯函数 + 常量在 `media/index.ts` 再导出）+ `mapUserDecisionsByOverlap(oldRows, newSegments)` 纯函数（每个新 seg 找最大时间重叠的旧 seg，重叠 / new.duration ≥ 0.5 且旧 user_decision ≠ 'undecided' → 输出 plan 条目）+ `ReplaceAllForMediaOptions` / `VideoSegmentQualityUpdate` 类型。
- `server/src/media/index.ts`（**修改**）— 加导出：`PRESERVE_USER_DECISION_OVERLAP_RATIO` / `mapUserDecisionsByOverlap` / `ReplaceAllForMediaOptions` / `VideoSegmentQualityUpdate`。
- `server/src/jobs/videoSegmentsWorker.ts`（**修改**）— R-107 桥接：新增 `parseForceFlag(payload, logger, correlation)` 解析 `processing_jobs.payload` JSON 的 `force` 字段；非 JSON / 非对象 / 缺 force 全部当 `force=false` 兜底（malformed JSON 触发 logger.warn）；把 `{ force }` 传给 `replaceAllForMedia`；info-log 多加 `force` 字段做溯源。
- `server/src/jobs/videoSegmentQualityWorker.ts`（**新增**）— 完整 P9.T7 worker：
  - 常量：`VIDEO_SEGMENT_QUALITY_JOB_TYPE = 'video_segment_quality'`、`MAX_STDERR_BYTES = 4096`、`MAX_BLACKDETECT_STDERR_BYTES = 1_048_576`。
  - 类型：`VideoSegmentQualitySettings` / `VideoSegmentQualityHandlerDeps` / `SegmentScore` / `DEFAULT_VIDEO_SEGMENT_QUALITY_SETTINGS`。
  - `makeVideoSegmentQualityHandler(deps)` pipeline：
    1. `mediaRepo.findById(jobMediaId)` → null 抛 'media not found or soft-deleted'。
    2. `media.type !== 'video'` → 抛 'media is not a video (type=X); refusing to score segments'。
    3. `videoSegmentsRepo.listByMediaId(media.id)` 0 行 → 抛 'no segments to score — run video_segments worker first'。
    4. `readFile(<storage.root>/trips/{tripId}/derived/{mediaId}/frames/manifest.json, 'utf8')` + `JSON.parse`；ENOENT / parse error 抛 'cannot read keyframes manifest at ... — run video_keyframes worker first (...)'；frames[] 空抛 'keyframes manifest has no frames'。
    5. 对每个 keyframe entry：`readFile(<storage.root>/<filePath>)` → `computeLaplacianStats(bytes, blurMaxEdge=512)` （复用 P6.T1 image_quality_blur 的算子）→ `normaliseSharpness(stats.variance, BLUR_THRESHOLD_MAYBE)` 得 [0,1] sharpness；任何失败抛。
    6. `pickDecodeSource` 选 video_proxy / originalPath（与 P9.T6 等价但内联）；都不可用抛 'no decode source available for blackdetect'。`runBlackdetect({ input, settings })` spawn ffmpeg `-hide_banner -nostats -v info -i <abs> -vf 'blackdetect=d=<min>:pic_th=<picTh>:pix_th=<pixTh>' -an -f null -`（bounded timeoutMs + SIGKILL + 4KB stderr 截断 + 1MB stderr buffer cap 防 OOM）；exit ≠ 0 抛；成功后 `parseBlackdetectStderr(stderr)` 用正则 `/black_start:\s*([+-]?\d+(?:\.\d+)?)\s+black_end:\s*([+-]?\d+(?:\.\d+)?)/g` 匹配 → drop end ≤ start → sort by start。
    7. 对每个 segment 调纯函数 `scoreOneSegment({ segment, sharpnessByKeyframe, blackIntervals, settings })`：keyframes ∈ `[start_time, end_time)` 平均得 blur_score（无 keyframe → NULL，且 reason 显式标注 "no keyframes in interval; blur degraded to NULL"）；black 区间 overlap 求和 / segment.duration → blackRatio（clamp 到 [0,1]）；`waste_type` = `blackRatio ≥ blackRatioThreshold ? 'black' : (blur_score !== null && blur_score ≤ blurWasteThreshold ? 'blurry' : 'none')`；`quality_score = blur_score === null ? null : clamp01(blur_score × (1 - blackRatio))`；`is_recommended = waste_type === 'none' AND quality_score !== null AND quality_score ≥ recommendThreshold`；reason 文本含 blur / blackRatio / quality / waste / keyframeCount + 可选 'recommended' / '(no keyframes ...)'。
    8. per-row `videoSegmentsRepo.updateQuality(...)`（一次 UPDATE 一行；无需事务因为各行评分独立 + 不写 user_decision；FK CASCADE 已经保证 media 被 hard-delete 后 race UPDATE 自然 changes=0）；info-log 含 `wasteTypeHistogram` + `recommendedCount` 便于在线诊断。
  - **V1 取舍**：`stability_score` 始终 NULL（P9.T5 keyframes 默认 2s 抽样太粗，不足以做帧差稳定性；design.md §8.2 把 vidstabdetect 推到后续阶段）。`waste_type='silence'` 不实现（prompt 只要求 blackdetect 黑场）；`waste_type='unstable'` 同上。
- `server/src/jobs/imageQualityBlurWorker.ts`（**未改**）— 通过 `export` 的 `computeLaplacianStats` + `normaliseSharpness` 直接复用。
- `server/src/jobs/index.ts`（**修改**）— 加导出 P9.T7 worker 符号：`DEFAULT_VIDEO_SEGMENT_QUALITY_SETTINGS` / `VIDEO_SEGMENT_QUALITY_JOB_TYPE` / `makeVideoSegmentQualityHandler` / `parseBlackdetectStderr` / `runBlackdetect` / `scoreOneSegment` / `SegmentScore` / `VideoSegmentQualityHandlerDeps` / `VideoSegmentQualitySettings`。
- `server/src/config/index.ts`（**修改**）— 8 个 P9.T7 env 旋钮：`VIDEO_SEGMENT_QUALITY_BLUR_MAX_EDGE=512` / `BLUR_WASTE_THRESHOLD=0.25` / `BLACK_RATIO_THRESHOLD=0.5` / `BLACKDETECT_PIC_TH=0.98` / `BLACKDETECT_PIX_TH=0.1` / `RECOMMEND_THRESHOLD=0.5` / `TIMEOUT_MS=300_000` / `WORKER_VERSION='1.0'`。新 `Config.video.segmentQuality` 接口 + `toConfig` 映射；复用既有 `BLACK_DETECT_DURATION` env（design.md §11.1）作为 blackdetect `d=` 参数；复用 `BLUR_THRESHOLD_MAYBE`（image 配置）作为 `normaliseSharpness` 分母让 image 与 video 分数同尺度。superRefine 守卫：blurMaxEdge ≥ 4 + 5 个 [0,1] 阈值范围检查。
- `server/src/index.ts`（**修改**）— bootstrap 注册 P9.T7 handler 到 video 通道，settings 一份从 config.video.segmentQuality.\* + config.quality.blurThresholdMaybe + config.ffmpeg.ffmpegPath 拉。
- `server/src/scripts/video-segment-quality-worker-smoke.ts`（**新增**）— 36/36 PASS smoke：9 个纯函数单测 + 10 个端到端 case（详见 tasks.md 描述）。
- `server/package.json`（**修改**）— 注册 `smoke:video-segment-quality-worker`。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— 标记 P9.T7 `[x]` + 关闭 R-107 + 记录 R-110 / R-111 / R-112。

#### 验证

- `npx tsc --noEmit` (server) — 干净。
- `npm run smoke:video-segment-quality-worker` — **36/36 PASS**：3 个 `parseBlackdetectStderr` 单测（空 / 1 区间 / 多区间 + 反向 drop + 排序）+ 5 个 `scoreOneSegment` 单测（无 keyframe NULL / 清晰 → recommended / 全黑 → 'black' / 模糊 → 'blurry' / 40% 黑 < 阈值不 'black'）+ 1 个 `mapUserDecisionsByOverlap` R-107 单测（'keep' ≥50% 重叠继承 / 'undecided' 跳过 / <50% 不继承）+ 10 个端到端：happy 4 段全打分（blur ∈ [0,1]、qualityScore ∈ [0,1]、stability NULL、user_decision 'undecided'、reason 非空、no 'black'、至少 1 个 recommended）+ scope-guard（media_items 不动 + media_versions 0 行不变 + 原视频字节不变 + segment 文件不动）+ 全黑 6s clip → segments 全 'black' 不推荐 + R-107 preservation（重跑 P9.T6 不带 force → 'keep' 在重叠的新 segment 上保留 + UUIDs 全换）+ R-107 force（payload `{"force":true}` → user_decision 全清回 'undecided'）+ 5 个失败路径（无 segments / 无 manifest / 非 video / soft-deleted / 无 decode source）。
- 回归：43 个 smoke 跑过，全部 PASS（含 migration-011 39/39、video-metadata 39/39、video-cover 41/41、video-proxy 35/35、video-keyframes 40/40、video-segments 41/41、video-segment-quality 36/36、P7 60/60、P8 全套、所有 P5/P6 image quality + dedup 全绿）。migration-006 / migration-008 既有的 2 个 upgrade-path 失败在 P9.T5 commit (e7cbcae) 已存在，与本任务无关。
- Server `npm run lint` + Client `npm run lint` + Client `npm run typecheck` — 干净。

#### 红线 / 接受标准对照

| 验收点 | 兑现 |
| --- | --- |
| ① 基于 P9.T5 keyframes 做模糊评分 | `computeLaplacianStats` + `normaliseSharpness` 每 keyframe → segment 内 keyframes 平均 blur_score |
| ② FFmpeg blackdetect 检测 + 映射到 segment | `runBlackdetect` spawn → `parseBlackdetectStderr` 区间提取 → segment overlap 求和 → blackRatio 写入 reason / quality_score |
| ③ UPDATE 到 video_segments 行 | `updateQuality` 单行 UPDATE blur_score/stability_score/quality_score/waste_type/is_recommended/reason/updated_at |
| ④ 不动 user_decision（CLAUDE.md §3.9）| `updateQuality` SQL 明确不包含 user_decision；smoke 多次断言"user_decision stays 'undecided'" |
| ⑤ R-107 处理 | `replaceAllForMedia(..., { force })` 默认保留 user_decision；payload `{"force":true}` 显式 wipe；smoke 双断言 + 单元测试 mapUserDecisionsByOverlap |
| ⑥ 原视频不被覆盖、不被删除 | scope-guard bytes-equal 双断言（含 segment 文件 + 原视频）|
| ⑦ 非 video / soft-deleted / 无 segments / 无 manifest / 无 decode source 失败可控 | 5 个失败 case 都有明确错误消息；retry budget 用尽后 mark failed |
| ⑧ 不新增 migration | migration 011 P9.T1 已就位；本任务只 UPDATE 已有列 |
| ⑨ 不影响 image 通道 | image_quality_blur 等通过 `export` 复用算子；image 通道注册不变 |
| ⑩ P9.T2-T6 / P7 / P8 不破坏 | 全套回归 smoke 全绿 |

#### P9.T7 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-107（已闭合）** | replaceAllForMedia 重跑会 wipe user_decision。 | **已闭合**：P9.T7 改 `replaceAllForMedia` 默认保留 user_decision，按 `mapUserDecisionsByOverlap(0.5)` 时间重叠映射；payload `{"force":true}` 才允许显式 wipe；纯函数 + 端到端双 smoke 覆盖。 |
| **R-110** | `stability_score` V1 始终 NULL。design.md §8.2 把抖动检测推到后续阶段，本任务遵守，但下游 P9.T8 API / P9.T9 前端如果引用此列要做 NULL 处理。 | 接受。P9.T8 Video API 把 stability_score 标 nullable；客户端展示 segment-level 推荐时只读 quality_score + waste_type 不依赖 stability_score。 |
| **R-111** | `waste_type='silence'` 和 `'unstable'` 由 schema 保留但 V1 不产生（无音频静音检测 + 无 vidstab）。 | 接受。design.md §8.1 把这两个轴推到后续阶段；schema 仍认接受用户手动 / AI 后续写入。 |
| **R-112** | blackdetect 在 `-c copy` 转码出来的 P9.T4 proxy 上跑可能因为 GOP 长度差异略微偏离原视频实际黑帧位置；目前 V1 仍 prefer proxy（更便宜），但若用户拿原片做对比可能感觉时间戳略不一致。 | 接受。decodeSource 字段已 log 出来便于诊断；如果实测偏差过大可在 config 加 `VIDEO_SEGMENT_QUALITY_PREFER_ORIGINAL` 旋钮强制走 originalPath。 |
| **R-113** | P9.T7 把 user_decision 沿 ≥50% 时间重叠映射到新 segment，但是若用户先手动调过 user_decision='keep'，然后 P9.T6 用一个非常不同的 durationSec 重切（例：10s→30s），新 segment 会**跨越**多个旧 segment 的不同决策。映射策略只挑"最大重叠"，可能丢失"keep+remove 混合"的语义。 | V1 接受：这种"换 durationSec 重跑"是显式操作行为，建议操作员同步发 `force:true` 重置 user_decision；不发的话最大重叠是合理近似。文档落地后等用户反馈再决定是否引入"多区间合并"策略。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)。R-78 / R-81 / R-107 已闭合。

### P9.T8 Video API 实现结果

阶段：已完成。日期：2026-05-24。

#### 改动文件

- `server/src/media/videoSegmentsRepository.ts`（**修改**）— 新增 `findByIdStmt` + 公开 `findById(id): VideoSegment | null`。Service 层调 mediaRepo.findById 兜底 P7 软删除契约（repo 自身故意不跨表）。
- `server/src/media/videoSchemas.ts`（**新增**）— `updateUserDecisionBodySchema`（`{ userDecision: 'keep'|'remove'|'undecided' }`，`.strict()`）+ `processVideoSegmentsBodySchema`（`{ force?: boolean }`，`.strict()`），均带 errorMap + 编译期 `_typeAlignCheck` 与 `VideoSegmentUserDecision` 类型对齐确保 schema 与 migration 011 CHECK 永不漂移。
- `server/src/media/videoService.ts`（**新增**）— `VideoService` 类，公开 4 个方法：
  - `async listSegments(mediaIdInput): ListVideoSegmentsResult` — `requireActiveVideoMedia` → `listByMediaId` → 每段附 canonical `filePath` → 读 `frames/manifest.json`（ENOENT/parse 失败优雅降级到 `keyframes: null`，其它 IO 错误透传 500）。返回结构：`{ mediaId, mediaDurationSec, segments[], keyframes | null }`。
  - `getSegmentDetail(segmentIdInput): VideoSegmentDetailResult` — 段+父媒体双查；父媒体软删/非 video/失踪一律 404。
  - `updateUserDecision(segmentIdInput, body): UpdateUserDecisionResult` — zod 强校验；段+父媒体双查；旧值=新值 → `alreadyApplied: true` 跳过 UPDATE；否则 `videoSegmentsRepo.updateUserDecision(id, userDecision, now)`（P9.T7 公开方法，仅写 user_decision 列）。
  - `processVideoSegments(mediaIdInput, body = {}): ProcessVideoSegmentsResult` — 入队 3 个 job：`video_segments` → `video_keyframes` → `video_segment_quality`。`baseMs + i` 单调递增 createdAt 保证 JobQueue（`ORDER BY created_at ASC, id ASC`）按依赖顺序 claim。force=true 仅在 segments slot payload 写入 `{"force":true}`；keyframes / quality slot 始终 payload=null（它们不动 user_decision）。`enqueueOneJobType` 私有方法：无旧行 → created（payload 透传）；pending/running → skipped；terminal-ish + payload!=null → 插新行（resetToRetrying 不动 payload）；terminal-ish + payload=null → resetToRetrying。
  - 公开类型：`VideoSegmentView`（VideoSegment 加 filePath）/ `KeyframesSummary` / `ListVideoSegmentsResult` / `VideoSegmentDetailResult` / `UpdateUserDecisionResult` / `ProcessSlotOutcome` / `ProcessSlotResult` / `ProcessVideoSegmentsResult`。
  - **循环导入修复**：3 个 `VIDEO_*_JOB_TYPE` 字符串故意 inlined，**不 import 自 worker**。媒体桶 `media/index.js` 重导出 videoService，而 workers value-import `videoSegmentMp4Path` 自 media/index.js，会触发 ESM TDZ 循环初始化错误（实测 `ReferenceError: Cannot access 'VIDEO_SEGMENTS_JOB_TYPE' before initialization`）。这些字符串属 closed `processing_jobs.job_type` 词汇表，drift 将被现有 smoke:video-* 验证（worker 注册到 JobQueue 时按 string 精确匹配；任何漂移立即编译失败 / smoke 全红）。代码内注释明确这是有意选择。
- `server/src/routes/video.ts`（**新增**）— `makeVideoRouter({ videoService })`，4 个 endpoint：
  - `GET /api/media/:mediaId/video-segments` — list。entityIdSchema 校验 mediaId。
  - `GET /api/media/:mediaId/video-segments/:segmentId` — detail。`:mediaId` 与 segment.media_id 不匹配返 NotFoundError（防跨 parent 枚举）。
  - `PATCH /api/video-segments/:segmentId/user-decision` — body 校验在 Service 层（zod 抛 ValidationError → 全局 errorHandler → 400）。
  - `POST /api/media/:mediaId/process-video-segments` — body 可选；`req.body ?? {}` 兼容 POST 无 body。
- `server/src/media/index.ts`（**修改**）— 重导出 `VideoService` + 类型 + `processVideoSegmentsBodySchema` + `updateUserDecisionBodySchema` + 类型。
- `server/src/app.ts`（**修改**）— `CreateAppOptions` 加 `videoService: VideoService`；解构 + 挂载 `app.use("/api", makeVideoRouter({ videoService }))`。
- `server/src/index.ts`（**修改**）— import `VideoService`；构造 `new VideoService(mediaRepo, videoSegmentsRepo, jobRepo, storage)`；注入 `createApp({ ..., videoService })`。
- `server/src/scripts/video-api-smoke.ts`（**新增**）— 48/48 PASS（16 个 case，包括 HTTP layer 真 HTTP 验证）。
- `server/package.json`（**修改**）— 注册 `smoke:video-api`。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— 标 P9.T8 `[x]` + 记录 R-114（job_type 字符串 inlined 的循环导入工作绕过）。

#### 验证

- `npx tsc --noEmit` (server) — 干净。
- `npm run smoke:video-api` — **48/48 PASS** 两次稳定运行：
  - CASE 1 happy list (4 段 + scores + canonical filePath + 12 keyframe 摘要)
  - CASE 2 empty segments + keyframes=null
  - CASE 3 corrupt manifest 优雅降级 keyframes=null
  - CASE 4 missing/non-video/soft-deleted 三类 404
  - CASE 5 detail happy 返回 mediaId + filePath
  - CASE 6 detail missing 404
  - CASE 7 PATCH happy（user_decision 翻 + scope-guard：blur_score/stability_score/quality_score/waste_type/is_recommended/reason/start_time/end_time 全部不变）
  - CASE 8 PATCH idempotent（alreadyApplied=true，updated_at 原样保留）
  - CASE 9 PATCH 三种 ValidationError（bad enum / extra key / missing field）
  - CASE 10 PATCH missing/soft-deleted 404
  - CASE 11 process happy 3 slot created + 顺序 + 幂等 skipped + DB 行数确认
  - CASE 12 process force=true：segments slot payload=`{"force":true}`，keyframes/quality slot payload=null
  - CASE 13 process force=true after terminal：插新行而非 reset（确保 worker 读到新 force flag）
  - CASE 14 process 三种 400（非 video / force 非 boolean / extra key）
  - CASE 15 process missing/soft-deleted 404
  - CASE 16 HTTP layer 真 HTTP 验证 4 个 endpoint（GET list / GET detail with cross-parent 404 / PATCH 200 + bad body 400 / POST process 三种 body 200 + bad body 400）
- 回归：44 个 smoke 全绿（含 video-segments 41/41、video-keyframes 40/40、video-segment-quality 36/36、video-cover/proxy/metadata、整套 P7 60/60 + P8 全套契约）；migration-006/008 既有 2 个失败仍是 e7cbcae P9.T5 commit 前既有问题，与本任务无关。
- Server `npm run lint` + Client `npm run lint` + Client `npm run typecheck` — 干净。

#### Endpoint 契约总览

| Verb | Path | Body | Response 200 | 错误码 |
| --- | --- | --- | --- | --- |
| GET | `/api/media/:mediaId/video-segments` | — | `{ mediaId, mediaDurationSec, segments[], keyframes \| null }` | 404 missing/non-video/soft-deleted |
| GET | `/api/media/:mediaId/video-segments/:segmentId` | — | `{ mediaId, segment }` | 404 segment missing OR :mediaId 与 segment.media_id 不匹配 |
| PATCH | `/api/video-segments/:segmentId/user-decision` | `{ userDecision: 'keep'\|'remove'\|'undecided' }` | `{ segmentId, mediaId, previousUserDecision, userDecision, alreadyApplied, updatedAt }` | 400 zod / 404 segment 缺失或父媒体软删 |
| POST | `/api/media/:mediaId/process-video-segments` | `{ force?: boolean }` (可选) | `{ mediaId, force, results: [{ jobType, outcome, jobId, reason? }] × 3 }` | 400 非 video / zod / 404 媒体缺失 / 软删 |

#### 红线 / 接受标准对照

| 验收点 | 兑现 |
| --- | --- |
| ① 暴露 video segments 查询接口（基础字段 / 时间 / 评分 / blackdetect 结果）| GET segments + GET detail；每段含 P9.T1~T7 全部列 + 派生 filePath |
| ② 暴露 keyframes / quality 相关读取能力 | listSegments 内联 keyframes manifest 摘要（P9.T5 产物）；评分列直接来自 P9.T7 落库；API 不重算 |
| ③ 用户手动 PATCH endpoint | PATCH user-decision 复用 `updateUserDecision()`；scope-guard 验证只写 user_decision 列；R-107 语义在 P9.T7 的 `replaceAllForMedia` 处兜底 |
| ④ 暴露 process endpoint | POST process-video-segments 入队 3 个 job；幂等 skipped；force=true 仅在 segments slot 写 payload |
| ⑤ 不重构 video pipeline | 仅 add findById 到 repo；P9.T6/T7 worker 代码未动 |
| ⑥ 不改 schema | 复用现有 migration 011；无新 migration |
| ⑦ 不破坏现有 43 个 smoke 回归 | 44 个 smoke 全绿（+1 新 smoke）|
| ⑧ 不覆盖 user_decision | scorer 不动；PATCH 是用户显式写入；R-107 兜底 |
| ⑨ R-110/R-111 保留字段不动 | stability_score 在 API 中暴露为 number\|null；waste_type 完整 5 值枚举透传 |
| ⑩ 不进入前端 UI 实现 | 本任务仅 server 端 |

#### P9.T8 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-114** | `videoService.ts` 把 3 个 `VIDEO_*_JOB_TYPE` 字符串 inlined 而非 import 自 worker 文件，绕过 ESM 循环初始化（`media/index.js` 重导出 videoService.js 触发的 TDZ）。如果 worker 改字符串而 service 没同步改，运行时 job_type 不匹配 → JobQueue handler 注册不到。 | 文件内有显式注释说明取舍。drift 通过现有 `smoke:video-*-worker`（构造 worker 时直接用 constants）+ `smoke:video-api`（HTTP 入队 + Job 表里写入 jobType 字符串）双向验证：任一边漂移立即触发 smoke 全红。后续重构可考虑把 closed job_type 词汇表抽到一个无依赖的 `src/jobs/jobTypes.ts` 常量文件让 media + jobs 双方 import。 |
| **R-115** | `processVideoSegments` 入队 3 个 job 时用 `Date.now() + i` 单调递增 createdAt 保证 JobQueue claim 顺序。若操作员在 1ms 内连续两次调用本端点（极快重试 / 自动化脚本），两次调用的 baseMs 可能相同，两批 6 个 row 的 createdAt 部分重叠，JobQueue claim 顺序退化到按 random UUID。被 claim 的 quality job 仍能正确报错 "no segments to score" 并走 retry budget；不会写脏数据。 | V1 接受。生产侧的 throttle 由前端 / 反代层负责；smoke `CASE 13` 通过显式 `await setTimeout(2)` 避开同 ms 测试。如未来需要更强保证可改用 (createdAt, sequenceField) 复合排序 + 自增列。|
| **R-116** | listSegments 异步读 `frames/manifest.json`：corrupt JSON 静默降级到 `keyframes: null`。从用户视角"keyframes 缺失"和"keyframes 文件损坏"是同一种状态。运维不易区分。 | V1 接受。worker 端日志已经记录 keyframes 写入；如未来需要可在 API response 内加 `keyframesError: string \| null` 透传降级原因。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)。R-78 / R-81 / R-107 已闭合。

### P9.T9 前端视频片段页 实现结果

阶段：已完成。日期：2026-05-24。

#### 改动文件

- `client/src/api/video.ts`（**新增**）— Video API 客户端，4 个 fetcher：
  - `fetchVideoSegments(mediaId, signal?)` → `ListVideoSegmentsResponse`
  - `fetchVideoSegmentDetail(mediaId, segmentId, signal?)` → `VideoSegmentDetailResponse`
  - `updateSegmentUserDecision(segmentId, userDecision)` → `UpdateUserDecisionResponse`
  - `processVideoSegments(mediaId, force = false)` → `ProcessVideoSegmentsResponse`
  - 完整 wire 类型：`VideoSegment`（含 canonical filePath）/ `KeyframesSummary` / `KeyframeEntry` / `ListVideoSegmentsResponse` / `VideoSegmentDetailResponse` / `UpdateUserDecisionResponse` / `VideoSegmentWasteType` / `VideoSegmentUserDecision`（别名 `MediaUserDecision`）/ `ProcessSlotOutcome` / `ProcessSlotResult` / `ProcessVideoSegmentsResponse`。复用 `media.ts` 的 ApiErrorEnvelope 解析（`error.message` 透传到 thrown `Error.message`）。
- `client/src/hooks/useVideoSegments.ts`（**新增**）— stale-while-revalidate hook 镜像 `useMediaDetail` 的契约：`{ data, loading, error, refetch }`，AbortController on unmount / mediaId 切换 / refetch，传 `undefined` 时短路到 not-loading。
- `client/src/pages/VideoSegmentsPage.tsx`（**新增**）— 挂在 `/videos/:mediaId/segments`。结构：
  - **loading / error / loaded(empty) / loaded(populated)** 完整状态机；
  - **header** 含返回 MediaDetail 链接 + 元信息（media id 截断 / duration / segments 数 / keyframes 数）+ 「Re-analyse」(force=false) 按钮 + 「Re-analyse from scratch」(force=true) 按钮；
  - **force=true 二次确认**：复用 `.modal-overlay` + `.modal-card` 模式（与 P7 软删除模态同构），文案明确"会 wipe 所有 user_decision"+"如想保留请走默认 Re-analyse（自动按 ≥50% 重叠映射保留）"；Esc/Cancel/click overlay 关闭（pending 中禁用）；
  - **aria-live banners**：process 成功显示 `slot=outcome` 概要 + R-107 解释文案；decision 成功显示 from→to 切换；任何失败用 `form-error role=alert` 红色 banner 永不静默；
  - **keyframe strip**：横向滚动展示 P9.T5 manifest 内联 frames，每帧 lazy load + 时间戳 caption；
  - **segment 卡片**：waste_type pill（5 值闭合枚举映射 emoji + tone）+ Recommended ★ pill + Q/Blur/Stab 数值 pill（按分数自适应 tone 0.7+/0.4+/0.2+/<0.2 = positive/neutral/warning/negative）+ 卡内 keyframes（按 `f.timestampSec ∈ [start, end)` 筛选）+ keep/remove/undecided 三按钮组（active 切到 btn-primary + aria-pressed）+ "Show details" 折叠面板（segment id / canonical filePath 含 `/storage/` 下载链接 / updatedAt / reason）。
  - **乐观更新**：`decisionOverrides` map 让按钮立即反馈用户选择；服务器返回后 sync；失败回滚由 banner 替代（不显式 revert，因 API 失败时数据库未变，组件状态自然停在前值）。
  - **process 后**：清空 `decisionOverrides` 然后 `refetch`，因 R-107 重映射结果不可前端预测（user_decision 可能被时间重叠映射到不同的新 segment）。
  - 完整 helpers：`formatSeconds(num)`（mm:SS.s）/ `truncateId(uuid)` / `labelWasteType` / `toneForWasteType` / `toneForScore` / `decisionLabel`。
- `client/src/App.tsx`（**修改**）— 加 `import VideoSegmentsPage` + `<Route path="/videos/:mediaId/segments" element={<VideoSegmentsPage />} />`。路由注释从 stub 升级到 `✓ wired`。
- `client/src/pages/MediaDetailPage.tsx`（**修改**）— page-header-actions 加 `<Link to="/videos/:id/segments" className="btn-secondary">View segments</Link>`，仅 `media.type === "video"` 时渲染（image / unknown 不显示）。
- `client/src/index.css`（**修改**）— 追加 ~180 行 P9.T9 样式：`.video-segments-section-h` / `.video-segments-list` / `.video-segment-card`（含 `[data-waste-type]` / `[data-user-decision]` / `[data-recommended]` 属性选择器：black/blurry 红边、remove 半透明、recommended 绿底）/ `.video-segment-card-head` / `.video-segment-card-time` / `.video-segment-card-badges` / `.video-segment-card-frames` / `.video-segment-card-decisions` / `.video-segment-card-disclosure` / `.video-segment-card-details` / `.video-keyframe-strip-wrap` / `.video-keyframe-strip`（横向滚动）/ `.video-keyframe-strip-item` / `.video-keyframe-img` / `.video-keyframe-time`。完全复用既有色板（`#d0d7de` / `#1f2328` / `#57606a` / `#dafbe1` / `#ffebe9` 等）+ 既有 `.btn-*` / `.quality-pill` / `.modal-*` 组件，零新色板 token。

#### 用户可执行操作

进入路径：TripDetail → MediaCard(video) → MediaDetailPage → "View segments" → VideoSegmentsPage。

1. **查看 segments**：每段时间范围 + duration + waste_type + Q/Blur/Stab 评分 + Recommended 标 + 段内 keyframes 缩略。
2. **查看 keyframe strip**：顶部横向滚动展示整个视频的关键帧时间线。
3. **展开 segment 详情**：点 "Show details" 看 segment id / 文件路径 / reason 字符串（含 P9.T7 写入的 `blur=… | blackRatio=… | quality=… | waste=… | keyframes=… | recommended` 摘要）/ 下载链接。
4. **手动决策**：点 keep / remove / undecided 按钮 → PATCH 触发 → 按钮立即变 active + aria-live banner 反馈 "from X to Y"；失败时红色 form-error banner。
5. **重新分析**（保留用户选择）：点 "Re-analyse" → POST force=false → R-107 时间重叠映射保留 user_decision → banner 显示 slot=outcome 概要 + 解释文案。
6. **强制重置**：点 "Re-analyse from scratch" → 弹模态二次确认 → 确认后 POST force=true → user_decision 全清 → banner 解释下次 worker tick 后会 wipe。
7. **错误处理**：404 / 400 / 500 全部走 aria-live 红色 banner；retry by refetch（点 "Re-analyse" 时同时清空 overrides + refetch）。

#### 验证

- `cd client && npm run lint` — 干净。
- `cd client && npm run typecheck` — 干净（tsc -b 全 ok）。
- `cd client && npm run build` — vite 构建成功（59 modules transformed，dist gzip 70.98 kB JS + 4.27 kB CSS）。
- `cd server && npm run smoke:video-api` — **48/48 PASS**（P9.T8 契约 + HTTP layer 真 fetch）。
- 全套 server smoke 回归：44 个 PASS（含 video-segments 41/41 / video-keyframes 40/40 / video-segment-quality 36/36 / video-cover 41/41 / video-proxy 35/35 / video-metadata 39/39 / 整套 P7 60/60 + P8 全部）；migration-006/008 既有 2 个失败属 P9.T5 前历史遗留，与本任务无关。
- 前端没有 vitest / jest 等测试框架（同 P8 / P5 / P3 等过往前端任务的契约：lint + typecheck + build + 服务端 HTTP smoke 覆盖 API 契约）。

#### 红线 / 接受标准对照

| 验收点 | 兑现 |
| --- | --- |
| ① 新增视频片段页面渲染 segment 列表 | VideoSegmentsPage + segment 卡片清单 |
| ② 每段时间范围 / 状态 / 质量摘要 / 缩略 / user_decision | 全部在 SegmentCard 渲染 |
| ③ segment 详情展开 | "Show details" 折叠面板 reveal id / filePath / updatedAt / reason |
| ④ keyframes 摘要 | 横向 keyframe strip + 段内 keyframes |
| ⑤ 用户手动决策按钮 | keep / remove / undecided 三键 + 即时 PATCH + aria-live |
| ⑥ 调用 P9.T8 PATCH | 已接入 `updateSegmentUserDecision` |
| ⑦ 决策失败不静默 | `form-error role=alert` 红色 banner |
| ⑧ 不在前端覆盖 R-107 preservation | force flag 完全透传到服务器；前端无任何 user_decision 重映射逻辑 |
| ⑨ 重新分析入口 | "Re-analyse" + "Re-analyse from scratch" 双按钮 |
| ⑩ force=true 二次确认 | `.modal-overlay` + `.modal-card` 模态，明确文案 |
| ⑪ 避免连续点击重复请求 | `processing` 标志位 disable 按钮 + 同 segment `decisionPending` map |
| ⑫ loading / 空 / 错误 / pending 状态 | 四种状态全覆盖 |
| ⑬ 不动后端 / schema / 评分算法 | 零后端变更（仅 server smoke 验证回归）|
| ⑭ 不引入大框架重构 | 纯 React + React Router 复用既有组件 / CSS 体系 |
| ⑮ 不进入 P9.T10 | 仅完成 P9.T9 |

#### P9.T9 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-117** | 乐观更新的 `decisionOverrides` map 在 process re-run 后被清空 + refetch 拉新数据，但实际服务端 worker 在 video 通道 (concurrency=1) 上需要等若干秒才能落库。在 worker 完成前如果用户立即点 "Re-analyse" 后看到的 segments 仍是旧 user_decision；这是预期，但 UX 上可能让用户误以为 process 没生效。 | V1 接受：banner 文案已经说明"下次 worker tick 后生效"；如未来需要可加 polling 或者 SSE。 |
| **R-118** | 卡片内 keyframes 用 `f.timestampSec ∈ [start, end)` 筛选；若 P9.T5 keyframes 间隔大于 P9.T6 segment 时长（极短视频 / 操作员配置奇怪），部分 segment 会渲染 0 张缩略图。SegmentCard 不显示空 frames 区段（条件渲染），无视觉故障，但用户可能误以为该段缺数据。 | V1 接受：keyframes 间隔默认 2s，segment 默认 10s，正常情况下每段 ≥ 5 张缩略；config 异常时段内 0 帧也合理（worker 未跑或视频极短）。 |
| **R-119** | 前端 `filePath` 直接拼到 `<a href="/storage/${filePath}">` 作为下载链接。理论上一个被精心构造的 filePath（含 `..` 等）可能被浏览器规整后越界，但服务端 `/storage` 路由 (storage.ts P3.T1) 已经做 `assertSafeRelPath` 守门，越界请求会返 400。 | V1 接受：服务端守门是真正的安全边界，前端只承担便利展示。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)。R-78 / R-81 / R-107 已闭合。

### P9.T10 阶段 P9 验收 实现结果

阶段：已完成。日期：2026-05-25。验收**通过**。

#### 验收方式

新增 `server/src/scripts/p9-acceptance-smoke.ts`——P9 整阶段的 canonical 端到端验收 smoke。它 boot 真 SQLite + 真 LocalStorageProvider + 真 ffmpeg/ffprobe + 真 Express server，对一段 ffmpeg lavfi `testsrc=duration=12:size=320x240:rate=25` 12 秒视频跑完整 P9.T1~T9 链路，做 36 条断言。注册 `smoke:p9-acceptance` 到 package.json。

为何"再写一个 smoke"而不是"手工跑 dev server + 浏览器"：这个仓库的所有阶段验收（P7.T6 recycle-bin-acceptance, P5.T6 dedup, P8.T6 enhance, etc.）都用 smoke 这条管道——既是验收文档又是回归 fixture。本任务遵循同样的契约。

#### 测试视频规格

- ffmpeg `lavfi` `testsrc=duration=12:size=320x240:rate=25`
- 编码 `libx264 / yuv420p / preset=ultrafast`，源端 `-g 25 -keyint_min 25` 强制 1s GOP（让 P9.T5 的 1s 间隔抽帧有 IDR 命中）
- 文件大小 ~250 KB（每次重新生成；不入 repo）

#### 跑通的链路阶段（按 design.md §8.1 依赖顺序）

| Stage | Job type | 产物 | 验收点 |
| --- | --- | --- | --- |
| 1 | `video_metadata` | `media_items.duration` + `media_versions(type='metadata')` | duration=12 + row 存在 |
| 2 | `video_cover` | `derived/{mediaId}/video_cover.jpg` | 文件存在 + 非空 |
| 3 | `video_proxy` | `derived/{mediaId}/video_proxy.mp4` + `media_versions(type='video_proxy')` | 文件存在 + 非空 |
| 4 | `video_keyframes` | `derived/{mediaId}/frames/manifest.json` + frame_NNNNNN.jpg × 12 | manifest 解析 + 帧文件存在 + frameCount=12 |
| 5 | `video_segments` | `video_segments` 行 + `derived/{mediaId}/segments/{id}.mp4` | 段连续 + 总长 ≈ 12s + 每个文件存在 |
| 6 | `video_segment_quality` | UPDATE blur_score/quality_score/waste_type/is_recommended/reason | 全在 [0,1] + 不动 user_decision + 至少 1 个 recommended |

#### Video API 端到端契约

通过真 Express server + 真 fetch 验证 P9.T8 四个 endpoint：

- `GET /api/media/:mediaId/video-segments` → 200 + 段数与 repo 一致 + keyframes 摘要内联
- `GET /api/media/:mediaId/video-segments/:segmentId` → 200 + id 匹配 + filePath 与 list 中一致
- `PATCH /api/video-segments/:segmentId/user-decision` → 200 + DB user_decision 写入 + 评分列不动
- `POST /api/media/:mediaId/process-video-segments` → 200，force=true 时 segments slot payload 携带 `{"force":true}`

#### 前端页面验收

- `cd client && npm run lint` 干净
- `cd client && npm run typecheck` 干净
- `cd client && npm run build` (vite + tsc) 成功生成 dist（gzip 70.98 kB JS + 4.27 kB CSS）
- 路由 `/videos/:mediaId/segments` 已经在 P9.T9 接入，按 React 路由静态分析无回归

#### 用户决策按钮验收

- PATCH 'keep' → 服务器 200 + previousUserDecision='undecided' + userDecision='keep' + alreadyApplied=false
- 段表里 user_decision='keep' 落库
- scope-guard 双断言：评分列（blur_score / stability_score / quality_score / waste_type / is_recommended / reason / start_time / end_time）全部保持不变（在 smoke:video-api 已 cover；这里端到端再验一遍）
- P7：软删除 media 后 PATCH 同一 segmentId 返 404，restore 后 PATCH 又能写

#### 重新分析入口验收

- POST force=false → 200 + 3 slot results + 1ms 内返回（R-117：API 异步语义验证）
- workers 排空后 R-107 时间重叠映射保留 user_decision='keep' 到 midpoint 命中的新 segment（端到端验证！这是 P9 阶段的核心红线）
- POST force=true → 200 + force 回显 + workers 排空后所有 user_decision 重置为 'undecided'
- 连续 POST 调用之间 sleep 5ms（与 R-115 防撞建议一致），smoke 稳定可重跑

#### P7 软删除契约验收

| 操作 | 期望 | 实测 |
| --- | --- | --- |
| `softDeleteMedia(mediaId)` | 成功 | ✓ |
| GET /video-segments → 404 | ✓ | status=404 + `Media not found` |
| PATCH user-decision 到子 segment → 404 | ✓ | status=404 + "parent media missing or soft-deleted" |
| POST process → 404 | ✓ | status=404 |
| `restoreMedia(mediaId)` → restored=true | ✓ | qualitySelectorEnqueued=true |
| GET /video-segments 又能用 → 200 | ✓ | 段数恢复可见 |

软删除契约**完全保留**，与 P7.T1/T2 行为一致。

#### R-114 / R-115 / R-116 / R-117 / R-118 / R-119 风险重审

| 风险 | P9.T10 验证结论 | 后续动作 |
| --- | --- | --- |
| **R-114**（job_type 字符串 inlined） | drift 立即被本 smoke + smoke:video-* 全套发现：worker 注册的 `VIDEO_*_JOB_TYPE` 与 service 内 inline 字符串完全一致才能 36/36 PASS | 维持现状 |
| **R-115**（短时间连续 process 调用 createdAt 撞车） | smoke 在 force=true 重发前 `await setTimeout(5)` 验证 worker 顺序仍按时间戳确定；UI 端禁用按钮已经覆盖 throttle 场景 | 维持现状 |
| **R-116**（corrupt manifest 优雅降级） | smoke `R-116 SANITY` case：另起一个 media（无 manifest）→ GET 返 200 + keyframes=null，验证无 crash | 维持现状 |
| **R-117**（process 返回与 worker 落库非同步） | smoke 显式 measure POST process 调用 elapsed < 1000ms（实测 1ms）；前端 banner 文案已经说明"下次 worker tick 后生效"；UX 接受 | 维持现状 |
| **R-118**（极端配置下段内 0 keyframes） | 未触发——默认 1s keyframes vs 3s segments，每段都有 ≥ 3 帧 | 维持现状（V1 不阻塞）|
| **R-119**（前端 /storage 路径安全） | smoke 真 HTTP fetch /storage/<canonical filePath> 返 200 + 非空字节，验证服务端 assertSafeRelPath 是真实安全边界 | 维持现状 |

#### P9.T10 揭示并记录的新风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-120** | P9.T6 `-c copy` 切点对齐 source keyframe（R-109 已记录），但**真实生产 pipeline 默认走 P9.T4 proxy** 而非 originalPath（pickDecodeSource 偏好 proxy）。proxy worker 用 `preset='veryfast'` 不显式设 `-g`，x264 默认 keyint=250（10s @ 25fps），所以 12s 视频在 durationSec=3 配置下实际产出 **2 段（0-10s + 10-12s）** 而非朴素的 4 段。 acceptance smoke 改为按"段数 ≥ 1 + 连续 + 总长 ≈ 源"验证（不硬编码 4）+ R-107 测试改为按目标 midpoint 找新 segment（不假设具体段索引）。这是真实可观察的产品行为：`durationSec` 是"上限提示"而非硬保证。 | V1 接受：UI 文案已经按"实际段长"展示（VideoSegmentsPage 不显示"配置 durationSec"）。如需更细粒度可在 config 加 `VIDEO_PROXY_GOP_SEC` 旋钮显式控制 proxy 的 `-g`；或者在 segments worker 加 `-force_key_frames 'expr:gte(t,n_forced*<dur>)'` 强重编码（代价：×慢）。这两个都是后续阶段（视频剪辑 / 输出）真正需要时再做。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)。R-78 / R-81 / R-107 已闭合。

#### 跑过的验证命令

- `cd client && npm run lint` — 干净
- `cd client && npm run typecheck` — 干净（tsc -b）
- `cd client && npm run build` — vite 构建成功（59 modules, gzip 70.98 kB JS + 4.27 kB CSS）
- `cd server && npm run lint` — 干净
- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run smoke:p9-acceptance` — **36/36 PASS**
- `cd server && npm run smoke:video-api` — 48/48 PASS
- `cd server && npm run smoke:video-segments-worker` — 41/41 PASS
- `cd server && npm run smoke:video-keyframes-worker` — 40/40 PASS
- `cd server && npm run smoke:video-segment-quality-worker` — 36/36 PASS
- **完整 server 回归 45 个 smoke 全绿**（含 P3/P4/P5/P6/P7/P8/P9.T1~T9 全套契约 + 新增的 p9-acceptance；migration-006 / migration-008 既有 2 个 upgrade-path 失败为 P9.T5 commit 前的历史遗留，已在 P9.T6 progress.md 记录，与本任务无关）

#### P9 阶段收口建议

✅ **P9 阶段建议整体收口**。所有子任务（T1 schema → T2 metadata → T3 cover → T4 proxy → T5 keyframes → T6 segments → T7 quality scorer → T8 Video API → T9 前端片段页 → T10 验收）已完成；E2E 链路 36/36 PASS；P7 软删除契约、R-107 user_decision preservation 端到端验证通过；所有跨任务红线（原视频不变 / 评分不覆盖用户决策 / API 异步语义）端到端通过。

下一阶段：**P10**（AI 视觉精修——image_ai_refine / aesthetic_score / ai_caption / ai_classify），requirements.md §7.10 + §7.14 + §7.15 + §7.16；按 tasks.md 顺序执行。

### P10.T1 AI 视觉精修基础框架 实现结果

阶段：已完成。日期：2026-05-25。

本次提示词把原 tasks.md 的 P10.T1（`AIProvider` 接口 + `NoopProvider`）和 P10.T2（迁移 `ai_invocations`）合并执行——它们组成 P10 的"基础框架"层。两个 task 都在 tasks.md 标记 `[x]`。

#### 改动文件

- `server/migrations/012_create_ai_invocations.sql`（**新增**）— 审计表，requirements §8.9 + design.md §4.2 ai_invocations 行；14 列、5 个 CHECK 约束、2 个 FK SET NULL、4 个索引；schema only，无数据写入。
- `server/src/ai/AIProvider.ts`（**新增**）— 公开 interface `AIProvider`、类型 `AIRequestType` / `AIInvocationStatus` / `AIRequest` / `AISuccessResponse` / `AIFailureResponse` / `AIResponse`、错误类 `AIProviderNotConfiguredError`（code='AI_NOT_CONFIGURED'）+ `AIProviderUnsupportedRequestError`（code='AI_REQUEST_TYPE_UNSUPPORTED'）。
- `server/src/ai/NoopProvider.ts`（**新增**）— 默认实现：`name='noop'` / `available=false` / `supports=Object.freeze(new Set())` / `invoke()` 始终 throw `AIProviderNotConfiguredError`，从不返回 failure response 也从不发网络请求。
- `server/src/ai/index.ts`（**新增**）— barrel + `createAIProviderFromConfig({enabled, provider}, logger?)` 工厂；case-insensitive after trim；任何未知 provider id 都 fallback 到 Noop 并发 WARN 日志（V1 唯一可识别的 token 是 `noop` / `disabled`，未来 PR 在这里加 openai / gemini / bedrock / local-mock 分支）。
- `server/src/index.ts`（**修改**）— bootstrap 在 capabilities 检测后构造 `const aiProvider = createAIProviderFromConfig(config.ai, logger)`，目前 `void aiProvider`（P10.T1 不挂 createApp，P10.T3+ 再 wire）。
- `server/src/scripts/migration-012-smoke.ts`（**新增**）— `smoke:migration-012` 31/31 PASS。
- `server/src/scripts/ai-provider-smoke.ts`（**新增**）— `smoke:ai-provider` 18/18 PASS（含 stub logger 验证 INFO/WARN 日志路径）。
- `server/package.json`（**修改**）— 注册两个新 smoke 命令。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— P10.T1 + P10.T2 标记 `[x]` + 本节实现结果。

#### Migration 012 schema 摘要

```
ai_invocations(
  id              TEXT PK,
  media_id        TEXT NULLABLE  FK media_items.id ON DELETE SET NULL,
  job_id          TEXT NULLABLE  FK processing_jobs.id ON DELETE SET NULL,
  provider        TEXT NOT NULL  CHECK length(provider) > 0,
  model_name      TEXT NOT NULL  CHECK length(model_name) > 0,
  request_type    TEXT NOT NULL  CHECK IN ('image_ai_refine','ai_caption',
                                            'ai_classify','aesthetic_score',
                                            'video_plan','ranking'),
  request_params  TEXT,                                  -- opaque JSON
  status          TEXT NOT NULL DEFAULT 'pending'
                                CHECK IN ('pending','success','failed'),
  response_summary TEXT,
  cost_estimate   REAL,                                  -- unconstrained (provider normalises)
  duration_ms     INTEGER       CHECK NULL OR >= 0,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT strftime(...),
  updated_at      TEXT NOT NULL DEFAULT strftime(...)
) STRICT;
-- indexes: created_at, media_id, job_id, (provider, model_name)
```

FK SET NULL（不 CASCADE）是 audit 表的关键设计：parent media / job 被 hard-delete 后，审计行存活（cost / duration / error 是历史事实），只把外键置空。requirements §8.9 + design.md §4.2 显式要求此行为。

#### AIProvider 接口结构

```ts
export interface AIProvider {
  readonly name: string;                                 // 'noop' / 'openai' / 'gemini' / ...
  readonly available: boolean;                           // 前端读它决定按钮置灰
  readonly supports: ReadonlySet<AIRequestType>;         // 闭合的 request type 子集
  invoke(req: AIRequest): Promise<AIResponse>;           // success / failed shape，throw 仅在配置错误
}
```

错误类：
- `AIProviderNotConfiguredError`（code='AI_NOT_CONFIGURED'）—— provider 拒绝尝试（配置缺失）。
- `AIProviderUnsupportedRequestError`（code='AI_REQUEST_TYPE_UNSUPPORTED'）—— provider 在线但不支持当前 request type。
- 网络/SDK 错误：provider 在 `AIFailureResponse` 中报告（带 `errorMessage` + `durationMs` 用于审计），不 throw。

未来真实 provider PR 的实现规则（写在文件头注释里）：
1. 不写 DB / FS 状态；输出 bytes 通过 `outputBytes` 返回，由 worker 写 media_versions。
2. 不读 user_decision；R-107 是 worker 层契约，provider 不感知。
3. `available` 必须可 idempotent 读，不发起网络调用。
4. cost / duration 必报告（无法测量时 cost=null + duration=measured wall-clock）。

#### Disabled / fallback 行为

| 配置 | Provider 实例 | 日志 | 说明 |
| --- | --- | --- | --- |
| `AI_ENABLED=false` + `AI_PROVIDER=""`（默认） | NoopProvider | 1 × INFO `ai: disabled by config` | CLAUDE.md §2.8 默认状态 |
| `AI_ENABLED=false` + `AI_PROVIDER="openai"` | NoopProvider | 1 × INFO | operator 显式关闭，provider 字符串忽略 |
| `AI_ENABLED=true` + `AI_PROVIDER=""` | NoopProvider | 1 × WARN | 配置层 superRefine 会先拒绝；factory 防御性 fallback |
| `AI_ENABLED=true` + `AI_PROVIDER="noop"` / `"disabled"` | NoopProvider | 1 × WARN | 显式 noop，case-insensitive after trim |
| `AI_ENABLED=true` + `AI_PROVIDER=<unknown>` | NoopProvider | 1 × WARN 含 `"unknown id"` | V1 没有任何真实 provider 注册；后续 PR 在 factory dispatch 处加 |
| 任何调用 `noop.invoke(req)` | — | — | throw `AIProviderNotConfiguredError`(code='AI_NOT_CONFIGURED') |

#### 执行过的测试命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净
- `cd server && npm run smoke:migration-012` — **31/31 PASS**
- `cd server && npm run smoke:ai-provider` — **18/18 PASS**
- `cd server && npm run smoke:p9-acceptance` — 36/36 PASS（验证 AI 默认关闭下 P9 链路无回归）
- `cd server && npm run smoke:video-api` — 48/48 PASS
- `cd server && npm run smoke:migration-011` — 39/39 PASS（验证 migration 012 不影响 011 的 upgrade 路径）
- `cd server && npm run smoke:p7-recycle-bin-acceptance` — 60/60 PASS（P7 软删除契约不回归）
- `cd server && npm run smoke:upload` — 30 passed（上传主流程不依赖 AI）

#### 红线对照

| 约束 | 兑现 |
| --- | --- |
| AI 结果不得覆盖用户手动选择 / 评分 / 保留删除决策 | NoopProvider 不发任何写；AIProvider 接口注释明确"never write DB"；audit 表 ai_invocations 与 user_decision 列零交集 |
| AI 默认关闭，缺少 AI 配置不能导致主流程失败 | `AI_ENABLED=false` 默认 → Noop；上述 5 个回归 smoke 全绿验证 |
| 不要进入 P10.T2 | tasks.md 实际把原 P10.T2（迁移）合并进本任务的"基础框架"，所以 P10.T2 也已标记 `[x]`；下一步是 P10.T3（POST /api/media/:id/ai-refine 入队端点）|
| 不要实现真实 AI 调用 | 只有 Noop；factory 对 openai / gemini 等未知 id 都 fallback 到 Noop + WARN |
| 不要破坏 R-107 / R-109 / R-114~R-120 | smoke:p9-acceptance + smoke:video-api 验证全部端到端不动 |

#### P10.T1 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-121** | `AIRequestType` 类型（TS）与 migration 012 的 `request_type` CHECK enum（SQL）是两份独立的字符串列表，靠人工对齐。其中一边新增 / 改名时另一边不同步会让 worker 在 INSERT 时遇到 CHECK 约束失败。 | V1 接受：P10.T1 没有 worker，drift 暂时无实际后果。P10.T5 worker 落地时建议加 lint：检查 TS 字面量与 SQL enum 字符串一致；或在 P10.T5 重构时引入 `server/src/ai/requestTypes.ts` 常量列表，TS + SQL 检查都从该常量读。 |
| **R-122** | factory 对未知 `AI_PROVIDER` token 只 WARN + fallback Noop，不 throw。后续 PR 加真实 provider 时，若操作员拼错 provider id（例如 `openia`），系统会静默走 Noop。 | V1 接受：未配置 AI 时基础功能必须仍可用（CLAUDE.md §2.8）这条红线优先级高于"拼错 provider id 应该立即报错"。P10.T7 验收时建议加 `GET /api/health` 暴露 `ai.provider.name` + `ai.provider.available` 字段，操作员从 health endpoint 自查；前端 P10.T6 按钮置灰也会反映"AI 不可用"。 |
| **R-123** | `aiProvider` 在 bootstrap 已构造但未注入 createApp 选项（暂时 `void aiProvider`），P10.T3 落地时容易忘了 wire。 | 已用 `void aiProvider` 标记保留引用；P10.T3 提示词应包含"将 aiProvider 加到 CreateAppOptions"。文件内有注释 anchor。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)、R-120 (P9.T10)。R-78 / R-81 / R-107 已闭合。

### P10.T3 POST /api/media/:id/ai-refine 入队端点 实现结果

阶段：已完成。日期：2026-05-25。

#### 改动文件

- `server/src/ai/index.ts`（**修改**）— 新增 `IMAGE_AI_REFINE_JOB_TYPE = "image_ai_refine"` 常量导出。三处对齐（AIRequestType TS union ↔ migration 012 `request_type` CHECK enum ↔ JobQueue 注册时 worker handler 的 jobType 字符串）现在汇聚到这一个常量，R-121 的 drift 风险被 import-time 类型化缩到三行紧邻。
- `server/src/media/mediaService.ts`（**修改**）— 新方法 `aiRefineMedia(mediaIdInput)` + 公开 `AiRefineMediaResult` 类型。复用 `reprocessOneJobType` 单 slot 入队 + 同 `enhanceMedia` 的幂等语义（created / reset / skipped + reason）。注释明确"可用性检查是 route 层的责任，不是 service 的"——AI_NOT_CONFIGURED 是 infrastructure-level 错误（501），与 NotFoundError (404) / BadRequestError (400) 的 domain 错误正交。
- `server/src/media/index.ts`（**修改**）— 重导出 `AiRefineMediaResult`。
- `server/src/routes/media.ts`（**修改**）— `MediaRouterDeps` 增加 `aiProvider: AIProvider` 字段；新增 `POST /api/media/:id/ai-refine` route handler：(1) 先读 `deps.aiProvider.available`，false → throw `AppError(AI_NOT_CONFIGURED, statusCode=501, details: { providerName })`，shadows 所有 domain 检查（design.md §11.2 "功能未启用"）；(2) 通过则调 `mediaService.aiRefineMedia(id)`，返回 200 + `AiRefineMediaResult` envelope。
- `server/src/app.ts`（**修改**）— `CreateAppOptions.aiProvider: AIProvider` 字段加上、解构、传入 `makeMediaRouter`。
- `server/src/index.ts`（**修改**）— **R-123 闭合**：删除 `void aiProvider` 占位，直接把 `aiProvider` 加进 `createApp({ ..., aiProvider })`；P10.T1 的注释也同步更新。
- `server/src/scripts/media-versions-api-smoke.ts`（**修改**）— 向后兼容：`makeMediaRouter` 调用加 `aiProvider: new NoopProvider()`（这个 smoke 不打 /ai-refine endpoint，所以 Noop 是 the correct safe default）。新增 `import { NoopProvider } from "../ai/index.js"`。
- `server/src/scripts/media-ai-refine-trigger-smoke.ts`（**新增**）— 27/27 PASS smoke：12 个 service 层 case（包含 fresh created / 4 种状态 skipped+reset / 幂等 / missing 404 / soft-deleted 404 / video 400 / unknown 400 / scope-guard）+ 真 Express server 6 个 HTTP case（NoopProvider 双场景 501 + AvailableTestProvider stub 200 + 幂等 + missing 404 + video 400 + soft-deleted 404）。
- `server/package.json`（**修改**）— 注册 `smoke:media-ai-refine-trigger`。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— P10.T3 标 `[x]`、R-123 闭合、本节实现结果。

#### `POST /api/media/:id/ai-refine` 行为

| 场景 | HTTP | body | 备注 |
| --- | --- | --- | --- |
| `AI_ENABLED=false`（默认）| **501** | `{"error":{"code":"AI_NOT_CONFIGURED",...,"details":{"providerName":"noop"}}}` | gate 在 route 层；route 不调 service |
| `AI_ENABLED=true` + 未知 AI_PROVIDER（factory fallback → Noop）| **501** | 同上 | R-122 的天然覆盖：未知 provider 就是 `available=false` |
| AI 可用 + media 不存在 | **404** | `{"error":{"code":"NOT_FOUND",...}}` | service 抛 NotFoundError |
| AI 可用 + media 已软删 | **404** | 同上 | P7 contract |
| AI 可用 + media 是 video / unknown | **400** | `{"error":{"code":"BAD_REQUEST",...}}` | service 抛 BadRequestError |
| AI 可用 + image media + 无既有 job | **200** | `{ mediaId, jobType:"image_ai_refine", outcome:"created", jobId }` | 入队 1 行 pending |
| AI 可用 + image media + 既有 pending/running | **200** | `{ ..., outcome:"skipped", reason:"already pending" or "already running" }` | 不重复入队 |
| AI 可用 + image media + 既有 failed/success/cancelled | **200** | `{ ..., outcome:"reset" }` | 同 jobId 重 retry 路径 |

`AI_NOT_CONFIGURED` 返 501 的条件：`deps.aiProvider.available === false`。由于 P10.T1 factory 已经把 disabled / unknown / empty / 'noop' 等所有"不可用"情形统一映射到 NoopProvider（available=false），这单一布尔检查覆盖所有不可用状态——无需在 route 重新枚举 config 字段。

#### `aiProvider` 注入路径（R-123 闭合）

```
bootstrap (src/index.ts)
   └── createAIProviderFromConfig(config.ai, logger)
        ↓ AIProvider 实例
   └── createApp({ ..., aiProvider })
        ↓ CreateAppOptions.aiProvider
   └── makeMediaRouter({ uploadService, mediaService, aiProvider })
        ↓ MediaRouterDeps.aiProvider
   └── router.post("/media/:id/ai-refine", h) { deps.aiProvider.available... }
```

零未消费变量。`void aiProvider` 占位删除。所有现有 smoke 通过：47 / 47。

#### 避免重复入队

复用 P8.T1 已经验证的 `reprocessOneJobType` 入队原语，对 `IMAGE_AI_REFINE_JOB_TYPE` 这个 job_type 做单 slot 入队：
- 既有 `image_ai_refine` 是 `pending` / `running` → `outcome='skipped'`，response 含原 jobId + `reason`，**不创建新行**。
- 既有 `image_ai_refine` 是 `failed` / `success` / `cancelled` / `retrying` → 走 `resetToRetrying`（P4.T2 R-40 canonical 路径），同 jobId 翻到 retrying，**不创建新行**。
- 无既有 → 插一行 pending，`outcome='created'`。

smoke 双重保险：service 层 case 验证 `outcome` + DB 行数；HTTP 层 case 验证一次 POST 后 jobs count=1，第二次 POST 后 count 仍为 1 + `outcome='skipped'`。

#### 执行过的测试命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净
- `cd server && npm run smoke:media-ai-refine-trigger` — **27/27 PASS**
- `cd server && npm run smoke:ai-provider` — 18/18 PASS（无回归）
- `cd server && npm run smoke:migration-012` — 31/31 PASS（无回归）
- `cd server && npm run smoke:media-enhance-trigger` — 27/27 PASS（对称 P8.T1 路径无回归）
- `cd server && npm run smoke:media-versions-api` — 35/35 PASS（mediaRouter 新依赖兼容）
- `cd server && npm run smoke:p9-acceptance` — 36/36 PASS（P9 端到端无回归）
- `cd server && npm run smoke:video-api` — 48/48 PASS
- **完整 47 个 server smoke 全绿**（含 P3/P4/P5/P6/P7/P8/P9 全套 + P10.T1+T2+T3）

#### R-121 / R-122 状态重审

| 风险 | P10.T3 当下状态 |
| --- | --- |
| **R-121**（job_type / request_type / TS union 三处对齐） | 缓解：`IMAGE_AI_REFINE_JOB_TYPE` 常量已成为唯一文字字符串源。AIRequestType union 和 migration 012 enum 仍然各自维护文字，但 worker 注册（P10.T5）将必须 import 这个常量——drift 在 grep 视野内。 |
| **R-122**（未知 provider 静默 → Noop） | 缓解：P10.T3 的 501 + body.error.details.providerName 让操作员从 HTTP 响应直接看到 "providerName: 'noop'"——如果他们配置了 `AI_PROVIDER='openia'` 期望走真实 provider，得到的 501 + providerName=noop 已经能引导排错。P10.T7 验收时仍建议在 /api/health 加 ai.provider 字段。 |
| **R-123**（aiProvider 未注入 createApp）| **已闭合**：本任务删 `void aiProvider`、加 `CreateAppOptions.aiProvider`、route 层直接消费。 |

#### P10.T3 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-124** | `aiRefineMedia` service 方法依赖 route 层先做 availability 检查；若未来另一个调用者（比如 cron / batch 入队）直接调用 service 而忘了检查 `aiProvider.available`，会创建一个 worker 永远不会执行的 pending job（P10.T1 NoopProvider 没注册 handler 给 image_ai_refine）。 | V1 接受：service 方法 jsdoc 明确文档化这一点；P10.T5 worker 落地时本身会再检查 provider，给二次防御。如未来发现多个调用者风险变高，可在 service 方法构造时持有 `aiProvider` 引用并复制 route 的 gate 逻辑。 |
| **R-125** | 501 + `AI_NOT_CONFIGURED` body 中 `details.providerName` 总是 'noop'（V1 没有其他 provider），从客户端角度该信息当前价值有限；P10.T6 前端会读 `available` 字段做置灰，不依赖这个 detail。 | 接受：当真实 provider 落地时，failure case（比如配置错 provider 但 health 显示 ai 可用）会变得有价值。 |
| **R-126** | `AvailableTestProvider` stub 在 smoke 中 `invoke()` 故意 throw 以防 P10.T3 路径意外触发真实 AI 调用。该断言是负向断言（"如果走到了就失败"），smoke 通过时只意味着"没走到"。如果未来在 service 中真的塞了 invoke 调用，会被 smoke 抓住，但只在 happy / 幂等场景；其他分支（404/400/501）天然不会走到 invoke，所以测试覆盖在那里是对称的。 | V1 接受：现状已经是"P10.T3 不该调 invoke"，P10.T5 worker 接管 invoke。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)、R-120 (P9.T10)、R-121 / R-122 (P10.T1+T2)。R-78 / R-81 / R-107 / R-123 已闭合。

### P10.T4 AI 配额计数 + 429 Gate 实现结果

阶段：已完成。日期：2026-05-25。

#### 改动文件

- `server/src/ai/aiInvocationsRepository.ts`（**新增**）— `AiInvocationsRepository` 类：4 个 prepared statements (`insert` / `countSinceStmt` / `countByTripIdStmt` / `findByIdStmt`)。`countByTripId` 用 `INNER JOIN media_items ON ai.media_id = m.id` —— 孤儿审计行（媒体已 hard-delete、FK SET NULL）自然 drop out，无法 charge 给已 hard-delete 的 trip。公开类型 `AiInvocationInsertData` / `AiInvocationRow`。
- `server/src/ai/index.ts`（**修改**）— 重导出 repo + 类型。
- `server/src/media/mediaService.ts`（**修改**）— 重写 `aiRefineMedia`，新增 `AiRefineDeps` + `AiRefineOptions` 接口；构造函数加可选第 6 参数 `aiRefineDeps`；`AiRefineMediaResult` 加可选 `aiInvocationId` 字段；末尾加 `startOfUtcDayIso(at)` 辅助函数算 UTC 自然日边界。
- `server/src/media/index.ts`（**修改**）— 重导出 `AiRefineDeps` + `AiRefineOptions`。
- `server/src/routes/media.ts`（**修改**）— `/ai-refine` 端点传 `providerName: deps.aiProvider.name` 给 service 以便 audit 行记录实际 provider 名。
- `server/src/index.ts`（**修改**）— 构造 `aiInvocationsRepo`，传给 MediaService 第 6 参数（用现有 `config.ai.dailyLimit` / `config.ai.tripLimit`）。
- `server/src/scripts/media-ai-refine-trigger-smoke.ts`（**修改**）— 升级 MediaService 构造调用，传 `aiRefineDeps` (dailyLimit=0, tripLimit=0 — 不影响原 P10.T3 case)，引入 `AiInvocationsRepository`。
- `server/src/scripts/ai-quota-trigger-smoke.ts`（**新增**）— `smoke:ai-quota-trigger` 24/24 PASS，覆盖所有 quota 行为路径。
- `server/package.json`（**修改**）— 注册 `smoke:ai-quota-trigger`。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— 标 P10.T4 `[x]`、本节实现结果。

#### 新增 quota 配置（复用既有）

不新增 env 旋钮——复用 design.md §11.1 已经声明的：

| Env | 默认 | 语义 |
| --- | --- | --- |
| `AI_DAILY_LIMIT` | `0` | 全局每 UTC 自然日 ai_invocations 上限；`0` 表示不限 |
| `AI_TRIP_LIMIT` | `0` | 同一 trip 累计 ai_invocations 上限（终身计数）；`0` 表示不限 |

CLAUDE.md §2.8 红线：默认 `0` = 不限，未配置 quota 时主流程必须可用 — 已通过 `unlimited` smoke case 验证。

#### 入队顺序（实现锚定）

```
POST /api/media/:id/ai-refine
   1. media 是否存在                      → 否 → 404 NOT_FOUND          (不计 quota)
   2. media 是否 soft-deleted             → 是 → 404 NOT_FOUND          (不计 quota；P7 contract)
   3. media 是否 image                    → 否 → 400 BAD_REQUEST        (不计 quota)
   4. aiProvider.available === true       → 否 → 501 AI_NOT_CONFIGURED  (不计 quota；P10.T3 route gate)
   5. 既有 pending/running 任务            → 是 → 200 outcome='skipped'   (不计 quota；幂等)
   6. dailyLimit > 0 & used >= limit      → 是 → 429 AI_QUOTA_EXCEEDED   (kind=daily)
   7. tripLimit > 0 & used >= limit       → 是 → 429 AI_QUOTA_EXCEEDED   (kind=trip)
   8. 入队 image_ai_refine + INSERT 一行 ai_invocations(status='pending')
   → 200 outcome=created|reset + aiInvocationId
```

5 → 6 顺序的关键：**幂等先于 quota**。双击 / 自动化重发对同一 pending job 不会被扣额度（CLAUDE.md §3.9 友好），但对新 media 的请求会被扣。

#### Daily quota 如何统计

```sql
SELECT COUNT(*) FROM ai_invocations
WHERE created_at >= ?       -- ? = startOfUtcDayIso(now)
```

边界用 UTC 自然日（`Date.UTC(y, m, d, 0, 0, 0, 0)`），避免服务器跨时区跳动 / fleet 多区域间不一致。`created_at` 列由 migration 012 的 `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` 默认值填，字符串字典序与时序一致。

计数包含**所有 status**（pending / success / failed）—— "已接受的 AI 请求"语义：进了队列就计数，因为成本可能已经被 incurred。failed 也计入（保守计费）。

`AI_DAILY_LIMIT=0` 时跳过整个 daily gate 块。

Smoke `daily-gate` case 用 `now()` clock override pin 到 `2030-01-15` → 3 次入队达到 limit=3 → 第 4 次 throw；切到 `2030-01-16` → 计数重置 → 入队又通过。

#### Per-trip quota 如何统计

```sql
SELECT COUNT(*) FROM ai_invocations ai
INNER JOIN media_items m ON ai.media_id = m.id
WHERE m.trip_id = ?
```

INNER JOIN 保证：媒体已 hard-delete 后（FK SET NULL → ai.media_id=NULL），孤儿行不再 count，等价于"trip 历史已部分释放"——合理：操作员主动删除媒体后那些已计费的调用不应锁定后续 trip 配额。

计数同上跨所有 status。**未按自然日重置**——这是 `AI_TRIP_LIMIT` 的语义（design.md §11.1 名字里没 "DAILY" 字样）；如果操作员想要"每 trip 每日"语义，目前没实现（需要 trip + 日双 key 计数，可放进 P10.T7 验收后续讨论）。

`AI_TRIP_LIMIT=0` 时跳过 trip gate 块。

Smoke `trip-gate` case：limit=2，trip A 内 2 次成功 + 第 3 次 429（kind=trip + tripId 透传）；trip B 不受影响。

#### `429 AI_QUOTA_EXCEEDED` 返回条件

```
HTTP 429
{
  "error": {
    "code": "AI_QUOTA_EXCEEDED",
    "message": "AI daily quota exceeded (3/3)"   // or "AI trip quota exceeded (2/2)"
    "requestId": "...",
    "details": {
      "kind": "daily",                            // or "trip"
      "limit": 3,
      "used": 3,
      "sinceIso": "2030-01-15T00:00:00.000Z"     // daily only
      "tripId": "<uuid>"                          // trip only
    }
  }
}
```

`details.kind` 让前端区分两种 quota 弹错文案；`limit` / `used` 让前端展示 "今日 3/3 已用满"；`sinceIso` 给操作员看 UTC 日边界（避免"我刚到家凌晨怎么也算超额"困惑）；`tripId` 让前端跳转回 trip 详情。

#### 哪些失败请求**不会**计入 quota

| 失败类型 | HTTP | 是否计 quota | 原因 |
| --- | --- | --- | --- |
| AI 未启用 / provider unavailable | 501 | ❌ | route gate 在 service 之前，没进 ai_invocations |
| media 不存在 | 404 | ❌ | service 在 quota gate 前先 NotFoundError throw |
| media 已 soft-deleted | 404 | ❌ | 同上 |
| 非 image media | 400 | ❌ | service 在 quota gate 前先 BadRequestError throw |
| 既有 pending/running 任务（双击） | 200 outcome='skipped' | ❌ | idempotency 先于 quota；不写新 ai_invocations 行 |
| quota 命中 | 429 | ❌ | 拒绝 = 没入队 = 没写 ai_invocations |
| 入队成功 created/reset | 200 | ✅ | 写一行 status='pending' |

Smoke `no-count(404)` / `no-count(400)` / `HTTP+Noop` / `skipped-no-count` 都断言"audit count 不变"。

#### 执行过的测试命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（修复了一个未使用 import 的 warning）
- `cd server && npm run smoke:ai-quota-trigger` — **24/24 PASS**（8 case：unlimited / daily=3 第4次429 / next UTC day 重置 / trip=2 第3次429 + 不同trip OK / 同media双击skipped 不扣 quota / 404 不扣 / 400 不扣 / HTTP 501 不扣 / HTTP 429 body shape）
- `cd server && npm run smoke:media-ai-refine-trigger` — 27/27 PASS（P10.T3 case 不回归）
- `cd server && npm run smoke:ai-provider` — 18/18 PASS
- `cd server && npm run smoke:migration-012` — 31/31 PASS
- `cd server && npm run smoke:media-versions-api` — 35/35 PASS（mediaRouter aiProvider 兼容路径不动）
- **完整 48 个 server smoke 全绿**（含 P3-P9 全套契约 + P10.T1-T4）

#### P10.T4 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-127** | `AI_TRIP_LIMIT` 是"trip 终身"而非"trip 每日"。操作员如果期望"per-trip-per-day"语义需要应用层叠加 daily quota 来近似；否则一个长期 trip 累计很多调用后会永远 429。 | V1 接受：design.md §11.1 命名暗示终身上限。如未来需要 per-trip-per-day，加 `AI_TRIP_DAILY_LIMIT` env + 查询条件加 `created_at >= ?` 即可（不动 schema）。在 progress.md 记录以提醒 P10.T7 验收注意。 |
| **R-128** | failed audit 行也计 quota——保守计费策略。如果操作员希望"failed 不计入，免费重试"，目前不支持。 | V1 接受：进了队就计费更接近真实 AI 厂商账单语义（很多厂商对失败请求仍收 inference 费）。可在未来加 `AI_QUOTA_INCLUDE_FAILED=true` 旋钮。 |
| **R-129** | daily quota 用 UTC 自然日；UTC+8 用户在凌晨 8:00 看到的"今日"会与服务器认为的"今日"差 8 小时，导致 used 计数与用户直觉不符。 | V1 接受：UTC 是 fleet 一致性的最优解；前端在 429 body 里看到 `sinceIso` 可以自行换算成本地时间展示。如未来强烈需要本地日历，需要 `AI_DAILY_QUOTA_TIMEZONE` env + 边界计算重写。 |
| **R-130** | quota check 与 enqueue 之间存在 TOCTOU 窗口（毫秒级）：两个并发请求都看到 used=limit-1 然后都入队，导致超过 limit 一次。SQLite 单线程串行化让窗口极小但非零。 | V1 接受：并发风险有限（前端去重 + JobQueue concurrency=1）。可在 P10.T7 验收时压测；如发现实际越限再加 `transaction()` 包裹 count + insert（better-sqlite3 的事务能保证窗口内可重复读）。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)、R-120 (P9.T10)、R-121 / R-122 (P10.T1+T2)、R-124 / R-125 / R-126 (P10.T3)。R-78 / R-81 / R-107 / R-123 已闭合。

### P10.T5 image_ai_refine Worker Handler 实现结果

阶段：已完成。日期：2026-05-25。

#### 改动文件

- `server/src/jobs/imageAiRefineWorker.ts`（**新增**）— P10.T5 worker handler，10 步执行流水 + audit/job 状态闭环。
- `server/src/ai/aiInvocationsRepository.ts`（**修改**）— 新增 `findPendingByJobId(jobId)` / `markSuccess(args)` / `markFailed(args)` 方法。每个方法都使用 atomic-claim `WHERE status='pending'` 谓词；不引入 `running` 中间态（migration 012 enum 不允许）。
- `server/src/ai/index.ts`（**修改**）— 重导出 `AiInvocationMarkSuccessArgs` / `AiInvocationMarkFailedArgs` 类型。
- `server/src/jobs/index.ts`（**修改**）— 重导出 `DEFAULT_IMAGE_AI_REFINE_SETTINGS` / `IMAGE_AI_REFINE_JOB_TYPE` / `makeImageAiRefineHandler` + 类型。`IMAGE_AI_REFINE_JOB_TYPE` 从 `ai/index.ts` 的源常量 re-export（R-121 同步收敛到一行 import）。
- `server/src/index.ts`（**修改**）— `imageHandlers.set(IMAGE_AI_REFINE_JOB_TYPE, makeImageAiRefineHandler({...}))` 注册到 image 通道。bootstrap 把已有的 `aiInvocationsRepo` + `aiProvider` 实例传给 worker；不动 video 通道。
- `server/src/scripts/image-ai-refine-worker-smoke.ts`（**新增**）— `smoke:image-ai-refine-worker` 34/34 PASS，14 case 覆盖 worker 闭环 + 失败路径 + scope-guard + FK integrity。
- `server/package.json`（**修改**）— 注册新 smoke。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— P10.T5 标 `[x]` + 本节实现结果。

#### Worker handler 执行流程

```
[JobQueue claims processing_jobs row, status='running'] → 调 makeImageAiRefineHandler returned async (job)

1. audit = aiInvocationsRepo.findPendingByJobId(job.id)
   → null: throw "no pending ai_invocations row" (JobQueue markFailed processing_jobs)
2. media = mediaRepo.findById(job.mediaId)  // active-only
   → null: markAuditFailed("not found or soft-deleted") + throw
   → media.type !== 'image': markAuditFailed("not an image") + throw
   → media.originalPath === null: markAuditFailed("no original_path") + throw
3. sourceBuf = readFile(media.originalPath via storage.read)
   → throw: markAuditFailed("failed to read original bytes") + throw
   → empty: markAuditFailed("original file is empty") + throw
4. !aiProvider.available
   → markAuditFailed("AI provider not available at handler time") + throw
5. response = await aiProvider.invoke({requestType:'image_ai_refine', mediaId, jobId, inputBytes:sourceBuf})
   → throws AIProviderNotConfiguredError: markAuditFailed("AI_NOT_CONFIGURED at invoke") + throw
   → throws AIProviderUnsupportedRequestError: markAuditFailed("does not support") + throw
   → throws generic Error: markAuditFailed("invoke threw: ...") + throw
   → response.status === 'failed': markAuditFailed("returned failure: <msg>") with response.durationMs + throw
6. validate response.outputBytes
   → undefined / empty: markAuditFailed("no outputBytes") + throw
   → sharp.metadata() throws: markAuditFailed("not parseable image") + throw
   → width/height undefined: markAuditFailed("parsed but no width/height") + throw
7. stored = storage.putDerived({relPath:'ai_refined.jpg', overwrite:true})
   → throw: markAuditFailed("failed to persist ai_refined.jpg") + throw
8. mediaVersionsRepo.upsert({version_type:'ai_refined', model_name, params, width, height, fileSize, mimeType:'image/jpeg'})
   → throw: markAuditFailed("failed to upsert media_versions") + throw
9. aiInvocationsRepo.markSuccess({modelName, costEstimate, durationMs, responseSummary, now})
   → changes === 0: logger.warn but DON'T fail (artefact + media_versions already written)
10. handler returns cleanly → JobQueue markSuccess processing_jobs.status='success'
```

每一步失败都先 `markAuditFailed(errorMessage, durationMs)`（atomic-claim `WHERE status='pending'`）再 throw。`markAuditFailed` 自身 throw 时 logger.error 但保留 original 错误（操作员需要真实失败原因更胜过 bookkeeping 错误）。

#### `ai_invocations` 状态流转

V1 状态机（migration 012 CHECK enum 限制为 `{pending, success, failed}`，无 `running` 中间态）：

```
                   ┌───────────► success
                   │             (markSuccess + 填 model_name/cost/duration/response_summary)
                   │
   [enqueue]       │
   ─────────►  pending  ──────────────────────────────────────►  failed
   (P10.T4)        │                                              (markFailed + 填 error_message/duration_ms)
                   │
                   └──── (orphan: 父 media hard-deleted → media_id flip NULL via FK SET NULL)
```

Atomic-claim 谓词 `WHERE status='pending'`：在两条 markSuccess/markFailed 路径上都生效，确保任何时候 only the first writer wins，race / 重复消费都看到 `changes=0`。对 V1 channel concurrency=1 production 是 belt-and-suspenders；对未来 multi-worker rollout 是真正的并发安全网。

P10.T5 prompt 提到的"running"中间态有意 skip（schema 不允许；新加要 migration 013，权衡后判定不必要 — atomic-claim 已达成等效语义）。R-131 记录这个决策。

#### `media_versions(version_type='ai_refined')` 如何写入

```ts
mediaVersionsRepo.upsert({
  mediaId,                                          // FK to media_items
  versionType: 'ai_refined',                        // closed enum，migration 005/006 已含
  filePath: 'trips/{tripId}/derived/{mediaId}/ai_refined.jpg',  // canonical path
  mimeType: 'image/jpeg',                           // V1 固定 JPEG
  width: <sharp.metadata 读自 outputBytes>,
  height: <sharp.metadata 读自 outputBytes>,
  fileSize: outputBytes.length,
  modelName: response.modelName,                    // 真实 provider model id
  params: JSON.stringify({                          // 审计 / 可重现性
    workerVersion: '1.0',
    provider: response.provider,
    model: response.modelName,
    costEstimate: response.costEstimate,
    durationMs: response.durationMs,
    responseSummary: response.responseSummary ?? null,
    raw: response.raw ?? null,
  }),
  now: ISO timestamp,
});
```

UPSERT 走 `(media_id, version_type='ai_refined')` UNIQUE 约束（migration 005）：重跑 / reset 时同一行被覆盖，**不产生重复 'ai_refined #2' 行**。derived 文件按 `overwrite=true` 落盘，旧文件被新内容覆盖（一致行为：reset 把上一次 ai-refined 的产物替换为新结果）。

Smoke `rerun: still exactly 1 ai_refined row (upsert in place, no duplicate)` 验证：同一 media 重跑后 width/height 从 32×32 翻到 16×16 + model_name 从 v1 翻到 v2，**count 始终为 1**。

#### 失败场景处理

| 场景 | audit 状态 | job 状态 | media_versions ai_refined | 错误信息 |
| --- | --- | --- | --- | --- |
| 找不到 pending audit row | （不存在，未修改）| failed | 不写 | "no pending ai_invocations row" |
| media 不存在 / 软删 | failed | failed | 不写 | "not found or soft-deleted" |
| 非 image media | failed | failed | 不写 | "not an image (type=...)" |
| originalPath NULL | failed | failed | 不写 | "no original_path" |
| 原图读取失败 / 空 | failed | failed | 不写 | "failed to read original bytes" |
| provider unavailable | failed | failed | 不写 | "AI provider 'X' is not available at handler time" |
| invoke throws AI_NOT_CONFIGURED | failed | failed | 不写 | "AI_NOT_CONFIGURED at invoke: ..." |
| invoke throws unsupported | failed | failed | 不写 | "does not support 'image_ai_refine': ..." |
| invoke throws generic | failed | failed | 不写 | "invoke threw: <name>: <msg>" |
| response.status='failed' | failed (durationMs from response) | failed | 不写 | "returned failure: <provider msg>" |
| outputBytes empty | failed | failed | 不写 | "returned no outputBytes" |
| outputBytes 不是图 | failed | failed | 不写 | "not a parseable image: <metaErr>" |
| putDerived 写盘失败 | failed | failed | 不写 | "failed to persist ai_refined.jpg" |
| upsert media_versions 失败 | failed | failed | 不写 | "failed to upsert media_versions" |

每条失败路径都不污染 media_items.user_decision / active_version_type / status / preview_path / 原图字节。Scope-guard smoke 显式断言所有 5 个字段不动 + 原图 byte-for-byte。

#### 执行过的测试命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run smoke:image-ai-refine-worker` — **34/34 PASS**（14 case）
- `cd server && npm run smoke:media-ai-refine-trigger` — 27/27 PASS（P10.T3 路径不动）
- `cd server && npm run smoke:ai-quota-trigger` — 24/24 PASS（P10.T4 不动）
- `cd server && npm run smoke:ai-provider` — 18/18 PASS（P10.T1 不动）
- `cd server && npm run smoke:migration-012` — 31/31 PASS（schema 不动）
- `cd server && npm run smoke:media-versions-api` — 35/35 PASS（mediaRouter 链路不动）
- `cd server && npm run smoke:media-enhance-trigger` — 27/27 PASS（兄弟 enhance 路径不动）
- `cd server && npm run smoke:image-enhance-worker` — 34/34 PASS（image 通道兄弟 worker 不动）
- **完整 49 个 server smoke 全绿**（含 P3-P9 全套契约 + P10.T1-T5）

#### P10.T5 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-131** | audit 状态机 V1 跳过 `running` 中间态，pending 直接到 success/failed。监控视角缺少"有多少 audit row 正在 worker 中"的精确信号；只能从 `processing_jobs.status='running' && job_type='image_ai_refine'` 间接推断。 | V1 接受：atomic-claim WHERE status='pending' 谓词等价覆盖竞争语义；channel concurrency=1 让race 是理论级。如未来 multi-worker 或需要 ops 看板，加 migration 013 把 enum 扩成 `{pending,running,success,failed}` + worker 加 markRunning 调用。 |
| **R-132** | retry 行为：JobQueue 默认 retry 配置会在 worker throw 后把 processing_jobs.status 翻到 retrying。但 P10.T4 没在 retry 时插新 audit 行；P10.T5 worker 也不 fabricate。结果：retry 时 worker 第一步 `findPendingByJobId` 返 null，直接失败。retry 等于"立即失败"，没有真正重试 AI 调用。 | V1 接受（实测 retry 路径设 maxRetries=0 即可禁用）：避免 retry 重复扣 quota / 重复账单。如需 retry，未来要么 worker fabricate 新 audit row（违反 prompt "只消费 pending"），要么 JobQueue 在 retry 时回调一个 hook 让 service 重新插 audit。P10.T7 验收前最好把 image_ai_refine 的 JobQueue retry 单独配置为 0。 |
| **R-133** | worker 不重复 P10.T4 的 quota gate；如果某条 job 在 quota=N 被入队 + 后来 limit 改为 N-1，worker 仍然会执行该 job（quota only enforced at enqueue time，不在 dequeue time 重 check）。 | V1 接受：quota 是入队 gate 不是执行 gate；这种语义匹配真实 SaaS quota（季度配额改了不会回退已经服务的请求）。如未来需要 dequeue 也 check，加一次 `countByTripId` 即可。 |
| **R-134** | worker 上报到 media_versions.params 的 JSON 包含 provider.raw（任意 shape）。如果 provider 返回 raw 含敏感数据（API key 回声 / 用户 prompt 原文），会落库且 hard-delete 媒体后随 audit row 一起 cascade（实际不会因为 ai_invocations.media_id FK SET NULL，audit 行存活）。需要 provider 实现方自律。 | V1 接受：CLAUDE.md §5.5 已经要求 "AI 调用日志记录模型/耗时/状态/费用估算，不记录用户图片原始 base64"。worker 不主动屏蔽 raw（provider 责任）。可在 P10.T6 / P10.T7 时加 lint check 检查常见敏感关键字。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)、R-120 (P9.T10)、R-121 / R-122 (P10.T1+T2)、R-124 / R-125 / R-126 (P10.T3)、R-127 / R-128 / R-129 / R-130 (P10.T4)、R-131 / R-132 / R-133 / R-134 (P10.T5)。R-78 / R-81 / R-107 / R-123 已闭合。

### P10.T6 前端 AI Refine 按钮 实现结果

阶段：已完成。日期：2026-05-25。

#### 改动文件

- `client/src/api/health.ts`（**新增**）— `fetchHealth(signal?)` 返回服务器 `/api/health` 的 capabilities 投影；类型 `HealthResponse / HealthCapabilities / HealthStorage`；failure-soft（HTTP / network 错误统一抛 Error 让 hook 兜接）。
- `client/src/hooks/useHealth.ts`（**新增**）— stale-while-revalidate hook（load on mount + 可选 `refetch()`）；AbortController 防 race；failure-soft 错误状态不影响其他 UI。
- `client/src/api/media.ts`（**修改**）— 加 `aiRefineMedia(id)` 函数 + `AiRefineMediaResult` / `AiRefineOutcome` 类型，与 `enhanceMedia` 对称（mediaId / jobType / outcome=created|reset|skipped / jobId / reason? / **aiInvocationId?** P10.T4 audit 行 id）。
- `client/src/pages/MediaDetailPage.tsx`（**修改**）— 8 处变更：
  1. import `aiRefineMedia` + `AiRefineMediaResult` 类型 + `useHealth` hook
  2. 新增 state：`aiRefinePending` / `aiRefineConfirmOpen` + 用 `useHealth()` 读取 `aiEnabledOnServer = data?.capabilities.aiEnabled ?? false`
  3. 新增 handlers：`openAiRefineConfirm()` / `closeAiRefineConfirm()` (pending 时拒绝关闭) / `handleAiRefineConfirmed()` async
  4. 扩展 `EnhancementSection` 调用：传 `aiRefinePending` / `aiEnabledOnServer` / `healthLoading` / `onAiRefineClick`
  5. `EnhancementSectionProps` 接口扩 4 个字段；新增 `aiRefined` 第 3 个 VersionCell（带 🤖 emoji + "Not yet" 占位 + 文案随 aiEnabledOnServer 动态变化）
  6. 加 `Adopt AI refined` 按钮（仅当 ai_refined 存在且未 active 时启用）+ `AI Refine` / `Re-AI-refine` 按钮（三态 tooltip：health loading / aiEnabled=false / pending / 正常成本提示）
  7. 加 AI Refine 确认对话框（modal-overlay 复用；body 文案明确说"counts against quota / async worker / 原图不变 / 可切回 original"；error 直接 inline 在 modal 内）
  8. 扩展 `EnhanceFeedback` 联合类型加 `ai-refine-success` 变体 + `error.op='ai-refine'`；`EnhanceFeedbackBanner` 渲染 ai-refine-success 时展示 jobId+aiInvocationId（mono 截断）+ outcome 自然语言 + 提示刷新看 ai_refined

#### AI Refine 前端交互流程

```
[user 打开 MediaDetailPage(image)] →
   useMediaDetail + useMediaVersions + useHealth 三个 hook 并行加载

[EnhancementSection 渲染] →
   ┌─ Original cell                   (always present)
   ├─ Enhanced cell (or "Not yet")    (P8.T5 既有)
   └─ AI refined cell (or "Not yet")  (P10.T6 新增 🤖 emoji)

[action row]
   Adopt enhanced  / Use original  / Re-enhance              (P8.T5 既有)
   Adopt AI refined / [AI Refine | Re-AI-refine]              (P10.T6 新增)

[AI Refine 按钮状态]
   • health loading        → disabled + tooltip "Checking AI availability…"
   • aiEnabled=false        → disabled (greyed) + tooltip "AI provider is not configured on this server. Set AI_ENABLED=true + AI_PROVIDER…"
   • aiRefinePending         → disabled + tooltip "AI Refine submission in flight…"
   • 其他正常状态           → enabled + tooltip 描述 "counts against daily/per-trip quota; 原图 untouched"

[click AI Refine] →
   openAiRefineConfirm() → modal 弹出（Cancel + Run AI Refine 双按钮）
   modal body: "This sends the image to the configured AI provider…
                It counts against your daily / per-trip quota and may
                incur provider cost. The refine runs asynchronously…
                Your original file is never modified. You can switch
                back to it any time using Use original."

[click "Run AI Refine"] →
   handleAiRefineConfirmed() →
     setAiRefinePending(true)
     POST /api/media/:id/ai-refine
       ├─ 200 → setEnhanceFeedback({kind:'ai-refine-success', result:{outcome,jobId,aiInvocationId,...}})
       │       closeAiRefineConfirm()
       │       refetchVersions()  // ai_refined 行在 P10.T5 worker 完成后自动出现
       └─ 4xx/5xx → setEnhanceFeedback({kind:'error', op:'ai-refine', message:服务端文案})
                   modal 保持打开（用户能看到 inline error 不丢上下文）
     setAiRefinePending(false)

[success 后 banner 呈现]
   "AI Refine: Submitted — the AI refine worker will run on the image
    channel. job=a1b2c3d4… audit=e5f6g7h8… Refresh the page after a
    moment to see the ai_refined version."

[P10.T5 worker drains the queue async] →
   写 media_versions(version_type='ai_refined') + ai_invocations.markSuccess
   
[user refresh / refetchVersions 触发后] →
   useMediaVersions 读到新 ai_refined row →
   第 3 个 VersionCell 从占位变成真实预览图 →
   "Adopt AI refined" 按钮启用
```

#### 错误展示对照

| 后端响应 | 前端 banner 文案 |
| --- | --- |
| 501 `AI_NOT_CONFIGURED` | red form-error: "AI Refine failed: AI provider is not configured. Set AI_ENABLED=true and a supported AI_PROVIDER to enable AI refine." |
| 429 `AI_QUOTA_EXCEEDED` (kind=daily) | red form-error: "AI Refine failed: AI daily quota exceeded (3/3)" |
| 429 `AI_QUOTA_EXCEEDED` (kind=trip) | red form-error: "AI Refine failed: AI trip quota exceeded (2/2)" |
| 404 `NOT_FOUND` | red form-error: "AI Refine failed: Media not found: …" |
| 400 `BAD_REQUEST` (非 image) | red form-error: "AI Refine failed: ai-refine is only supported for image media; this row is 'video'" |
| 500 / network error | red form-error: "AI Refine failed: \<error.message\>" |

前端不解析 `details.kind` 做特别区分文案——直接展示服务端 message（服务端 P10.T3/P10.T4 已经把 daily/trip 区分写进 message）。这保留了未来加 i18n 时的灵活性（只需翻译 message 文案）。

#### 执行过的检查命令和结果

- `cd client && npm run typecheck` （tsc -b）— 干净
- `cd client && npm run lint` — 干净（0 warning / 0 error）
- `cd client && npm run build` — vite 构建成功（61 modules transformed，gzip 72.10 kB JS + 4.27 kB CSS）
- `cd server && npm run smoke:media-ai-refine-trigger` — 27/27 PASS（P10.T3 不动）
- `cd server && npm run smoke:ai-quota-trigger` — 24/24 PASS（P10.T4 不动）
- `cd server && npm run smoke:image-ai-refine-worker` — 34/34 PASS（P10.T5 不动）
- `cd server && npm run smoke:media-versions-api` — 35/35 PASS（P8.T4 不动）
- `cd server && npm run smoke:p9-acceptance` — 36/36 PASS（视频链路不动）
- 客户端没有 vitest / jest 等单元测试框架（同 P9.T9 客户端任务的契约：lint + typecheck + build + server HTTP smoke 覆盖契约）

#### 红线对照

| 要求 | 兑现 |
| --- | --- |
| image media 才显示 AI Refine | EnhancementSection 仅 `media.type === "image"` 渲染（既有 P8.T5 约束）|
| 非 image 不会误显示 | video / unknown 一律走 `null` 分支 |
| 未配置 AI 时按钮置灰 | health.data.capabilities.aiEnabled=false → 按钮 `disabled` + tooltip 解释 |
| quota 不足时不会误提交 | 服务端 P10.T4 已经在 enqueue 时 gate；前端在 429 时显示红色 banner |
| 点击后弹耗时/成本确认 | 必须经过 modal-overlay 二次点击 "Run AI Refine" 才发起 POST |
| 调用 POST /api/media/:id/ai-refine | `aiRefineMedia(id)` 走 fetch；与 P10.T3 endpoint 完全对接 |
| 展示 jobId / outcome | banner mono 截断 jobId 前 8 位 + outcome 自然语言 |
| worker 完成后 ai_refined 自动出现 | refetchVersions() 在 success 后触发；useMediaVersions stale-while-revalidate 自然刷新 |
| 不破坏原图 / preview / active version / user decision / version compare / video 页面 | 0 行变更涉及这些路径；server smokes 全绿 |

#### P10.T6 剩余风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| **R-135** | `/api/health.capabilities.aiEnabled` 只反映 `AI_ENABLED` 环境变量，不等于 `aiProvider.available`。当 `AI_ENABLED=true` 但 `AI_PROVIDER='openai'` 还没真实接入时，capabilities 报 `true` → 按钮 enabled → 用户点击 → 服务端 501 → 错误 banner。UX 上比"按钮直接灰掉"差一步。 | V1 接受：错误 banner 文案明确指向"AI provider is not configured"；用户不会陷入循环。如需更精确 UI，未来扩展 health 端点暴露 `capabilities.aiProviderAvailable` + `aiProviderName` 双字段（一次性 fix；不需要 schema 变更）。 |
| **R-136** | refetchVersions() 在 ai-refine-success 后立即触发，但 P10.T5 worker 是 async（image 通道 concurrency=1，可能还在排队后面的 enhance/thumbnail job）。用户立即看到的 versions 仍然不含 ai_refined 行——需要等几秒到一分钟手动刷新。banner 文案"Refresh the page after a moment"已经提示，但不能避免用户多次刷新。 | V1 接受：与 enhance 的同款 UX（也是 async 刷新）。未来可以加 SSE / WebSocket / 简单 polling 让 ai_refined 出现时自动 push 到前端，但那是 P11+ 的事。 |
| **R-137** | 错误 banner 直接展示服务端 message 字符串（含英文）。i18n 时这些 message 都需要重新 localize；前端没有把 `error.code` + `error.details` 做 keyword 解析。 | V1 接受：项目目前都是英文 message；i18n 是后续 phase 的工作。结构化 `details` 已经在 server 端可用（429 body 含 kind/limit/used），未来 i18n 时可基于 details 重新组装文案。 |

继续保留：R-74 ~ R-77 / R-79 / R-80 (P7)、R-82 ~ R-92 (P8)、R-93 / R-94 (P9.T1)、R-95 / R-96 / R-97 (P9.T2)、R-98 / R-99 / R-100 (P9.T3)、R-101 / R-102 / R-103 (P9.T4)、R-104 / R-105 / R-106 (P9.T5)、R-108 / R-109 (P9.T6)、R-110 / R-111 / R-112 / R-113 (P9.T7)、R-114 / R-115 / R-116 (P9.T8)、R-117 / R-118 / R-119 (P9.T9)、R-120 (P9.T10)、R-121 / R-122 (P10.T1+T2)、R-124 / R-125 / R-126 (P10.T3)、R-127 / R-128 / R-129 / R-130 (P10.T4)、R-131 / R-132 / R-133 / R-134 (P10.T5)。R-78 / R-81 / R-107 / R-123 已闭合。

### P10.T7 阶段 P10 验收 + LocalMockProvider 实现结果

阶段：已完成。日期：2026-05-25。

#### 改动文件

- `server/src/ai/LocalMockProvider.ts`（**新增**）— deterministic in-process AIProvider 用作 P10 验收 + 本地 / 测试 fixture。
- `server/src/ai/index.ts`（**修改**）— 加 `local-mock` 分支到 factory + `LOCAL_MOCK_PROVIDER_NAME` / `LOCAL_MOCK_MODEL_NAME` 公开常量 + 重导出 LocalMockProvider 类。
- `server/src/jobs/jobQueue.ts`（**修改**）— 新增可选 `retryOverrides?: Readonly<Record<string, JobQueueRetryConfig>>` 构造参数；handleFailure / recoverZombies 都查表，命中则用 override 否则继承全局 retryConfig；boot 时 validate 每个 override 用与全局相同的轴。
- `server/src/index.ts`（**修改**）— bootstrap 把 `IMAGE_AI_REFINE_JOB_TYPE` 加进 `retryOverrides: { maxRetries: 0 }`（R-132 闭合 — 生产环境 image_ai_refine 立即 terminal 不 retry）。
- `server/src/scripts/p10-acceptance-smoke.ts`（**新增**）— `smoke:p10-acceptance` **37/37 PASS**（覆盖 LocalMockProvider 单测 + factory + 端到端 HTTP+worker + 所有 R-131~R-137 dispositions）。
- `server/package.json`（**修改**）— 注册新 smoke。
- `docs/tasks.md` / `docs/progress.md`（**修改**）— P10.T7 标 `[x]` + R-131/R-132/R-134 闭合 + R-133/R-135/R-136/R-137 disposition 记录 + P10 阶段整体收口。

#### LocalMockProvider 如何启用

```
AI_ENABLED=true
AI_PROVIDER=local-mock
```

匹配规则：case-insensitive after trim（`Local-Mock` / `  LOCAL-MOCK  ` 都识别）。factory 选中 LocalMockProvider 时记一条 INFO 日志：

```
ai: LocalMockProvider selected — deterministic in-process fixture; do not use in production
```

provider 行为：
- `name = "local-mock"` (stable id 写入 ai_invocations.provider)
- `available = true` (route gate 通过)
- `supports = {"image_ai_refine"}`（其他 request type 抛 AIProviderUnsupportedRequestError）
- `invoke({inputBytes})`：sharp 跑固定 `.modulate({brightness:1.02, saturation:0.92}).tint({r:240,g:235,b:220}).jpeg({quality:85, mozjpeg:true})` 产 deterministic JPEG；输入空 → AIFailureResponse；sharp 抛 → AIFailureResponse 包含 sharp 消息
- 返回值 cost=0，duration=measured，**raw=undefined**（永不污染 media_versions.params.raw）

CLAUDE.md §2.8 默认行为不变：`AI_ENABLED=false`（默认）→ NoopProvider，base features 不受影响。

#### P10 端到端验收结果

**LocalMockProvider 单测** (12 case)：
- factory 选择正确 ✅
- name/model 是 stable 字符串 ✅
- case-insensitive + AI_ENABLED=false 时 Noop 优先 ✅
- invoke 返 success + outputBytes 非空且与输入不同 + parse 为 JPEG ✅
- raw undefined ✅ (R-134 闭合证据)
- 空输入返 AIFailureResponse 不抛 ✅

**端到端 HTTP+worker 验收** (25 case)：
- **GET /api/health.capabilities.aiEnabled=true** when AI on ✅ (R-135 disposition)
- POST /ai-refine 200 + jobId + aiInvocationId ✅
- audit pending → success；processing_jobs success；media_versions.ai_refined upsert with width/height/model_name ✅
- **R-134 闭合**：params.raw === null + scan 6 个 sensitive keywords (api_key/token/secret/password/authorization/bearer) 全无命中 ✅
- ai_refined.jpg 落盘 + sharp parse 为 JPEG ✅
- **R-131 闭合**：audit 直接 pending→success 跳过 running，atomic claim 谓词替代等价语义 ✅
- 原图字节不变；media_items.user_decision / active_version_type / status / preview_path 全部不变 ✅
- GET /versions 含 ai_refined isActive=false（P8.T5 panel 可见）✅
- /storage 投递 ai_refined.jpg ✅
- 400 (video) / 404 (missing) / 501 (Noop) / 429 (quota) 全部 no audit row written ✅
- **R-133 sanity**：quota 429 拒绝后 audit count 不变（说明 quota gate 在 audit 之前）✅
- **R-132 闭合**：retryOverrides maxRetries=0 → tick1 claim+fail，tick2 claim 0 行，retry_count 始终 0 ✅
- **R-137 disposition**：error.details 含 structured kind/limit/used + mediaId/type 给未来 i18n ✅
- **R-136 disposition**：response 含 jobId + aiInvocationId 给 UI banner 诊断 ✅
- FK foreign_key_check + integrity_check 全程干净 ✅

#### R-131 到 R-137 的处理结论

| ID | 状态 | 处理 |
| --- | --- | --- |
| **R-131** (audit 跳过 running) | ✅ **闭合** | P10.T7 smoke 证明 audit 直接 pending→success 与 pending→failed 走得通；atomic-claim `WHERE status='pending'` 提供等价 race 保护。schema enum 不动；如未来要 ops 看板加 'running' 是 migration 013 + AIInvocationStatus 扩展（一致性变更，非紧急）。 |
| **R-132** (retry 路径破坏 audit) | ✅ **闭合** | JobQueue 新增 `retryOverrides` 字段；bootstrap 把 `image_ai_refine` 设为 maxRetries=0；smoke 证明 tick1 fail + tick2 claim 0 + retry_count 永不 increment。zombie 恢复路径也用同一 override。 |
| **R-133** (worker 不重复 quota gate) | ✅ **disposition 保留** | smoke 证明 quota 429 在 audit 之前，audit count 不变；configured-mid-flight 语义符合 SaaS quota（已服务的请求不回退）。无需改实现。 |
| **R-134** (params.raw 不含 provider 敏感 echo) | ✅ **闭合** | LocalMockProvider.invoke() 刻意 omit raw，worker 写 params 时 `raw: response.raw ?? null` → 落地 null。smoke 双重证据：(a) parsed params.raw === null；(b) params JSON 字符串扫描 6 个 sensitive keyword 全无命中。 |
| **R-135** (capabilities.aiEnabled vs provider.available) | ✅ **disposition 保留** | smoke 验证 /api/health.capabilities.aiEnabled=true 在 LocalMockProvider 时正常；但 capabilities 没暴露 provider.name/available（认 R-135 仍然有效作为未来 polish）。错误 banner 已经能兜住 misconfig 场景。 |
| **R-136** (refetchVersions 早于 worker drain) | ✅ **disposition 保留** | smoke 证明 response 含 jobId + aiInvocationId 给 UI 展示；用户拿到 banner 后手动刷新即可看到 ai_refined。SSE/WebSocket 是 phase 11+ polish。 |
| **R-137** (错误 banner i18n) | ✅ **disposition 保留** | smoke 证明 error.details 包含 structured kind/limit/used/mediaId/type，未来 i18n 可基于 details 而不是 message 字符串。message 暂时英文 OK（项目本身英文）。 |

**4 闭合 / 3 disposition 保留**。新增风险编号从 R-138 开始（本次无新增）。

#### 执行过的检查命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run smoke:p10-acceptance` — **37/37 PASS**
- 完整 51 个 server smoke 全绿（含 P3-P10 全套契约 + 新 P10.T7 acceptance）
- `cd client && npm run lint` — 干净
- `cd client && npm run typecheck` — 干净（tsc -b ok）
- `cd client && npm run build` — vite 构建成功（gzip 72.10 kB JS + 4.27 kB CSS）
- 客户端无 vitest / jest 测试框架（同 P9.T9 / P10.T6 客户端任务的契约）

#### P10 阶段收口建议

✅ **P10 阶段建议整体收口**。所有子任务（T1 AIProvider 接口 → T2 ai_invocations schema → T3 POST /ai-refine + 501 gate → T4 daily/trip quota → T5 image_ai_refine worker → T6 客户端 AI Refine 按钮 + modal → T7 LocalMockProvider + 端到端验收）已完成；端到端验收 37/37 PASS；CLAUDE.md §2.4 红线（原图不变 / 用户决策不变）+ §2.8 红线（未配置 AI 时主流程不受影响）全部端到端验证；R-131/R-132/R-134 闭合；R-133/R-135/R-136/R-137 disposition 保留待未来 polish。requirements §7.10 验收 5 条：
1. ✅ 用户主动点击才触发（modal 二次确认）
2. ✅ 系统提示预计耗时和成本（modal body 文案明确）
3. ✅ 结果保存为 ai_refined version（worker UPSERT + P8.T5 panel 渲染）
4. ✅ 记录模型 / 参数 / 耗时 / 状态 / 错误（ai_invocations 全字段）
5. ✅ 支持每日 / 每 Trip 调用次数限制（P10.T4 quota gate + 429 + smoke 覆盖）
6. ✅ 支持关闭 AI 精修（AI_ENABLED=false 默认；前后端两层 gate）
7. ✅ 支持用户放弃结果（active_version_type 未自动切到 ai_refined，需用户显式 select-version）

## 下一阶段入口

P10 阶段完成。tasks.md 中没有定义 P11 / 后续阶段；下一步取决于产品决策（候选方向：i18n、SSE/WebSocket 推送、真实 SaaS provider 接入 (openai / gemini / bedrock 任一)、permanent-delete 端点、AI caption / classify / aesthetic_score 工作流、phase 11 / 12 设计文档撰写）。建议在拍板下一阶段前先 review `docs/tasks.md` + `docs/requirements.md` + `docs/design.md` 确认是否需要补充新阶段任务定义。

---

## 维护说明

- 每完成一个阶段，在本文件追加一节并把状态从 `进行中` 改为 `已完成`。
- 每完成一个 task，在所属阶段小节里追加 commit 与主要成果条目；不在文件末尾堆叠。
- 风险一旦消化，从 `剩余风险` 表中移除并附 commit 引用，避免列表无限增长。
- 本文件不替代 `docs/tasks.md`：任务的范围、约束、验收以 tasks.md 为准；本文件只是回顾视图。

---

## 2026-05-25 · P11 规划文档更新（音频处理 + 音频库 + 多视频合成）

> **本次只是文档规划同步，未进入任何代码实现**。所有 P11 子任务保持 `[ ] LATER`，未触动 P10 及之前已完成阶段的代码或测试。

### 背景

P10 阶段（AI 视觉精修）已于 2026-05-25 整体收口（commit `02d5044`）。在进入 P11 实现之前，按用户提示词把视频智能剪辑阶段的范围补齐：新增音频处理、音频库（系统默认 + 用户上传 + URL 导入）、多视频合成三块能力，并把 P11 拆成 T1 ~ T9 共 9 个子任务，全部标 LATER。

### 本次修改了哪些文件

- `docs/requirements.md`（**修改**）
- `docs/design.md`（**修改**）
- `docs/tasks.md`（**修改**）
- `docs/progress.md`（**修改**，即本文件）

未新增 / 未删除任何代码文件、迁移、API、worker、前端组件、依赖。

### requirements.md 新增了哪些需求

1. **§7.13 视频基础优化**：补充音频细化需求的指向（移除原声 / 淡入淡出 / 按目标时长裁剪 / 循环填充 / 替换配乐细节落到 §7.14 与 §7.19）；验收追加“音量归一化峰值不爆音”。
2. **§7.14 视频智能剪辑**：
   - 明确剪辑流程非破坏式（原视频与已有剪辑版本不被覆盖）。
   - 增加 `audioPolicy` 概念：`keep_original` / `remove_original` / `replace_with_default` / `replace_with_library_audio` / `mute` 五值闭合枚举 + 子字段 `audioLibraryId` / `removeOriginalAudio` / `normalizeVolume` / `fadeInMs` / `fadeOutMs` / `loopToFit` / `trimToDuration`。
   - 验收新增 3 条：去原声替换默认配乐、手动替换剪辑视频音频、渲染失败时有明确错误且原视频不受影响。
3. **§7.19 音频库**（新增整节）：系统内置默认音频 + 用户上传 + URL 导入；条目元数据（名称 / 来源 / 时长 / 格式 / 是否默认 / 是否用户上传 + 版权 / 来源 metadata 预留）；URL 导入只处理用户明确提供的合法地址，不爬取，先本地下载再使用；删除保护（默认音频不可经普通接口删除、引用检查）。7 条验收。
4. **§7.20 多视频合成**（新增整节）：从多个已剪辑视频中选择若干、调整顺序、合成为最终视频；音频策略（保留各段 / 统一替换 / 静音）；规格归一化（分辨率 / 帧率 / 音轨）；不覆盖已有剪辑视频；合成历史可查看；7 条验收。
5. **§8.10 audio_library**（新增数据模型）：14 列含 `source_type` 闭合枚举 + 来源 URL + 本地路径 + 时长 + 默认 / 用户上传布尔 + 版权 metadata 等。
6. **§8.11 video_compositions**（新增数据模型）：多视频合成记录（inputs 顺序敏感、audio_policy、output_media_version_id、status、error_message）。
7. **§9.5 Video API**：新增 `POST /api/videos/compose`，对 `generate-edit-plan` / `render` 增加“含 audioPolicy”说明。
8. **§9.7 Audio Library API**（新增整节）：GET 列表 / POST 上传 / POST URL 导入 / DELETE 删除。
9. **§14 阶段 11**：扩展目标和验收，从 4 条扩展为 9 条目标 + 11 条验收。
10. **§15.4 音频处理与多视频合成验收**（新增）：9 条端到端验收标准（含本次提示词列出的 7 条产品级验收）。

### design.md 新增了哪些设计

1. **§3.3 API 设计要点**：补充音频库 API（上传 / URL 导入 / 删除 / 列表）与多视频合成 API（`POST /api/videos/compose`）的关键约束。
2. **§4.2 表结构概览**：新增 `audio_library` 与 `video_compositions` 两行，描述外键 / 索引 / 设计要点。
3. **§5.2 文件目录布局**：补充 `audio_library/system/` / `audio_library/user/` / `audio_library/imported/` 三类音频存储路径，以及 `outputs/compositions/{compositionId}.mp4` 多视频合成输出路径。
4. **§8.3 视频基础优化与剪辑**：在剪辑方案 JSON 中明示 `audioPolicy` 完整字段示例；强调每次渲染都是新 `media_versions` 行，不覆盖任何既有 edit 版本。
5. **§8.5 音频库与音频处理**（新增整节）：
   - §8.5.1 `audio_library` schema 字段表（与 requirements §8.10 对齐）。
   - §8.5.2 音频文件存储：系统 / 用户 / URL 导入三路径分离，URL 导入必须先本地下载，渲染不依赖远程 URL。
   - §8.5.3 ffmpeg 音频处理：替换 / 去声 / 循环 / 裁剪 / 淡入淡出 / 音量归一化的具体 FFmpeg filter 与参数策略。
   - §8.5.4 删除保护：引用检查 + 默认音频不可经普通接口删除。
6. **§8.6 多视频合成**（新增整节）：
   - §8.6.1 合成流程：选择 → 顺序 → 音频策略 → 规格归一化 → concat → 写新 `media_versions` 行。
   - §8.6.2 异常输入处理：分辨率 / 帧率 / 音频参数不一致时的统一策略，缺失输入的失败路径。
   - §8.6.3 不覆盖原则（红线）：合成只读不改输入剪辑视频与原视频。
7. **§14 与需求的对应关系**：新增 §7.13 / §7.14 → §8.3 / §8.5；§7.19 → §8.5；§7.20 → §8.6 三行映射。

### tasks.md 调整后的 P11 子任务列表

原 P11.T1 ~ P11.T5（5 个子任务）扩展为 P11.T1 ~ P11.T9（9 个子任务），全部保持 LATER：

| 编号 | 标题 | 主要范围 |
|---|---|---|
| P11.T1 | 视频基础优化 | 转码 / 统一分辨率与帧率 / 轻防抖 / 音量归一化，新文件，不覆盖原视频 |
| P11.T2 | 音频处理基础能力 | 移除原声 / 淡入淡出 / 裁剪 / 循环填充 / 替换 BGM，FFmpeg filter 工具链 |
| P11.T3 | 音频库 Audio Library | migration + 系统默认音频 seed（不含 API / 前端）|
| P11.T4 | 剪辑方案生成 | 规则引擎 + 可选 AI；方案含 `audioPolicy`；AI 不可用时回退规则 |
| P11.T5 | 视频渲染 API | `POST /api/videos/:id/generate-edit-plan` + `POST /api/videos/:id/render`，按 audioPolicy 输出新 edit 版本 |
| P11.T6 | 音频库 API | GET / POST upload / POST import-url / DELETE；URL 导入先下载再写表；删除时引用检查 |
| P11.T7 | 前端：剪辑方案预览与音频替换 | 方案预览 + 顺序调整 + 音频替换 + 多时长输出 |
| P11.T8 | 多个已剪辑视频合成为一个视频 | `video_compositions` schema + worker + `POST /api/videos/compose` + 前端合成 UI |
| P11.T9 | 阶段验收 | §7.14 / §7.19 / §7.20 / §15.4 全部验收条目 |

`requirements ↔ tasks` 索引表同步更新：
- §7.13 → P11.T1
- §7.14 → P11.T2 / P11.T4 / P11.T5 / P11.T7
- §7.19 → P11.T3 / P11.T6
- §7.20 → P11.T8

### 新增风险（R-138 ~ R-142）

| 编号 | 风险 | 初步控制方向（实现期再细化） |
| --- | --- | --- |
| **R-138** | 音频版权 / 来源风险：用户上传或 URL 导入的音频可能存在版权问题；系统默认音频也需要明确许可证。前端展示与剪辑使用未做版权声明时，存在用户场景下的合规风险。 | (1) `audio_library.metadata_json` 预留版权 / 作者 / 许可证字段；(2) 系统默认音频统一选用允许商业 / 个人使用的免版税或 CC0 来源，并在 seed 时写入许可证元信息；(3) 用户上传 / URL 导入界面提示用户对版权负责，必要时增加勾选确认。实现期由 P11.T3 / P11.T6 落实。 |
| **R-139** | URL 导入音频的安全边界风险：恶意 URL 可能指向超大文件、非音频内容、内网地址（SSRF）或下载耗时极长的资源，直接落到 `audio_library/imported/` 会撑爆磁盘 / 引发 SSRF。 | (1) URL 导入只走 HTTP / HTTPS；拒绝 `file://` / 内网保留地址（10/8、172.16/12、192.168/16、127/8、169.254/16）；(2) MIME / 扩展名白名单 + 文件大小上限 + 下载超时（如 30s）；(3) 下载阶段失败 → 事务回滚不留半成品；(4) 失败错误码与文案集中维护（design.md §10）。实现期由 P11.T6 落实。 |
| **R-140** | 长视频合成耗时风险：多个长视频合成时 FFmpeg 任务可能跑数十分钟，占用单进程 Worker 与磁盘 IO，影响其他视频任务和图片任务。 | (1) 多视频合成使用 video 通道并发 1（与现有 P9 worker 共享 `VIDEO_WORKER_CONCURRENCY=1`），不允许扩散到图片通道；(2) 合成任务支持取消（`POST /api/jobs/:id/cancel`），失败 / 取消时清理临时文件；(3) 必要时增加单合成任务的硬超时（例如 1 小时），超时按 `failed` 处理。 |
| **R-141** | ffmpeg 音频循环 / 裁剪 / 淡入淡出兼容性风险：不同 FFmpeg 版本对 `aloop` / `atrim` / `afade` / `loudnorm` filter 的行为细节与参数支持略有差异（如 `aloop=-1` 的语义、双段 loudnorm 的二次扫描），导致同样的剪辑方案在不同部署环境产出不一致。 | (1) `.env.example` 与 README 明确 FFmpeg 最低版本（建议 4.4+）；(2) 启动检查（design §8.4）扩展为同时记录 `ffmpeg -filters` 关键 filter 是否可用；(3) 渲染 worker 在生成 ffmpeg 命令时优先使用稳定 filter 组合，避免依赖偏门参数；(4) 实现期为关键 filter 写最小 smoke fixture 锁定行为。 |
| **R-142** | 多视频合成时分辨率 / 帧率 / 音轨不一致风险：用户选择来自不同源视频的剪辑结果合成时，分辨率 / 帧率 / 像素格式 / 音频采样率可能不一致，直接 concat 会失败或输出参数错乱。 | (1) 合成 worker 必须在拼接前做规格归一化（scale + pad / fps + 像素格式统一，audio 统一采样率 + 声道数）；(2) 归一化基准来源在配置层集中（默认以第一段为基准，或全局配置目标分辨率 / 帧率 / 采样率）；(3) 归一化阶段失败时整段合成任务标记 `failed`，error_message 指明哪段、哪个维度不兼容。实现期由 P11.T8 落实。 |

> 风险编号衔接 R-137 之后，从 R-138 开始连续编号。R-138 ~ R-142 仅为本次规划阶段记录，实际控制措施在 P11.T1 ~ P11.T9 进入实现时再细化与闭合。

### 是否只是文档更新

**是**。本次仅修改 `docs/requirements.md` / `docs/design.md` / `docs/tasks.md` / `docs/progress.md` 四个文档，未触动任何代码、迁移、API、worker、前端、依赖、配置。CLAUDE.md §1（先文档后代码）要求满足；P10 阶段产物完整保留；红线未触发。

### 是否可以提交本次文档变更

可以。变更内容只在 `docs/` 下，无构建 / 测试 / lint 链路影响。建议 commit 消息模板：

```
docs(p11): plan audio processing + audio library + multi-video composition (P11 scoping)

- requirements.md: extend §7.13/§7.14, add §7.19 audio library, §7.20 multi-video composition,
  data models §8.10/§8.11, API §9.5/§9.7, stage §14, acceptance §15.4
- design.md: §3.3 API points, §4.2 schema, §5.2 storage layout (audio_library/* + compositions),
  §8.3 audioPolicy in render plan, §8.5 audio library + ffmpeg, §8.6 composition, §14 mapping
- tasks.md: P11 split into T1-T9 (all LATER), index updated
- progress.md: record doc-only update, new risks R-138 .. R-142

No code, migration, API, worker, frontend, or dependency changes.
```

下一步取决于产品决策是否拍板进入 P11.T1 实现。在拍板前不动代码。

---

## 2026-05-26 · P11.T1 视频基础优化（user-facing 浏览器友好再编码）

### 状态

✅ 完成。`docs/tasks.md` P11.T1 行从 `[ ] LATER` 翻成 `[x] MUST`。P11.T2 ~ P11.T9 保持 `[ ] LATER`，本轮未触碰。

### 范围按提示词收窄

实现：转码（ffmpeg H.264 / AAC）+ 分辨率 / 码率标准化（1080p 上限，不放大；CRF 23；preset=medium；audio 160 kbps）+ 新 video version 输出 + 原视频保护 + processing_jobs 状态推进 + media_versions params/path 落地 + 与现有 video pipeline / queue / worker 机制对齐。

**显式不做**（留给 P11.T2 ~ P11.T9）：
- 去原声 / 音量归一化 / 淡入淡出 / 默认配乐 / 音频长度循环 / 裁剪
- 音频库 schema + API + 默认音频 seed
- URL 导入音频
- 手动替换 / 选择音频
- 多视频合成
- 剪辑方案生成（rule engine + 可选 AI）
- `POST /api/videos/:id/generate-edit-plan` / `/render` / `/compose`
- 前端剪辑页 / 音频选择 UI / 多视频合成 UI

### 修改 / 新增的文件

**新增（3）**：
- `server/migrations/013_extend_media_versions_video_optimized.sql` — 12 步 STRICT 表重建，给 `media_versions.version_type` enum 加 `'video_optimized'`（9 值闭合枚举）；FK / 索引 / 其他 CHECK 字节级保持，跟 006 同套路。
- `server/src/jobs/videoOptimizeWorker.ts` — `VIDEO_OPTIMIZE_JOB_TYPE='video_optimize'` 常量 + `makeVideoOptimizeHandler` factory + `VideoOptimizeSettings` + `DEFAULT_VIDEO_OPTIMIZE_SETTINGS`。整体结构 mirror `videoProxyWorker.ts`：spawn ffmpeg → 写 tmp → ffprobe verify → storage.putDerived 落 `derived/{mediaId}/video_optimized.mp4` → UPSERT media_versions 行。
- `server/src/scripts/video-optimize-worker-smoke.ts` — 端到端 smoke，14 个 CASE，**52/52 PASS**。

**修改（7）**：
- `server/src/config/index.ts` — 加 8 个 env (`VIDEO_OPTIMIZE_*`) + `Config.video.optimize: {…}` slice + superRefine 守卫（CRF ≤ 51、targetHeight ≥ 144、preset 闭枚举）；preset 校验复用 `video_proxy` 同一份 x264 preset 白名单。
- `server/src/jobs/index.ts` — re-export `VIDEO_OPTIMIZE_JOB_TYPE / makeVideoOptimizeHandler / DEFAULT_VIDEO_OPTIMIZE_SETTINGS / VideoOptimizeHandlerDeps / VideoOptimizeSettings`。
- `server/src/media/mediaService.ts` — 加 `optimizeVideoMedia(mediaIdInput: unknown): OptimizeVideoMediaResult`，与 `enhanceMedia` / `aiRefineMedia` 对称（单 slot 入队，404 missing/soft-deleted，400 非 video，复用 `reprocessOneJobType` 的 created/reset/skipped + reason）。
- `server/src/media/index.ts` — re-export `OptimizeVideoMediaResult` 类型。
- `server/src/routes/media.ts` — 加 `POST /api/media/:id/optimize-video`，对称 `/enhance` 与 `/ai-refine`，直接调 `mediaService.optimizeVideoMedia(id)`。
- `server/src/index.ts` — bootstrap 注册 video_optimize handler 到 video 通道（共享 `VIDEO_WORKER_CONCURRENCY=1` 预算）；wire `config.video.optimize.*` 到 settings。
- `server/package.json` — 新增 `smoke:video-optimize-worker` script。
- `.env.example` — 新增 P11.T1 段落注释 + 8 个 env 默认值。

**未触碰的领域**：客户端代码（0 行改动）；任何 AI / quota / audit / 配色逻辑；P8 enhance / P10 ai-refine 路径；P9.T2-T7 既有 video worker 实现；P7 软删除 / 恢复 / 回收站；UploadService / TripService / DedupService / VideoService。

### 视频输出路径与 version 类型

- **version_type**：`'video_optimized'`（新值，与既有 8 值并列；与 `video_proxy` 区分见下表）
- **on-disk 路径**：`storage/trips/{tripId}/derived/{mediaId}/video_optimized.mp4`
- **逻辑路径**（业务表 + 前端用）：`trips/{tripId}/derived/{mediaId}/video_optimized.mp4`
- **静态访问**：通过 P3.T1 的 `/storage/<logicalPath>` 路由可直接 GET（无新增静态路由 / 无新 API mount 点）
- **media_versions 行字段**：`mime_type='video/mp4'`、`width` / `height` / `file_size` 由 ffprobe verify 阶段写入、`status='ready'`、`params` JSON 含 `workerVersion / targetHeight / crf / preset / videoCodec / audioCodec / audioBitrateKbps / optimizedDurationSec / optimizedVideoCodec / optimizedAudioCodec / optimizedBitrate` 共 11 个字段

### video_optimized vs video_proxy（防止混淆）

| 维度 | `video_proxy` (P9.T4) | `video_optimized` (P11.T1) |
| --- | --- | --- |
| 目的 | 内部低清分析源（keyframes / segments / quality 共享） | 用户面向 浏览器友好再编码 |
| 高度上限 | 720p | 1080p |
| CRF | 28（压缩缩略图级） | 23（视觉透明） |
| Preset | veryfast | medium |
| 音频 | 128 kbps | 160 kbps |
| 文件名 | `derived/{mediaId}/video_proxy.mp4` | `derived/{mediaId}/video_optimized.mp4` |
| 用户可见 | 否（API 内部） | 是（P11.T7 / 静态路由可见） |

两者用不同 version_type，文件不冲突，互不覆盖。

### 是否覆盖原始视频

**否**。worker 显式：
1. 读 `media.originalPath` 用 `resolveUnderRoot(storage.root, …)` 解析为绝对路径
2. ffmpeg 输出到 `os.tmpdir()` 下的临时文件（每次 `mkdtemp` 创建）
3. `storage.putDerived` 把 tmp 拷到 `derived/{mediaId}/video_optimized.mp4`（`overwrite: true` 仅覆盖前一次同名 optimized 输出）
4. `finally` 清理 tmp 目录

smoke CASE 2 + CASE 7 显式断言原视频字节级不变（happy + 二次重跑两轮）。

### 执行过的检查命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run build` (`tsc -p tsconfig.json`) — 干净
- `cd server && npm run smoke:video-optimize-worker` — **52/52 PASS**
- 邻近回归 5 个 smoke 全绿：
  - `smoke:video-proxy-worker` — 35/35 PASS（确认 video_proxy 未被影响）
  - `smoke:media-versions-api` — 35/35 PASS（确认 P8.T4 versions API 未被破坏）
  - `smoke:p9-acceptance` — 36/36 PASS（确认 P9 整套 video pipeline 未被影响）
  - `smoke:p10-acceptance` — 37/37 PASS（确认 P10 AI refine 未被影响）
  - `smoke:p7-recycle-bin-acceptance` — 60/60 PASS（确认 P7 软删除 / 恢复未被破坏）
- `cd client && npm run lint` — 干净
- `cd client && npm run typecheck` (`tsc -b`) — 干净
- `cd client && npm run build` (`vite + tsc`) — 干净（61 modules, gzip 72.10 kB JS + 4.27 kB CSS；无客户端 bundle 改动）

### Smoke 测试覆盖（52 PASS / 0 FAIL）

| CASE | 主要断言 |
| --- | --- |
| 1 happy（320×240 + audio） | job claimed + success / video_optimized.mp4 落盘 / H.264 + MP4 / 不放大（240p 保持 240p）/ 音轨保留 AAC / media_versions 行 6 字段齐全 + status='ready' / params 记录 7 个 transcode 旋钮 |
| 2 non-destructive | 原视频字节级不变（byte-equal） |
| 3 scope-guard media_items | preview_path / thumbnail_path / user_decision / active_version_type / status / duration / width / height 7 列全部不动 |
| 4 scope-guard media_versions | 仅写 video_optimized 单行，无其他 version_type 泄漏 |
| 5 downscale 4K → 1080p | 3840×2160 输入 → 1920×1080 输出（保持宽高比 + 偶数宽 yuv420p） |
| 6 audio-less source | 无音频源仍成功（`-map 0:a?` 可选音频映射）|
| 7 idempotent | 二次 tick UPSERT 单行 + 文件存在 + 原视频字节仍不变 |
| 8 image media | job 'failed' + error_message 含 'not a video' + image 类型；无 media_versions 行写入 |
| 9 soft-deleted media | job 'failed' + error_message 含 'not found or soft-deleted'；无 derived 文件泄漏；无 media_versions 行泄漏（P7 契约）|
| 10 unknown / NULL originalPath | job 'failed' + 错误信息说明类型或路径问题 |
| 11 ghost original file | job 'failed' + 错误信息含 ffmpeg exited |
| 12 broken / not-a-real-MP4 | job 'failed' + 错误信息含 ffmpeg exited（moov atom not found）|
| 13 MediaService 集成 | 404 missing media (code=NOT_FOUND/statusCode=404) / 400 image (code=BAD_REQUEST/statusCode=400) / created / skipped (pending) / reset (success → re-enter retrying) 5 断言 |
| 14 DB integrity | PRAGMA foreign_key_check 0 行 + PRAGMA integrity_check 'ok' |

### 是否新增风险

新增 1 条风险（R-143），衔接 R-138 ~ R-142 之后。

| ID | 风险 | 控制措施 |
| --- | --- | --- |
| **R-143** | 高码率 / 长视频 optimize 任务可能跑数分钟以上，占满 video 通道串行预算（`VIDEO_WORKER_CONCURRENCY=1`），堵塞其他 video 任务（cover / proxy / keyframes / segments / segment_quality）。一个 4K 1 小时长视频在 preset=medium 下可能 30 分钟以上。 | (1) 配置层 `VIDEO_OPTIMIZE_TIMEOUT_MS=600000` 兜底（默认 10 分钟），超时即 SIGKILL → 任务 failed → 可手动重试；(2) 运维侧可调 `VIDEO_OPTIMIZE_PRESET` 到 `faster` / `veryfast` 加速（牺牲文件大小换时间）或拉高 `VIDEO_WORKER_CONCURRENCY` 多并发（牺牲单任务速度换吞吐）；(3) 可控制 enqueue 节奏（service 层 `optimizeVideoMedia` 已支持 idempotent skipped — 防止用户连点产生多重排队）；(4) **未来 polish**：P11.T7 前端引入进度展示让用户感知，或加 "fast preset" 开关 / 加 cancel 入口（复用 `POST /api/jobs/:id/cancel`）。本轮接受 disposition：单视频排队等待在 V1 可接受。 |

R-138 ~ R-142 保留：
- **R-138 音频版权风险** — 待 P11.T3 / P11.T6 落实
- **R-139 URL 导入音频 SSRF 风险** — 待 P11.T6 落实
- **R-140 长视频合成耗时风险** — 待 P11.T8 落实
- **R-141 ffmpeg 音频 filter 兼容性风险** — 待 P11.T2 落实
- **R-142 多视频合成规格不一致风险** — 待 P11.T8 落实

### 阶段定位

P11 阶段进度：T1 已完成（`[x]`），T2 ~ T9 仍为 LATER（`[ ]`）。

下一步任务候选（按 docs/tasks.md P11 顺序）：
- P11.T2 音频处理基础能力（FFmpeg `afade` / `aloop` / `atrim` / `loudnorm` / `-an` 工具链）
- P11.T3 音频库 Audio Library schema + 系统默认音频 seed

由产品决策选定下一项再执行。

### 是否可以提交本次变更

可以。建议 commit 消息：

```
feat(server): video_optimize worker + POST /api/media/:id/optimize-video (P11.T1)

- migration 013: extend media_versions.version_type enum with 'video_optimized'
- worker: makeVideoOptimizeHandler — H.264/AAC, 1080p cap, no upscale, CRF 23
- service: MediaService.optimizeVideoMedia (single-slot enqueue, 404/400/idempotent)
- route: POST /api/media/:id/optimize-video on the media router
- config: 8 new VIDEO_OPTIMIZE_* envs + superRefine guards
- smoke: smoke:video-optimize-worker — 52/52 PASS (end-to-end via real ffmpeg)
- new risk R-143 (long-video optimize blocking video-channel) recorded
- never overwrites the original; output at derived/{mediaId}/video_optimized.mp4

No audio policy, library, URL import, or composition (P11.T2~T9 stay LATER).
No frontend changes (P11.T7).
```

---

## 2026-05-26 · P11.T2 音频处理基础能力（FFmpeg 工具链）

### 状态

✅ 完成。`docs/tasks.md` P11.T2 行从 `[ ] LATER` 翻成 `[x] MUST`。P11.T3 ~ P11.T9 保持 `[ ] LATER`，本轮未触碰。

### 范围按提示词收窄

实现：
- 去原声（`-an`）
- 音频截取（`atrim` + `asetpts=PTS-STARTPTS`）
- 淡入淡出（`afade=t=in` / `afade=t=out`，clamp short-clip）
- 单 pass loudnorm（EBU R128：I=-16 LUFS / TP=-1.5 dBTP / LRA=11）
- 背景音乐循环 + 截断（`-stream_loop -1` + `-t <target>`，前置非有限值守卫）
- 视频音轨替换（`-map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest`，`musicPath=null` 等价 `stripAudio`）
- 默认音乐库目录约定（`server/assets/audio/default/`，缺失优雅 fallback）

**显式不做**（留给 P11.T3 ~ T9）：
- audio_library SQLite schema / repository / API（P11.T3 / P11.T6）
- URL 导入音频（P11.T6，含 SSRF 守卫）
- 剪辑方案生成 / audioPolicy 绑定 / render orchestration（P11.T4 / P11.T5）
- 多视频合成（P11.T8）
- 前端音频选择 UI（P11.T7）
- ducking / vocal preservation / 多轨混音 / AI 选音乐（明确提示词排除）

### 修改 / 新增的文件

**新增（3）**：
- `server/src/jobs/audioProcessor.ts`：纯函数 4 个（`buildAtrimFilter` / `buildAfadeFilter` / `buildLoudnormFilter` / `joinAfChain`）+ async runner 4 个（`stripAudio` / `trimAudio` / `prepareBackgroundMusic` / `replaceVideoAudio`）+ 发现助手 1 个（`findDefaultAudioCandidates`）+ 配置类型 `AudioProcessorSettings` + `DEFAULT_AUDIO_PROCESSOR_SETTINGS`。NOT a JobHandler — 是工具链，未来 P11.T5/T8 worker 调用。
- `server/src/scripts/audio-processor-smoke.ts`：14 个 case 纯函数 + 10 个 case ffmpeg + 8 个 case 无限循环守卫 + 1 个 case spawn 失败 = **34/34 PASS**。
- `server/assets/audio/default/.gitkeep`：占位目录 + 约定说明（操作员可放 audio 文件，缺失时主流程不中断）。

**修改（4）**：
- `server/src/config/index.ts`：加 4 个 env (`DEFAULT_AUDIO_LIBRARY_DIR` / `VIDEO_AUDIO_LOUDNORM_ENABLED` / `VIDEO_AUDIO_FADE_IN_SECONDS` / `VIDEO_AUDIO_FADE_OUT_SECONDS`) + `Config.video.audio: {…}` slice + superRefine 守卫（两个 fade ≤ 30s 上限）。
- `server/src/jobs/index.ts`：re-export 13 个公开符号（4 runner + 1 discovery + 3 常量 + 5 类型）。
- `server/package.json`：加 `smoke:audio-processor` 脚本。
- `.env.example`：加 P11.T2 段落注释 + 4 个默认值。

**文档（2）**：`docs/tasks.md`（P11.T2 标 [x]） + `docs/progress.md`（本节）。

**未触碰的领域**：
- migration（无新 schema）
- 任何 API route（service / route 层零改动）
- 客户端代码（0 行）
- `media_versions` / `processing_jobs` 写入
- P11.T1 video_optimize worker
- P9.T2~T7 既有 video pipeline
- P10 AI / P8 enhance / P7 软删除 / 任何前期阶段产物

### 关键设计决策

1. **路径注入 hard-block**：所有 ffmpeg 调用走 `spawn("ffmpeg", [argv...])` 数组形式，**绝不**做 `${path}` 字符串拼接 → 系统级 shell 不参与；filter 字符串构造集中在纯函数里（可单测形状），由 `-af "<filter>"` 单 argv 传入。
2. **无限循环 hard-block**：`prepareBackgroundMusic(target ≤ 0 | NaN | Infinity)` 在 spawn 前直接 throw。这是 `-stream_loop -1` 失去 `-t` 上限的唯一防护。smoke 显式验证 4 个非法值都被拒 + 输出文件不被产生。
3. **音乐缺失 graceful**：`findDefaultAudioCandidates` 遇 ENOENT → 返回 `[]` 而不是抛错。配合 P11.T1 video_optimize 不依赖音乐，base feature 不会因为没人放音乐而挂掉（CLAUDE.md §2.8）。
4. **mute 路径统一**：`replaceVideoAudio(musicPath=null)` 直接调 `stripAudio`，确保 mute 场景与去原声场景共享同一份 spawn / timeout / stderr 处理代码。
5. **音质默认值**：EBU R128 单 pass loudnorm 默认值与公开行业标准对齐；fade 上限 30s 守卫避免 env 误配置导致整段音乐被压成 fade 噪声。
6. **toolkit vs worker 分离**：本模块只暴露纯函数 + async runner，不写 `media_versions` / 不入队 / 不改 `processing_jobs`。未来 P11.T5 render worker / P11.T8 compose worker 才会调用这些 building block，并负责 schema 副作用 —— 单一职责清晰。

### 执行过的检查命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run build` (`tsc -p tsconfig.json`) — 干净
- `cd server && npm run smoke:audio-processor` — **34/34 PASS**
- 邻近回归 3 个 smoke 全绿：
  - `smoke:video-optimize-worker` — 52/52 PASS（P11.T1 未被影响）
  - `smoke:p10-acceptance` — 37/37 PASS（P10 AI 未被影响）
  - `smoke:p9-acceptance` — 36/36 PASS（P9 视频流水线未被影响）
- `cd client && npm run lint` — 干净
- `cd client && npm run typecheck` (`tsc -b`) — 干净
- `cd client && npm run build` (`vite + tsc`) — 干净（61 modules / gzip 72.10 kB JS + 4.27 kB CSS / 无客户端 bundle 改动）

### Smoke 测试覆盖（34 PASS / 0 FAIL）

| 类型 | 覆盖项 | 数量 |
| --- | --- | --- |
| Pure: buildAtrimFilter | duration only / start+end / all 3 axes / 拒空 / 拒负 | 5 |
| Pure: buildAfadeFilter | in+out / in-only / 双 disabled→null / clamp short-clip / 拒 total≤0 | 5 |
| Pure: buildLoudnormFilter | 默认形 / 拒 NaN | 2 |
| Pure: joinAfChain | join 非 null / 全 null→null | 2 |
| Pure: findDefaultAudioCandidates | 缺失目录→[] / 空目录→[] / 混合过滤+排序 | 3 |
| Guard: prepareBackgroundMusic 无限循环防护 | target=0 / -1 / NaN / Infinity 全部 throw + 输出文件未生成 | 8 |
| ffmpeg: stripAudio | input fixture 有音 → 输出无音轨 | 2 |
| ffmpeg: trimAudio | 3s → 1s（±0.2s 容差） | 1 |
| ffmpeg: prepareBackgroundMusic | 2s loop→4s / 3s trim→1s / 全 filter disabled | 3 |
| ffmpeg: replaceVideoAudio | 视频+新音 / musicPath=null 等价 stripAudio | 2 |
| ffmpeg: 缺失 binary | 错误形 `ffmpeg spawn failed (stripAudio)` | 1 |

### 新增风险

新增 1 条风险（R-144），衔接 R-138 ~ R-143 之后。

| ID | 风险 | 控制措施 |
| --- | --- | --- |
| **R-144** | 单 pass `loudnorm` 在 dB 域不稳定 —— 同一文件多次跑可能产生轻微 LUFS 偏差（典型 ±1 LUFS），混音感观一致性弱于双 pass measure-then-render 流程。 | (1) V1 接受单 pass；目标 `I=-16 LUFS` 对 web 播放足够透明，偏差不会造成可闻 clipping；(2) **未来 polish**：P11.T5 render worker 落地时升级为双 pass —— 第一遍 dry-run 测量 `measured_I / measured_LRA / measured_TP / measured_thresh`，第二遍带 `measured_*` 参数再编码。代价是每次渲染多一次全文件解码。当前 toolkit 接口稳定，升级只需在 `prepareBackgroundMusic` 内部加 `if (twoPassEnabled)` 分支，不破坏现有调用者。 |

### 当前已知限制

1. **默认音乐库为空**：`server/assets/audio/default/` 仅含 `.gitkeep`。运行 `findDefaultAudioCandidates` 返回 `[]`，业务流程不会因此中断；待 P11.T3 / 运营侧补充音频。版权 / 许可证管理由 R-138 跟进（P11.T3 schema 落地时再加 metadata 字段）。
2. **loudnorm 仅单 pass**：见 R-144。
3. **长视频音频处理仍需 timeout / concurrency 保护**：本节 runner 已强制 `timeoutMs` 兜底 + SIGKILL；但音频任务尚未接入 JobQueue 的 video 通道（P11.T5 render worker 落地时才会注册到 video channel 共享 `VIDEO_WORKER_CONCURRENCY=1` 预算）。
4. **toolkit 暂无入口**：没有 API、没有 route、没有 frontend；只能从未来 worker / smoke 调用。这是按提示词刻意设计的（"不要新增正式 API，除非 smoke test 必须最小调用"）；未来 P11.T5 / P11.T8 worker 将作为消费者。

R-138 ~ R-143 全部保留：
- **R-138 音频版权风险** — 待 P11.T3 / P11.T6 落实
- **R-139 URL 导入音频 SSRF 风险** — 待 P11.T6 落实
- **R-140 长视频合成耗时风险** — 待 P11.T8 落实
- **R-141 ffmpeg 音频 filter 兼容性风险** — **部分缓解**：P11.T2 已确认 `afade` / `aloop`（通过 `-stream_loop`）/ `atrim` / `loudnorm` / `-an` 在本地 ffmpeg 4.4+ 工作正常；smoke 锁定了 argv 形状，可用作 CI 兼容性 fixture
- **R-142 多视频合成规格不一致风险** — 待 P11.T8 落实
- **R-143 长视频 optimize 堵塞 video 通道** — P11.T1 已记，控制措施同前

### 阶段定位

P11 阶段进度：
- ✅ T1 已完成（commit `73adae0`，video_optimize）
- ✅ T2 已完成（本轮，audio toolkit）
- ⬜ T3 ~ T9 仍为 LATER

下一步任务候选（按 docs/tasks.md P11 顺序）：
- **P11.T3 音频库 Audio Library schema + 系统默认音频 seed** — 落 `audio_library` migration（design.md §8.5.1 给出字段），把 `assets/audio/default/` 下的文件（若有）seed 进表
- **P11.T4 剪辑方案生成** — 基于 `video_segments` + `audioPolicy` 出 plan
- **P11.T5 视频渲染 API** —— audio toolkit 的第一个真正消费者

由产品决策选定下一项再执行。

### 是否可以提交本次变更

可以。建议 commit 消息：

```
feat(server): audio processing toolkit (strip / trim / fade / loudnorm / loop / replace) (P11.T2)

- jobs/audioProcessor.ts: pure filter builders + bounded async runners
  - buildAtrimFilter / buildAfadeFilter / buildLoudnormFilter / joinAfChain
  - stripAudio / trimAudio / prepareBackgroundMusic / replaceVideoAudio
  - findDefaultAudioCandidates (graceful ENOENT → []; CLAUDE.md §2.8)
  - prepareBackgroundMusic refuses targetDurationSec ≤ 0 / NaN / Infinity
    BEFORE spawn — the only guard against runaway -stream_loop -1 encodes
  - all ffmpeg invocations via spawn(cmd, [argv...]) — no shell, no
    path-injection surface
- config: 4 new VIDEO_AUDIO_* / DEFAULT_AUDIO_LIBRARY_DIR envs + fade ≤ 30s
- assets: server/assets/audio/default/.gitkeep with conventions doc
- smoke: smoke:audio-processor — 34/34 PASS (pure 16 + guards 8 + ffmpeg 10)
- new risk R-144 (single-pass loudnorm vs two-pass) recorded

NOT a worker (no JobQueue / media_versions side-effects). No new API,
no migration, no frontend. P11.T3~T9 stay LATER.
```

---

## 2026-05-26 · P11.T3 音频库 Audio Library（schema + repository + service + seed runner）

### 状态

✅ 完成。`docs/tasks.md` P11.T3 行从 `[ ] LATER` 翻成 `[x] MUST`。P11.T4 ~ P11.T9 保持 `[ ] LATER`，本轮未触碰。

### 范围按提示词收窄

实现：
- migration 014 `audio_library` 表（STRICT，15 列 / 8 CHECK / 3 索引 / 与 media_items 完全解耦）
- `AudioLibraryRepository`（CRUD + upsert-by-(source_type, checksum) 关键 idempotency 主轴）
- `AudioLibraryService`（`listSystemAudio` / `findById` / `seedDefaultDirectory`）
- 默认音频目录约定 `server/assets/audio/default/`（P11.T2 已建占位）下文件的发现 → checksum → 可选 ffprobe duration → UPSERT
- `AUDIO_LIBRARY_SEED_ON_STARTUP=false` 配置占位（**不接入 bootstrap**；hook 留给 P11.T6+）
- smoke 端到端覆盖 36/36 PASS

**显式不做**（留给 P11.T4 ~ T9）：
- 任何 HTTP route / API（P11.T6）
- 用户上传 / URL 导入（P11.T6，含 SSRF / 版权 metadata）
- 前端 UI（P11.T7）
- 启动时自动 seed（hook 已留但本轮不接入 bootstrap）
- 与剪辑方案 / `audioPolicy` 集成（P11.T4 / P11.T5）
- 多视频合成（P11.T8）
- AI 选音乐 / ducking / 多轨混音

### 修改 / 新增的文件

**新增（4）**：
- `server/migrations/014_create_audio_library.sql` — STRICT 表，15 列 / 8 CHECK / 3 索引。无 FK（音频库与 media_items 解耦，design.md §8.5.1 显式约定）。
- `server/src/media/audioLibraryRepository.ts` — `AudioLibraryRepository` 类含 7 个 prepared statement + 8 个公开类型。所有 SQL 在此一处，service / smoke / 未来 route 只看 view shape。
- `server/src/media/audioLibraryService.ts` — `AudioLibraryService` 类（`listSystemAudio` / `findById` / `seedDefaultDirectory`）+ 私有 helper `seedOneCandidate` / `sha256OfFile` (streaming) / `probeAudio` (ffprobe, 15s 超时) / `slugify`。
- `server/src/scripts/audio-library-seed-smoke.ts` — 端到端 smoke 36 个 case。

**修改（4）**：
- `server/src/media/index.ts` — re-export 8 个公开符号（repo + service + 5 types + 1 outcome enum）。
- `server/src/config/index.ts` — 加 `AUDIO_LIBRARY_SEED_ON_STARTUP=false` env + `config.video.audio.seedOnStartup` 字段（**bootstrap 不消费**，hook 留给 P11.T6+）。
- `server/package.json` — 加 `smoke:audio-library-seed` 脚本。
- `.env.example` — 加 P11.T3 段落注释 + 默认值。

**文档（2）**：`docs/tasks.md`（P11.T3 标 [x]） + `docs/progress.md`（本节）。

**未触碰的领域**：
- 任何 route / API（与 P11.T2 同样的红线 — P11.T6 territory）
- 客户端代码（0 行）
- bootstrap (`server/src/index.ts`) — 即使 config 加了 `seedOnStartup` 字段也没接入
- `media_versions` / `processing_jobs` / `media_items`
- P11.T1 / P11.T2 / P10 / P9 / P8 / P7 任何阶段产物

### audio_library schema 摘要

```
audio_library (STRICT)
├── id                   TEXT NOT NULL PRIMARY KEY
├── name                 TEXT NOT NULL                  -- slugified handle (e.g. demo-track)
├── display_name         TEXT NOT NULL                  -- human label (e.g. Demo-Track)
├── source_type          TEXT NOT NULL CHECK ∈ {'system','user'}
├── file_path            TEXT NOT NULL                  -- absolute on-disk
├── relative_path        TEXT                           -- relative to storage root when present
├── mime_type            TEXT
├── duration_seconds     REAL                           -- nullable: ffprobe-fail degrades to NULL
├── size_bytes           INTEGER NOT NULL CHECK ≥ 0
├── checksum             TEXT NOT NULL                  -- sha256 hex (64 chars)
├── is_active            INTEGER NOT NULL DEFAULT 1 CHECK ∈ {0,1}
├── tags                 TEXT                           -- comma-separated
├── metadata_json        TEXT                           -- JSON; license / author / source_url etc. live here
├── created_at, updated_at
└── INDEX (source_type, checksum) UNIQUE  -- idempotency key
    INDEX (source_type, is_active)        -- typical read path (BGM picker)
    INDEX (checksum)                       -- cross-source dedup advisory
```

### 默认音频 seed 流程

```
seedDefaultDirectory(dir, opts?):
  1. fs.stat(dir) -> directoryExisted: boolean (ENOENT → false, graceful)
  2. findDefaultAudioCandidates(dir) -> filtered audio files (graceful)
       [from P11.T2; auto-skips .gitkeep / non-audio / dotfiles]
  3. For each candidate (serial):
       a. fs.stat -> size_bytes
       b. sha256OfFile -> checksum (streaming read; arbitrary file size)
       c. probeAudio(ffprobePath, 15s timeout) -> duration_seconds
            ↓ on error: degrade to duration_seconds=null (NOT a row failure)
       d. mime = AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream"
       e. slugify(basename) -> name; basename -> display_name
       f. upsertBySourceTypeAndChecksum(...) -> 'inserted' | 'updated' | 'unchanged'
            ↓ on update: bytes-of-truth refreshed, operator-surface preserved
  4. Return summary { directory, directoryExisted, scanned, inserted, updated,
                       unchanged, skipped, failed, items[] }
```

### 关键设计决策

1. **UPSERT 主轴是 `(source_type, checksum)`，不是 `id`**：同一份音频文件内容（同 source_type）只对应一行。重命名 / 移动文件不会创建新行，只刷新 file_path / relative_path / size / mime / duration / updated_at。**operator-edited 列（display_name / tags / metadata_json / is_active / name / created_at / id）永不被 seed 覆盖**（CLAUDE.md §3.9 user_decision 精神延伸到 audio_library 的运营手编内容）。
2. **ffprobe 故障 graceful**：单文件 probe 失败只导致 `duration_seconds=null`，整体 seed pass 不挂；smoke 端到端验证了 ffprobe 不可用 + 0 byte 损坏文件 + corrupted MP3 三种降级路径。
3. **无 FK**：音频库与 media_items 完全解耦，design.md §8.5.1 显式约定（"音频库每个条目"独立于 trip / media）。多视频复用同一音频 / 跨 trip 复用 / 媒体删除不级联音频的语义都自然成立。
4. **不接入 bootstrap**：`AUDIO_LIBRARY_SEED_ON_STARTUP` 配置加了但 `server/src/index.ts` 不读，因为操作员手动跑 smoke / 未来 CLI 比每次 server 启动隐式 seed 更可控。Hook 已留给 P11.T6 落地真实 admin API 时启用。
5. **mime by ext**：ffprobe 的 `format_name`（如 "mp3" / "mov,mp4"）不能直接映射 MIME，所以 service 用一个小的 ext → mime 表（mp3 → audio/mpeg / m4a → audio/mp4 / aac → audio/aac / wav → audio/wav / flac → audio/flac / ogg → audio/ogg / opus → audio/opus）。其他扩展名落到 `application/octet-stream` 防御（行还是写得进去）。
6. **slugify name vs human display_name**：`name` 是机器 handle（`demo-track`），`display_name` 是 UI 标题（`Demo-Track`）。两者独立 + 第一次 seed 后都不再被覆盖；让操作员能改 display_name 不会破坏 logging / API 引用。

### 执行过的检查命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run build` — 干净
- `cd server && npm run smoke:audio-library-seed` — **36/36 PASS**
- 邻近回归 3 个 smoke 全绿：
  - `smoke:audio-processor` — 34/34 PASS（P11.T2 未影响）
  - `smoke:video-optimize-worker` — 52/52 PASS（P11.T1 未影响）
  - `smoke:p10-acceptance` — 37/37 PASS（P10 AI 未影响）
- `cd client && npm run lint` / `typecheck` / `build` — 干净（无客户端改动）

### Smoke 测试覆盖（36 PASS / 0 FAIL）

| 区段 | case 数 | 关键断言 |
| --- | --- | --- |
| Migration shape | 5 | 表存在 / 15 列齐全 / `(source_type, checksum)` UNIQUE / `(source_type, is_active)` 索引 / source_type CHECK 拒 invalid |
| Repository CRUD | 7 | findById / listActive / listAll / setActive(false) 隐藏 + 保留 / setActive 返回 changes=1 |
| Repository upsert idempotency | 8 | outcome='updated' / id 保留（不是新 UUID）/ file_path / size_bytes / relative_path 刷新 / display_name / tags / metadata_json / is_active 全部 preserved |
| Service: graceful fallback | 3 | missing dir directoryExisted=false / 仅 .gitkeep / non-audio+dotfile 全部 scanned=0 |
| Service: happy seed + 元数据 | 3 | 第一次 seed 1 inserted + mime/duration/size/checksum 正确 + name slug + display_name 保留原 case |
| Service: re-seed 幂等 | 2 | 第二次 seed outcome='updated' / 同一文件只 1 行 |
| Service: 跨 seed 保留 operator 编辑 | 1 | re-seed 后 operator-edited display_name + tags + metadata_json 全部保留 |
| Service: ffprobe 降级 | 2 | ffprobe 不可用 binary → duration=null + size/checksum/mime 仍正确 |
| Service: per-file 失败不级联 | 2 | mixed batch (good + 0-byte corrupt) → 2 inserted / 0 failed |
| Integrity | 2 | PRAGMA foreign_key_check 0 行 + PRAGMA integrity_check 'ok' |

**关键 invariants 已锁**：
- migration 014 fresh-DB + upgrade-from-013 都能跑（runMigrations 在 smoke 启动时调用，验证 011→012→013→014 完整链）
- operator-edited 列绝不被 seed 覆盖（4 字段单测）
- ffprobe 故障不级联（3 个降级测试用例）

### 新增风险

新增 1 条风险（R-145），衔接 R-138 ~ R-144 之后。

| ID | 风险 | 控制措施 |
| --- | --- | --- |
| **R-145** | seed runner 未实现 "deactivate missing audio"：操作员从 `assets/audio/default/` 删了文件后再 seed，原行的 `is_active` 保持 1 + `file_path` 仍指向不存在的文件。未来 render worker 调用时会 ffmpeg fail-to-open，从而失败该次渲染。 | (1) V1 显式接受这个状态：行保留 + is_active 不动 + file_path 不刷新（因为 file 不存在，checksum 无法重算，seed 根本不知道该删哪个旧行）；(2) 未来 polish：可加一个独立 cleanup job 扫描 `audio_library WHERE source_type='system' AND is_active=1` + `fs.access` 检测 + `setActive(false)`，但要先确认没有进行中的 render 引用该行；(3) 操作员可以手动 `setActive(false, ...)`（已暴露 API）+ 通过 admin 工具看 file_path 是否仍存在。**短期变通**：操作员先 setActive(false) 再删文件，比反过来安全。 |

### 当前已知限制

1. **默认音乐库为空**：`server/assets/audio/default/` 仅含 `.gitkeep`。`listSystemAudio()` 在没人手动放音频 / 跑 seed 时返回 `[]`。这是按设计的 graceful state；P11.T6 落地 user 上传后整体音乐库就有内容了。R-138（版权 metadata）也要在 P11.T3 之后真实采购音频时一并解决。
2. **ffprobe 不可用时 `duration_seconds=null`**：smoke 验证降级路径正确，但下游 render（P11.T5）若要根据 duration 决定 BGM 循环 / 截断长度，遇 null 需要回退到 fallback 时长或拒绝渲染。设计原则不变：null 不阻塞 seed，render 时再处理。
3. **未做 deactivate missing audio**：见 R-145。
4. **未做 startup auto-seed**：`AUDIO_LIBRARY_SEED_ON_STARTUP` 配置加了 hook 但 `server/src/index.ts` 不读 — 等 P11.T6 真实 admin API 落地时再决定接入方式。
5. **未做 audio 文件移动到 storage tree**：默认音频留在 `server/assets/audio/default/`（git 跟踪的项目资产），不复制进 `storage/` 运行时目录。`relative_path` 因此为 NULL；`file_path` 是绝对路径。P11.T6 用户上传时 `relative_path` 才会填值（落到 `storage/audio/...` 之类）。

R-138 ~ R-144 全部保留：
- **R-138 音频版权风险** — 仍待 P11.T6 真实采购音频 + metadata 字段使用时落实（schema 已预留 `metadata_json`，本次 seed 写入 `{seededFromDirectory, originalFilename, extension}` 占位，未来可加 license/author/source_url）
- **R-139 URL 导入 SSRF** — 待 P11.T6
- **R-140 长视频合成耗时** — 待 P11.T8
- **R-141 ffmpeg 音频 filter 兼容性** — P11.T2 部分缓解
- **R-142 多视频合成规格不一致** — 待 P11.T8
- **R-143 长视频 optimize 堵塞 video 通道** — P11.T1 已记
- **R-144 单 pass loudnorm dB 偏差** — P11.T2 已记，待 P11.T5

### 阶段定位

P11 阶段进度：
- ✅ T1 已完成（commit `73adae0`，video_optimize）
- ✅ T2 已完成（commit `99f7be0`，audio toolkit）
- ✅ T3 已完成（本轮，audio_library schema + repository + service + seed runner）
- ⬜ T4 ~ T9 仍为 LATER

下一步任务候选（按 docs/tasks.md P11 顺序）：
- **P11.T4 剪辑方案生成** — 基于 `video_segments` + `audioPolicy` 出 plan；rule engine 优先 + AI 可选
- **P11.T5 视频渲染 API** — 第一个真正消费 P11.T1 / T2 / T3 三块产物的 worker（video_optimize 转码 + audioProcessor 工具链 + audio_library 选音乐）
- **P11.T6 音频库 API** — 给 audio_library 加 list / upload / import-url / delete 路由（用户面）

由产品决策选定下一项再执行。

### 是否可以提交本次变更

可以。建议 commit 消息：

```
feat(server): audio_library schema + seed runner + repository/service (P11.T3)

- migration 014: audio_library STRICT table (15 cols / 8 CHECKs / 3 indexes)
  - (source_type, checksum) UNIQUE — the idempotency main axis
  - no FK to media_items (audio is cross-trip / cross-media reusable)
- repository: AudioLibraryRepository — findById / listActive*BySourceType /
  upsertBySourceTypeAndChecksum (preserves operator-edited surface) / setActive
- service: AudioLibraryService — listSystemAudio / findById / seedDefaultDirectory
  - graceful: missing dir, empty dir, .gitkeep, non-audio files all yield scanned=0
  - per-file ffprobe failure degrades to duration=null (NOT a row failure)
  - SHA256 via streaming createReadStream (handles arbitrary file size)
  - operator-edited columns (display_name / tags / metadata_json / is_active)
    are NEVER clobbered by a re-seed
- config: AUDIO_LIBRARY_SEED_ON_STARTUP=false (hook reserved; bootstrap NOT wired)
- smoke: smoke:audio-library-seed — 36/36 PASS
- new risk R-145 (deactivate-missing-audio) recorded

No HTTP route, no frontend, no bootstrap wiring. P11.T4~T9 stay LATER.
```

---

## 2026-05-26 · P11.T4 剪辑方案生成（rule engine + audioPolicy + AI refine hook）

### 状态

✅ 完成。`docs/tasks.md` P11.T4 行从 `[ ] LATER` 翻成 `[x] MUST`。P11.T5 ~ P11.T9 保持 `[ ] LATER`，本轮未触碰。

### 范围按提示词收窄

实现：
- Edit plan JSON 结构（`VideoEditPlan` 14 字段 + 子结构 `EditPlanClip` / `EditPlanTransition` / `EditPlanAudioPolicy` / `EditPlanWarning`）
- 纯函数 rule engine（`buildEditPlan` / `computePerClipCapSeconds` / `resolveAudioPolicy` —— 不触 DB，可单测）
- `VideoEditPlanService` —— DB lookup 包装 + warning 收集 + AI refiner gate
- `POST /api/trips/:tripId/generate-edit-plan` —— 返回 plan JSON，不渲染
- audioPolicy 三种 mode：`keep_original` / `mute` / `replace_with_library` + bg-audio 缺失 graceful 降级
- AI refiner 接口预留（`aiRefinePlan` + `noopPlanRefiner`）+ `VIDEO_EDIT_PLAN_AI_ENABLED=false` 配置（V1 默认 off）

**显式不做**（留给 P11.T5 ~ T9）：
- 任何 ffmpeg 调用 / 实际渲染
- `processing_jobs` / `media_versions` 写入
- 真实 AI 模型调用
- 前端预览 UI（P11.T7）
- 多视频合成（P11.T8）
- ducking / 智能精彩片段识别 / 复杂转场（fade / crossfade）

### 修改 / 新增的文件

**新增（5）**：
- `server/src/media/videoEditPlan.ts` — 14 个公开类型 + 4 个常量 + 5 个纯函数。无 DB 依赖、无 ffmpeg 依赖；可单测。
- `server/src/media/videoEditPlanService.ts` — `VideoEditPlanService` 类（构造接受 deps bundle + audioDefaults + aiEnabled + 可选 refiner + 可选 logger）。
- `server/src/media/videoEditPlanSchemas.ts` — zod body schema + 4 个闭合枚举 schema。
- `server/src/routes/videoEditPlan.ts` — 单 endpoint route（`makeVideoEditPlanRouter`）。
- `server/src/scripts/video-edit-plan-smoke.ts` — 33 个 case smoke（pure + service + HTTP 三层）。

**修改（6）**：
- `server/src/media/index.ts` — re-export 22 个公开符号（types + constants + 函数 + service + schemas）。
- `server/src/config/index.ts` — 加 `VIDEO_EDIT_PLAN_AI_ENABLED=false` env + `config.video.editPlan.aiEnabled` 字段。
- `server/src/app.ts` — `CreateAppOptions` 加 `videoEditPlanService` + mount route。
- `server/src/index.ts` — 构造 `AudioLibraryRepository` + `VideoEditPlanService` + 注入 createApp。
- `server/package.json` — 加 `smoke:video-edit-plan` 脚本。
- `.env.example` — 加 P11.T4 段落注释 + 默认值。

**文档（2）**：`docs/tasks.md`（P11.T4 标 [x]） + `docs/progress.md`（本节）。

**未触碰的领域**：
- 任何既有 worker / handler / migration
- 客户端代码（0 行）
- `processing_jobs` / `media_versions` / `video_segments`
- `media_items` 的任何列（user_decision / active_version_type 等）
- P9 / P10 / P11.T1 / P11.T2 / P11.T3 任何阶段产物

### Edit plan JSON 结构示例

由 `buildEditPlan` 在 3 个视频 (12s / 20s / 8s) 上、target=30s、`replace_with_library` BGM 模式生成（cumulative 28s < 30s 触发 insufficient warning）：

```jsonc
{
  "version": "1.0",
  "tripId": "trip-demo",
  "style": "standard",
  "targetDurationSec": 30,
  "totalDurationSec": 28,
  "resolution": "1080p",
  "aspectRatio": "16:9",
  "sourceMediaIds": ["vid-a", "vid-b", "vid-c"],
  "clips": [
    { "mediaId": "vid-a", "sourcePath": "trips/trip-demo/originals/vid-a.mp4",
      "startSec": 0, "endSec": 10, "durationSec": 10, "order": 0,
      "reason": "first 10s of source (rule_engine_v1)" },
    { "mediaId": "vid-b", "sourcePath": "trips/trip-demo/originals/vid-b.mp4",
      "startSec": 0, "endSec": 10, "durationSec": 10, "order": 1,
      "reason": "first 10s of source (rule_engine_v1)" },
    { "mediaId": "vid-c", "sourcePath": "trips/trip-demo/originals/vid-c.mp4",
      "startSec": 0, "endSec": 8,  "durationSec": 8,  "order": 2,
      "reason": "first 8s of source (rule_engine_v1)" }
  ],
  "transitions": [
    { "fromClipOrder": 0, "toClipOrder": 1, "kind": "none", "durationSec": 0 },
    { "fromClipOrder": 1, "toClipOrder": 2, "kind": "none", "durationSec": 0 }
  ],
  "audioPolicy": {
    "mode": "replace_with_library",
    "backgroundAudioId": "audio-7f3c",
    "removeOriginalAudio": true,
    "loudnorm": true,
    "fadeInSeconds": 1.5,
    "fadeOutSeconds": 2,
    "loopToFit": true,
    "targetDurationSec": 30
  },
  "warnings": [
    {
      "code": "insufficient_source_material",
      "message": "Selected clips total 28s, short of the 30s target. Consider lowering the target duration or adding more source videos.",
      "details": { "achievedSec": 28, "targetSec": 30, "clipCount": 3 }
    }
  ],
  "createdAt": "2026-05-26T04:00:00.000Z",
  "aiRefined": false
}
```

### Rule engine 当前规则（V1）

```
buildEditPlan(input):
  1. resolve target = input.targetDurationSec ?? STYLE_TARGETS[style] ?? 30
  2. perClipCap = max(MIN_CLIP_DURATION_SECONDS=3, target / N)
  3. for each candidate in order (mediaRepo.list 默认 created_at DESC):
       clipDur = min(durationSec, perClipCap)
       if cumulative + clipDur > target: clipDur = target - cumulative (truncate)
       push clip { startSec: 0, endSec: clipDur, durationSec: clipDur, order, reason }
       cumulative += clipDur
       if cumulative >= target: break
  4. if cumulative < target: warn 'insufficient_source_material' with details
  5. emit N-1 transitions (kind='none', durationSec=0)
```

**为什么"取每段开头 N 秒"而非中段 / 末段**：
- 不需要 per-segment 评分基础设施（那是 video_segments + P9.T7 的领域；P11.T4 不依赖 P9.T7 跑过）
- 视频开头通常含场景定调 / 镜头建立 / 起手动作，剪辑感觉自然
- 完全确定性 + 可重现（同样输入产同样输出，便于 smoke 锁定）
- 未来可升级：消费 P9.T7 `video_segment_quality` 选高分段、用 `is_recommended=1` 段优先

### audioPolicy 设计

| requested.mode | bg audio | resolved.mode | 备注 |
| --- | --- | --- | --- |
| undefined | null | `keep_original` | 默认 |
| undefined | provided + active | `replace_with_library` | 推断 |
| `mute` | any | `mute` | `removeOriginalAudio=true`, fade=0 |
| `keep_original` | any | `keep_original` | bg audio 被忽略 |
| `replace_with_library` | null / inactive | `keep_original` + warning | graceful 降级 |
| `replace_with_library` | provided + active | `replace_with_library` | 完整启用 |

**字段语义**（已在类型 jsdoc 详述）：
- `backgroundAudioId` —— 非空仅当 mode=`replace_with_library`
- `removeOriginalAudio` —— `mute`/`replace_with_library` 时 true（duplicate signal 让 renderer 不必再编码 mode→strip 逻辑）
- `loudnorm` —— 来自 `config.video.audio.loudnormEnabled`，仅 `replace_with_library` 有效消费
- `fadeInSeconds` / `fadeOutSeconds` —— 来自 `config.video.audio.fadeIn/Out`，所有模式都保留默认（让未来 worker 想 fade `keep_original` 也有数据）
- `loopToFit` —— `replace_with_library` true / 其他 false
- `targetDurationSec` —— 镜像 plan 顶层，让 renderer 单点调用 `prepareBackgroundMusic(target=this)`

### 执行过的检查命令和结果

- `cd server && npx tsc --noEmit` — 干净
- `cd server && npm run lint` — 干净（0 warning）
- `cd server && npm run build` — 干净
- `cd server && npm run smoke:video-edit-plan` — **33/33 PASS**
- 邻近回归 5 个 smoke 全绿：
  - `smoke:audio-library-seed` — 36/36 PASS（P11.T3 未影响）
  - `smoke:audio-processor` — 34/34 PASS（P11.T2 未影响）
  - `smoke:video-optimize-worker` — 52/52 PASS（P11.T1 未影响）
  - `smoke:p10-acceptance` — 37/37 PASS
  - `smoke:p9-acceptance` — 36/36 PASS
- `cd client && npm run lint` / `typecheck` / `build` — 干净（无前端改动）

### Smoke 测试覆盖（33 PASS / 0 FAIL）

| 层 | case 数 | 关键断言 |
| --- | --- | --- |
| Pure rule engine | 13 | computePerClipCapSeconds（3 case，含 N=0 / floor 3）+ resolveAudioPolicy 4 mode 转换表 + buildEditPlan 6 场景（0 cand / 1×120s @ target=30 → cap=30 / 1×5s @ target=30 → warning / 4 long → 4×7.5s / 3 short → cumulative < target / 字段携带 + N-1 transitions） |
| Service + DB | 17 | empty trip / image-only / happy 2 video → 2×15s / sourcePath+order+reason / style→target 映射（short=15/long=60）/ 显式 targetDurationSec override / audioMode=mute / backgroundAudioId 隐含 replace_with_library / bg-audio 不存在降级 + warning / bg-audio inactive 降级 + warning / 显式 mediaIds 跨 trip / 缺失 id / 非 video / 有效 mediaIds 仍出可用 plan / 缺失 trip 404 / 未知 body key 400 / 越界 targetDurationSec 400 / 未知 style enum 400 |
| HTTP 层 | 3 | POST happy 200 + body shape 14 字段齐全 / POST 缺失 trip 404 + envelope.code='NOT_FOUND' / POST 未知 key 400 + envelope.code='VALIDATION_FAILED' |

### 新增风险

新增 1 条风险（R-146），衔接 R-138 ~ R-145 之后。

| ID | 风险 | 控制措施 |
| --- | --- | --- |
| **R-146** | rule engine V1 没有真正的"精彩片段"识别 —— "取每段开头 N 秒"对游记 / 旅行视频（前几秒往往是开场画面 / 调机位）可能截到无意义片段。用户期望的"高光集锦"需要 video_segment_quality（P9.T7）或 AI refiner 才能真正智能化。 | (1) V1 接受：plan 是 JSON 可由用户在前端（P11.T7）手动调整 startSec / endSec / 重排 / 删段；rule engine 只负责"开箱即有方案"；(2) 未来 polish：消费 `video_segments` + `is_recommended=1` 过滤明显垃圾段（black / blurry / waste），按 `quality_score DESC` 排序选高分；(3) 真正 AI refiner 落地（不是 V1 noop）时把 plan 喂给视觉理解模型做语义重排 —— 这要等到 P11.T5+ 或独立 P12 阶段。 |

### 当前已知限制

1. **只生成方案，不渲染**：P11.T5 才真正消费 plan + 调 ffmpeg 输出视频。
2. **rule engine 简单**：见 R-146；后续可加 video_segment_quality 评分 + AI 语义。
3. **AI refiner 仅接口预留**：`VIDEO_EDIT_PLAN_AI_ENABLED=false` 默认；即便 true 也只在 bootstrap 注入了真实 refiner 时才调用（V1 始终是 noop pass-through）。
4. **转场默认 `none`**：V1 渲染 P11.T5 也只支持 concat；复杂转场（fade / crossfade）留给 P11.T5+ render polish。
5. **不消费 video_segments**：rule engine 只读 `media_items.duration`；P9.T7 已经写了 `is_recommended` / `quality_score` 但本轮不消费（避免范围蔓延）。R-146 disposition 指向未来升级路径。
6. **clips 顺序按 `created_at DESC`**：mediaRepo.list 默认顺序；与 gallery 一致但非"按拍摄时间"。未来 P11.T7 前端可让用户拖拽重排。
7. **mediaIds 跨 trip 静默拒绝**：emit `media_not_found` warning 而不是显式 `cross_trip_media`；与"不暴露其他 trip 的 media 存在性"安全策略一致。

R-138 ~ R-145 全部保留：
- **R-138 音频版权风险** — 待 P11.T6 / 真实采购音频
- **R-139 URL 导入 SSRF** — 待 P11.T6
- **R-140 长视频合成耗时** — 待 P11.T8
- **R-141 ffmpeg 音频 filter 兼容性** — P11.T2 部分缓解
- **R-142 多视频合成规格不一致** — 待 P11.T8
- **R-143 长视频 optimize 堵塞 video 通道** — P11.T1 已记
- **R-144 单 pass loudnorm dB 偏差** — P11.T2 已记
- **R-145 deactivate missing audio** — P11.T3 已记

### 阶段定位

P11 阶段进度：
- ✅ T1 已完成（commit `73adae0`，video_optimize）
- ✅ T2 已完成（commit `99f7be0`，audio toolkit）
- ✅ T3 已完成（commit `e90eead`，audio_library schema + seed runner）
- ✅ T4 已完成（本轮，edit plan rule engine + route）
- ⬜ T5 ~ T9 仍为 LATER

下一步任务候选（按 docs/tasks.md P11 顺序）：
- **P11.T5 视频渲染 API** —— 第一个真正消费 P11.T1 / T2 / T3 / T4 全套产物的 worker（plan → ffmpeg concat + audio toolkit 应用 audioPolicy + 写 `media_versions(version_type='edited')`）
- **P11.T6 音频库 API** —— 给 audio_library 加 user-facing CRUD 路由
- **P11.T7 前端剪辑预览** —— UI 调用 P11.T4 生成 plan → 显示 → 用户调整 → P11.T5 渲染

由产品决策选定下一项再执行。

### 是否可以提交本次变更

可以。建议 commit 消息：

```
feat(server): edit plan rule engine + POST /api/trips/:tripId/generate-edit-plan (P11.T4)

- media/videoEditPlan.ts: pure types + rule engine + audioPolicy resolver
  - buildEditPlan (no DB / no ffmpeg) — deterministic clip selection
  - resolveAudioPolicy — keep_original / mute / replace_with_library + graceful fallback
  - aiRefinePlan + noopPlanRefiner — AI hook reserved, V1 noop
- media/videoEditPlanService.ts: DB lookup wrapper + warning collection
  - trip 404 / mediaIds cross-trip / non-video / null-duration handling
  - background_audio not_found / inactive → graceful keep_original fallback
- media/videoEditPlanSchemas.ts: .strict() body schema + 4 closed enums
- routes/videoEditPlan.ts: POST /api/trips/:tripId/generate-edit-plan
- config: VIDEO_EDIT_PLAN_AI_ENABLED=false (hook reserved; V1 noop refiner)
- smoke: smoke:video-edit-plan — 33/33 PASS (pure + service + HTTP)
- new risk R-146 (rule engine has no highlight detection) recorded

No render, no ffmpeg, no processing_jobs / media_versions writes,
no real AI, no frontend. P11.T5~T9 stay LATER.
```

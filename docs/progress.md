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

## 下一阶段入口

进入阶段 7（安全删除与恢复）的第一项任务：

- **P7.T1 [MUST]**：软删除路径 —— `DELETE /api/media/:id` 写 `deleted_at`；事务内先重置 `duplicate_groups.recommended_media_id`（若该 media 是组的 recommended），清/翻 `duplicate_group_items.user_decision`；保证不破坏 FK / 不留下指向已软删除 media 的悬挂引用；前端走"二次确认"提示但不真删文件（design.md §4.3 软删除主路径）。

阶段完成后回填本文件对应小节（状态、commit 范围、每个任务的成果与验证、阶段剩余风险）。

---

## 维护说明

- 每完成一个阶段，在本文件追加一节并把状态从 `进行中` 改为 `已完成`。
- 每完成一个 task，在所属阶段小节里追加 commit 与主要成果条目；不在文件末尾堆叠。
- 风险一旦消化，从 `剩余风险` 表中移除并附 commit 引用，避免列表无限增长。
- 本文件不替代 `docs/tasks.md`：任务的范围、约束、验收以 tasks.md 为准；本文件只是回顾视图。

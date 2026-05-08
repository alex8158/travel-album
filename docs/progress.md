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

- 状态：**未开始**
- 任务范围：P1.T1 – P1.T8（参见 [docs/tasks.md](tasks.md) §阶段 1）
- 入口任务：**P1.T1 [MUST]** 新增 `trips` 表 migration
  - 字段以 [docs/requirements.md](requirements.md) §8.1 为准
  - 必含软删除字段 `deleted_at`
  - 通过 `_schema_migrations` 跟踪，文件名建议 `001_*.sql`

阶段完成后回填本文件对应小节（状态、commit 范围、每个任务的成果与验证、阶段剩余风险）。

---

## 维护说明

- 每完成一个阶段，在本文件追加一节并把状态从 `进行中` 改为 `已完成`。
- 每完成一个 task，在所属阶段小节里追加 commit 与主要成果条目；不在文件末尾堆叠。
- 风险一旦消化，从 `剩余风险` 表中移除并附 commit 引用，避免列表无限增长。
- 本文件不替代 `docs/tasks.md`：任务的范围、约束、验收以 tasks.md 为准；本文件只是回顾视图。

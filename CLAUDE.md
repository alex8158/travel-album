# CLAUDE.md — Travel Album Site V2 开发规则

本文件是本项目对 AI 开发助手（Claude Code / Codex / Kiro 等）的强约束，所有代码生成必须遵守。

权威输入顺序：
1. `docs/requirements.md`：需求规格说明书（不可改）。
2. `docs/design.md`：基于需求生成的架构设计。
3. `docs/tasks.md`：基于需求和设计拆分的可执行任务清单。
4. 本文件（CLAUDE.md）：贯穿项目的硬性开发规则。

需求、设计、任务三者出现冲突时，以 `requirements.md` 为准，并先修文档再写代码。

---

## 1. 开发流程硬性约束

1. 不允许跳过 `docs/design.md` 直接写业务代码。
2. 不允许一次性实现所有功能，必须按 `docs/tasks.md` 中的任务顺序逐项执行。
3. 每次只执行 `docs/tasks.md` 中的一个任务。
4. 在动手修改代码前，必须先：
   - 说明本次执行的是哪一个任务（任务编号 + 标题）。
   - 列出准备创建或修改的文件清单。
   - 说明本次任务**不做**的事情，避免范围蔓延。
5. 不允许一次性大规模重构。如果发现任务范围过大，先在 `docs/tasks.md` 中拆分，再执行其中一个子任务。
6. 完成任务后必须输出：修改文件清单、验证方式与结果、已知风险、下一步建议。
7. 当用户要求“写代码 / 实现功能”而当前文档（设计 / 任务）尚不充分时，先补文档再写代码。

## 2. 不可逾越的产品红线

来源：`requirements.md` §3、§7.18、§17。

1. 原始图片不得被覆盖或修改。
2. 原始视频不得被覆盖或修改。
3. 自动增强、AI 精修、视频转码、视频片段、剪辑输出等都必须作为派生文件单独保存，并通过 `media_versions` / `video_segments` 等表关联。
4. 系统不得自动永久删除任何用户素材，只允许打标记 / 软删除。
5. 永久删除必须由用户在前端二次确认后才能执行。
6. 删除 `media_items` 前必须先处理关联表（`media_analysis`、`duplicate_group_items`、`media_versions`、`video_segments`、`processing_jobs` 等），且若该媒体是 `duplicate_groups.recommended_media_id`，必须先重新选择或置空。
7. 数据库变更必须使用事务，避免“文件删了但数据库没改”或反之。
8. AI 调用默认关闭。未配置 AI 时，全部基础功能必须仍可用。

任何违反以上红线的代码必须在提交前修正，没有例外。

## 3. 代码与架构原则

1. 模块边界遵循 `requirements.md` §5 中的术语：`Upload_Manager` / `File_Classifier` / `Dedup_Engine` / `Quality_Selector` / `Worker` 等独立成模块，不混入路由层。
2. 文件存储必须封装为 `StorageProvider` 接口，第一版实现本地磁盘，后续可替换为 S3，**业务代码不得直接拼接绝对路径**。
3. AI 模型调用必须封装为可插拔 `AIProvider`，业务流程不得硬编码模型名或厂商。
4. 阈值（模糊阈值、相似度阈值、质量权重、视频切分参数等）集中放在配置层，不允许散落到业务代码里。
5. “传统算法优先，AI 按需介入”：能用 sharp / OpenCV / FFmpeg / pHash 解决的，第一版不调用大模型。
6. 上传接口必须立刻返回，不允许在 HTTP 请求中同步执行缩略图、hash、模糊检测等耗时操作。所有耗时任务进 `processing_jobs` 队列异步处理。
7. 单个媒体或单个任务失败必须被隔离，不允许导致同批次其他媒体失败或整个 Trip 不可用。
8. 推荐结果必须可解释：`media_analysis.reason` / `duplicate_group_items.reason` 等字段必须写入，不得空缺。
9. 用户的手动选择（`user_decision`）优先级高于系统推荐，后续重新计算时不得覆盖用户选择，除非用户主动要求重算。

## 4. 数据与状态机

1. `media_items.status` 取值限定为：`uploaded` / `processing` / `processed` / `failed` / `archived` / `deleted`。
2. `processing_jobs.status` 取值限定为：`pending` / `running` / `success` / `failed` / `retrying` / `cancelled`。
3. 任意状态变更必须只走允许的迁移路径，不允许直接 `UPDATE status = 'success'` 跳过中间状态。
4. Worker 启动时必须能识别长时间停留在 `running` 的僵尸任务，按策略恢复或标记 `failed`。
5. 第一版采用软删除：`deleted_at` 不为空表示已删除。前端默认查询过滤 `deleted_at IS NULL`。

## 5. 安全与隐私

1. 严禁提交真实密钥、token、用户数据。
2. 仅允许提交 `.env.example`，禁止提交 `.env`。`.env` 必须加入 `.gitignore`。
3. 不在日志中打印完整 EXIF GPS、用户原始文件名以外的敏感字段；如需调试，截断或脱敏。
4. 上传接口必须做文件类型与大小校验，拒绝伪造扩展名进入图片/视频处理流程。
5. AI 调用日志记录模型、耗时、状态、费用估算，不记录用户图片原始 base64。

## 6. 任务执行后产出

每完成一个 `tasks.md` 中的任务，输出必须包含：

1. **任务编号与标题**。
2. **改动文件清单**（含新增 / 修改 / 删除）。
3. **验证方式**：跑了哪些 build / test / lint / 手动验证步骤，结果如何。
4. **风险点与未覆盖场景**。
5. **下一步建议**：通常指向 `tasks.md` 中的下一个任务。

如果某项验证未跑（例如该阶段还没接入测试框架），必须明确写出原因，不得隐瞒。

## 7. 文档维护

1. 实现过程中如果发现需求文档与实际不一致，先在对话中提出，由用户决定是否修改 `requirements.md`，再相应修订 `design.md` / `tasks.md`，最后改代码。
2. `docs/design.md` 在阶段性结束时（例如完成阶段 1 / 阶段 2）回顾一次，更新与实际偏差较大的部分。
3. `docs/tasks.md` 中已完成任务标记 `[x]`，不删除历史任务，方便回看。

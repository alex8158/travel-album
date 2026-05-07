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

- **Node.js**：建议 LTS 版本（具体版本在 P0.T2 初始化 `package.json` 时确定）。
- **SQLite**：第一版数据库；项目使用 `better-sqlite3`，会随 npm 安装。
- **磁盘空间**：原始图片 / 视频 + 派生文件均落盘到 `storage/`，请预留足够空间。

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

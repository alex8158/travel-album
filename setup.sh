#!/usr/bin/env bash
# =============================================================================
# Travel Album Site V2 — One-shot installer (setup.sh)
# -----------------------------------------------------------------------------
# 用途：
#   在一台干净的 macOS / Ubuntu / Debian / Fedora / RHEL / Arch 机器上，把所有
#   运行依赖（系统级 + npm）装齐、把 .env 与运行时目录建好、把前后端编译产物
#   构建出来。idempotent — 可以反复运行。
#
# 用法：
#   ./setup.sh
#
# 本脚本做的事：
#   1. 探测操作系统 + 包管理器（brew / apt / dnf / pacman）。
#   2. 校验或安装：Node.js >= 20.11.0、ffmpeg、ffprobe、native 编译工具链
#      （better-sqlite3 通过 node-gyp 编译，依赖 Python + 系统 C++ 编译器）。
#   3. 在 server/ 和 client/ 下执行 npm ci（无 lockfile 时回退 npm install）。
#   4. 如果根目录没有 .env，从 .env.example 复制一份并提示按需修改。
#   5. 创建 ./data 和 ./storage 运行时目录。
#   6. server 编译（tsc → dist/）+ client 构建（tsc -b && vite build → dist/）。
#   7. 打印下一步：怎么 start、怎么部署 SPA、怎么备份。
#
# 本脚本不做的事：
#   - 不启动任何服务（用 start.sh）。
#   - 不配置反向代理 / TLS / systemd / pm2 / docker。
#   - 不写入真实密钥；.env 仅由 .env.example 拷贝得到，默认 dev 配置。
#   - 不修改既有 .env 文件（再次运行不覆盖你已有的环境变量）。
#
# 退出码：
#   0  全部成功
#   1  通用失败
#   2  系统级依赖缺失且无法自动安装
#   3  Node.js 版本过低
# =============================================================================

set -euo pipefail

# ---- 1. 颜色 & 日志辅助 ----------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_GREEN='\033[0;32m'
  C_YELLOW='\033[0;33m'
  C_RED='\033[0;31m'
  C_BLUE='\033[0;34m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

log_step()    { printf "\n${C_BOLD}${C_BLUE}==> %s${C_RESET}\n" "$*"; }
log_info()    { printf "    %s\n" "$*"; }
log_ok()      { printf "    ${C_GREEN}✓ %s${C_RESET}\n" "$*"; }
log_warn()    { printf "    ${C_YELLOW}! %s${C_RESET}\n" "$*"; }
log_err()     { printf "    ${C_RED}✗ %s${C_RESET}\n" "$*" 1>&2; }

# ---- 2. 进入仓库根 ---------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
log_step "Repository root: $REPO_ROOT"

# ---- 3. 检测 OS / 包管理器 -------------------------------------------------
OS="$(uname -s)"
PKG_MGR=""
PKG_INSTALL_CMD=""
PKG_UPDATE_CMD=""

case "$OS" in
  Darwin)
    if command -v brew >/dev/null 2>&1; then
      PKG_MGR="brew"
      PKG_INSTALL_CMD="brew install"
      PKG_UPDATE_CMD="brew update"
    else
      log_err "macOS 检测到了，但没有 Homebrew。请先安装 Homebrew：https://brew.sh"
      exit 2
    fi
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      PKG_MGR="apt"
      PKG_INSTALL_CMD="sudo apt-get install -y"
      PKG_UPDATE_CMD="sudo apt-get update"
    elif command -v dnf >/dev/null 2>&1; then
      PKG_MGR="dnf"
      PKG_INSTALL_CMD="sudo dnf install -y"
      PKG_UPDATE_CMD="sudo dnf check-update || true"
    elif command -v pacman >/dev/null 2>&1; then
      PKG_MGR="pacman"
      PKG_INSTALL_CMD="sudo pacman -S --noconfirm"
      PKG_UPDATE_CMD="sudo pacman -Sy"
    else
      log_err "Linux 检测到了，但没找到 apt-get / dnf / pacman。请手动安装下列依赖。"
      exit 2
    fi
    ;;
  *)
    log_err "不支持的 OS：$OS（本脚本支持 macOS / Linux）。Windows 用户请用 WSL2。"
    exit 2
    ;;
esac
log_ok "OS: $OS，包管理器: $PKG_MGR"

# ---- 4. 校验 Node.js >= 20.11.0 -------------------------------------------
log_step "校验 Node.js >= 20.11.0"
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=11

if ! command -v node >/dev/null 2>&1; then
  log_err "未检测到 node。请先安装 Node.js（推荐 nvm：https://github.com/nvm-sh/nvm）"
  log_info "  nvm install 20"
  log_info "  nvm use 20"
  exit 3
fi

NODE_VERSION_RAW="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION_RAW" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VERSION_RAW" | cut -d. -f2)"

if (( NODE_MAJOR < NODE_MIN_MAJOR )) || \
   { (( NODE_MAJOR == NODE_MIN_MAJOR )) && (( NODE_MINOR < NODE_MIN_MINOR )); }; then
  log_err "Node.js 当前 $NODE_VERSION_RAW，要求 >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR.0"
  exit 3
fi
log_ok "node $NODE_VERSION_RAW"

if ! command -v npm >/dev/null 2>&1; then
  log_err "未检测到 npm（应该随 node 一起安装）。"
  exit 3
fi
log_ok "npm $(npm -v)"

# ---- 5. 安装 ffmpeg / ffprobe ---------------------------------------------
log_step "校验 ffmpeg / ffprobe"
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  log_ok "ffmpeg $(ffmpeg -version | head -n1 | awk '{print $3}')"
  log_ok "ffprobe $(ffprobe -version | head -n1 | awk '{print $3}')"
else
  log_warn "未检测到 ffmpeg/ffprobe，尝试用 $PKG_MGR 安装"
  case "$PKG_MGR" in
    brew)   eval "$PKG_INSTALL_CMD ffmpeg" ;;
    apt)    eval "$PKG_UPDATE_CMD" && eval "$PKG_INSTALL_CMD ffmpeg" ;;
    dnf)    eval "$PKG_INSTALL_CMD ffmpeg" ;;
    pacman) eval "$PKG_UPDATE_CMD" && eval "$PKG_INSTALL_CMD ffmpeg" ;;
  esac
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    log_ok "ffmpeg + ffprobe 安装完成"
  else
    log_err "自动安装失败。视频功能将不可用；图片功能不受影响。"
    log_info "  手动安装后重新跑本脚本。参考 README.md §系统级依赖。"
    # 不退出 —— 让用户选择是否继续（CLAUDE.md §2.8 精神：base feature 不依赖 ffmpeg）
  fi
fi

# ---- 6. 安装 native 编译工具链（better-sqlite3 需要） ---------------------
log_step "校验 native 编译工具链（better-sqlite3 走 node-gyp）"
case "$PKG_MGR" in
  brew)
    if ! xcode-select -p >/dev/null 2>&1; then
      log_warn "未检测到 Xcode Command Line Tools，尝试 xcode-select --install"
      xcode-select --install || true
      log_info "  如果弹窗了，请装完 CLT 再重跑本脚本。"
    else
      log_ok "Xcode CLT 已安装"
    fi
    ;;
  apt)
    if ! dpkg -s build-essential >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
      log_warn "缺 build-essential 或 python3，安装中"
      eval "$PKG_UPDATE_CMD"
      eval "$PKG_INSTALL_CMD build-essential python3"
    fi
    log_ok "build-essential + python3 OK"
    ;;
  dnf)
    eval "$PKG_INSTALL_CMD gcc-c++ make python3"
    log_ok "gcc-c++ + make + python3 OK"
    ;;
  pacman)
    eval "$PKG_INSTALL_CMD base-devel python"
    log_ok "base-devel + python OK"
    ;;
esac

# ---- 7. .env 文件 ---------------------------------------------------------
log_step "环境变量文件 .env"
if [[ -f "$REPO_ROOT/.env" ]]; then
  log_ok ".env 已存在，保留不覆盖"
else
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  log_ok "从 .env.example 创建了 .env"
  log_warn "默认值为开发配置；上线前请按需调整："
  log_info "  - NODE_ENV=production"
  log_info "  - PORT （默认 3000）"
  log_info "  - PERMANENT_DELETE_ENABLED （默认 false，需要永久删除功能时再打开）"
  log_info "  - AI_ENABLED + AI_PROVIDER 等 AI 相关（默认 false，按需配置）"
  log_info "  - AUDIO_LIBRARY_SEED_ON_STARTUP （默认 false，把音频放进 server/assets/audio/default/ 后可开启）"
fi

# ---- 8. 运行时目录 --------------------------------------------------------
log_step "运行时目录"
mkdir -p "$REPO_ROOT/data"
mkdir -p "$REPO_ROOT/storage"
log_ok "data/    （SQLite 数据库 app.db 落在这里）"
log_ok "storage/ （所有上传的原图原视频 + 派生文件落在这里）"

# ---- 9. 安装 npm 依赖 -----------------------------------------------------
install_npm() {
  local dir="$1"
  log_step "安装 npm 依赖：$dir"
  if [[ -f "$dir/package-lock.json" ]]; then
    ( cd "$dir" && npm ci )
  else
    ( cd "$dir" && npm install )
  fi
  log_ok "$dir/node_modules 就绪"
}

install_npm "$REPO_ROOT/server"
install_npm "$REPO_ROOT/client"

# ---- 10. 构建产物 ---------------------------------------------------------
log_step "编译 server（tsc → server/dist）"
( cd "$REPO_ROOT/server" && npm run build )
log_ok "server/dist/index.js"

log_step "构建 client（tsc -b && vite build → client/dist）"
( cd "$REPO_ROOT/client" && npm run build )
log_ok "client/dist/index.html + assets/"

# ---- 11. 收尾 -------------------------------------------------------------
cat <<EOF

${C_BOLD}${C_GREEN}=========================================================================${C_RESET}
${C_BOLD}${C_GREEN}  setup 完成${C_RESET}
${C_BOLD}${C_GREEN}=========================================================================${C_RESET}

下一步：

  ${C_BOLD}启动 server${C_RESET}
    cd server
    npm start                # 前台，看日志
                             # 或：nohup npm start > ../data/server.log 2>&1 &
                             # 生产推荐：systemd unit 或 pm2

  ${C_BOLD}启动 client（V1 三选一）${C_RESET}

    选项 A — Vite preview（最简单，自带 4173 端口；需先在 vite.config.ts
              加 preview.proxy 配置以转发 /api → server，详见 README）

    选项 B — 反向代理（推荐生产）
              用 nginx / Caddy 把 /api/* 转发到 :3000，其他静态文件
              直接读 client/dist/。示例 Caddyfile：

                example.com {
                  reverse_proxy /api/* localhost:3000
                  reverse_proxy /storage/* localhost:3000
                  root * $(pwd)/client/dist
                  try_files {path} /index.html
                  file_server
                }

    选项 C — 自带 ./start.sh（dev-grade，server + vite preview）

  ${C_BOLD}运维清单${C_RESET}
    - 备份目标：data/app.db 与 storage/ 整个目录
    - 日志：server 默认 pino JSON 到 stdout，自己 pipe 到文件或采集
    - 健康：GET /api/health 返回 ffmpegAvailable / permanentDeleteEnabled / aiEnabled
    - 配置变更：编辑 .env 后重启 server；client 改了需要重跑 npm run build

  ${C_BOLD}红线（CLAUDE.md §2）${C_RESET}
    - 原始图片 / 视频永不被覆盖
    - 永久删除默认关闭（PERMANENT_DELETE_ENABLED=false）
    - AI 默认关闭（AI_ENABLED=false）；无 AI 时基础功能仍可用

EOF

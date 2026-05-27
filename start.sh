#!/usr/bin/env bash
# =============================================================================
# Travel Album Site V2 — Dev-grade launcher (start.sh)
# -----------------------------------------------------------------------------
# 用途：
#   在 ./setup.sh 跑完之后，最小化启动 server 与 client。适用于个人 V1 自托管
#   或本地 demo。生产环境请用 systemd / pm2 / docker + nginx/Caddy 反代。
#
# 用法：
#   ./start.sh              # 前台启动（Ctrl+C 同时杀掉 server 与 client）
#   ./start.sh --bg         # 后台启动，写入 ./data/*.pid 和 ./data/*.log
#   ./start.sh --stop       # 关掉后台进程
#   ./start.sh --status     # 看后台进程是否存活
#
# 注意：
#   - 本脚本用 npx serve 跑 client/dist 静态文件，并把 /api/* 与 /storage/*
#     反向代理到 server。如未安装 serve，会自动 npx 拉取（首次有网络成本）。
#   - server 走 server/dist 的编译产物（不是 dev watch）。改了代码要先
#     `cd server && npm run build` 再重启。client 改了要 `cd client && npm run build`。
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

SERVER_PORT="${PORT:-3000}"
CLIENT_PORT="${CLIENT_PORT:-4173}"

DATA_DIR="$REPO_ROOT/data"
SERVER_PID_FILE="$DATA_DIR/server.pid"
CLIENT_PID_FILE="$DATA_DIR/client.pid"
SERVER_LOG="$DATA_DIR/server.log"
CLIENT_LOG="$DATA_DIR/client.log"

mkdir -p "$DATA_DIR"

# ---- 颜色 ------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'; C_RED=$'\033[0;31m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi

is_running() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || echo '')"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

stop_pid() {
  local pidfile="$1"
  local label="$2"
  if is_running "$pidfile"; then
    local pid
    pid="$(cat "$pidfile")"
    printf "  stopping %s (pid %s)... " "$label" "$pid"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf "%sforcing SIGKILL%s " "$C_YELLOW" "$C_RESET"
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    printf "%sstopped%s\n" "$C_GREEN" "$C_RESET"
  else
    printf "  %s not running\n" "$label"
    rm -f "$pidfile"
  fi
}

cmd_status() {
  printf "${C_BOLD}server${C_RESET} (port %s): " "$SERVER_PORT"
  if is_running "$SERVER_PID_FILE"; then
    printf "${C_GREEN}running${C_RESET} (pid $(cat "$SERVER_PID_FILE"))\n"
  else
    printf "${C_YELLOW}not running${C_RESET}\n"
  fi
  printf "${C_BOLD}client${C_RESET} (port %s): " "$CLIENT_PORT"
  if is_running "$CLIENT_PID_FILE"; then
    printf "${C_GREEN}running${C_RESET} (pid $(cat "$CLIENT_PID_FILE"))\n"
  else
    printf "${C_YELLOW}not running${C_RESET}\n"
  fi
}

cmd_stop() {
  stop_pid "$SERVER_PID_FILE" "server"
  stop_pid "$CLIENT_PID_FILE" "client"
}

# ---- 前置检查 --------------------------------------------------------------
preflight() {
  if [[ ! -f "$REPO_ROOT/server/dist/index.js" ]]; then
    printf "${C_RED}✗ server/dist/index.js 不存在 — 请先跑 ./setup.sh${C_RESET}\n" 1>&2
    exit 1
  fi
  if [[ ! -f "$REPO_ROOT/client/dist/index.html" ]]; then
    printf "${C_RED}✗ client/dist/index.html 不存在 — 请先跑 ./setup.sh${C_RESET}\n" 1>&2
    exit 1
  fi
  if [[ ! -f "$REPO_ROOT/.env" ]]; then
    printf "${C_YELLOW}! 警告：根目录无 .env，server 会用默认值启动${C_RESET}\n"
  fi
}

# ---- 启动 server -----------------------------------------------------------
start_server_fg() {
  printf "${C_BOLD}=> server (foreground)${C_RESET}  http://localhost:%s\n" "$SERVER_PORT"
  cd "$REPO_ROOT/server"
  exec npm start
}

start_server_bg() {
  if is_running "$SERVER_PID_FILE"; then
    printf "${C_YELLOW}! server 已经在跑（pid $(cat "$SERVER_PID_FILE")），跳过${C_RESET}\n"
    return
  fi
  printf "${C_BOLD}=> server (background)${C_RESET}  http://localhost:%s  log=%s\n" \
    "$SERVER_PORT" "$SERVER_LOG"
  ( cd "$REPO_ROOT/server" && nohup npm start > "$SERVER_LOG" 2>&1 & echo $! > "$SERVER_PID_FILE" )
  sleep 1
  if is_running "$SERVER_PID_FILE"; then
    printf "  ${C_GREEN}server up (pid $(cat "$SERVER_PID_FILE"))${C_RESET}\n"
  else
    printf "  ${C_RED}server 启动失败 — 看 %s${C_RESET}\n" "$SERVER_LOG"
    exit 1
  fi
}

# ---- 启动 client（serve 静态 + 反代 /api 与 /storage） ---------------------
# 这里用 npx serve 跑 client/dist。serve 本身不带反向代理，所以我们用一个
# 简易 node 静态服务器 + 反向代理脚本（内联在下面）。
#
# 为什么不直接 vite preview？因为 vite preview 默认不把 /api/* /storage/*
# 转发到后端；要么改 vite.config.ts 加 preview.proxy，要么用反向代理。
# 这里用内联脚本避免修改源码。
write_client_runtime() {
  local runtime_dir="$DATA_DIR/client-runtime"
  mkdir -p "$runtime_dir"
  cat > "$runtime_dir/serve.mjs" <<'CLIENT_RUNTIME_EOF'
// Dev-grade static server for client/dist with /api + /storage reverse proxy.
// Auto-spawned by start.sh.
import http from "node:http";
import https from "node:https";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CLIENT_PORT || 4173);
const TARGET = process.env.API_TARGET || "http://localhost:3000";
const ROOT = process.env.CLIENT_ROOT;
if (!ROOT) {
  console.error("CLIENT_ROOT env not set");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function proxyRequest(req, res) {
  const targetUrl = new URL(req.url, TARGET);
  const lib = targetUrl.protocol === "https:" ? https : http;
  const proxyReq = lib.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    console.error("[proxy]", req.method, req.url, "->", String(err));
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "PROXY_FAILED", message: String(err) } }));
    } else {
      res.end();
    }
  });
  req.pipe(proxyReq);
}

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  // SPA fallback
  let relPath = url === "/" ? "/index.html" : url;
  let absPath = normalize(join(ROOT, relPath));
  if (!absPath.startsWith(ROOT)) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const st = statSync(absPath);
    if (st.isDirectory()) {
      absPath = join(absPath, "index.html");
    }
  } catch {
    // file not found → SPA fallback to index.html
    absPath = join(ROOT, "index.html");
  }
  const ext = extname(absPath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": mime, "cache-control": "no-cache" });
  createReadStream(absPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/api/") || url === "/api" ||
      url.startsWith("/storage/") || url === "/storage") {
    proxyRequest(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`client static + proxy listening on http://localhost:${PORT} (proxy → ${TARGET})`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
CLIENT_RUNTIME_EOF
  echo "$runtime_dir/serve.mjs"
}

start_client_fg() {
  local script
  script="$(write_client_runtime)"
  printf "${C_BOLD}=> client (foreground)${C_RESET}  http://localhost:%s  proxy → http://localhost:%s\n" \
    "$CLIENT_PORT" "$SERVER_PORT"
  CLIENT_ROOT="$REPO_ROOT/client/dist" \
  CLIENT_PORT="$CLIENT_PORT" \
  API_TARGET="http://localhost:$SERVER_PORT" \
    exec node "$script"
}

start_client_bg() {
  if is_running "$CLIENT_PID_FILE"; then
    printf "${C_YELLOW}! client 已经在跑（pid $(cat "$CLIENT_PID_FILE")），跳过${C_RESET}\n"
    return
  fi
  local script
  script="$(write_client_runtime)"
  printf "${C_BOLD}=> client (background)${C_RESET}  http://localhost:%s  log=%s\n" \
    "$CLIENT_PORT" "$CLIENT_LOG"
  ( CLIENT_ROOT="$REPO_ROOT/client/dist" \
    CLIENT_PORT="$CLIENT_PORT" \
    API_TARGET="http://localhost:$SERVER_PORT" \
    nohup node "$script" > "$CLIENT_LOG" 2>&1 & echo $! > "$CLIENT_PID_FILE" )
  sleep 1
  if is_running "$CLIENT_PID_FILE"; then
    printf "  ${C_GREEN}client up (pid $(cat "$CLIENT_PID_FILE"))${C_RESET}\n"
  else
    printf "  ${C_RED}client 启动失败 — 看 %s${C_RESET}\n" "$CLIENT_LOG"
    exit 1
  fi
}

# ---- 入口 ------------------------------------------------------------------
case "${1:-}" in
  --stop)
    cmd_stop
    ;;
  --status)
    cmd_status
    ;;
  --bg)
    preflight
    start_server_bg
    start_client_bg
    printf "\n${C_BOLD}${C_GREEN}=>${C_RESET} 后台启动完成：\n"
    printf "    client: http://localhost:%s\n" "$CLIENT_PORT"
    printf "    server: http://localhost:%s/api/health\n" "$SERVER_PORT"
    printf "    停服：  ./start.sh --stop\n"
    printf "    状态：  ./start.sh --status\n"
    printf "    日志：  tail -F %s %s\n" "$SERVER_LOG" "$CLIENT_LOG"
    ;;
  ""|--fg)
    preflight
    # 前台模式：server 后台启动 + client 前台启动，前台进程退出时同步停 server
    start_server_bg
    trap 'cmd_stop' EXIT INT TERM
    start_client_fg
    ;;
  *)
    cat 1>&2 <<EOF
未知参数: $1

用法:
  ./start.sh              前台启动（Ctrl+C 同时停 server 与 client）
  ./start.sh --bg         后台启动，写 pid + log 到 ./data/
  ./start.sh --stop       停掉后台进程
  ./start.sh --status     查看后台进程状态
EOF
    exit 1
    ;;
esac

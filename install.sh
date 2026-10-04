#!/usr/bin/env bash
# Kaswin Event Indexer 一键安装与部署脚本 (Linux x86_64 / arm64)
# 支持 Ubuntu 20.04+, Debian 11+, CentOS 8+ 等带 systemd 的环境

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  err "此脚本需要 root 权限执行，请使用 sudo bash install.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/kaswin-indexer"
DATA_DIR="/var/lib/kaswin-indexer"
SERVICE_NAME="kaswin-indexer.service"
USER_NAME="kaswin-index"

info "=== 开始部署 Kaswin TN10 Event Indexer ==="

# 1. 检查或准备 Node.js (需要 >= 22.0.0)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    NODE_BIN="$(command -v node)"
    ok "检测到系统 Node.js: v$NODE_VER ($NODE_BIN)"
  else
    warn "系统 Node.js 版本为 v$NODE_VER，低于推荐的 v22+"
  fi
fi

if [[ -z "$NODE_BIN" ]]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    *) err "暂不支持的系统架构: $ARCH" ;;
  esac
  info "正在下载独立的 Node.js v22.12.0 ($NODE_ARCH)..."
  mkdir -p "$INSTALL_DIR/bin"
  TAR_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-$NODE_ARCH.tar.gz"
  curl -fsSL "$TAR_URL" | tar -xz -C "$INSTALL_DIR/bin" --strip-components=2 "node-v22.12.0-linux-$NODE_ARCH/bin/node"
  chmod +x "$INSTALL_DIR/bin/node"
  NODE_BIN="$INSTALL_DIR/bin/node"
  ok "Node.js 二进制已安装至 $NODE_BIN"
fi

# 2. 创建专属低权限用户
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  info "创建系统专用用户 $USER_NAME..."
  useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" "$USER_NAME"
  ok "用户 $USER_NAME 已创建"
fi

# 3. 安装文件到 /opt/kaswin-indexer
info "复制程序文件至 $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR/indexer.mjs" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/contracts" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/artifacts" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/sdk" "$INSTALL_DIR/"
if [[ -f "$SCRIPT_DIR/.env.example" && ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$INSTALL_DIR/.env"
fi

# 4. 创建并授权数据目录
mkdir -p "$DATA_DIR"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"
chown -R root:root "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"

# 5. 配置 systemd 服务
info "配置 systemd 服务: $SERVICE_NAME..."
cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=Kaswin TN10 Event Indexer and CID REST
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=-$INSTALL_DIR/.env
ExecStart=$NODE_BIN --max-old-space-size=192 $INSTALL_DIR/indexer.mjs run --db $DATA_DIR/events.sqlite --api-host 0.0.0.0 --api-port 8788 --pool
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
MemoryMax=384M
TasksMax=32
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
ok "服务已启动并设置开机自启"

# 6. 健康检查
info "正在等待服务启动并进行健康检查..."
SUCCESS=0
for i in {1..10}; do
  sleep 2
  if curl -sS -f "http://127.0.0.1:8788/v1/rounds?limit=1" >/dev/null 2>&1; then
    SUCCESS=1
    break
  fi
done

if [[ $SUCCESS -eq 1 ]]; then
  ok "=== 部署成功！==="
  echo ""
  echo "  - REST API 地址: http://127.0.0.1:8788/v1/rounds"
  echo "  - 数据库文件路径: $DATA_DIR/events.sqlite"
  echo "  - 配置文件路径:   $INSTALL_DIR/.env"
  echo ""
  echo "常用运维命令:"
  echo "  - 查看服务状态:   systemctl status $SERVICE_NAME"
  echo "  - 查看实时日志:   journalctl -u $SERVICE_NAME -f"
  echo "  - 重启服务:       systemctl restart $SERVICE_NAME"
else
  warn "服务已启动，但 API 检查尚未响应。请查看日志: journalctl -u $SERVICE_NAME -n 30"
fi

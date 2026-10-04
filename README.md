# Kaswin Event Indexer (`kaswin-indexer`)

[English](./README.en.md) | [简体中文](./README.md)

Kaspa Testnet 10 上的 Kaswin 状态契约（Covenant）只读事件索引器与 CID REST 服务的独立自包含发布版本。

本项目用于监听链上事件、定位花费者、验证选定链 acceptance、核验固定契约规则（默认 **F3.2**，兼容旧版 **F3** 终局轮次），并为前端 DApp / Kaswin Web 提供低延迟的 CID 只读接口。

- **纯只读与安全**：不持私钥、不签名、不广播交易。
- **双节点热备池**：内置 TN10 Seed + Resolver 自动探测与故障转移。
- **无持续扫链**：基于 UTXO 通知与针对性 spender 检索，极低带宽占用与 CPU 消耗。
- **零外部依赖**：已内置 Node.js 22+ 兼容的固定 Kaspa WASM SDK (2.0.1) 与编译后契约规则包。

---

## 快速部署方案一：Docker / Docker Compose（推荐首选）

无论在什么系统上，只要已安装 Docker，即可一键拉起。

### 1. 使用 Docker Compose 一键启动

```bash
git clone https://github.com/agang0311/kaswin-indexer.git
cd kaswin-indexer

# （可选）配置自定义节点或注册表地址：
cp .env.example .env

# 一键启动
docker compose up -d
```

### 2. 使用纯 Docker 命令运行

```bash
docker build -t kaswin-indexer .

docker run -d --name kaswin-indexer \
  -p 8788:8788 \
  -v kaswin-indexer-data:/data \
  --restart unless-stopped \
  kaswin-indexer
```

启动约 10~15 秒（完成双节点探测与订阅握手）后，访问测试：
```bash
curl http://localhost:8788/v1/rounds
```

---

## 快速部署方案二：Linux 独立主机一键安装（无 Docker）

适合部署在独立 VPS 或物理机上，脚本会自动创建系统用户、设置数据目录、注册 systemd 服务并开机自启。

```bash
git clone https://github.com/agang0311/kaswin-indexer.git
cd kaswin-indexer

# 执行一键安装（需要 root / sudo 权限）
sudo bash install.sh
```

脚本将自动完成：
1. 检查或下载独立的 Node.js 22 LTS 二进制；
2. 创建 `kaswin-index` 专属低权限运行用户；
3. 将程序部署至 `/opt/kaswin-indexer`，数据目录设为 `/var/lib/kaswin-indexer`；
4. 注册并启动 `kaswin-indexer.service` 并通过健康检查。

### 服务管理命令：
```bash
systemctl status kaswin-indexer.service   # 查看状态
journalctl -u kaswin-indexer.service -f   # 查看实时日志
systemctl restart kaswin-indexer.service  # 重启服务
```

---

## 配置说明

支持通过 `.env` 环境变量或启动参数覆盖配置：

| 环境变量 | CLI 参数 | 说明 | 默认值 |
|---|---|---|---|
| `KASWIN_NODE_URL` | `--url` | 固定单 wRPC 节点地址 | 留空（使用节点池） |
| `KASWIN_NODE_URLS` | `--urls` | 逗号分隔的双节点地址 | 留空 |
| `KASWIN_REGISTRY_ADDRESSES` | `--registry-addresses` | 监听的 Registry 地址列表 | 官方 TN10 Registry |
| `KASWIN_CORS_ORIGIN` | `--cors-origin` | 跨域来源（`*`、具体域名或 `none` 禁用） | `*`（默认允许跨域） |
| `KASWIN_API_PORT` | `--api-port` | REST API 端口 | `8788` |
| `KASWIN_API_HOST` | `--api-host` | REST API 监听地址 | `0.0.0.0` |

---

## REST API 接口说明

服务默认运行在 `8788` 端口：

- `GET /v1/rounds`：获取已索引轮次列表（支持 `?limit=50`、`?cursor=<cid>` 分页）。
- `GET /v1/rounds?status=open`：筛选进行中轮次。
- `GET /v1/rounds?status=sealed`：筛选已封存/待结算轮次。
- `GET /v1/rounds?status=close`：筛选已完结/终局轮次。
- `GET /v1/rounds/{cid}`：根据 64 位十六进制 Covenant ID 查询轮次详情。

---

## 开发者与调试命令

本地已有 Node.js 22 环境时，可直接使用以下命令：

```bash
# 查看加载的契约规则与配置（不连网）
node indexer.mjs contracts

# 查看数据库当前索引状态与轮次
node indexer.mjs status --db events.sqlite

# 前台启动运行
node indexer.mjs run --db events.sqlite --pool --api-port 8788
```

---

## 适配其他合约 DApp (二次开发)

本项目采用插件化架构，底层 Borsh wRPC 连接、双节点故障转移、Selected-chain acceptance 共识核验、重组回滚和 SQLite 存储**完全通用**。

如果你想将此 Indexer 改造并接入自己的 Kaspa Covenant DApp（如 AMM、拍卖、借贷、订单薄等）：
👉 **详细步骤与插件编写示例见：[二次开发与适配指南 (CUSTOM_DAPP_GUIDE.md)](./CUSTOM_DAPP_GUIDE.md)**

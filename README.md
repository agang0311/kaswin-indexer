# Kaspa Raffle Indexer

面向超过 1000 张票抽奖轮的独立只读 indexer。它连接 Kaspa 节点，保存公开购票记录的 Merkle 树，并向网页返回中奖票、参与者及批量退款 proof。它不持有私钥，不签名，不生成随机数，也不能改变链上开奖结果。

1000 张票以内不需要运行此应用，网页会直接从 Registry 与 covenant 交易重建票据树。

## 本机运行

需要 Node.js 22.11 或更高版本：

```powershell
cd indexer
npm ci
$env:KASPA_RPC_URL="ws://127.0.0.1:18110"
$env:KASPA_NETWORK="mainnet"
$env:RAFFLE_INDEX_HOST="127.0.0.1"
npm start
```

在抽奖网页的高级设置中，把 Indexer 地址设为 `http://127.0.0.1:8787`。

## Docker

```powershell
docker build -t kaspa-raffle-indexer indexer
docker run --rm -p 8787:8787 -v kaspa-raffle-index:/data `
  -e KASPA_RPC_URL=ws://host.docker.internal:18110 `
  -e KASPA_NETWORK=mainnet `
  kaspa-raffle-indexer
```

容器默认监听 `0.0.0.0:8787`。公网部署应在前面放置 HTTPS 反向代理；从 HTTPS 页面访问明文 HTTP indexer 会被浏览器的混合内容策略阻止。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `KASPA_RPC_URL` | `ws://tn12-node.kaspa.com:18210` | Kaspa wRPC 节点 |
| `KASPA_NETWORK` | `testnet-10` | `mainnet` 或 TN12 的 SDK 网络 ID `testnet-10` |
| `RAFFLE_INDEX_HOST` | `127.0.0.1` | HTTP 监听地址；远程或容器部署使用 `0.0.0.0` |
| `RAFFLE_INDEX_PORT` | `8787` | HTTP 监听端口 |
| `RAFFLE_INDEX_DATA` | `indexer/.index-data` | 持久化目录 |
| `RAFFLE_INDEX_CONFIRMATIONS` | `10` | 确认深度 |
| `RAFFLE_INDEX_POLL_MS` | `1000` | 同步间隔（毫秒） |
| `RAFFLE_INDEX_START_HASH` | 已保存 cursor | 首次同步起点区块哈希 |

健康检查为 `GET /health`。公开 API 仅提供轮次摘要与可由浏览器自行验证的 Merkle proof。

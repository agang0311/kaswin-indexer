# Kaspa 状态契约（Covenant）Indexer 二次开发与适配指南

[English Version](./CUSTOM_DAPP_GUIDE.en.md) | [简体中文](./CUSTOM_DAPP_GUIDE.md)

本项目不仅是 Kaswin 的专属索引器，其核心架构是一个**通用的 Kaspa Stateful Covenant 状态机追踪与验证引擎**。

如果你的团队正在 Kaspa 上开发自己的有状态智能合约（如 AMM 流动性池、链上拍卖、借贷协议、链上订单薄、预测市场或跨链桥等），你可以直接以此项目为底座进行二次开发，**无需从零编写复杂的 Kaspa 节点通信、WebSocket 事件订阅、Selected-Chain 确认与链重组回滚逻辑**。

---

## 1. 架构分层：你能复用什么？

整个 Indexer 分为两层：**通用基础设施层** 与 **业务契约插件层**。

```text
┌─────────────────────────────────────────────────────────────┐
│                    通用基础设施层 (100% 直接复用)              │
│                                                             │
│  [Borsh wRPC 节点池] ──► [双节点热备与自动故障切换]            │
│  [UTXO 实时事件订阅] ──► [Selected-Chain Acceptance 共识确认]  │
│  [深度区块 Hydration] ──► [时间锁/解锁脚本/重组 Rollback 支持]   │
│  [SQLite WAL 存储]   ──► [Outbox 状态中继 / Docker / systemd] │
└──────────────────────────────┬──────────────────────────────┘
                               │ 调用插件接口
┌──────────────────────────────▼──────────────────────────────┐
│                    业务契约插件层 (开发者自行定制)             │
│                                                             │
│  1. 发现机制 (Discovery)    : 你的合约实例如何被识别与注册？       │
│  2. 创世构建 (Genesis)      : 如何从首笔 UTXO 解析出初始状态？     │
│  3. 状态推进 (Advance)      : 花费当前 UTXO 时如何严格核验证据？   │
│  4. 前端接口 (REST API)     : 向 Web 提供哪些维度的查询字段？      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心概念与生命周期

在 Kaspa 上追踪有状态 Covenant 的标准生命周期：

1. **CID (Covenant ID)**：每个合约实例由其 Genesis 输出与授权 Outpoint 确定唯一的 64 位十六进制 CID。
2. **Tip (当前 UTXO)**：合约当前的最新状态锚定在某个未花费输出上（包含当前金额与 P2SH 脚本哈希）。
3. **Spender (花费交易)**：当某人调用合约时，构造一笔花费该 Tip 的交易。
4. **Acceptance (共识接受)**：索引器收到通知后，查询节点验证该交易是否被选定链（Selected Chain）接受（排除孤块、分叉与双花）。
5. **Advance (状态推进)**：索引器调用你的插件，校验该交易的 Witness 参数，根据状态机逻辑推导新状态并生成新的 Tip，存入 SQLite。

---

## 3. 极速定制：四步实现你的 DApp 插件

### 第一步：编写插件模块 (`contracts/my-dapp.mjs`)

在 `contracts/` 目录下创建你的插件文件，实现以下标准接口：

```javascript
// contracts/my-dapp.mjs

export async function create(options = {}, { sdk }) {
  const PROFILE_ID = options.profileId || 'my-app-unique-hash';

  return {
    // 插件基础信息
    id: 'my-dapp',
    version: '1.0.0',
    profileId: PROFILE_ID,

    // 1. 监听地址列表：节点订阅此地址，有交易立刻触发推送
    watchAddresses: () => options.watchAddresses || [],

    // 2. 快速初筛：非本合约的交易直接忽略，避免不必要的网络开销
    matchesGenesis: (tx) => {
      // 例如：检查交易 Payload 是否带特定标识，或是否输出到特定地址
      return tx?.payload?.startsWith('MY_DAPP_GENESIS');
    },

    // 3. 详细初筛诊断（可选）
    inspectGenesis: (tx) => ({ match: true }),

    // 4. 创世解析：当创世交易被链上接受时调用
    genesis: (tx, block) => {
      const output = tx.outputs[0];
      const cid = output.covenant?.covenantId;
      const txid = tx.verboseData.transactionId;

      // 解析初始状态（例如：拍卖品ID、起拍价、卖家等）
      const initialState = {
        seller: '...',
        minBid: 1000n,
        currentBid: 0n,
        highestBidder: null,
      };

      return {
        id: txid,
        genesisTxid: txid,
        cid,
        tip: { transactionId: txid, index: 0 },
        spk: output.scriptPublicKey,
        value: String(output.value),
        state: initialState,
        terminal: null, // 非空表示终局（如已结束退款或完成交割）
      };
    },

    // 5. 状态转移核验：当追踪中的合约 Tip 被花费时调用（核心安全闸门）
    advance: (currentRound, tx, block) => {
      // 提取解锁证据 (Witness)
      const witness = tx.inputs[0].signatureScript;
      
      // 提取动作类型与业务参数（如出价金额）
      const action = 'BID';
      const newBid = BigInt(tx.outputs[0].value);

      // 【安全核验】：在此执行业务规则校验
      if (newBid <= BigInt(currentRound.state.currentBid)) {
        throw Error('BID_AMOUNT_TOO_LOW');
      }

      // 计算并验证期望的输出（例如：新合约 UTXO、原出价人退款输出）
      // 如果链上实际输出不符合规则，直接抛出异常拒绝推进

      const txid = tx.verboseData.transactionId;
      return {
        ...currentRound,
        latestTxid: txid,
        tip: { transactionId: txid, index: 0 }, // 若终局则置为 null
        value: String(newBid),
        state: {
          ...currentRound.state,
          currentBid: newBid,
          highestBidder: '...',
        },
        terminal: null,
      };
    },

    // 6. 动作识别（用于日志和 API 展示）
    actionOf: (tx) => 'BID',

    // 7. 轮次状态快照有效性检查
    checkRound: (round) => true,
  };
}
```

---

### 第二步：在配置文件中注册插件 (`contracts/default.json`)

修改 `contracts/default.json`，启用你的插件：

```json
{
  "contracts": [
    {
      "module": "my-dapp.mjs",
      "retired": false,
      "options": {
        "profileId": "7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863",
        "watchAddresses": [
          "kaspatest:你的工厂或注册表地址"
        ]
      }
    }
  ]
}
```

> **平滑升级与多版本并存**：如果你以后发布了 V2 合约，只需在配置中新增 V2 并将 V1 设为 `"retired": true`。Indexer 会自动使用 V2 发现新实例，同时**继续使用 V1 规则跟踪和推进所有历史 V1 实例直至终局**。

---

### 第三步：按需扩展 REST API (`src/api.mjs`)

默认 API 已经提供了标准的高性能只读接口：
- `GET /v1/rounds`：支持 keyset cursor 分页与状态过滤。
- `GET /v1/rounds/{cid}`：按 64 位 CID 查询实例详情与完整历史。

如果你的 DApp 前端需要定制查询字段（例如按创作者筛选、按竞拍结束时间排序）：
1. 在 `src/store.mjs` 中添加针对你业务状态字段的 SQLite 索引或查询方法；
2. 在 `src/api.mjs` 中添加对应的路由处理即可。

---

### 第四步：测试与运行

#### 1. 离线验证插件加载：
```bash
node indexer.mjs contracts
```
检查输出中是否包含你的插件 ID、版本与监听地址。

#### 2. 手动指定已知交易进行回放追踪：
```bash
node indexer.mjs track <创世交易TXID> <包含该交易的区块HASH>
```

#### 3. 查看当前存储状态：
```bash
node indexer.mjs status --db events.sqlite
```

#### 4. 启动后台守护进程：
```bash
# 本地直接运行
node indexer.mjs run --db events.sqlite --pool --api-port 8788

# 或直接使用 Docker 部署
docker compose up -d
```

---

## 4. 契约索引避坑与安全守则

1. **绝对不要仅凭 Mempool 或区块包含做决定**：
   Kaspa 是 GHOSTDAG 共识，出块速度极快（TN10 为 10 BPS）。**包含在区块中不等于交易被选定链接受**。本 Indexer 内置的 `acceptance()` 机制会自动核验 Selected-chain，务必保留此机制。
2. **严禁在金额计算中使用 JavaScript Number**：
   Kaspa sompi 金额必须全程使用 `bigint` 或定长字符串进行处理，防止由于 IEEE-754 浮点精度截断导致的资金核算漏洞。
3. **固化契约指纹（Profile Pinning）**：
   绝不要从网络端动态下载契约编译产物或验证逻辑。所有模板哈希与验证规则应作为静态文件编译入项目并通过哈希固化，确保索引器的核验逻辑可审计、确定性与不可篡改。
4. **单写入者原则**：
   底层存储采用 SQLite WAL 模式以支撑极高的并发只读查询。写入必须保持单进程独占，不要启动多个 Indexer 实例同时读写同一个 SQLite 数据库文件。

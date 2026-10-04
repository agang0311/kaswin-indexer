# Custom Covenant DApp Adaptation & Development Guide

[English Version](./CUSTOM_DAPP_GUIDE.en.md) | [简体中文](./CUSTOM_DAPP_GUIDE.md)

Beyond serving Kaswin, the core of this project is a **generic, production-grade tracking and validation engine for Kaspa Stateful Covenants**.

If your team is building custom stateful contracts on Kaspa (such as AMM liquidity pools, on-chain auctions, lending protocols, order books, prediction markets, or bridges), you can directly use this repository as your indexing foundation—**without re-implementing complex wRPC connection management, WebSocket event filtering, selected-chain acceptance confirmation, or reorg rollback handling**.

---

## 1. Architectural Layers: What Can You Reuse?

The indexer is separated cleanly into two layers: **Generic Infrastructure** and **Custom Contract Plugins**.

```text
┌─────────────────────────────────────────────────────────────┐
│                 Generic Infrastructure Layer (100% Reused)   │
│                                                             │
│  [Borsh wRPC Node Pool]   ──► [Dual-Node Hot Standby & Failover] │
│  [Live UTXO Event Stream] ──► [Selected-Chain Acceptance Gate] │
│  [Deep Block Hydration]   ──► [LockTime/Witness/Reorg Rollback]│
│  [SQLite WAL Storage]     ──► [Outbox Relay / Docker / systemd]│
└──────────────────────────────┬──────────────────────────────┘
                               │ Invokes Plugin Interface
┌──────────────────────────────▼──────────────────────────────┐
│                 Custom Contract Plugin Layer (Customized)   │
│                                                             │
│  1. Discovery Mechanism   : How is a new contract instance recognized?
│  2. Genesis Construction  : How is initial state extracted from Output 0?
│  3. Transition Validation : How is the witness & next state verified?
│  4. Front-End REST API    : Which query dimensions are exposed to Web?
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Core Concepts & Lifecycle

Tracking a stateful covenant on Kaspa follows a standardized lifecycle:

1. **CID (Covenant ID)**: Each contract instance is uniquely identified by a 64-character lowercase hex CID, computed from its genesis output group and authorizing outpoint.
2. **Tip (Current UTXO)**: The current live state of the contract is anchored to an unspent output (containing current value and P2SH script hash).
3. **Spender (Spending Transaction)**: When an actor interacts with the covenant, they construct a transaction spending the current Tip.
4. **Acceptance (Consensus Verification)**: Upon receiving an event, the indexer queries the node to verify whether the spending transaction has been accepted on the selected chain (filtering out isolated blocks, forks, and double-spends).
5. **Advance (State Transition)**: The indexer calls your plugin, inspects the witness arguments, recomputes next state and outputs, and updates the local SQLite store atomically.

---

## 3. Step-by-Step: Implementing Your DApp Plugin

### Step 1: Create Your Plugin Module (`contracts/my-dapp.mjs`)

Create a plugin file under `contracts/` implementing the standard plugin interface:

```javascript
// contracts/my-dapp.mjs

export async function create(options = {}, { sdk }) {
  const PROFILE_ID = options.profileId || 'my-app-unique-hash';

  return {
    // Plugin Metadata
    id: 'my-dapp',
    version: '1.0.0',
    profileId: PROFILE_ID,

    // 1. Watched addresses: node pushes notifications whenever these addresses receive funds
    watchAddresses: () => options.watchAddresses || [],

    // 2. Fast pre-filter: quickly discard unrelated transactions before block hydration
    matchesGenesis: (tx) => {
      // Example: check transaction payload prefix or target address
      return tx?.payload?.startsWith('MY_DAPP_GENESIS');
    },

    // 3. Structured diagnostic check (optional)
    inspectGenesis: (tx) => ({ match: true }),

    // 4. Genesis parser: called when a genesis transaction is accepted on selected chain
    genesis: (tx, block) => {
      const output = tx.outputs[0];
      const cid = output.covenant?.covenantId;
      const txid = tx.verboseData.transactionId;

      // Extract your application's initial state (e.g. auction item, reserve price, seller)
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
        terminal: null, // Non-null when round is finalized/closed
      };
    },

    // 5. State transition gate: invoked whenever a tracked Tip is spent
    advance: (currentRound, tx, block) => {
      // Extract unlock witness from input signatureScript
      const witness = tx.inputs[0].signatureScript;
      
      const action = 'BID';
      const newBid = BigInt(tx.outputs[0].value);

      // [CRITICAL SECURITY GATE]: Enforce contract rules
      if (newBid <= BigInt(currentRound.state.currentBid)) {
        throw Error('BID_AMOUNT_TOO_LOW');
      }

      // Recompute and verify expected outputs (continuation UTXO, refund outputs, etc.)
      // If the on-chain outputs do not match expected transition rules, throwing an error
      // flags the round as STALE and prevents advancing along an invalid branch.

      const txid = tx.verboseData.transactionId;
      return {
        ...currentRound,
        latestTxid: txid,
        tip: { transactionId: txid, index: 0 }, // Set to null if covenant terminates
        value: String(newBid),
        state: {
          ...currentRound.state,
          currentBid: newBid,
          highestBidder: '...',
        },
        terminal: null,
      };
    },

    // 6. Action classification (for logging and UI)
    actionOf: (tx) => 'BID',

    // 7. Invariant check on round snapshot
    checkRound: (round) => true,
  };
}
```

---

### Step 2: Register in Contract Config (`contracts/default.json`)

Configure `contracts/default.json` to load your new module:

```json
{
  "contracts": [
    {
      "module": "my-dapp.mjs",
      "retired": false,
      "options": {
        "profileId": "7ca61d81be1a2448d16b18cb2bdce845c91ed4993a6da0fd26b14d211fbce863",
        "watchAddresses": [
          "kaspatest:your_factory_or_registry_address"
        ]
      }
    }
  ]
}
```

> **Smooth Upgrades & Multi-Version Support**: When deploying a V2 contract in the future, simply add V2 to the config and mark V1 as `"retired": true`. The indexer will discover new rounds using V2 while **continuing to validate all existing V1 rounds until they terminate**.

---

### Step 3: Customize REST Endpoints (`src/api.mjs`)

The default REST API provides:
- `GET /v1/rounds`: Keyset pagination and status filtering (`open`, `sealed`, `close`).
- `GET /v1/rounds/{cid}`: Fetch detailed round state and transition history by 64-character hex CID.

If your front-end needs specialized queries (e.g., search by creator, sort by auction end time):
1. Add custom SQLite queries or indices in `src/store.mjs`;
2. Map your custom state fields in `src/api.mjs`.

---

### Step 4: Test & Deploy

#### 1. Test offline plugin loading:
```bash
node indexer.mjs contracts
```

#### 2. Replay a known testnet genesis transaction:
```bash
node indexer.mjs track <GENESIS_TXID> <CONTAINING_BLOCK_HASH>
```

#### 3. Inspect database state:
```bash
node indexer.mjs status --db events.sqlite
```

#### 4. Run daemon or deploy with Docker:
```bash
# Foreground run
node indexer.mjs run --db events.sqlite --pool --api-port 8788

# Or with Docker
docker compose up -d
```

---

## 4. Best Practices & Consensus Rules

1. **Never Rely on Mempool or Block Inclusion Alone**:
   Kaspa's GHOSTDAG achieves high block rates (10 BPS on TN10). **A transaction being included in a block does not guarantee acceptance on the selected chain**. The built-in `acceptance()` pipeline guards against reorgs and invalid branches.
2. **Never Use JavaScript Number for Values**:
   Always handle sompi amounts, DAAs, and timestamps using `bigint` or lossless strings.
3. **Immutable Profile Pinning**:
   Never download bytecode or contract schemas dynamically over the network. Pin template hashes and artifact fingerprints statically to ensure deterministic, auditable validation.
4. **Single-Writer Database**:
   SQLite WAL mode allows high-concurrency read queries across multiple clients, but writes must remain single-process. Never attach multiple live indexer daemons to the same SQLite database file.

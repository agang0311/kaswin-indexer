# Kaswin Event Indexer (`kaswin-indexer`)

[English](./README.en.md) | [简体中文](./README.md)

Standalone read-only event indexer and CID REST service for Kaswin stateful covenants on **Kaspa Testnet 10**.

This service tracks on-chain UTXO events, resolves spenders, validates selected-chain transaction acceptance, enforces pinned contract transition rules (defaulting to **F3.2**, with backward compatibility for existing **F3** terminal rounds), and provides low-latency, CID-keyed REST endpoints for front-end DApps and Kaswin Web.

- **Read-Only & Secure**: Holds no private keys, signs no transactions, and never broadcasts to the network.
- **Dual-Node Hot-Standby Pool**: Built-in automatic discovery and failover using official Testnet 10 seeds and resolvers.
- **No Continuous Chain Scanning**: Pure event-driven tracking via UTXO subscription notifications and targeted spender hydration, resulting in minimal network bandwidth and CPU usage.
- **Zero External Monorepo Dependencies**: Self-contained distribution with embedded Kaspa WASM SDK (pinned v2.0.1) and precompiled contract rule packages.

---

## Deployment Option 1: Docker & Docker Compose (Recommended)

Fastest and most consistent deployment on any machine with Docker installed.

### 1. Launch with Docker Compose

```bash
git clone https://github.com/agang0311/kaswin-indexer.git
cd kaswin-indexer

# (Optional) Customize node or registry addresses:
cp .env.example .env

# Start in background
docker compose up -d
```

### 2. Run with Plain Docker

```bash
docker build -t kaswin-indexer .

docker run -d --name kaswin-indexer \
  -p 8788:8788 \
  -v kaswin-indexer-data:/data \
  --restart unless-stopped \
  kaswin-indexer
```

After ~10–15 seconds (initial pool probing and subscription handshake), verify the service:
```bash
curl http://localhost:8788/v1/rounds
```

---

## Deployment Option 2: Linux Host One-Click Install (Non-Docker)

Ideal for standalone Linux servers or VPS instances. The installer automatically handles runtime dependencies, creates a dedicated system user, sets up data directories, and installs a hardened systemd service.

```bash
git clone https://github.com/agang0311/kaswin-indexer.git
cd kaswin-indexer

# Run installer (requires root or sudo privileges)
sudo bash install.sh
```

What the script does:
1. Detects or downloads an isolated Node.js 22 LTS binary (`x86_64` / `arm64`);
2. Creates a dedicated low-privilege `kaswin-index` system user;
3. Deploys files to `/opt/kaswin-indexer` and initializes the database at `/var/lib/kaswin-indexer`;
4. Installs and starts `kaswin-indexer.service` with automatic restart and health verification.

### Service Management Commands:
```bash
systemctl status kaswin-indexer.service   # Check service status
journalctl -u kaswin-indexer.service -f   # View live logs
systemctl restart kaswin-indexer.service  # Restart service
```

---

## Configuration

Settings can be customized via `.env` environment variables or CLI flags:

| Environment Variable | CLI Option | Description | Default |
|---|---|---|---|
| `KASWIN_NODE_URL` | `--url` | Single fixed wRPC node URL (Borsh) | Empty (uses pool) |
| `KASWIN_NODE_URLS` | `--urls` | Comma-separated dual-node URLs | Empty |
| `KASWIN_REGISTRY_ADDRESSES` | `--registry-addresses` | Watched Kaswin Registry address list | Official TN10 Registry |
| `KASWIN_API_PORT` | `--api-port` | REST API listening port | `8788` |
| `KASWIN_API_HOST` | `--api-host` | REST API listening host | `0.0.0.0` |

---

## REST API Reference

The service serves read-only JSON endpoints on port `8788` (CORS-friendly):

- `GET /v1/rounds`: List indexed rounds (supports keyset pagination via `?limit=50` and `?cursor=<cid>`).
- `GET /v1/rounds?status=open`: Filter rounds in active/open purchasing phase.
- `GET /v1/rounds?status=sealed`: Filter rounds in sealed/pending settlement phase.
- `GET /v1/rounds?status=close`: Filter completed or refunded terminal rounds.
- `GET /v1/rounds/{cid}`: Fetch detailed round state, history, and purchase records by its 64-character lowercase hex Covenant ID.

---

## Developer & CLI Commands

When developing or debugging locally on Node.js 22+:

```bash
# Inspect loaded contract plugins and pinned profiles (offline)
node indexer.mjs contracts

# Inspect local database round statuses and journal
node indexer.mjs status --db events.sqlite

# Run in foreground for debugging
node indexer.mjs run --db events.sqlite --pool --api-port 8788
```

---

## Adapting for Custom Covenant DApps

This project is built around a pluggable architecture. The underlying Borsh wRPC connection, dual-node failover pool, selected-chain acceptance verification, reorg rollback engine, and SQLite storage are **completely generic and reusable**.

If you wish to adapt this indexer for your own Kaspa Covenant DApp (e.g., AMM, auctions, order books, bridges):
👉 **See the complete walkthrough: [Custom DApp Adaptation Guide (CUSTOM_DAPP_GUIDE.en.md)](./CUSTOM_DAPP_GUIDE.en.md)**

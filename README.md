# Kaspa Raffle Indexer

This is the standalone, replaceable indexer for raffle rounds with more than 1,000 tickets. The static browser app verifies every Merkle proof returned by this service; the indexer never controls funds or selects winners.

```powershell
cd indexer
npm install
$env:KASPA_NETWORK="mainnet"
$env:KASPA_RPC_URL="ws://127.0.0.1:18110"
$env:RAFFLE_INDEX_PORT="8787"
$env:RAFFLE_INDEX_DATA="C:\kaspa-raffle-index"
npm start
```

For a public mainnet deployment, put the HTTP port behind HTTPS and set CORS at the reverse proxy. Point the web app's **Raffle index API** field at that URL. Rounds of 1,000 tickets or fewer can reconstruct their state directly from explorer history and browser storage and do not require this service.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KASPA_NETWORK` | `testnet-10` | Kaspa network id |
| `KASPA_RPC_URL` | `ws://tn12-node.kaspa.com:18210` | Toccata wRPC node |
| `RAFFLE_INDEX_PORT` | `8787` | HTTP listen port |
| `RAFFLE_INDEX_DATA` | `../.index-data` | Durable index directory |
| `RAFFLE_INDEX_CONFIRMATIONS` | `10` | Confirmation depth |
| `RAFFLE_INDEX_POLL_MS` | `1000` | Poll interval |

// Single-writer SQLite cache (node:sqlite, Node >= 22.5). Chain + covenant rules stay the source of truth.
// Every mutation that changes a round also appends the relay outbox row in the same transaction.
import {DatabaseSync} from 'node:sqlite';

const enc = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const dec = s => s == null ? null : JSON.parse(s);

export class Store {
  constructor(path = ':memory:', {defaultContract = null} = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds(
        id TEXT PRIMARY KEY, contract TEXT, data TEXT NOT NULL, address TEXT, status TEXT NOT NULL,
        live_seen_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transitions(
        txid TEXT NOT NULL, round_id TEXT NOT NULL REFERENCES rounds(id), contract TEXT, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL, accepting TEXT NOT NULL, accepting_daa TEXT NOT NULL,
        accepting_blue_score TEXT NOT NULL, containing TEXT, previous TEXT, next TEXT NOT NULL,
        evidence TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY(round_id, seq));
      CREATE INDEX IF NOT EXISTS transitions_status ON transitions(status);
      CREATE TABLE IF NOT EXISTS checkpoints(at INTEGER NOT NULL, sink TEXT NOT NULL, virtual_daa TEXT NOT NULL, sink_blue_score TEXT);
      CREATE INDEX IF NOT EXISTS checkpoints_at ON checkpoints(at);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS discoveries(txid TEXT PRIMARY KEY, hint TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // Migration from the single-contract schema: add the column, then bind old rows to the contract that created them.
    for (const t of ['rounds', 'transitions'])
      if (!this.db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'contract')) this.db.exec(`ALTER TABLE ${t} ADD COLUMN contract TEXT`);
    this.db.exec("CREATE INDEX IF NOT EXISTS rounds_cid ON rounds(json_extract(data,'$.cid'))");
    const orphans = this.db.prepare('SELECT COUNT(*) n FROM rounds WHERE contract IS NULL').get().n;
    if (orphans) {
      if (!defaultContract) throw Error('LEGACY_ROUNDS_NEED_DEFAULT_CONTRACT ' + orphans);
      this.db.prepare('UPDATE rounds SET contract=? WHERE contract IS NULL').run(defaultContract);
      this.db.prepare('UPDATE transitions SET contract=? WHERE contract IS NULL').run(defaultContract);
    }
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getMeta(key) { return dec(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value); }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, enc(value)); }

  discovery(id) { const r = this.db.prepare('SELECT * FROM discoveries WHERE txid=?').get(id); return r ? {...r, hint: dec(r.hint)} : null; }
  discoverTask(id, hint, now) {
    const old = this.discovery(id);
    const merged = {...old?.hint, ...hint, eventAt: old?.hint.eventAt ?? hint.eventAt ?? now};
    const changed = old && String(old.hint.daa) !== String(merged.daa);
    const status = old?.status === 'APPLIED' ? 'APPLIED' : old?.status === 'IGNORED' && !changed ? 'IGNORED' : 'PENDING';
    this.db.prepare(`INSERT INTO discoveries(txid,hint,status,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(txid) DO UPDATE SET hint=excluded.hint,status=excluded.status,updated_at=excluded.updated_at`).run(id, enc(merged), status, now);
    return this.discovery(id);
  }
  discoveryResult(id, status, now, error = null) {
    this.db.prepare('UPDATE discoveries SET status=?,error=?,attempts=attempts+1,updated_at=? WHERE txid=?').run(status, error, now, id);
  }
  pendingDiscoveries() { return this.db.prepare("SELECT txid,hint FROM discoveries WHERE status='PENDING' ORDER BY updated_at LIMIT 100").all().map(r => ({id:r.txid,hint:dec(r.hint)})); }

  round(id) { const r = this.db.prepare('SELECT * FROM rounds WHERE id=?').get(id); return r ? rowRound(r) : null; }
  rounds({liveOnly = false} = {}) {
    return this.db.prepare(`SELECT * FROM rounds ${liveOnly ? "WHERE status='LIVE'" : ''} ORDER BY id`).all().map(rowRound);
  }
  byCid(cid) {
    return this.db.prepare("SELECT * FROM rounds WHERE json_extract(data,'$.cid')=? AND status!='ROLLED_BACK' LIMIT 2").all(cid).map(rowRound);
  }
  cidPage(after, limit, category = null) {
    const bucket = `CASE WHEN status='STALE' OR contract NOT LIKE 'kaswin-f3@%' THEN 'unknown'
      WHEN status='TERMINAL' THEN 'close'
      WHEN json_extract(data,'$.state.phase')=1 THEN 'open'
      WHEN json_extract(data,'$.state.phase') IN (2,3,4) THEN 'sealed'
      WHEN json_extract(data,'$.state.phase')=5 THEN 'close' ELSE 'unknown' END`;
    return this.db.prepare(`SELECT * FROM rounds WHERE json_extract(data,'$.cid')>? AND status!='ROLLED_BACK'
      AND (? IS NULL OR (${bucket})=?) ORDER BY json_extract(data,'$.cid'),id LIMIT ?`).all(after, category, category, limit).map(rowRound);
  }
  putRound(round, address, now, contract) {
    if (!contract) throw Error('ROUND_WITHOUT_CONTRACT');
    const status = round.tip ? 'LIVE' : 'TERMINAL';
    const old = this.db.prepare('SELECT contract FROM rounds WHERE id=?').get(round.id);
    if (old && old.contract !== contract) throw Error('ROUND_CONTRACT_CANNOT_CHANGE');   // a covenant's rules are fixed at Genesis
    this.db.prepare(`INSERT INTO rounds(id,contract,data,address,status,live_seen_at,updated_at) VALUES(?,?,?,?,?,NULL,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,address=excluded.address,status=excluded.status,updated_at=excluded.updated_at`)
      .run(round.id, contract, enc(round), round.tip ? address : null, status, now);
  }
  markLiveSeen(id, at) { this.db.prepare('UPDATE rounds SET live_seen_at=? WHERE id=?').run(at, id); }

  lastSeq(roundId) { return this.db.prepare('SELECT MAX(seq) s FROM transitions WHERE round_id=?').get(roundId)?.s ?? -1; }
  addTransition(t) {
    this.db.prepare(`INSERT INTO transitions(txid,round_id,contract,seq,kind,status,accepting,accepting_daa,accepting_blue_score,containing,previous,next,evidence,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(t.txid, t.roundId, t.contract, t.seq, t.kind, t.status, t.accepting, String(t.acceptingDaa),
      String(t.acceptingBlueScore), t.containing ?? null, t.previous ? enc(t.previous) : null, enc(t.next), enc(t.evidence), t.observedAt);
  }
  unfinalized() { return this.db.prepare("SELECT * FROM transitions WHERE status='ACCEPTED' ORDER BY round_id, seq").all().map(rowTransition); }
  transitions(roundId) { return this.db.prepare('SELECT * FROM transitions WHERE round_id=? ORDER BY seq').all(roundId).map(rowTransition); }
  setTransitionStatus(roundId, seq, status) { this.db.prepare('UPDATE transitions SET status=? WHERE round_id=? AND seq=?').run(status, roundId, seq); }
  activeAfter(roundId, seq) {
    return this.db.prepare("SELECT * FROM transitions WHERE round_id=? AND seq>=? AND status!='ROLLED_BACK' ORDER BY seq DESC").all(roundId, seq).map(rowTransition);
  }

  addCheckpoint(c, keep) {
    this.db.prepare('INSERT INTO checkpoints(at,sink,virtual_daa,sink_blue_score) VALUES(?,?,?,?)').run(c.at, c.sink, String(c.virtualDaa), c.sinkBlueScore == null ? null : String(c.sinkBlueScore));
    this.db.prepare('DELETE FROM checkpoints WHERE at < (SELECT MIN(at) FROM (SELECT at FROM checkpoints ORDER BY at DESC LIMIT ?))').run(keep);
  }
  /** Newest checkpoints first, all recorded strictly before `before`. */
  checkpointsBefore(before, limit = 8) {
    return this.db.prepare('SELECT * FROM checkpoints WHERE at < ? ORDER BY at DESC LIMIT ?').all(before, limit)
      .map(r => ({at: r.at, sink: r.sink, virtualDaa: r.virtual_daa, sinkBlueScore: r.sink_blue_score}));
  }

  enqueue(payload, now) { this.db.prepare('INSERT INTO outbox(payload,created_at) VALUES(?,?)').run(enc(payload), now); }
  pending(limit = 100) { return this.db.prepare('SELECT id,payload FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT ?').all(limit).map(r => ({id: r.id, payload: dec(r.payload)})); }
  delivered(id, at) { this.db.prepare('UPDATE outbox SET delivered_at=? WHERE id=?').run(at, id); }

  log(kind, data, at) {
    this.db.prepare('INSERT INTO journal(at,kind,data) VALUES(?,?,?)').run(at, kind, enc(data));
    this.db.prepare('DELETE FROM journal WHERE id <= (SELECT MAX(id) FROM journal) - 5000').run();
  }
  journal(limit = 50) { return this.db.prepare('SELECT * FROM journal ORDER BY id DESC LIMIT ?').all(limit).map(r => ({at: r.at, kind: r.kind, data: dec(r.data)})); }
  close() { this.db.close(); }
}
function rowRound(r) { return {id: r.id, contract: r.contract, data: dec(r.data), address: r.address, status: r.status, liveSeenAt: r.live_seen_at, updatedAt: r.updated_at}; }
function rowTransition(r) {
  return {txid: r.txid, roundId: r.round_id, contract: r.contract, seq: r.seq, kind: r.kind, status: r.status, accepting: r.accepting,
    acceptingDaa: r.accepting_daa, acceptingBlueScore: r.accepting_blue_score, containing: r.containing,
    previous: dec(r.previous), next: dec(r.next), evidence: dec(r.evidence), observedAt: r.observed_at};
}

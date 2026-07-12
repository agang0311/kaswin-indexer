import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  Encoding,
  RpcClient,
  ScriptPublicKey,
  addressFromScriptPublicKey,
  initSync
} from "@onekeyfe/kaspa-wasm/kaspa.js";

const DEPTH = 20;
const CAPACITY = 1 << DEPTH;
const RECORD_BYTES = 64;
const ZERO32 = Buffer.alloc(32);
const appRoot = import.meta.dirname;
const dataDir = path.resolve(process.env.RAFFLE_INDEX_DATA || path.join(appRoot, ".index-data"));
const statePath = path.join(dataDir, "state.json");
const eventLogPath = path.join(dataDir, "events.ndjson");
const eventBlockIndexPath = path.join(dataDir, "event-blocks.bin");
const baseStatePath = path.join(dataDir, "base-state.json");
const baseTicketsDir = path.join(dataDir, "base-tickets");
const rpcUrl = process.env.KASPA_RPC_URL || "ws://tn12-node.kaspa.com:18210";
const network = process.env.KASPA_NETWORK || "testnet-10";
const port = Number(process.env.RAFFLE_INDEX_PORT || 8787);
const confirmations = Number(process.env.RAFFLE_INDEX_CONFIRMATIONS || 10);
const pollMs = Number(process.env.RAFFLE_INDEX_POLL_MS || 1_000);
const offline = process.env.RAFFLE_INDEX_OFFLINE === "1";

fs.mkdirSync(dataDir, { recursive: true });
const kaspaModuleUrl = import.meta.resolve("@onekeyfe/kaspa-wasm/kaspa.js");
initSync({ module: fs.readFileSync(fileURLToPath(new URL("./kaspa_bg.wasm.bin", kaspaModuleUrl))) });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

function pair(left, right) {
  return sha256(Buffer.concat([left, right]));
}

const emptyNodes = [ZERO32];
for (let level = 1; level <= DEPTH; level += 1) emptyNodes.push(pair(emptyNodes[level - 1], emptyNodes[level - 1]));

function hexPayload(hex) {
  try {
    const value = JSON.parse(Buffer.from(hex || "", "hex").toString("utf8"));
    return value?.app === "kaspa-raffle-static" ? value : null;
  } catch {
    return null;
  }
}

function fixedHex(value, bytes, label) {
  const normalized = String(value || "").toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) throw new Error(`${label} must be ${bytes} bytes.`);
  return normalized;
}

function txIdOf(tx) {
  return tx?.verboseData?.transactionId || "";
}

function outputInfo(tx, index = 0) {
  const output = tx?.outputs?.[index];
  if (!output) return undefined;
  const covenant = output.covenant || output.covenantBinding;
  return {
    index,
    amountSompi: String(output.value ?? "0"),
    address: output.verboseData?.scriptPublicKeyAddress || "",
    covenantId: covenant?.covenantId || covenant?.id || ""
  };
}

function pubkeyAddress(pubkeyHex) {
  const script = new ScriptPublicKey(0, `20${pubkeyHex}ac`);
  const address = addressFromScriptPublicKey(script, network);
  script.free();
  if (!address) throw new Error("Unable to derive ticket owner address.");
  return address.toString();
}

function storageStem(roundId) {
  return encodeURIComponent(String(roundId));
}

class TicketTree {
  constructor(roundId, summary = {}) {
    this.roundId = roundId;
    this.count = 0;
    this.frontier = Buffer.alloc(DEPTH * 32);
    this.levelFds = new Map();
    this.ownerFds = new Map();
    const stem = storageStem(roundId);
    this.ticketFile = path.join(dataDir, `${stem}.tickets.bin`);
    this.treeDir = path.join(dataDir, `${stem}.tree`);
    this.ownerDir = path.join(this.treeDir, "owners");
    this.checkpointFile = path.join(this.treeDir, "checkpoint.json");
    const expectedCount = Number(summary.soldTickets || 0);
    if (expectedCount === 0) return;
    if (!fs.existsSync(this.ticketFile) || fs.statSync(this.ticketFile).size < expectedCount * RECORD_BYTES) {
      throw new Error(`Ticket index for ${roundId} is shorter than its saved ticket count.`);
    }

    const checkpoint = this.readCheckpoint();
    const derivedFilesReady = fs.existsSync(this.ownerDir) && Array.from(
      { length: DEPTH + 1 },
      (_, level) => path.join(this.treeDir, `level-${String(level).padStart(2, "0")}.bin`)
    ).every((levelPath) => fs.existsSync(levelPath));
    if (
      derivedFilesReady &&
      checkpoint?.count === expectedCount &&
      checkpoint.rootHex === summary.ticketRoot &&
      /^[0-9a-f]{1280}$/.test(checkpoint.frontierHex || "")
    ) {
      this.count = expectedCount;
      this.frontier = Buffer.from(checkpoint.frontierHex, "hex");
      return;
    }

    this.resetDerivedIndexes();
    const fd = fs.openSync(this.ticketFile, "r");
    const record = Buffer.alloc(RECORD_BYTES);
    try {
      for (let index = 0; index < expectedCount; index += 1) {
        if (fs.readSync(fd, record, 0, RECORD_BYTES, index * RECORD_BYTES) !== RECORD_BYTES) {
          throw new Error(`Ticket index for ${roundId} is truncated at ${index}.`);
        }
        this.append(record.subarray(0, 32), record.subarray(32, 64), false, false);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (summary.ticketRoot && this.rootHex !== summary.ticketRoot) {
      throw new Error(`Ticket tree root for ${roundId} does not match its saved state.`);
    }
    this.writeCheckpoint();
  }

  readCheckpoint() {
    try {
      return JSON.parse(fs.readFileSync(this.checkpointFile, "utf8"));
    } catch {
      return undefined;
    }
  }

  writeCheckpoint() {
    fs.mkdirSync(this.treeDir, { recursive: true });
    const temporary = `${this.checkpointFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      count: this.count,
      rootHex: this.rootHex,
      frontierHex: this.frontierHex
    })}\n`);
    fs.renameSync(temporary, this.checkpointFile);
  }

  closeLevelFiles() {
    for (const fd of this.levelFds.values()) fs.closeSync(fd);
    this.levelFds.clear();
    for (const fd of this.ownerFds.values()) fs.closeSync(fd);
    this.ownerFds.clear();
  }

  dispose() {
    this.closeLevelFiles();
  }

  resetDerivedIndexes() {
    this.closeLevelFiles();
    fs.rmSync(this.treeDir, { recursive: true, force: true });
    fs.mkdirSync(this.ownerDir, { recursive: true });
    this.count = 0;
    this.frontier.fill(0);
  }

  levelFd(level) {
    let fd = this.levelFds.get(level);
    if (fd !== undefined) return fd;
    fs.mkdirSync(this.treeDir, { recursive: true });
    const levelPath = path.join(this.treeDir, `level-${String(level).padStart(2, "0")}.bin`);
    fd = fs.openSync(levelPath, fs.existsSync(levelPath) ? "r+" : "w+");
    this.levelFds.set(level, fd);
    return fd;
  }

  readNode(level, index) {
    const bytes = Buffer.alloc(32);
    const read = fs.readSync(this.levelFd(level), bytes, 0, 32, index * 32);
    return read === 32 ? bytes : emptyNodes[level];
  }

  writeNode(level, index, node) {
    fs.writeSync(this.levelFd(level), node, 0, 32, index * 32);
  }

  persistTicketRecord(ticketId, owner, transactionId) {
    const expected = Buffer.concat([owner, transactionId]);
    if (fs.existsSync(this.ticketFile) && fs.statSync(this.ticketFile).size >= (ticketId + 1) * RECORD_BYTES) {
      const existing = Buffer.alloc(RECORD_BYTES);
      const fd = fs.openSync(this.ticketFile, "r");
      try {
        fs.readSync(fd, existing, 0, RECORD_BYTES, ticketId * RECORD_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      if (existing.equals(expected)) return;
      fs.truncateSync(this.ticketFile, ticketId * RECORD_BYTES);
    }
    fs.appendFileSync(this.ticketFile, expected);
  }

  persistOwnerRecord(ticketId, owner) {
    fs.mkdirSync(this.ownerDir, { recursive: true });
    const bucketId = owner[0];
    const bucket = path.join(this.ownerDir, `${bucketId.toString(16).padStart(2, "0")}.bin`);
    const record = Buffer.alloc(36);
    owner.copy(record, 0);
    record.writeUInt32LE(ticketId, 32);
    let fd = this.ownerFds.get(bucketId);
    if (fd === undefined) {
      fd = fs.openSync(bucket, "a");
      this.ownerFds.set(bucketId, fd);
    }
    fs.writeSync(fd, record);
  }

  append(ownerPubkey, txId, persist = true, checkpoint = true) {
    if (this.count >= CAPACITY) throw new Error(`Round ${this.roundId} reached Merkle capacity.`);
    const owner = Buffer.from(ownerPubkey);
    const transactionId = Buffer.from(txId);
    if (owner.length !== 32 || transactionId.length !== 32) throw new Error("Ticket record must contain a pubkey and transaction id.");
    const ticketId = this.count;
    let node = sha256(owner);
    this.writeNode(0, ticketId, node);
    let pathIndex = ticketId;
    let carrying = true;

    for (let level = 0; level < DEPTH; level += 1) {
      if ((pathIndex & 1) === 0 && carrying) {
        node.copy(this.frontier, level * 32);
        carrying = false;
      }
      const levelCount = Math.ceil((ticketId + 1) / (1 << level));
      const siblingIndex = pathIndex ^ 1;
      const sibling = siblingIndex < levelCount
        ? this.readNode(level, siblingIndex)
        : emptyNodes[level];
      const parent = (pathIndex & 1) === 0 ? pair(node, sibling) : pair(sibling, node);
      pathIndex >>= 1;
      this.writeNode(level + 1, pathIndex, parent);
      node = parent;
    }

    if (persist) {
      this.persistTicketRecord(ticketId, owner, transactionId);
    }
    this.persistOwnerRecord(ticketId, owner);
    this.count += 1;
    if (checkpoint) this.writeCheckpoint();
    return ticketId;
  }

  owner(ticketId) {
    if (!Number.isInteger(ticketId) || ticketId < 0 || ticketId >= this.count) return undefined;
    const bytes = Buffer.alloc(32);
    const fd = fs.openSync(this.ticketFile, "r");
    try {
      if (fs.readSync(fd, bytes, 0, 32, ticketId * RECORD_BYTES) !== 32) return undefined;
    } finally {
      fs.closeSync(fd);
    }
    return bytes;
  }

  transactionId(ticketId) {
    if (!Number.isInteger(ticketId) || ticketId < 0 || ticketId >= this.count) return undefined;
    const fd = fs.openSync(this.ticketFile, "r");
    const bytes = Buffer.alloc(32);
    try {
      fs.readSync(fd, bytes, 0, 32, ticketId * RECORD_BYTES + 32);
    } finally {
      fs.closeSync(fd);
    }
    return bytes;
  }

  ticketForOwner(pubkeyHex) {
    const needle = Buffer.from(fixedHex(pubkeyHex, 32, "Owner public key"), "hex");
    const bucket = path.join(this.ownerDir, `${needle[0].toString(16).padStart(2, "0")}.bin`);
    if (!fs.existsSync(bucket)) return -1;
    const records = fs.readFileSync(bucket);
    for (let offset = 0; offset + 36 <= records.length; offset += 36) {
      if (records.subarray(offset, offset + 32).equals(needle)) return records.readUInt32LE(offset + 32);
    }
    return -1;
  }

  proof(ticketId) {
    const owner = this.owner(ticketId);
    if (!owner) return undefined;
    const siblings = [];
    let pathIndex = ticketId;
    for (let level = 0; level < DEPTH; level += 1) {
      const levelCount = Math.ceil(this.count / (1 << level));
      const siblingIndex = pathIndex ^ 1;
      siblings.push(siblingIndex < levelCount
        ? this.readNode(level, siblingIndex)
        : emptyNodes[level]);
      pathIndex >>= 1;
    }
    return {
      ticketId: ticketId + 1,
      ownerPubkey: owner.toString("hex"),
      owner: pubkeyAddress(owner.toString("hex")),
      transactionId: this.transactionId(ticketId)?.toString("hex"),
      proofHex: Buffer.concat(siblings).toString("hex"),
      rootHex: this.rootHex
    };
  }

  rangeProof8(firstTicketId) {
    if (!Number.isInteger(firstTicketId) || firstTicketId < 0 || firstTicketId % 8 !== 0 || firstTicketId + 8 > this.count) return undefined;
    const owners = Array.from({ length: 8 }, (_, offset) => this.owner(firstTicketId + offset));
    if (owners.some((owner) => !owner)) return undefined;
    const siblings = [];
    let pathIndex = firstTicketId >> 3;
    for (let level = 3; level < DEPTH; level += 1) {
      const levelCount = Math.ceil(this.count / (1 << level));
      const siblingIndex = pathIndex ^ 1;
      siblings.push(siblingIndex < levelCount ? this.readNode(level, siblingIndex) : emptyNodes[level]);
      pathIndex >>= 1;
    }
    return {
      firstTicketId: firstTicketId + 1,
      ticketCount: 8,
      ownerPubkeys: owners.map((owner) => owner.toString("hex")),
      owners: owners.map((owner) => pubkeyAddress(owner.toString("hex"))),
      proofHex: Buffer.concat(siblings).toString("hex"),
      rootHex: this.rootHex
    };
  }

  get rootHex() {
    return this.count ? this.readNode(DEPTH, 0).toString("hex") : emptyNodes[DEPTH].toString("hex");
  }

  get frontierHex() {
    return this.frontier.toString("hex");
  }
}

function readState() {
  if (!fs.existsSync(statePath)) return { cursor: "", rounds: {} };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

const saved = readState();

function ticketIndexNames(directory = dataDir) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".tickets.bin"));
}

function initializeBaseSnapshot() {
  if (fs.existsSync(baseStatePath)) return;
  fs.mkdirSync(baseTicketsDir, { recursive: true });
  for (const name of ticketIndexNames()) {
    fs.copyFileSync(path.join(dataDir, name), path.join(baseTicketsDir, name));
  }
  const base = {
    version: 1,
    rounds: saved.rounds || {}
  };
  const temporary = `${baseStatePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(base)}\n`);
  fs.renameSync(temporary, baseStatePath);
  // Missing base metadata identifies a legacy snapshot. Checkpoint its saved
  // state and begin a new append-only event segment from this point onward.
  fs.writeFileSync(eventLogPath, "");
  fs.writeFileSync(eventBlockIndexPath, Buffer.alloc(0));
}

initializeBaseSnapshot();
const rounds = new Map();
for (const [roundId, summary] of Object.entries(saved.rounds || {})) {
  rounds.set(roundId, { ...summary, tree: new TicketTree(roundId, summary) });
}
let cursor = process.env.RAFFLE_INDEX_START_HASH || saved.cursor || "";
let pendingBlocks = Array.isArray(saved.pendingBlocks) ? saved.pendingBlocks : [];
let eventBlockIndex = fs.existsSync(eventBlockIndexPath) ? fs.readFileSync(eventBlockIndexPath) : Buffer.alloc(0);

function eventLogBytes() {
  return fs.existsSync(eventLogPath) ? fs.statSync(eventLogPath).size : 0;
}

function serializableRound(round) {
  const { tree, ...summary } = round;
  return {
    ...summary,
    soldTickets: tree.count,
    ticketRoot: tree.rootHex,
    ticketFrontier: tree.frontierHex
  };
}

function saveState() {
  const value = {
    version: 1,
    network,
    rpcUrl,
    cursor,
    pendingBlocks,
    eventLogBytes: eventLogBytes(),
    rounds: Object.fromEntries([...rounds].map(([roundId, round]) => [roundId, serializableRound(round)]))
  };
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, statePath);
}

function roundForPayload(payload) {
  let round = rounds.get(payload.roundId);
  if (!round) {
    round = {
      roundId: payload.roundId,
      contractVersion: payload.contractVersion || "",
      status: "Open",
      refundCursor: 0,
      tree: new TicketTree(payload.roundId)
    };
    rounds.set(payload.roundId, round);
  }
  return round;
}

function indexEvent(tx) {
  const payload = hexPayload(tx.payload);
  const transactionId = txIdOf(tx);
  if (!payload?.roundId || !transactionId) return null;
  return { payload, transactionId, output: outputInfo(tx) };
}

function applyEvent(event) {
  const { payload, transactionId } = event;
  if (!payload?.roundId || !transactionId) return;
  if (
    (payload.type === "round-create" || payload.type === "round-register") &&
    payload.contractVersion && payload.contractVersion !== "raffle-v6-aligned-batch-buy"
  ) return;
  const round = roundForPayload(payload);

  if (payload.type === "round-create" || payload.type === "round-register") {
    Object.assign(round, {
      contractVersion: payload.contractVersion || round.contractVersion,
      version: payload.version || round.version,
      creator: payload.creator || round.creator,
      creatorPubkey: payload.creatorPubkey || round.creatorPubkey,
      oraclePublicKey: payload.oraclePublicKey || round.oraclePublicKey,
      oracleEndpoint: payload.oracleEndpoint || round.oracleEndpoint,
      ticketPrice: payload.ticketPrice || round.ticketPrice,
      maxTickets: payload.maxTickets ?? round.maxTickets,
      minTickets: payload.minTickets ?? round.minTickets,
      refundAfterDaaScore: payload.refundAfterDaaScore || round.refundAfterDaaScore,
      createdAtDaaScore: payload.createdAtDaaScore || round.createdAtDaaScore,
      refundTimeoutSeconds: payload.refundTimeoutSeconds || round.refundTimeoutSeconds,
      registryAddress: payload.registryAddress || round.registryAddress,
      createTxId: payload.createTxId || (payload.type === "round-create" ? transactionId : round.createTxId),
      covenantId: payload.covenantId || round.covenantId
    });
    if (payload.type === "round-create") round.latest = { txId: transactionId, ...event.output };
    return;
  }

  if (payload.type === "ticket") {
    if (round.status !== "Open") throw new Error(`Ticket ${transactionId} targets non-open round ${round.roundId}.`);
    const ticketNumber = Number(payload.ticketId);
    const ticketCount = Number(payload.ticketCount || 1);
    if (ticketNumber !== round.tree.count + 1 || !Number.isInteger(ticketCount) || ticketCount < 1 || ticketCount > 8) {
      throw new Error(`Ticket ${transactionId} is not the next 1-8 ticket purchase for ${round.roundId}.`);
    }
    const owner = Buffer.from(fixedHex(payload.buyerPubkey, 32, "Buyer public key"), "hex");
    const txId = Buffer.from(transactionId, "hex");
    for (let offset = 0; offset < ticketCount; offset += 1) round.tree.append(owner, txId);
    round.latest = { txId: transactionId, ...event.output };
    return;
  }

  if (payload.type === "round-finalize") {
    round.status = "Finalized";
    round.finalized = {
      txId: transactionId,
      winnerTicketId: payload.winnerTicketId,
      winnerAddress: payload.winnerAddress,
      amount: payload.amount
    };
    round.latest = undefined;
    return;
  }

  if (payload.type === "round-refund-start") {
    if (round.refundCursor !== 0) throw new Error(`Refund already started for ${round.roundId}.`);
    round.status = "Refunding";
    round.latest = { txId: transactionId, ...event.output };
    return;
  }

  if (payload.type === "round-refund-batch") {
    const claimedCursor = Number(payload.refundCursor ?? round.refundCursor);
    const ticketCount = Number(payload.ticketCount || 0);
    if (claimedCursor !== round.refundCursor || ticketCount !== 8 || claimedCursor % 8 !== 0) {
      throw new Error(`Refund batch cursor mismatch for ${round.roundId}.`);
    }
    round.refundCursor += ticketCount;
    const successor = event.output;
    if (successor?.covenantId || (successor?.address && round.refundCursor < round.tree.count)) {
      round.status = "Refunding";
      round.latest = { txId: transactionId, ...successor };
    } else {
      round.status = "Refunded";
      round.refundTxId = transactionId;
      round.latest = undefined;
    }
    return;
  }

  if (payload.type === "round-refund-ticket") {
    const claimedCursor = Number(payload.refundCursor ?? round.refundCursor);
    if (claimedCursor !== round.refundCursor) throw new Error(`Refund cursor mismatch for ${round.roundId}.`);
    round.refundCursor += 1;
    const successor = event.output;
    if (successor?.covenantId || (successor?.address && round.refundCursor < round.tree.count)) {
      round.status = "Refunding";
      round.latest = { txId: transactionId, ...successor };
    } else {
      round.status = "Refunded";
      round.refundTxId = transactionId;
      round.latest = undefined;
    }
    return;
  }

  if (payload.type === "round-refund") {
    round.status = "Refunded";
    round.refundTxId = transactionId;
    round.latest = undefined;
  }
}

function eventBlockWasApplied(hash) {
  const bytes = Buffer.from(hash, "hex");
  let offset = -1;
  while ((offset = eventBlockIndex.indexOf(bytes, offset + 1)) >= 0) {
    if (offset % 32 === 0) return true;
  }
  return false;
}

function appendEventBlock(block) {
  if (!block.events.length || eventBlockWasApplied(block.hash)) return;
  fs.appendFileSync(eventLogPath, `${JSON.stringify(block)}\n`);
  const hash = Buffer.from(block.hash, "hex");
  fs.appendFileSync(eventBlockIndexPath, hash);
  eventBlockIndex = Buffer.concat([eventBlockIndex, hash]);
  for (const event of block.events) applyEvent(event);
}

function removeTicketIndexes() {
  for (const name of ticketIndexNames()) {
    fs.rmSync(path.join(dataDir, name), { force: true });
  }
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".tree")) {
      fs.rmSync(path.join(dataDir, entry.name), { recursive: true, force: true });
    }
  }
}

function restoreBaseSnapshot() {
  for (const round of rounds.values()) round.tree.dispose();
  rounds.clear();
  removeTicketIndexes();
  for (const name of ticketIndexNames(baseTicketsDir)) {
    fs.copyFileSync(path.join(baseTicketsDir, name), path.join(dataDir, name));
  }
  const base = JSON.parse(fs.readFileSync(baseStatePath, "utf8"));
  for (const [roundId, summary] of Object.entries(base.rounds || {})) {
    rounds.set(roundId, { ...summary, tree: new TicketTree(roundId, summary) });
  }
}

async function rebuildAfterRemovedBlocks(removed) {
  if (!fs.existsSync(eventLogPath)) return;
  const temporaryLog = `${eventLogPath}.tmp`;
  const temporaryIndex = `${eventBlockIndexPath}.tmp`;
  const output = fs.createWriteStream(temporaryLog, { encoding: "utf8" });
  const indexOutput = fs.createWriteStream(temporaryIndex);
  const lines = readline.createInterface({ input: fs.createReadStream(eventLogPath), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line) continue;
    const block = JSON.parse(line);
    if (removed.has(block.hash)) continue;
    if (!output.write(`${JSON.stringify(block)}\n`)) await once(output, "drain");
    if (!indexOutput.write(Buffer.from(block.hash, "hex"))) await once(indexOutput, "drain");
  }
  output.end();
  indexOutput.end();
  await Promise.all([once(output, "finish"), once(indexOutput, "finish")]);
  fs.renameSync(temporaryLog, eventLogPath);
  fs.renameSync(temporaryIndex, eventBlockIndexPath);

  restoreBaseSnapshot();
  eventBlockIndex = fs.readFileSync(eventBlockIndexPath);
  const replayLines = readline.createInterface({ input: fs.createReadStream(eventLogPath), crlfDelay: Infinity });
  for await (const line of replayLines) {
    if (!line) continue;
    const block = JSON.parse(line);
    for (const event of block.events) applyEvent(event);
  }
  saveState();
  console.log(`[indexer] rebuilt ${rounds.size} rounds after removing ${removed.size} chain block(s)`);
}

async function recoverUncheckpointedEvents() {
  const logBytes = eventLogBytes();
  let offset = Number(saved.eventLogBytes || 0);
  if (offset === logBytes) return;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > logBytes) {
    restoreBaseSnapshot();
    offset = 0;
  }
  const replayLines = readline.createInterface({
    input: fs.createReadStream(eventLogPath, { start: offset }),
    crlfDelay: Infinity
  });
  let replayedBlocks = 0;
  for await (const line of replayLines) {
    if (!line) continue;
    const block = JSON.parse(line);
    for (const event of block.events) applyEvent(event);
    replayedBlocks += 1;
  }
  saveState();
  if (replayedBlocks) console.log(`[indexer] recovered ${replayedBlocks} uncheckpointed event block(s)`);
}

function encodingForUrl(url) {
  return url.includes(":18110") || url.includes(":18210") ? Encoding.SerdeJson : Encoding.Borsh;
}

const rpc = new RpcClient({ url: rpcUrl, encoding: encodingForUrl(rpcUrl), networkId: network });
let syncing = false;
let stopped = false;

const startupRemovedBlocks = new Set(
  (process.env.RAFFLE_INDEX_REMOVE_BLOCKS || "").split(",").map((value) => value.trim()).filter(Boolean)
);
await recoverUncheckpointedEvents();
if (startupRemovedBlocks.size) await rebuildAfterRemovedBlocks(startupRemovedBlocks);

async function syncOnce() {
  if (syncing || stopped) return;
  syncing = true;
  try {
    if (!cursor) {
      const dag = await rpc.getBlockDagInfo();
      cursor = dag.sink;
      saveState();
      return;
    }
    const response = await rpc.getVirtualChainFromBlockV2({
      startHash: cursor,
      dataVerbosityLevel: "Full",
      minConfirmationCount: 0
    });
    if (response.removedChainBlockHashes.length) {
      const removed = new Set(response.removedChainBlockHashes);
      pendingBlocks = pendingBlocks.filter((block) => !removed.has(block.hash));
      if ([...removed].some(eventBlockWasApplied)) await rebuildAfterRemovedBlocks(removed);
    }
    for (const group of response.chainBlockAcceptedTransactions) {
      const hash = group.chainBlockHeader?.hash;
      if (!hash || pendingBlocks.some((block) => block.hash === hash) || eventBlockWasApplied(hash)) continue;
      pendingBlocks.push({
        hash,
        events: (group.acceptedTransactions || []).map(indexEvent).filter(Boolean)
      });
    }
    while (pendingBlocks.length > confirmations) {
      const confirmed = pendingBlocks.shift();
      appendEventBlock(confirmed);
    }
    const lastGroupHash = response.chainBlockAcceptedTransactions.at(-1)?.chainBlockHeader?.hash;
    const lastAddedHash = response.addedChainBlockHashes.at(-1);
    if (lastGroupHash || lastAddedHash) {
      cursor = lastGroupHash || lastAddedHash;
    }
    saveState();
  } catch (error) {
    console.error(`[indexer] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    syncing = false;
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  response.end(body);
}

function publicRound(round) {
  const value = serializableRound(round);
  return {
    ...value,
    latestCovenant: round.latest ? {
      covenantId: round.covenantId || round.latest.covenantId,
      address: round.latest.address,
      txId: round.latest.txId,
      outputIndex: round.latest.index || 0,
      amountSompi: round.latest.amountSompi,
      soldTickets: round.tree.count,
      potAmount: (BigInt(round.ticketPrice || 0) * BigInt(Math.max(0, round.tree.count - round.refundCursor))).toString(),
      status: round.status,
      ticketRoot: round.tree.rootHex,
      ticketFrontier: round.tree.frontierHex,
      refundCursor: round.refundCursor,
      creatorPubkey: round.creatorPubkey,
      refundAfterDaaScore: round.refundAfterDaaScore,
      ticketOwnerPubkeys: []
    } : undefined
  };
}

const server = http.createServer((request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" });
      response.end();
      return;
    }
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
    if (parts.length === 1 && parts[0] === "health") {
      return json(response, 200, {
        ok: true,
        network,
        rpcUrl,
        cursor,
        rounds: rounds.size,
        syncing,
        eventLogBytes: eventLogBytes(),
        rssBytes: process.memoryUsage().rss
      });
    }
    if (parts.length === 1 && parts[0] === "rounds") {
      return json(response, 200, [...rounds.values()].map(publicRound));
    }
    if (parts[0] !== "rounds" || !parts[1]) return json(response, 404, { error: "Not found" });
    const round = rounds.get(parts[1]);
    if (!round) return json(response, 404, { error: "Round not indexed" });
    if (parts.length === 2) return json(response, 200, publicRound(round));
    if (parts[2] === "tickets" && parts.length === 4) {
      const ticketId = Number(parts[3]) - 1;
      const proof = round.tree.proof(ticketId);
      return proof ? json(response, 200, proof) : json(response, 404, { error: "Ticket not indexed" });
    }
    if (parts[2] === "ranges" && parts.length === 5 && parts[4] === "8") {
      const firstTicketId = Number(parts[3]) - 1;
      const proof = round.tree.rangeProof8(firstTicketId);
      return proof ? json(response, 200, proof) : json(response, 404, { error: "Aligned 8-ticket range not indexed" });
    }
    if (parts[2] === "owners" && parts[3] && parts[4] === "proof") {
      const ticketId = round.tree.ticketForOwner(parts[3]);
      const proof = round.tree.proof(ticketId);
      return proof ? json(response, 200, proof) : json(response, 404, { error: "Owner did not buy a ticket" });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

if (!offline) {
  await rpc.connect();
  await syncOnce();
}
const timer = offline ? undefined : setInterval(syncOnce, pollMs);
server.listen(port, "127.0.0.1", () => {
  const source = offline ? "offline fixture" : `${rpcUrl} (${network}, ${confirmations} confirmations)`;
  console.log(`[indexer] http://127.0.0.1:${port} -> ${source}`);
});

async function shutdown() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  saveState();
  await new Promise((resolve) => server.close(resolve));
  if (!offline) await rpc.disconnect();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

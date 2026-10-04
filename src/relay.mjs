// Outbox delivery to the relay (at-least-once, ordered, idempotent key = type:roundId:seq).
import fs from 'node:fs';

export function makeRelay({url = null, token = null, file = null, fetchImpl = globalThis.fetch, timeoutMs = 8000} = {}) {
  if (!url && !file) return null;
  return async payload => {
    const body = JSON.stringify({...payload, idempotencyKey: `${payload.type}:${payload.roundId}:${payload.seq ?? ''}`});
    if (file) fs.appendFileSync(file, body + '\n');
    if (!url) return;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {method: 'POST', signal: ctl.signal,
        headers: {'content-type': 'application/json', ...(token ? {authorization: 'Bearer ' + token} : {})}, body});
      if (!r.ok && r.status !== 409) throw Error('RELAY_HTTP_' + r.status);   // 409 = already stored
    } finally { clearTimeout(t); }
  };
}

export async function flushOutbox(store, send, now = Date.now) {
  if (!send) return 0;
  let n = 0;
  for (const item of store.pending(100)) {
    await send(item.payload);                 // stop at first failure to preserve order
    store.delivered(item.id, now());
    n++;
  }
  return n;
}

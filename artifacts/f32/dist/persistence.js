/** Transactional browser persistence. Imports are data, never trusted verification evidence. */
import { check, unhex, integer } from './bytes.js';
export function namespace(networkGenesis, profile, genesisTxId) {
    unhex(networkGenesis, 32);
    unhex(profile, 32);
    if (genesisTxId !== undefined)
        unhex(genesisTxId, 32);
    return [networkGenesis, profile, genesisTxId ?? ''].join('/') + '/';
}
export class IndexedStore {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(name = 'kaswin-r7-components', factory = indexedDB) {
        return new Promise((resolve, reject) => {
            const req = factory.open(name, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('records'))
                    req.result.createObjectStore('records');
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IDB_UPGRADE_BLOCKED'));
            req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(new IndexedStore(db)); };
        });
    }
    close() { this.db.close(); }
    get(key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').get(key);
            let result = null;
            r.onsuccess = () => { result = r.result ?? null; };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('IDB_ABORT'));
        });
    }
    compareAndSet(key, expectedRevision, value) {
        if (expectedRevision !== null)
            integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records'), req = store.get(key);
            let result;
            let cause;
            req.onsuccess = () => {
                try {
                    const prev = req.result;
                    check((prev?.revision ?? null) === expectedRevision, 'STALE_CACHE_REVISION');
                    result = { revision: (prev?.revision ?? -1) + 1, value };
                    store.put(result, key);
                }
                catch (e) {
                    cause = e;
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(cause ?? tx.error ?? new Error('IDB_ABORT'));
            tx.onerror = () => reject(cause ?? tx.error);
        });
    }
    remove(key, expectedRevision) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readwrite'), store = tx.objectStore('records'), r = store.get(key);
            let cause;
            r.onsuccess = () => {
                try {
                    check(r.result?.revision === expectedRevision, 'STALE_CACHE_REVISION');
                    store.delete(key);
                }
                catch (e) {
                    cause = e;
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(cause ?? tx.error);
            tx.onerror = () => reject(cause ?? tx.error);
        });
    }
    list(prefix) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('records', 'readonly'), r = tx.objectStore('records').openCursor(), out = [];
            r.onsuccess = () => {
                const c = r.result;
                if (!c)
                    return;
                if (typeof c.key === 'string' && c.key.startsWith(prefix))
                    out.push({ key: c.key, record: c.value });
                c.continue();
            };
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }
}
//# sourceMappingURL=persistence.js.map
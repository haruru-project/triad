// IndexedDB layer. Service Worker と ページ の両方から import される。
// localStorage は SW から触れないため、共有ストレージは必ず IndexedDB を使う。

const DB_NAME = 'triad';
const DB_VER = 1;

export const STORE_TURNS = 'turns';
export const STORE_INBOX = 'inbox';
export const STORE_KV = 'kv';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TURNS)) {
        db.createObjectStore(STORE_TURNS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_INBOX)) {
        db.createObjectStore(STORE_INBOX, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store, value, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').put(value, key));
}

export async function get(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').getAll());
}

export async function del(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').delete(key));
}

export async function clear(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').clear());
}

// --- inbox: 共有シート経由で届いた「誰のものか未確定のテキスト」 ---

export async function addInbox(text) {
  const item = {
    id: (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()) + Math.random(),
    text,
    receivedAt: Date.now(),
  };
  await put(STORE_INBOX, item);
  return item.id;
}

export async function drainInbox() {
  const items = await getAll(STORE_INBOX);
  return items.sort((a, b) => a.receivedAt - b.receivedAt);
}

/* ══════════════════════════════════════════════════════
   db.js — IndexedDB helpers (multi-profile)
══════════════════════════════════════════════════════ */

/* Namespaced per signed-in user (see BRAuth.scopeSuffix in ../auth.js) so
   two accounts on the same browser never share SIP profiles/entries. */
const DB_NAME_BASE = 'sip-compounder';
const DB_NAME = window.BRAuth ? DB_NAME_BASE + '::' + window.BRAuth.scopeSuffix() : DB_NAME_BASE;
const DB_VERSION = 2;
let db;

export function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      const oldVersion = e.oldVersion;

      /* ── stores present since v1 ── */
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries'))  d.createObjectStore('entries',  { keyPath: 'id', autoIncrement: true });

      /* ── v2: profiles store ── */
      if (oldVersion < 2) {
        if (!d.objectStoreNames.contains('profiles')) {
          d.createObjectStore('profiles', { keyPath: 'id', autoIncrement: true });
        }
      }
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror   = e => rej(e.target.error);
  }).then(_db => migrateLegacyDataOnce(_db));
}

/* One-time migration: the first account to open this app on a given
   browser inherits whatever was already in the old shared (un-namespaced)
   database, so existing data isn't lost by this update. Skipped for
   guests, who never get a persistent copy of anyone's data. */
function migrateLegacyDataOnce(_db) {
  return new Promise((resolve) => {
    try {
      if (DB_NAME === DB_NAME_BASE || (window.BRAuth && window.BRAuth.isGuestSync())) return resolve(_db);
      const flag = 'br_migrated::' + DB_NAME;
      if (localStorage.getItem(flag)) return resolve(_db);
      const countReq = _db.transaction('profiles', 'readonly').objectStore('profiles').count();
      countReq.onsuccess = () => {
        if (countReq.result > 0) { localStorage.setItem(flag, '1'); return resolve(_db); }
        const legacyReq = indexedDB.open(DB_NAME_BASE);
        legacyReq.onupgradeneeded = e => e.target.transaction.abort();
        legacyReq.onerror = () => resolve(_db);
        legacyReq.onsuccess = e => {
          const legacyDb = e.target.result;
          const stores = ['settings', 'entries', 'profiles'].filter(s => legacyDb.objectStoreNames.contains(s));
          if (!stores.length) { localStorage.setItem(flag, '1'); legacyDb.close(); return resolve(_db); }
          Promise.all(stores.map(s => new Promise(res => {
            const r = legacyDb.transaction(s, 'readonly').objectStore(s).getAll();
            r.onsuccess = () => res({ store: s, items: r.result || [] });
            r.onerror = () => res({ store: s, items: [] });
          }))).then(results => {
            const wtx = _db.transaction(stores, 'readwrite');
            results.forEach(({ store, items }) => {
              const os = wtx.objectStore(store);
              items.forEach(it => os.put(it));
            });
            wtx.oncomplete = () => { localStorage.setItem(flag, '1'); legacyDb.close(); resolve(_db); };
            wtx.onerror = () => { legacyDb.close(); resolve(_db); };
          });
        };
      };
      countReq.onerror = () => resolve(_db);
    } catch (e) {
      resolve(_db);
    }
  });
}

const txs   = (s, m = 'readonly') => db.transaction(s, m).objectStore(s);
export const dbGet = (s, k) => new Promise((res, rej) => { const r = txs(s).get(k);        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const dbPut = (s, v) => { if (window.BRAuth) window.BRAuth.assertCanWrite(); return new Promise((res, rej) => { const r = txs(s, 'readwrite').put(v);    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); };
export const dbDel = (s, k) => { if (window.BRAuth) window.BRAuth.assertCanWrite(); return new Promise((res, rej) => { const r = txs(s, 'readwrite').delete(k); r.onsuccess = () => res();         r.onerror = () => rej(r.error); }); };
export const dbAll = (s)    => new Promise((res, rej) => { const r = txs(s).getAll();               r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const dbClr = (s)    => { if (window.BRAuth) window.BRAuth.assertCanWrite(); return new Promise((res, rej) => { const r = txs(s, 'readwrite').clear();   r.onsuccess = () => res();         r.onerror = () => rej(r.error); }); };

/* ── Profile-scoped keys ── */
/* settings key: "settings:{profileId}", entries key prefix: "p{profileId}:" */

/**
 * Get settings for a specific profile.
 * Settings are stored in the 'settings' store with id = profileId.
 */
export function dbGetSettings(profileId) {
  return dbGet('settings', profileId);
}

/**
 * Put settings for a specific profile.
 */
export function dbPutSettings(profileId, data) {
  return dbPut('settings', { ...data, id: profileId });
}

/**
 * Get all entries for a specific profile.
 * Each entry has a `profileId` field.
 */
export function dbGetEntries(profileId) {
  return new Promise((res, rej) => {
    const store = db.transaction('entries', 'readonly').objectStore('entries');
    const results = [];
    const cursor = store.openCursor();
    cursor.onsuccess = e => {
      const c = e.target.result;
      if (!c) { res(results); return; }
      if (c.value.profileId === profileId) results.push(c.value);
      c.continue();
    };
    cursor.onerror = e => rej(e.target.error);
  });
}

/**
 * Put an entry for a specific profile.
 */
export function dbPutEntry(profileId, entry) {
  return dbPut('entries', { ...entry, profileId });
}

/**
 * Delete an entry by id.
 */
export function dbDelEntry(id) {
  return dbDel('entries', id);
}

/**
 * Clear all entries for a specific profile.
 */
export function dbClearEntries(profileId) {
  if (window.BRAuth) window.BRAuth.assertCanWrite();
  return new Promise((res, rej) => {
    const store = db.transaction('entries', 'readwrite').objectStore('entries');
    const toDelete = [];
    const cursor = store.openCursor();
    cursor.onsuccess = e => {
      const c = e.target.result;
      if (!c) {
        // Now delete
        const tx = db.transaction('entries', 'readwrite');
        const st = tx.objectStore('entries');
        let done = 0;
        if (!toDelete.length) { res(); return; }
        toDelete.forEach(id => {
          const r = st.delete(id);
          r.onsuccess = () => { done++; if (done === toDelete.length) res(); };
          r.onerror   = e => rej(e.target.error);
        });
        return;
      }
      if (c.value.profileId === profileId) toDelete.push(c.value.id);
      c.continue();
    };
    cursor.onerror = e => rej(e.target.error);
  });
}

/* ── Profile CRUD ── */
export function dbGetAllProfiles() { return dbAll('profiles'); }
export function dbPutProfile(p)    { return dbPut('profiles', p); }
export function dbDelProfile(id)   { return dbDel('profiles', id); }

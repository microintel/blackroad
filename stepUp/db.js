/* ══════════════════════════════════════════════════════
   db.js — IndexedDB helpers (multi-profile)
══════════════════════════════════════════════════════ */

const DB_NAME = 'sip-compounder', DB_VERSION = 2;
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
  });
}

const txs   = (s, m = 'readonly') => db.transaction(s, m).objectStore(s);
export const dbGet = (s, k) => new Promise((res, rej) => { const r = txs(s).get(k);        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const dbPut = (s, v) => new Promise((res, rej) => { const r = txs(s, 'readwrite').put(v);    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const dbDel = (s, k) => new Promise((res, rej) => { const r = txs(s, 'readwrite').delete(k); r.onsuccess = () => res();         r.onerror = () => rej(r.error); });
export const dbAll = (s)    => new Promise((res, rej) => { const r = txs(s).getAll();               r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const dbClr = (s)    => new Promise((res, rej) => { const r = txs(s, 'readwrite').clear();   r.onsuccess = () => res();         r.onerror = () => rej(r.error); });

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

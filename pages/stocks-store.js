/* ============================================================
   BlackRoad — Stocks IndexedDB Store
   Shared, dependency-free CRUD layer over IndexedDB.
   Used by both /blackroad-dashboard.html and /pages/stocks.html
   so both pages read/write the exact same data.
   ============================================================ */
(function (global) {
  "use strict";

  const DB_NAME_BASE = "BlackRoadDB";
  // Namespaced per signed-in user so two accounts on the same browser never
  // share holdings (see BRAuth.scopeSuffix in ../auth.js).
  const DB_NAME = global.BRAuth ? DB_NAME_BASE + "::" + global.BRAuth.scopeSuffix() : DB_NAME_BASE;
  const DB_VERSION = 1;
  const STORE = "stocks";
  const CHANNEL_NAME = "blackroad-stocks-sync";

  let dbPromise = null;
  let channel = null;
  try {
    channel = ("BroadcastChannel" in global) ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch (e) { channel = null; }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("symbol", "symbol", { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  function store(mode) {
    return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function notify(type, payload) {
    if (channel) { try { channel.postMessage({ type, payload, at: Date.now() }); } catch (e) {} }
    try { global.dispatchEvent(new CustomEvent("stocks:changed", { detail: { type, payload } })); } catch (e) {}
  }

  function onChange(handler) {
    if (channel) channel.onmessage = (e) => handler(e.data);
    global.addEventListener("stocks:changed", (e) => handler(e.detail));
  }

  async function getAll() {
    const s = await store("readonly");
    return new Promise((resolve, reject) => {
      const req = s.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(id) {
    const s = await store("readonly");
    return new Promise((resolve, reject) => {
      const req = s.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function add(stock) {
    if (global.BRAuth) global.BRAuth.assertCanWrite();
    const s = await store("readwrite");
    const now = new Date().toISOString();
    const record = Object.assign({ createdAt: now, updatedAt: now }, stock);
    const id = await new Promise((resolve, reject) => {
      const req = s.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    notify("add", Object.assign({ id }, record));
    return id;
  }

  async function update(id, changes) {
    if (global.BRAuth) global.BRAuth.assertCanWrite();
    const s = await store("readwrite");
    const updated = await new Promise((resolve, reject) => {
      const getReq = s.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return reject(new Error("Stock not found"));
        const merged = Object.assign({}, existing, changes, { id, updatedAt: new Date().toISOString() });
        const putReq = s.put(merged);
        putReq.onsuccess = () => resolve(merged);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    notify("update", updated);
    return updated;
  }

  async function remove(id) {
    if (global.BRAuth) global.BRAuth.assertCanWrite();
    const s = await store("readwrite");
    await new Promise((resolve, reject) => {
      const req = s.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
    notify("remove", { id });
    return true;
  }

  /** Seed the store with defaults, but only if it is completely empty. */
  async function seedIfEmpty(defaults) {
    const rows = await getAll();
    if (rows.length > 0) return rows;
    const s = await store("readwrite");
    const now = new Date().toISOString();
    await Promise.all(defaults.map((d) => new Promise((resolve, reject) => {
      const req = s.add(Object.assign({ createdAt: now, updatedAt: now }, d));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })));
    return getAll();
  }

  function computeMetrics(row) {
    const qty = Number(row.qty) || 0;
    const avgPrice = Number(row.avgPrice) || 0;
    const ltp = Number(row.ltp) || 0;
    const invested = qty * avgPrice;
    const currentValue = qty * ltp;
    const pnl = currentValue - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    return { invested, currentValue, pnl, pnlPct };
  }

  async function getSummary() {
    const rows = await getAll();
    let invested = 0, currentValue = 0;
    rows.forEach((r) => {
      const m = computeMetrics(r);
      invested += m.invested;
      currentValue += m.currentValue;
    });
    const pnl = currentValue - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    return { holdings: rows.length, invested, currentValue, pnl, pnlPct, rows };
  }

  function formatINR(n) {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(Math.round(n));
    return sign + "₹" + abs.toLocaleString("en-IN");
  }

  global.StocksStore = {
    getAll, get, add, update, remove, seedIfEmpty,
    computeMetrics, getSummary, formatINR, onChange
  };
})(window);


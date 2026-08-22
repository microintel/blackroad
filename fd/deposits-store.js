/* ============================================================
   BlackRoad — Fixed Deposits IndexedDB Store
   Shared, dependency-free CRUD layer over IndexedDB.
   Used by both /blackroad-dashboard.html (inlined copy) and
   /pages/fixed-deposits.html so both read/write the exact same
   data, the same way StocksStore does for Stocks.

   Record shape:
     { id, bankName, principal, interestRate, compounding,
       startDate, tenureMonths, notes,
       status: 'active' | 'closed',
       closedDate, closedAmount,
       createdAt, updatedAt }

   compounding: 'quarterly' | 'monthly' | 'yearly' | 'simple'
   (Indian bank FDs compound quarterly by default.)
   ============================================================ */
(function (global) {
  "use strict";

  const DB_NAME = "BlackRoadFD";
  const DB_VERSION = 1;
  const STORE = "deposits";
  const CHANNEL_NAME = "blackroad-deposits-sync";

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
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
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
    try { global.dispatchEvent(new CustomEvent("deposits:changed", { detail: { type, payload } })); } catch (e) {}
  }

  function onChange(handler) {
    if (channel) channel.onmessage = (e) => handler(e.data);
    global.addEventListener("deposits:changed", (e) => handler(e.detail));
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

  async function add(fd) {
    const s = await store("readwrite");
    const now = new Date().toISOString();
    const record = Object.assign({ status: "active", createdAt: now, updatedAt: now }, fd);
    const id = await new Promise((resolve, reject) => {
      const req = s.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    notify("add", Object.assign({ id }, record));
    return id;
  }

  async function update(id, changes) {
    const s = await store("readwrite");
    const updated = await new Promise((resolve, reject) => {
      const getReq = s.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return reject(new Error("Deposit not found"));
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

  /* put() accepts a full record (with or without an id) — used by
     import/restore, mirroring shared.js's putLoan()/putParty() style. */
  async function put(fd) {
    const s = await store("readwrite");
    const now = new Date().toISOString();
    const record = Object.assign({ status: "active", createdAt: now, updatedAt: now }, fd);
    const id = await new Promise((resolve, reject) => {
      const req = s.put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    notify("update", Object.assign({}, record, { id }));
    return id;
  }

  async function remove(id) {
    const s = await store("readwrite");
    await new Promise((resolve, reject) => {
      const req = s.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
    notify("remove", { id });
    return true;
  }

  /* ---------------- Maturity / interest math ---------------- */

  const COMPOUNDS_PER_YEAR = { quarterly: 4, monthly: 12, yearly: 1, simple: 0 };

  function addMonthsISO(dateStr, months) {
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return null;
    d.setMonth(d.getMonth() + Number(months || 0));
    return d.toISOString().slice(0, 10);
  }

  function yearsBetween(fromISO, toISO) {
    const a = new Date(fromISO + "T00:00:00");
    const b = new Date(toISO + "T00:00:00");
    if (isNaN(a) || isNaN(b)) return 0;
    return Math.max(0, (b - a) / (365.25 * 86400000));
  }

  /* Compound (or simple) interest growth of `principal` over `years`
     at `ratePct` % p.a., per the record's compounding frequency. */
  function growAmount(principal, ratePct, years, compounding) {
    const P = Number(principal) || 0;
    const r = Number(ratePct) || 0;
    if (P <= 0 || years <= 0) return P;
    const n = COMPOUNDS_PER_YEAR[compounding] ?? 4;
    if (n === 0) return P * (1 + (r * years) / 100); // simple interest
    return P * Math.pow(1 + r / (100 * n), n * years);
  }

  /* Derived figures for one FD, as of today (or a given ISO date). */
  function computeMetrics(row, asOfISO) {
    const asOf = asOfISO || new Date().toISOString().slice(0, 10);
    const principal = Number(row.principal) || 0;
    const tenureMonths = Number(row.tenureMonths) || 0;
    const compounding = row.compounding || "quarterly";
    const maturityDate = row.startDate ? addMonthsISO(row.startDate, tenureMonths) : null;
    const tenureYears = tenureMonths / 12;
    const maturityAmount = maturityDate
      ? growAmount(principal, row.interestRate, tenureYears, compounding)
      : principal;

    let currentValue;
    let daysToMaturity = null;
    let derivedStatus;

    if (row.status === "closed") {
      currentValue = Number(row.closedAmount) || principal;
      derivedStatus = "closed";
    } else if (maturityDate && asOf >= maturityDate) {
      currentValue = maturityAmount;
      derivedStatus = "matured";
    } else {
      const elapsedYears = row.startDate ? yearsBetween(row.startDate, asOf) : 0;
      currentValue = growAmount(principal, row.interestRate, Math.min(elapsedYears, tenureYears), compounding);
      if (maturityDate) {
        const a = new Date(asOf + "T00:00:00");
        const b = new Date(maturityDate + "T00:00:00");
        daysToMaturity = Math.round((b - a) / 86400000);
      }
      derivedStatus = daysToMaturity !== null && daysToMaturity <= 30 ? "maturing-soon" : "active";
    }

    const interestEarned = currentValue - principal;
    return { maturityDate, maturityAmount, currentValue, interestEarned, daysToMaturity, status: derivedStatus };
  }

  async function getSummary(asOfISO) {
    const rows = await getAll();
    let totalInvested = 0, totalCurrentValue = 0, totalMaturityValue = 0, activeCount = 0;
    let nextMaturity = null;
    rows.forEach((r) => {
      const m = computeMetrics(r, asOfISO);
      if (r.status !== "closed") {
        totalInvested += Number(r.principal) || 0;
        totalCurrentValue += m.currentValue;
        totalMaturityValue += m.maturityAmount;
        activeCount += 1;
        if (m.status !== "closed" && m.maturityDate) {
          if (!nextMaturity || m.maturityDate < nextMaturity.date) {
            nextMaturity = { date: m.maturityDate, bankName: r.bankName || "Fixed Deposit" };
          }
        }
      }
    });
    return {
      count: rows.length, activeCount, totalInvested, totalCurrentValue, totalMaturityValue,
      nextMaturity, rows,
    };
  }

  function formatINR(n) {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(Math.round(n));
    return sign + "₹" + abs.toLocaleString("en-IN");
  }

  global.DepositsStore = {
    getAll, get, add, update, put, remove,
    computeMetrics, getSummary, formatINR, onChange,
    addMonthsISO,
  };
})(window);

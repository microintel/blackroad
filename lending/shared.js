/* =========================================================
   LENDLEDGER — shared.js
   Loaded on every page BEFORE the page-specific script.
   Provides: IndexedDB data layer, formatting utilities,
   toast, and the left-hand navigation / theme system.

   Data model is person-centric (like a khata book): every
   person you lend to or borrow from is a "party" with their
   own running balance, built from a shared pool of "You Gave"
   / "You Got" entries tagged with that party's id.

     balance = totalGave - totalGot
     balance > 0  ->  they owe you (receivable, "will get")
     balance < 0  ->  you owe them (payable, "will give")

   Storage: IndexedDB, database "LendLedger" (v2)
   Stores:
     "parties"  { id, name, phone, note }
     "entries"  { id, partyId, type:'gave'|'got', amount, date, note }
========================================================= */

const DB_NAME_BASE = "LendLedger";
// Namespaced per signed-in user so two accounts on the same browser never
// share people/entries/loans (see BRAuth.scopeSuffix in ../auth.js).
const DB_NAME = window.BRAuth ? DB_NAME_BASE + "::" + BRAuth.scopeSuffix() : DB_NAME_BASE;
const DB_VERSION = 3;
const STORE_PARTIES = "parties";
const STORE_ENTRIES = "entries";
const STORE_LOANS = "loans";

let db = null;

/* ---------------- IndexedDB helpers ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains(STORE_PARTIES)) {
        _db.createObjectStore(STORE_PARTIES, { keyPath: "id", autoIncrement: true });
      }
      if (!_db.objectStoreNames.contains(STORE_ENTRIES)) {
        const es = _db.createObjectStore(STORE_ENTRIES, { keyPath: "id", autoIncrement: true });
        es.createIndex("partyId", "partyId", { unique: false });
      }
      if (!_db.objectStoreNames.contains(STORE_LOANS)) {
        _db.createObjectStore(STORE_LOANS, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
    req.onblocked = () => reject(new Error("Database upgrade blocked — close other tabs of this app and reload."));
  }).then((_db) => migrateLegacyDataOnce(_db));
}

/* One-time migration: the first account to open LendLedger on a given
   browser inherits whatever was already in the old shared (un-namespaced)
   database, so existing data isn't lost by this update. */
function migrateLegacyDataOnce(_db) {
  return new Promise((resolve) => {
    try {
      if (DB_NAME === DB_NAME_BASE) return resolve(_db);
      const flag = "br_migrated::" + DB_NAME;
      if (localStorage.getItem(flag)) return resolve(_db);
      const countReq = _db.transaction(STORE_PARTIES, "readonly").objectStore(STORE_PARTIES).count();
      countReq.onsuccess = () => {
        if (countReq.result > 0) { localStorage.setItem(flag, "1"); return resolve(_db); }
        const legacyReq = indexedDB.open(DB_NAME_BASE);
        legacyReq.onupgradeneeded = (e) => e.target.transaction.abort();
        legacyReq.onerror = () => resolve(_db);
        legacyReq.onsuccess = (e) => {
          const legacyDb = e.target.result;
          const stores = [STORE_PARTIES, STORE_ENTRIES, STORE_LOANS].filter((s) =>
            legacyDb.objectStoreNames.contains(s)
          );
          if (!stores.length) { localStorage.setItem(flag, "1"); legacyDb.close(); return resolve(_db); }
          Promise.all(
            stores.map(
              (s) =>
                new Promise((res) => {
                  const r = legacyDb.transaction(s, "readonly").objectStore(s).getAll();
                  r.onsuccess = () => res({ store: s, items: r.result || [] });
                  r.onerror = () => res({ store: s, items: [] });
                })
            )
          ).then((results) => {
            const wtx = _db.transaction(stores, "readwrite");
            results.forEach(({ store, items }) => {
              const os = wtx.objectStore(store);
              items.forEach((it) => os.put(it));
            });
            wtx.oncomplete = () => { localStorage.setItem(flag, "1"); legacyDb.close(); resolve(_db); };
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

function storeTx(name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

/* -- Parties -- */

function getAllParties() {
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_PARTIES, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putParty(party) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_PARTIES, "readwrite").put(party);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deletePartyDB(id) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_PARTIES, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* -- Entries (You Gave / You Got, tagged with a partyId) -- */

function getAllEntries() {
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_ENTRIES, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putEntry(entry) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_ENTRIES, "readwrite").put(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteEntryDB(id) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_ENTRIES, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteEntriesForParty(partyId) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const store = storeTx(STORE_ENTRIES, "readwrite");
    const idx = store.index("partyId");
    const req = idx.openCursor(IDBKeyRange.only(partyId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

/* -- Loans (bank loans / EMI schedules — not tied to a Person) -- */

function getAllLoans() {
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_LOANS, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putLoan(loan) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_LOANS, "readwrite").put(loan);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteLoanDB(id) {
  if (window.BRAuth) BRAuth.assertCanWrite();
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_LOANS, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Balance math ---------------- */

/* Given a party's own entries, returns { totalGave, totalGot, balance }.
   balance > 0 -> they owe you. balance < 0 -> you owe them. */
function computeBalance(entries) {
  let totalGave = 0, totalGot = 0;
  (entries || []).forEach((e) => {
    if (e.type === "gave") totalGave += Number(e.amount) || 0;
    else totalGot += Number(e.amount) || 0;
  });
  return { totalGave, totalGot, balance: totalGave - totalGot };
}

/* ---------------- Formatting / misc utilities ---------------- */

function fmtMoney(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return "Undated";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function yearOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return "Undated";
  return String(d.getFullYear());
}

/* Adds `months` calendar months to an ISO date string, returns ISO date string. */
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + Number(months || 0));
  return d.toISOString().slice(0, 10);
}

/* Whole days from today until dateStr. Negative = in the past. */
function daysUntil(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------------- Theme system ----------------
   There is no in-app theme switcher. LendLedger follows BlackRoad's
   shared "br-theme" value in localStorage ("light" | "dark") and
   applies it on load — plus stays in sync if it changes in another
   tab/page via the storage event. */

const BR_THEME_KEY = "br-theme";

function getBrTheme() {
  try { return localStorage.getItem(BR_THEME_KEY) || "dark"; }
  catch (e) { return "dark"; }
}

function applyBrTheme() {
  const theme = getBrTheme();
  if (theme === "light") document.documentElement.setAttribute("data-theme", "paper");
  else document.documentElement.removeAttribute("data-theme");
  document.dispatchEvent(new CustomEvent("ll-theme-changed", { detail: { theme } }));
}

window.addEventListener("storage", (e) => {
  if (e.key === BR_THEME_KEY) applyBrTheme();
});

/* ---------------- Left navigation wiring ---------------- */

function initSideNav() {
  const page = document.body.dataset.page;
  document.querySelectorAll(".side-nav-item").forEach((a) => {
    if (a.dataset.page === page) a.classList.add("active");
  });
}

/* ---------- Mobile bottom-tab-bar sheet (More: themes + data tools) ---------- */
function initMobileSheets() {
  const groups = [
    { toggle: document.getElementById("mobileAccountToggle"), sheet: document.getElementById("accountSheet") },
  ].filter((g) => g.toggle && g.sheet);
  if (!groups.length) return;

  let backdrop = document.querySelector(".mobile-nav-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "mobile-nav-backdrop";
    document.body.appendChild(backdrop);
  }

  function closeAll() {
    groups.forEach((g) => g.sheet.classList.remove("mobile-open"));
    backdrop.classList.remove("show");
  }
  function openSheet(sheet) {
    groups.forEach((g) => g.sheet.classList.toggle("mobile-open", g.sheet === sheet));
    backdrop.classList.add("show");
  }

  groups.forEach((g) => {
    g.toggle.addEventListener("click", () => {
      g.sheet.classList.contains("mobile-open") ? closeAll() : openSheet(g.sheet);
    });
  });
  backdrop.addEventListener("click", closeAll);
  document.querySelectorAll(".tool-item").forEach((btn) => {
    btn.addEventListener("click", closeAll);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 900) closeAll();
  });
}

/* ---------- Import / Export (full backup of parties, entries, loans) ----------
   Export bundles every store into one JSON file the user can save anywhere.
   Import wipes current data and restores it from a chosen backup file, so
   people can move the ledger between devices or keep an off-app copy. */
function collectExportPayload() {
  return Promise.all([
    getAllParties(),
    getAllEntries(),
    getAllLoans(),
    window.BRAuth ? BRAuth.currentUser() : Promise.resolve(null),
  ]).then(([parties, entries, loans, owner]) => ({
    app: "LendLedger",
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: owner ? { name: owner.name, email: owner.email } : null,
    parties,
    entries,
    loans,
  }));
}

function exportData() {
  return collectExportPayload()
    .then((payload) => {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lendledger-backup-${todayISO()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Data exported");
    })
    .catch(() => showToast("Export failed"));
}

function importDataFromFile(file) {
  if (!file) return;
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to import data — guest mode is view-only.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      showToast("That file isn't a valid backup");
      return;
    }
    const hasAnyStore =
      data && (Array.isArray(data.parties) || Array.isArray(data.entries) || Array.isArray(data.loans));
    if (!hasAnyStore) {
      showToast("That file isn't a valid backup");
      return;
    }
    const confirmed = window.confirm(
      "Importing will replace all current people, entries and loans with the contents of this backup. This can't be undone. Continue?"
    );
    if (!confirmed) return;

    Promise.all([getAllParties(), getAllEntries(), getAllLoans()])
      .then(([parties, entries, loans]) =>
        Promise.all([
          ...parties.map((p) => deletePartyDB(p.id)),
          ...entries.map((en) => deleteEntryDB(en.id)),
          ...loans.map((l) => deleteLoanDB(l.id)),
        ])
      )
      .then(() =>
        Promise.all([
          ...(data.parties || []).map((p) => putParty(p)),
          ...(data.entries || []).map((en) => putEntry(en)),
          ...(data.loans || []).map((l) => putLoan(l)),
        ])
      )
      .then(() => {
        showToast("Data imported — reloading…");
        setTimeout(() => window.location.reload(), 700);
      })
      .catch(() => showToast("Import failed"));
  };
  reader.readAsText(file);
}

function initImportExport() {
  document.querySelectorAll(".js-export-data").forEach((btn) => {
    btn.addEventListener("click", exportData);
  });

  const fileInput = document.getElementById("importFileInput");
  document.querySelectorAll(".js-import-data").forEach((btn) => {
    btn.addEventListener("click", () => fileInput && fileInput.click());
  });
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      importDataFromFile(file);
      fileInput.value = "";
    });
  }
}

/* ---------- Mobile "Add person" tab ----------
   From any page this hops to the People directory and asks it
   to open the add-person dialog once loaded. */
function initMobileAddPersonTab() {
  const btn = document.getElementById("mobileAddPersonBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const topBtn = document.getElementById("addPersonBtn");
    if (document.body.dataset.page === "people" && topBtn) {
      topBtn.click();
    } else {
      window.location.href = "people.html?addPerson=1";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  applyBrTheme();
  initSideNav();
  initMobileSheets();
  initMobileAddPersonTab();
  initImportExport();
});

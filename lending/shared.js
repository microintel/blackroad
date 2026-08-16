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

const DB_NAME = "LendLedger";
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
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_PARTIES, "readwrite").put(party);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deletePartyDB(id) {
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
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_ENTRIES, "readwrite").put(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteEntryDB(id) {
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_ENTRIES, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteEntriesForParty(partyId) {
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
  return new Promise((resolve, reject) => {
    const req = storeTx(STORE_LOANS, "readwrite").put(loan);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteLoanDB(id) {
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

/* ---------------- Theme system (persisted across every page) ---------------- */

const THEME_KEY = "ll-theme";

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || "soft"; }
  catch (e) { return "soft"; }
}

function applyTheme(theme) {
  if (theme === "soft") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  document.querySelectorAll(".swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  document.dispatchEvent(new CustomEvent("ll-theme-changed", { detail: { theme } }));
}

/* ---------------- Left navigation wiring ---------------- */

function initSideNav() {
  const page = document.body.dataset.page;
  document.querySelectorAll(".side-nav-item").forEach((a) => {
    if (a.dataset.page === page) a.classList.add("active");
  });
  document.querySelectorAll(".swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === getStoredTheme());
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
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
  document.querySelectorAll(".swatch, .tool-item").forEach((btn) => {
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
  return Promise.all([getAllParties(), getAllEntries(), getAllLoans()]).then(
    ([parties, entries, loans]) => ({
      app: "LendLedger",
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      parties,
      entries,
      loans,
    })
  );
}

function exportData() {
  collectExportPayload()
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
  initSideNav();
  initMobileSheets();
  initMobileAddPersonTab();
  initImportExport();
});

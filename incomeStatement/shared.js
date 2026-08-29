/* =========================================================
   BLACKROAD — shared.js
   Loaded on every page BEFORE the page-specific script.
   Provides: IndexedDB data layer, formatting utilities,
   toast, and the left-hand navigation / theme system so all
   pages (dashboard, search, jump-to, import/export, and any
   future page) stay in sync.
   Storage: IndexedDB, database "BlackRoad2"
   Store:   "entries"  { id, income, date, from, expense, balance, transactions:[] }
   Store:   "meta"     { key, value } — e.g. { key:"updateDate", value:"2026-08-17" }
                       (keyPath "key", so it round-trips through the
                       whole-app backup/export on the main dashboard
                       the same way every other store does)
========================================================= */

const DB_NAME = "BlackRoad2";
const DB_VERSION = 3;
const STORE = "entries";
const META_STORE = "meta";

let db = null;

/* ---------------- IndexedDB helpers ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains(STORE)) {
        _db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
      // recreate "meta" with an in-line keyPath (older builds created it as
      // an out-of-line store, which can't be dumped by the generic backup)
      if (_db.objectStoreNames.contains(META_STORE)) {
        _db.deleteObjectStore(META_STORE);
      }
      _db.createObjectStore(META_STORE, { keyPath: "key" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function metaTx(mode) {
  return db.transaction(META_STORE, mode).objectStore(META_STORE);
}

function getAllEntries() {
  return new Promise((resolve, reject) => {
    const req = tx("readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putEntry(entry) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").put(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteEntryDB(id) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function clearAllDB() {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Income & Expenditure "last updated" date ----------------
   A single global date (not tied to any one entry) recording when the
   ledger was last brought up to date. Set from the Statement toolbar,
   shown on the dashboard. Persisted in the "meta" IndexedDB store. */

const UPDATE_DATE_KEY = "updateDate";

function getUpdateDate() {
  return new Promise((resolve, reject) => {
    const req = metaTx("readonly").get(UPDATE_DATE_KEY);
    req.onsuccess = () => resolve(req.result ? req.result.value : "");
    req.onerror = () => reject(req.error);
  });
}

function setUpdateDate(dateStr) {
  return new Promise((resolve, reject) => {
    const req = metaTx("readwrite").put({ key: UPDATE_DATE_KEY, value: dateStr });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function clearMetaDB() {
  return new Promise((resolve, reject) => {
    const req = metaTx("readwrite").clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function fmtUpdateDate(dateStr) {
  if (!dateStr) return "Not set";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return "Not set";
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
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

function monthAnchorId(year, label) {
  return "m-" + (year + "-" + label).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function recalcEntry(entry) {
  const totalExpense = (entry.transactions || []).reduce(
    (sum, t) => sum + (Number(t.amount) || 0), 0
  );
  entry.expense = totalExpense;
  entry.balance = (Number(entry.income) || 0) - totalExpense;
  return entry;
}

/* ---------------- Predefined expense categories ----------------
   Curated defaults offered in the category picker when adding an
   expense. People can still type their own via "Others" — this list
   isn't a restriction, just a fast start so most entries need zero
   typing. Kept in shared.js so any future page can reuse the same set. */

const DEFAULT_CATEGORIES = [
  "Apparel", "Baby", "Bakery / Pups", "Bank", "Beauty", "Borrow", "Bigbasket",
  "Biscuit", "Blinkit", "Brother / Sister", "Car", "Clothing", "Donate",
  "Dividend", "Drink / Juices", "Education", "Egg", "Electronics",
  "Entertainment", "Family", "FD", "Food", "Friends", "Gift", "Health",
  "Help", "Home", "Housing", "Little Heart", "Milk / Bread / Curd", "Mobile",
  "Mother / Dad", "Movie", "Mutual Fund", "Official Documents", "Party",
  "Personal Care", "Pet", "Penalty", "Recharges", "Receivable", "Repair",
  "Samosa / Outside Food", "Self", "Service", "Shopping", "Snacks", "SIP",
  "Stock", "Social", "Sport", "Style / Fashion", "Swiggy", "Tax",
  "Telephone", "Tiffin / Lunch / Parlour", "Tour", "Transportation",
  "Travel", "Vehicle", "Wine / Cigarette", "Zomato", "Zepto", "Others",
];

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

/* ---------------- Search matching (shared by dashboard + search page) ---------------- */

function matchesSearch(entry, term) {
  if (!term) return { entryMatch: true, txnMatches: entry.transactions || [] };
  const t = term.toLowerCase();
  const entryMatch = (entry.from || "").toLowerCase().includes(t);
  const txnMatches = (entry.transactions || []).filter((tr) =>
    (tr.description || "").toLowerCase().includes(t) ||
    (tr.category || "").toLowerCase().includes(t)
  );
  return { entryMatch, txnMatches };
}

/* ---------------- Theme system (persisted across every page) ----------------
   There is no in-app theme picker — the theme is fixed by whatever is
   stored under "br-theme" in localStorage ("dark" or "light"), the
   same key/values written by the theme toggle on the root
   blackroad-dashboard.html, so switching it there carries over here.
   The <head> of every page carries a tiny inline script that applies
   it immediately, before first paint; this just keeps it available
   for any other code on the page that needs the current value. */

const THEME_KEY = "br-theme";

function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || "dark"; }
  catch (e) { return "dark"; }
}

/* ---------------- Left navigation wiring ---------------- */

function initSideNav() {
  const page = document.body.dataset.page;
  document.querySelectorAll(".side-nav-item").forEach((a) => {
    if (a.dataset.page === page) a.classList.add("active");
  });
}

/* ---------- Mobile bottom-tab-bar sheet (Tools) ----------
   On phones, Search / Jump to / Import & Export live behind the
   "Tools" tab in the bottom bar, instead of sitting inline in the
   rail. There is no theme picker anywhere — the theme is fixed by
   the stored "br-theme" value — and the bottom bar no longer carries
   a Home tab; the fixed top-left back button (.dashboard-back-btn,
   present on every page, every screen size) is the way back to the
   BlackRoad dashboard. */
function initMobileSheets() {
  const groups = [
    { toggle: document.getElementById("mobileToolsToggle"), sheet: document.getElementById("toolsSheet") },
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

/* ---------- Mobile "Add income" tab ----------
   Income entries and expenses now live on the Statement page. On
   the Statement page itself this just triggers the same dialog as
   the (now mobile-hidden) top button. From any other page it hops
   to the Statement page and asks it to open the dialog once loaded. */
function initMobileAddIncomeTab() {
  const btn = document.getElementById("mobileAddIncomeBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const topBtn = document.getElementById("addIncomeBtn");
    if (document.body.dataset.page === "statement" && topBtn) {
      topBtn.click();
    } else {
      window.location.href = "statement.html?addIncome=1";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initSideNav();
  initMobileSheets();
  initMobileAddIncomeTab();
});

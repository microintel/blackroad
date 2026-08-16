/* =========================================================
   BLACKROAD — shared.js
   Loaded on every page BEFORE the page-specific script.
   Provides: IndexedDB data layer, formatting utilities,
   toast, and the left-hand navigation / theme system so all
   pages (dashboard, search, jump-to, import/export, and any
   future page) stay in sync.
   Storage: IndexedDB, database "BlackRoad2"
   Store:   "entries"  { id, income, date, from, expense, balance, transactions:[] }
========================================================= */

const DB_NAME = "BlackRoad2";
const DB_VERSION = 1;
const STORE = "entries";

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
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
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
   The <head> of every page also carries a tiny inline script that applies
   the stored theme immediately, before first paint — this handler keeps
   the swatch buttons in sync and re-applies on click. */

const THEME_KEY = "br-theme";

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
  document.dispatchEvent(new CustomEvent("br-theme-changed", { detail: { theme } }));
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

/* ---------- Mobile bottom-tab-bar sheet (Tools) ----------
   On phones, Search / Jump to / Import & Export — and the theme
   swatches — live behind the "Tools" tab in the bottom bar, instead
   of sitting inline in the rail. The old "Account" tab is now a
   plain link back to the BlackRoad dashboard (see initMobileAddIncomeTab
   area / mobileHomeLink in the markup), so it no longer opens a sheet. */
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
  document.querySelectorAll(".swatch, .tool-item").forEach((btn) => {
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

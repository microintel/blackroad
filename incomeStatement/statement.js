/* =========================================================
   BLACKROAD — statement.js (the full income/expense ledger)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   This page owns all entry/transaction CRUD — the dashboard
   (app.js) is read-only and just shows summary totals.
========================================================= */

/* ---------------- Rendering ---------------- */

let ENTRIES = []; // in-memory cache, refreshed from DB after every mutation
let openIds = new Set(); // which entries are expanded
let searchTerm = "";
let dateFrom = "";
let dateTo = "";
let openYears = null; // Set of year-strings that are expanded; null = not yet initialized
let yearsSeen = new Set(); // tracks which years we've already auto-decided open state for

async function refresh() {
  ENTRIES = await getAllEntries();
  ENTRIES.sort((a, b) => new Date(b.date) - new Date(a.date));
  renderLedger();
}

function inDateRange(dateStr) {
  if (!dateFrom && !dateTo) return true;
  if (!dateStr) return false;
  if (dateFrom && dateStr < dateFrom) return false;
  if (dateTo && dateStr > dateTo) return false;
  return true;
}

function renderLedger() {
  const body = document.getElementById("ledgerBody");
  const statusEl = document.getElementById("searchStatus");

  let visible = ENTRIES;
  let matchCount = 0;
  const hasDateFilter = !!(dateFrom || dateTo);

  if (searchTerm || hasDateFilter) {
    visible = [];
    ENTRIES.forEach((e) => {
      const { entryMatch, txnMatches } = matchesSearch(e, searchTerm);
      const passesSearch = entryMatch || txnMatches.length > 0;
      const passesDate = inDateRange(e.date) ||
        (e.transactions || []).some((t) => inDateRange(t.date));
      if (passesSearch && passesDate) {
        visible.push(e);
        matchCount++;
        if (searchTerm && !entryMatch && txnMatches.length > 0) openIds.add(e.id); // reveal matching txns
      }
    });
    if (searchTerm) {
      statusEl.style.display = "block";
      statusEl.textContent = matchCount === 0
        ? `No matches for "${searchTerm}"`
        : `${matchCount} entr${matchCount === 1 ? "y" : "ies"} match "${searchTerm}"`;
    } else {
      statusEl.style.display = "none";
    }
  } else {
    statusEl.style.display = "none";
  }

  if (ENTRIES.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-piggy-bank"></i></span>
        <h3>Your ledger is empty</h3>
        <p>Log your first income entry to start tracking what comes in, what goes out, and what's left.</p>
        <button class="add-income-btn" onclick="document.getElementById('addIncomeBtn').click()"><i class="bi bi-plus-lg"></i> Add income</button>
      </div>`;
    return;
  }

  if ((searchTerm || hasDateFilter) && visible.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-search"></i></span>
        <h3>No matches</h3>
        <p>Nothing in your ledger matches ${searchTerm ? `"${escapeHTML(searchTerm)}"` : "this date range"}. Try a different ${searchTerm ? "source, description, or category" : "range"}.</p>
      </div>`;
    return;
  }

  // group by year, then by month within each year
  const years = new Map(); // year -> Map(monthLabel -> entries[])
  visible.forEach((e) => {
    const y = yearOf(e.date);
    const label = monthLabel(e.date);
    if (!years.has(y)) years.set(y, new Map());
    const monthMap = years.get(y);
    if (!monthMap.has(label)) monthMap.set(label, []);
    monthMap.get(label).push(e);
  });

  // decide default open/closed state for years we haven't seen before
  // (most recent year open by default, older years collapsed)
  if (openYears === null) openYears = new Set();
  const sortedYearKeys = [...years.keys()];
  sortedYearKeys.forEach((y, idx) => {
    if (!yearsSeen.has(y)) {
      yearsSeen.add(y);
      if (idx === 0) openYears.add(y); // newest year, since ENTRIES sorted desc
    }
  });

  let html = "";
  for (const [year, monthMap] of years) {
    let yIncome = 0, yExpense = 0, yInvestment = 0, yCount = 0;
    monthMap.forEach((entries) => {
      entries.forEach((e) => {
        yIncome += Number(e.income) || 0;
        yExpense += Number(e.expense) || 0;
        yInvestment += Number(e.investment) || 0;
        yCount += (e.transactions || []).length;
      });
    });
    const isOpen = openYears.has(year);
    html += `<div class="year-group ${isOpen ? "open" : ""}" data-year="${year}">
      <div class="year-header" onclick="toggleYear('${year}')">
        <span class="year-caret"><i class="bi bi-chevron-right"></i></span>
        <span class="year-title">${year}</span>
        <span class="year-summary">
          <span class="yin">+${fmtMoney(yIncome)}</span>
          <span class="yout">-${fmtMoney(yExpense)}</span>
          ${yInvestment > 0 ? `<span class="yinv">${fmtMoney(yInvestment)} inv</span>` : ""}
          <span>${yCount} txn${yCount === 1 ? "" : "s"}</span>
        </span>
      </div>
      <div class="year-body">`;
    for (const [label, entries] of monthMap) {
      const monthId = monthAnchorId(year, label);
      html += `<div class="month-group" id="${monthId}">
        <div class="month-label">${label}</div>
        <div class="spine">`;
      entries.forEach((e) => { html += renderEntry(e); });
      html += `</div></div>`;
    }
    html += `</div></div>`;
  }
  body.innerHTML = html;
}

function toggleYear(year) {
  if (openYears.has(year)) openYears.delete(year); else openYears.add(year);
  renderLedger();
}

function renderEntry(e) {
  const isOpen = openIds.has(e.id);
  const txns = e.transactions || [];
  const balanceClass = e.balance <= 0 ? "zero" : "";

  let txnHTML = "";
  if (txns.length === 0) {
    txnHTML = `<div class="no-txns">No expenses logged against this entry</div>`;
  } else {
    txns.forEach((t) => {
      txnHTML += `
        <div class="txn-row">
          <span class="txn-ico"><i class="bi bi-dot"></i></span>
          <div class="txn-amt">${fmtMoney(t.amount)}</div>
          <div class="txn-date">${t.date || ""}</div>
          <div class="txn-desc">
            ${escapeHTML(t.description || "Expense")}
            ${t.category ? `<span class="cat${isInvestmentCategory(t.category) ? " inv" : ""}">${escapeHTML(t.category)}</span>` : ""}
          </div>
          <div class="entry-actions">
            <button class="icon-btn" title="Edit" onclick="event.stopPropagation(); openTxnDialog(${e.id}, '${t.id}')"><i class="bi bi-pencil"></i></button>
            <button class="icon-btn danger" title="Delete" onclick="event.stopPropagation(); confirmDeleteTxn(${e.id}, '${t.id}')"><i class="bi bi-trash3"></i></button>
          </div>
        </div>`;
    });
  }

  return `
    <div class="entry ${isOpen ? "open" : ""}" data-id="${e.id}">
      <div class="entry-card">
        <div class="entry-head" onclick="toggleEntry(${e.id})">
          <div class="entry-row-top">
            <div class="entry-from">${escapeHTML(e.from || "Income")}</div>
            <div class="entry-income">+${fmtMoney(e.income)}</div>
            <div class="entry-actions">
              <button class="icon-btn add" title="Add expense" onclick="event.stopPropagation(); openTxnDialog(${e.id})"><i class="bi bi-plus-lg"></i></button>
            </div>
          </div>
          <div class="entry-row-bottom">
            <div class="entry-date">${e.date || ""}</div>
            <div class="entry-meta-pills">
              <span class="entry-expense">-${fmtMoney(e.expense)}</span>
              ${Number(e.investment) > 0 ? `<span class="entry-investment">${fmtMoney(e.investment)} inv</span>` : ""}
              <span class="entry-balance ${balanceClass}">${fmtMoney(e.balance)}</span>
            </div>
          </div>
        </div>
        <div class="entry-body">
          <div class="entry-body-actions">
            <button class="body-action-btn" type="button" onclick="event.stopPropagation(); openIncomeDialog(${e.id})"><i class="bi bi-pencil"></i> Edit income</button>
            <button class="body-action-btn danger" type="button" onclick="event.stopPropagation(); confirmDeleteEntry(${e.id})"><i class="bi bi-trash3"></i> Delete entry</button>
          </div>
          ${txnHTML}
          <button class="add-txn-btn" type="button" onclick="openTxnDialog(${e.id})"><i class="bi bi-plus-lg"></i> Add expense from this entry</button>
        </div>
      </div>
    </div>`;
}

function toggleEntry(id) {
  if (openIds.has(id)) openIds.delete(id); else openIds.add(id);
  renderLedger();
}

/* ---------------- Dialog wiring ---------------- */

function openDialog(id) { document.getElementById(id).showModal(); }
function closeDialog(id) { document.getElementById(id).close(); }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.dataset.close));
});

/* -- Income dialog -- */
let editingIncomeId = null;

function openIncomeDialog(id) {
  editingIncomeId = id || null;
  const title = document.getElementById("incomeDialogTitle");
  const form = document.getElementById("incomeForm");
  form.reset();
  document.getElementById("incDate").value = todayISO();

  if (id) {
    const e = ENTRIES.find((x) => x.id === id);
    title.textContent = "Edit income";
    document.getElementById("incAmount").value = e.income;
    document.getElementById("incFrom").value = e.from;
    document.getElementById("incDate").value = e.date;
  } else {
    title.textContent = "Add income";
  }
  openDialog("incomeDialog");
}

document.getElementById("addIncomeBtn").addEventListener("click", () => openIncomeDialog(null));

document.getElementById("incomeForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to save income — guest mode is view-only.");
    closeDialog("incomeDialog");
    return;
  }
  const amount = parseFloat(document.getElementById("incAmount").value) || 0;
  const from = document.getElementById("incFrom").value.trim();
  const date = document.getElementById("incDate").value;

  if (editingIncomeId) {
    const e = ENTRIES.find((x) => x.id === editingIncomeId);
    e.income = amount;
    e.from = from;
    e.date = date;
    recalcEntry(e);
    await putEntry(e);
    showToast("Income entry updated");
  } else {
    const entry = recalcEntry({ income: amount, from, date, expense: 0, transactions: [] });
    await putEntry(entry);
    showToast("Income entry added");
  }
  closeDialog("incomeDialog");
  editingIncomeId = null;
  await refresh();
});

/* -- Transaction dialog -- */
let txnContext = { entryId: null, txnId: null };

const txnCategorySelect = document.getElementById("txnCategorySelect");
const txnCategoryInput  = document.getElementById("txnCategory");

// Populate the predefined category dropdown once at load time.
DEFAULT_CATEGORIES.forEach((cat) => {
  const opt = document.createElement("option");
  opt.value = cat;
  opt.textContent = cat;
  txnCategorySelect.appendChild(opt);
});
const CUSTOM_OPTION_VALUE = "__custom__";
(() => {
  const opt = document.createElement("option");
  opt.value = CUSTOM_OPTION_VALUE;
  opt.textContent = "Other (type your own)…";
  txnCategorySelect.appendChild(opt);
})();

function setCategoryPicker(value) {
  const trimmed = (value || "").trim();
  const isPreset = DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === trimmed.toLowerCase());
  if (!trimmed) {
    txnCategorySelect.value = "";
    txnCategoryInput.style.display = "none";
    txnCategoryInput.value = "";
  } else if (isPreset) {
    const match = DEFAULT_CATEGORIES.find((c) => c.toLowerCase() === trimmed.toLowerCase());
    txnCategorySelect.value = match;
    txnCategoryInput.style.display = "none";
    txnCategoryInput.value = match;
  } else {
    txnCategorySelect.value = CUSTOM_OPTION_VALUE;
    txnCategoryInput.style.display = "block";
    txnCategoryInput.value = trimmed;
  }
}

txnCategorySelect.addEventListener("change", () => {
  if (txnCategorySelect.value === CUSTOM_OPTION_VALUE) {
    txnCategoryInput.style.display = "block";
    txnCategoryInput.value = "";
    txnCategoryInput.focus();
  } else {
    txnCategoryInput.style.display = "none";
    txnCategoryInput.value = txnCategorySelect.value;
  }
});

function openTxnDialog(entryId, txnId) {
  txnContext = { entryId, txnId: txnId || null };
  const form = document.getElementById("txnForm");
  form.reset();
  document.getElementById("txnDate").value = todayISO();
  setCategoryPicker("");
  const title = document.getElementById("txnDialogTitle");

  if (txnId) {
    const e = ENTRIES.find((x) => x.id === entryId);
    const t = (e.transactions || []).find((x) => x.id === txnId);
    title.textContent = "Edit expense";
    document.getElementById("txnAmount").value = t.amount;
    document.getElementById("txnDesc").value = t.description;
    document.getElementById("txnDate").value = t.date;
    setCategoryPicker(t.category);
  } else {
    title.textContent = "Add expense";
  }
  openDialog("txnDialog");
}

document.getElementById("txnForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to save expenses — guest mode is view-only.");
    closeDialog("txnDialog");
    return;
  }
  const amount = parseFloat(document.getElementById("txnAmount").value) || 0;
  const description = document.getElementById("txnDesc").value.trim();
  const category = txnCategorySelect.value === CUSTOM_OPTION_VALUE
    ? txnCategoryInput.value.trim()
    : txnCategorySelect.value;
  const date = document.getElementById("txnDate").value;

  const e = ENTRIES.find((x) => x.id === txnContext.entryId);
  if (!e.transactions) e.transactions = [];

  const kind = isInvestmentCategory(category) ? "Investment" : "Expense";
  if (txnContext.txnId) {
    const t = e.transactions.find((x) => x.id === txnContext.txnId);
    Object.assign(t, { amount, description, category, date });
    showToast(kind + " updated");
  } else {
    e.transactions.push({ id: uid(), amount, description, category, date, type: "expense" });
    showToast(kind + " added");
  }
  recalcEntry(e);
  await putEntry(e);
  closeDialog("txnDialog");
  await refresh();
});

/* -- Confirm delete dialog (shared) -- */
let pendingDelete = null; // { type: 'entry'|'txn', entryId, txnId }

function confirmDeleteEntry(entryId) {
  const e = ENTRIES.find((x) => x.id === entryId);
  pendingDelete = { type: "entry", entryId };
  document.getElementById("confirmTitle").textContent = "Delete this income entry?";
  document.getElementById("confirmBody").textContent =
    `This removes "${e.from}" and its ${((e.transactions || []).length)} linked expense(s). This can't be undone.`;
  openDialog("confirmDialog");
}

function confirmDeleteTxn(entryId, txnId) {
  pendingDelete = { type: "txn", entryId, txnId };
  document.getElementById("confirmTitle").textContent = "Delete this expense?";
  document.getElementById("confirmBody").textContent = "This can't be undone.";
  openDialog("confirmDialog");
}

document.getElementById("confirmYesBtn").addEventListener("click", async () => {
  if (!pendingDelete) return;
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to delete entries — guest mode is view-only.");
    pendingDelete = null;
    closeDialog("confirmDialog");
    return;
  }
  if (pendingDelete.type === "entry") {
    await deleteEntryDB(pendingDelete.entryId);
    showToast("Entry deleted");
  } else {
    const e = ENTRIES.find((x) => x.id === pendingDelete.entryId);
    e.transactions = (e.transactions || []).filter((t) => t.id !== pendingDelete.txnId);
    recalcEntry(e);
    await putEntry(e);
    showToast("Expense deleted");
  }
  pendingDelete = null;
  closeDialog("confirmDialog");
  await refresh();
});

/* ---------------- Date range filter ---------------- */

const dateFromInput = document.getElementById("dateFrom");
const dateToInput = document.getElementById("dateTo");
const dateFilterClear = document.getElementById("dateFilterClear");

function updateDateFilterClearVisibility() {
  dateFilterClear.style.display = (dateFrom || dateTo) ? "block" : "none";
}

dateFromInput.addEventListener("change", () => {
  dateFrom = dateFromInput.value;
  updateDateFilterClearVisibility();
  renderLedger();
});
dateToInput.addEventListener("change", () => {
  dateTo = dateToInput.value;
  updateDateFilterClearVisibility();
  renderLedger();
});
dateFilterClear.addEventListener("click", () => {
  dateFrom = ""; dateTo = "";
  dateFromInput.value = ""; dateToInput.value = "";
  updateDateFilterClearVisibility();
  renderLedger();
});

/* ---------------- Collapse all / expand entries ---------------- */

function collapseAllEntries() {
  openIds.clear();
  renderLedger();
  showToast("All entries collapsed");
}
document.getElementById("collapseAllBtn").addEventListener("click", collapseAllEntries);

/* ---------------- Income & Expenditure "updated last date" ---------------- */

const updateDateInput = document.getElementById("updateDateInput");
updateDateInput.addEventListener("change", async () => {
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to save changes — guest mode is view-only.");
    return;
  }
  await setUpdateDate(updateDateInput.value);
  showToast("Update date saved");
});

/* ---------------- Sticky toolbar height tracking ----------------
   Keeps the year/month sticky headers positioned just below the
   ledger toolbar (head + quick stats + search + filters), whose
   height varies with content and viewport width. */

function updateToolbarHeight() {
  const toolbar = document.querySelector(".ledger-toolbar");
  if (!toolbar) return;
  document.documentElement.style.setProperty("--toolbar-h", toolbar.offsetHeight + "px");
}
window.addEventListener("resize", updateToolbarHeight);
if (window.ResizeObserver) {
  new ResizeObserver(updateToolbarHeight).observe(document.querySelector(".ledger-toolbar"));
}

/* ---------------- Boot ---------------- */

function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  const openId = params.get("open");
  const jumpAnchor = params.get("jump");
  const addIncome = params.get("addIncome");

  if (addIncome) {
    openIncomeDialog(null);
    const url = new URL(window.location);
    url.searchParams.delete("addIncome");
    window.history.replaceState({}, "", url);
  }

  if (openId) {
    const idNum = Number(openId);
    const e = ENTRIES.find((x) => x.id === idNum);
    if (e) {
      openIds.add(idNum);
      if (openYears) openYears.add(yearOf(e.date));
      renderLedger();
      requestAnimationFrame(() => {
        const el = document.querySelector(`.entry[data-id="${idNum}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  } else if (jumpAnchor) {
    const yearKey = jumpAnchor.split("-")[1]; // "m-2026-august" -> "2026"
    if (yearKey && openYears) openYears.add(yearKey);
    renderLedger();
    requestAnimationFrame(() => {
      const el = document.getElementById(jumpAnchor);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

(async function init() {
  try {
    db = await openDB();
    await refresh();
    updateDateInput.value = await getUpdateDate();
    updateToolbarHeight();
    handleDeepLink();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

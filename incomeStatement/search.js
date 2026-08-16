/* =========================================================
   BLACKROAD — search.js
   Search page: search input + filters (source, category,
   date range) + summary + matching results + PDF export.
   Filters read their option lists straight from the
   IndexedDB entries (via shared.js) — no file upload needed.
   Depends on shared.js for the DB layer, formatting
   utilities and matchesSearch().
========================================================= */

let ENTRIES = [];
let FILTERS = { sources: [], categories: [], fromDate: "", toDate: "" };

const searchInput = document.getElementById("searchInput");
const searchClear = document.getElementById("searchClear");
const searchStatus = document.getElementById("searchStatus");
const resultsEl = document.getElementById("searchResults");
const summaryEl = document.getElementById("searchSummary");

const filterToggle = document.getElementById("filterToggle");
const filterPanel = document.getElementById("filterPanel");
const filterSourceEl = document.getElementById("filterSource");
const filterCategoryEl = document.getElementById("filterCategory");
const filterFromEl = document.getElementById("filterFrom");
const filterToEl = document.getElementById("filterTo");
const filterApplyBtn = document.getElementById("filterApply");
const filterClearBtn = document.getElementById("filterClear");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");

const norm = (v) => (v || "").toLowerCase().trim();

/* ---------------- Build chip-based filter pickers from IndexedDB entries ----------------
   Each option is a tappable pill (not a native <select multiple>, which is
   awkward on mobile) — tap to toggle, any number can be active at once. */

const pendingSources = new Set();
const pendingCategories = new Set();

function buildChipGroup(container, values, pendingSet) {
  container.innerHTML = "";
  if (!values.length) {
    container.innerHTML = `<span class="chip-empty">None yet</span>`;
    return;
  }
  values.forEach((v) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (pendingSet.has(v) ? " active" : "");
    chip.textContent = v;
    chip.dataset.value = v;
    chip.addEventListener("click", () => {
      if (pendingSet.has(v)) pendingSet.delete(v); else pendingSet.add(v);
      chip.classList.toggle("active");
    });
    container.appendChild(chip);
  });
}

function populateFilterOptions() {
  const sources = new Set();
  const categories = new Set();
  ENTRIES.forEach((e) => {
    if (e.from) sources.add(e.from);
    (e.transactions || []).forEach((t) => { if (t.category) categories.add(t.category); });
  });
  buildChipGroup(filterSourceEl, [...sources].sort(), pendingSources);
  buildChipGroup(filterCategoryEl, [...categories].sort(), pendingCategories);
}

/* ---------------- Combined search + filter matching ---------------- */

// Transactions to show/sum for an entry, given the current term + filters.
function matchingTxns(entry, term) {
  let txns = entry.transactions || [];
  if (FILTERS.categories.length) {
    txns = txns.filter((t) => FILTERS.categories.some((c) => norm(t.category).includes(norm(c))));
  }
  if (term) {
    const entryNameMatch = norm(entry.from).includes(term);
    if (!entryNameMatch) {
      txns = txns.filter((t) => norm(t.description).includes(term) || norm(t.category).includes(term));
    }
  }
  return txns;
}

function getFilteredEntries(term) {
  const fTime = FILTERS.fromDate ? new Date(FILTERS.fromDate).setHours(0, 0, 0, 0) : null;
  const tTime = FILTERS.toDate ? new Date(FILTERS.toDate).setHours(23, 59, 59, 999) : null;

  return ENTRIES.filter((entry) => {
    if (fTime && tTime) {
      const recordTime = new Date(entry.date).getTime();
      if (!(recordTime >= fTime && recordTime <= tTime)) return false;
    }
    if (FILTERS.sources.length && !FILTERS.sources.some((s) => norm(entry.from).includes(norm(s)))) {
      return false;
    }
    if (term) {
      const entryMatch = norm(entry.from).includes(term);
      const txnMatch = matchingTxns(entry, term).length > 0;
      if (!entryMatch && !txnMatch) return false;
    }
    if (FILTERS.categories.length && matchingTxns(entry, term).length === 0) {
      return false;
    }
    return true;
  });
}

function hasActiveFilters() {
  return FILTERS.sources.length || FILTERS.categories.length || FILTERS.fromDate || FILTERS.toDate;
}

/* ---------------- Summary ---------------- */

function renderSummary(entries, term) {
  let income = 0, expense = 0, txnCount = 0;
  entries.forEach((e) => {
    income += Number(e.income) || 0;
    matchingTxns(e, term).forEach((t) => { expense += Number(t.amount) || 0; txnCount++; });
  });
  const balance = income - expense;
  summaryEl.innerHTML = `
    <div class="sm-item"><span class="sm-label">Entries</span><span class="sm-val">${entries.length}</span></div>
    <div class="sm-item"><span class="sm-label">Transactions</span><span class="sm-val">${txnCount}</span></div>
    <div class="sm-item"><span class="sm-label">Income</span><span class="sm-val">${fmtMoney(income)}</span></div>
    <div class="sm-item"><span class="sm-label">Expense</span><span class="sm-val">${fmtMoney(expense)}</span></div>
    <div class="sm-item"><span class="sm-label">Balance</span><span class="sm-val">${fmtMoney(balance)}</span></div>
  `;
  summaryEl.classList.add("show");
}

/* ---------------- Results ---------------- */

function renderResults() {
  const rawTerm = searchInput.value.trim();
  const term = norm(rawTerm);
  const active = rawTerm || hasActiveFilters();

  if (!active) {
    resultsEl.innerHTML = "";
    searchStatus.style.display = "none";
    summaryEl.classList.remove("show");
    downloadPdfBtn.style.display = "none";
    return;
  }

  const entries = getFilteredEntries(term);

  searchStatus.style.display = "block";
  searchStatus.textContent = entries.length === 0
    ? (rawTerm ? `No matches for "${rawTerm}"` : "No entries match these filters")
    : `${entries.length} entr${entries.length === 1 ? "y" : "ies"} match`;

  if (entries.length === 0) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-search"></i></span>
        <h3>No matches</h3>
        <p>Nothing in your ledger matches${rawTerm ? ` "${escapeHTML(rawTerm)}"` : " these filters"}. Try different terms or filters.</p>
      </div>`;
    summaryEl.classList.remove("show");
    downloadPdfBtn.style.display = "none";
    return;
  }

  renderSummary(entries, term);
  downloadPdfBtn.style.display = "inline-flex";

  resultsEl.innerHTML = entries.map((entry) => {
    const entryMatch = !rawTerm || norm(entry.from).includes(term);
    const txns = matchingTxns(entry, term);
    const showTxns = !entryMatch || FILTERS.categories.length > 0;
    const balanceClass = entry.balance <= 0 ? "zero" : "";
    let txnHTML = "";
    if (showTxns) {
      txnHTML = txns.map((t) => `
        <div class="txn-row">
          <span class="txn-ico"><i class="bi bi-dot"></i></span>
          <div class="txn-amt">${fmtMoney(t.amount)}</div>
          <div class="txn-date">${t.date || ""}</div>
          <div class="txn-desc">
            ${escapeHTML(t.description || "Expense")}
            ${t.category ? `<span class="cat">${escapeHTML(t.category)}</span>` : ""}
          </div>
        </div>`).join("");
    }
    return `
      <div class="entry open" style="margin-bottom:10px;">
        <div class="entry-card">
          <div class="entry-head" style="cursor:default;">
            <div class="entry-row-top">
              <div class="entry-from">${escapeHTML(entry.from || "Income")}</div>
              <div class="entry-income">+${fmtMoney(entry.income)}</div>
              <div class="entry-actions">
                <a class="result-open-link" href="statement.html?open=${entry.id}">Open <i class="bi bi-box-arrow-up-right"></i></a>
              </div>
            </div>
            <div class="entry-row-bottom">
              <div class="entry-date">${entry.date || ""}</div>
              <div class="entry-meta-pills">
                <span class="entry-expense">-${fmtMoney(entry.expense)}</span>
                <span class="entry-balance ${balanceClass}">${fmtMoney(entry.balance)}</span>
              </div>
            </div>
          </div>
          ${showTxns ? `<div class="entry-body" style="display:block;">${txnHTML}</div>` : ""}
        </div>
      </div>`;
  }).join("");
}

/* ---------------- PDF export (same layout as the old BlackRoad report tool) ---------------- */

function downloadPDF() {
  const rawTerm = searchInput.value.trim();
  const term = norm(rawTerm);
  const entries = getFilteredEntries(term);
  if (entries.length === 0) { showToast("No results to export"); return; }

  let globalIncome = 0, globalExpense = 0;
  const categorySummary = {};
  entries.forEach((entry) => {
    globalIncome += Number(entry.income) || 0;
    matchingTxns(entry, term).forEach((t) => {
      const amt = Number(t.amount) || 0;
      globalExpense += amt;
      categorySummary[t.category || "Uncategorized"] = (categorySummary[t.category || "Uncategorized"] || 0) + amt;
    });
  });

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF("p", "mm", "a4");

  pdf.setFillColor(26, 26, 26);
  pdf.rect(0, 0, 210, 15, "F");
  pdf.setTextColor(255);
  pdf.setFontSize(10);
  pdf.text("BLACKROAD REPORT", 15, 10);

  let y = 30;
  pdf.setTextColor(0);
  pdf.setFontSize(22);
  pdf.text("Search Results", 15, y);

  y += 12;
  pdf.setFontSize(10);
  pdf.setTextColor(100);
  pdf.text(`Generated: ${new Date().toLocaleDateString()}`, 15, y);

  const filterLines = [];
  if (rawTerm) filterLines.push(`Search term: "${rawTerm}"`);
  if (FILTERS.sources.length) filterLines.push(`Source: ${FILTERS.sources.join(", ")}`);
  if (FILTERS.categories.length) filterLines.push(`Category: ${FILTERS.categories.join(", ")}`);
  if (FILTERS.fromDate || FILTERS.toDate) {
    filterLines.push(`Date range: ${FILTERS.fromDate || "…"} to ${FILTERS.toDate || "…"}`);
  }
  filterLines.forEach((line) => {
    y += 6;
    const wrapped = pdf.splitTextToSize(line, 180);
    pdf.text(wrapped, 15, y);
    y += (wrapped.length - 1) * 5;
  });

  y += 10;
  pdf.autoTable({
    startY: y,
    head: [["Description", "Amount"]],
    body: [
      ["Total Income", globalIncome.toFixed(2)],
      ["Total Expenses", globalExpense.toFixed(2)],
      ["Net Balance", (globalIncome - globalExpense).toFixed(2)],
    ],
    theme: "grid",
    headStyles: { fillColor: [26, 26, 26] },
  });

  y = pdf.lastAutoTable.finalY + 15;
  pdf.setFontSize(14);
  pdf.setTextColor(0);
  pdf.text("Expense by Category", 15, y);
  pdf.autoTable({
    startY: y + 5,
    head: [["Category", "Amount"]],
    body: Object.entries(categorySummary).map(([c, a]) => [c, a.toFixed(2)]),
    headStyles: { fillColor: [80, 80, 80] },
  });

  y = pdf.lastAutoTable.finalY + 20;
  entries.forEach((entry) => {
    const txns = matchingTxns(entry, term);
    const recExp = txns.reduce((s, t) => s + (Number(t.amount) || 0), 0);

    if (y > 240) { pdf.addPage(); y = 20; }

    pdf.setFontSize(11);
    pdf.text(`${entry.date || ""} | ${entry.from || "Income"}`, 15, y);

    pdf.autoTable({
      startY: y + 3,
      head: [["Income", "Expenses", "Balance"]],
      body: [[(Number(entry.income) || 0).toFixed(2), recExp.toFixed(2), ((Number(entry.income) || 0) - recExp).toFixed(2)]],
      styles: { fontSize: 8 },
      margin: { left: 15 },
      tableWidth: 80,
    });

    pdf.autoTable({
      startY: pdf.lastAutoTable.finalY + 2,
      head: [["Category", "Description", "Amount"]],
      body: txns.map((t) => [t.category || "", t.description || "", (Number(t.amount) || 0).toFixed(2)]),
      theme: "striped",
      styles: { fontSize: 8 },
    });

    y = pdf.lastAutoTable.finalY + 15;
  });

  pdf.save("BlackRoad_Search_Report.pdf");
}

/* ---------------- Events ---------------- */

searchInput.addEventListener("input", () => {
  searchClear.style.display = searchInput.value.trim() ? "block" : "none";
  renderResults();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.style.display = "none";
  renderResults();
  searchInput.focus();
});

filterToggle.addEventListener("click", () => {
  filterPanel.classList.toggle("open");
});

filterApplyBtn.addEventListener("click", () => {
  FILTERS.sources = [...pendingSources];
  FILTERS.categories = [...pendingCategories];
  FILTERS.fromDate = filterFromEl.value;
  FILTERS.toDate = filterToEl.value;
  renderResults();
});

filterClearBtn.addEventListener("click", () => {
  pendingSources.clear();
  pendingCategories.clear();
  filterSourceEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  filterCategoryEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  filterFromEl.value = "";
  filterToEl.value = "";
  FILTERS = { sources: [], categories: [], fromDate: "", toDate: "" };
  renderResults();
});

downloadPdfBtn.addEventListener("click", downloadPDF);

(async function init() {
  try {
    db = await openDB();
    ENTRIES = await getAllEntries();
    ENTRIES.sort((a, b) => new Date(b.date) - new Date(a.date));
    populateFilterOptions();
    searchInput.focus();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

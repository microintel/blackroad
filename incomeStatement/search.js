/* =========================================================
   BLACKROAD — search.js
   Standalone search page: search input + matching results only.
   Depends on shared.js for the DB layer, formatting utilities
   and matchesSearch().
========================================================= */

let ENTRIES = [];

const searchInput = document.getElementById("searchInput");
const searchClear = document.getElementById("searchClear");
const searchStatus = document.getElementById("searchStatus");
const resultsEl = document.getElementById("searchResults");

function renderResults(term) {
  if (!term) {
    resultsEl.innerHTML = "";
    searchStatus.style.display = "none";
    return;
  }

  const matches = [];
  ENTRIES.forEach((e) => {
    const { entryMatch, txnMatches } = matchesSearch(e, term);
    if (entryMatch || txnMatches.length > 0) {
      matches.push({ entry: e, txns: entryMatch ? (e.transactions || []) : txnMatches, txnOnly: !entryMatch });
    }
  });

  searchStatus.style.display = "block";
  searchStatus.textContent = matches.length === 0
    ? `No matches for "${term}"`
    : `${matches.length} entr${matches.length === 1 ? "y" : "ies"} match "${term}"`;

  if (matches.length === 0) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-search"></i></span>
        <h3>No matches</h3>
        <p>Nothing in your ledger matches "${escapeHTML(term)}". Try a different source, description, or category.</p>
      </div>`;
    return;
  }

  resultsEl.innerHTML = matches.map(({ entry, txns, txnOnly }) => {
    const balanceClass = entry.balance <= 0 ? "zero" : "";
    let txnHTML = "";
    if (txnOnly) {
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
          ${txnOnly ? `<div class="entry-body" style="display:block;">${txnHTML}</div>` : ""}
        </div>
      </div>`;
  }).join("");
}

searchInput.addEventListener("input", () => {
  const term = searchInput.value.trim();
  searchClear.style.display = term ? "block" : "none";
  renderResults(term);
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.style.display = "none";
  renderResults("");
  searchInput.focus();
});

(async function init() {
  try {
    db = await openDB();
    ENTRIES = await getAllEntries();
    ENTRIES.sort((a, b) => new Date(b.date) - new Date(a.date));
    searchInput.focus();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

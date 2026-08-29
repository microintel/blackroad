/* =========================================================
   BLACKROAD — search.js
   Search page: text search + quick chips + full filter sheet
   (source, category, type, dates) +
   sort + saved filter presets + summary + PDF/CSV export.
   Results are a flat, tappable transaction-level list — an
   income entry and each of its expenses are independent rows,
   which is what lets amount/type filtering and
   sorting behave the way people actually expect.
   Depends on shared.js for the DB layer + formatting utils.
========================================================= */

let ENTRIES = [];
let FILTERS = {
  sources: [], categories: [],
  fromDate: "", toDate: "",
  type: "all",        // all | income | expense
  sortBy: "newest",   // newest | oldest | amount_desc | amount_asc
};

const searchInput   = document.getElementById("searchInput");
const searchClear   = document.getElementById("searchClear");
const searchStatus  = document.getElementById("searchStatus");
const resultsEl     = document.getElementById("searchResults");
const summaryEl     = document.getElementById("searchSummary");

const qchipRow        = document.getElementById("qchipRow");
const filterToggle    = document.getElementById("filterToggle");
const filterToggle2   = document.getElementById("filterToggle2");
const filterCountEl   = document.getElementById("filterCount");
const sheetBackdrop   = document.getElementById("sheetBackdrop");
const filterPanel     = document.getElementById("filterPanel");
const sheetCloseBtn   = document.getElementById("sheetCloseBtn");
const filterSourceEl  = document.getElementById("filterSource");
const filterCategoryEl= document.getElementById("filterCategory");
const filterFromEl    = document.getElementById("filterFrom");
const filterToEl      = document.getElementById("filterTo");
const typeSeg         = document.getElementById("typeSeg");
const filterApplyBtn  = document.getElementById("filterApply");
const filterClearBtn  = document.getElementById("filterClear");
const sortSelect      = document.getElementById("sortSelect");
const exportMenuBtn   = document.getElementById("exportMenuBtn");
const exportMenu      = document.getElementById("exportMenu");
const downloadPdfBtn  = document.getElementById("downloadPdfBtn");
const downloadCsvBtn  = document.getElementById("downloadCsvBtn");
const presetNameEl    = document.getElementById("presetName");
const presetSaveBtn   = document.getElementById("presetSaveBtn");
const presetChipsEl   = document.getElementById("presetChips");

const norm = (v) => (v || "").toLowerCase().trim();
const tokenize = (v) => norm(v).split(/[^a-z0-9]+/).filter(Boolean);

/* ---------------- Perf: Trie (prefix tree) search index ----------------
   Matches by word-prefix in O(k) per query instead of an O(n·m)
   substring scan across every transaction on every keystroke. Trade-off:
   "groc" finds "Groceries" (prefix), "eries" (mid-word) would not — an
   acceptable trade for real ledger search, where people type the start
   of a name/category/merchant. */
class TrieNode {
  constructor() { this.children = new Map(); this.ids = new Set(); }
}
class Trie {
  constructor() { this.root = new TrieNode(); }
  insert(word, id) {
    let node = this.root;
    node.ids.add(id);
    for (const ch of word) {
      let next = node.children.get(ch);
      if (!next) { next = new TrieNode(); node.children.set(ch, next); }
      node = next;
      node.ids.add(id);
    }
  }
  idsWithPrefix(prefix) {
    let node = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return null;
    }
    return node.ids;
  }
}

let txnTrie = new Trie();   // word -> Set of "entryIdx:txnIdx" ids (expense description + category)
let entryTrie = new Trie(); // word -> Set of entryIdx ids (income "from")

function trieMatchIds(trie, term) {
  const words = tokenize(term);
  if (!words.length) return null;
  let result = null;
  for (const w of words) {
    const ids = trie.idsWithPrefix(w);
    if (!ids || ids.size === 0) return new Set();
    result = result === null ? ids : new Set([...result].filter((id) => ids.has(id)));
    if (result.size === 0) return result;
  }
  return result;
}

/* ---------------- Build search cache + flat item list ----------------
   Runs once when entries load (and again on change), never per keystroke. */
let FLAT_ITEMS = []; // every income row + every expense row, independent

function primeSearchCache(entries) {
  txnTrie = new Trie();
  entryTrie = new Trie();
  FLAT_ITEMS = [];

  entries.forEach((entry, entryIdx) => {
    entry._id = entryIdx;
    entry._fromNorm = norm(entry.from);
    tokenize(entry.from).forEach((w) => entryTrie.insert(w, entryIdx));

    FLAT_ITEMS.push({
      kind: "income",
      matchId: entryIdx,
      entryId: entry.id,
      txnId: null,
      desc: entry.from || "Income",
      category: null,
      amount: Number(entry.income) || 0,
      date: entry.date || "",
      _fromNorm: entry._fromNorm,
    });

    (entry.transactions || []).forEach((t, txnIdx) => {
      t._id = `${entryIdx}:${txnIdx}`;
      t._descNorm = norm(t.description);
      t._catNorm = norm(t.category);
      tokenize(t.description).forEach((w) => txnTrie.insert(w, t._id));
      tokenize(t.category).forEach((w) => txnTrie.insert(w, t._id));

      FLAT_ITEMS.push({
        kind: "expense",
        matchId: t._id,
        entryId: entry.id,
        txnId: t.id,
        desc: t.description || "Expense",
        category: t.category || "",
        amount: Number(t.amount) || 0,
        date: t.date || entry.date || "",
        _fromNorm: entry._fromNorm,
      });
    });
  });
}

/* ---------------- Chip-based filter pickers ---------------- */

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

/* ---------------- Segmented controls ---------------- */

function wireSeg(seg, onChange) {
  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      seg.dataset.value = btn.dataset.val;
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      onChange(btn.dataset.val);
    });
  });
}
function setSeg(seg, value) {
  seg.dataset.value = value;
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.val === value));
}
wireSeg(typeSeg, () => {});

/* ---------------- Filtering + sorting (flat items) ---------------- */

function hasActiveFilters() {
  return FILTERS.sources.length || FILTERS.categories.length || FILTERS.fromDate || FILTERS.toDate ||
    FILTERS.type !== "all";
}

function countActiveFilters() {
  let n = 0;
  if (FILTERS.sources.length) n++;
  if (FILTERS.categories.length) n++;
  if (FILTERS.fromDate || FILTERS.toDate) n++;
  if (FILTERS.type !== "all") n++;
  return n;
}

function updateFilterBadge() {
  const n = countActiveFilters();
  filterCountEl.style.display = n ? "inline-block" : "none";
  filterCountEl.textContent = n;
}

function getFilteredItems(term) {
  const fTime = FILTERS.fromDate ? new Date(FILTERS.fromDate).setHours(0, 0, 0, 0) : null;
  const tTime = FILTERS.toDate ? new Date(FILTERS.toDate).setHours(23, 59, 59, 999) : null;
  const sourcesNorm = FILTERS.sources.map(norm);
  const categoriesNorm = FILTERS.categories.map(norm);

  const termEntryIds = term ? trieMatchIds(entryTrie, term) : null;
  const termTxnIds = term ? trieMatchIds(txnTrie, term) : null;

  let out = FLAT_ITEMS.filter((it) => {
    if (term) {
      const matched = it.kind === "income"
        ? (termEntryIds && termEntryIds.has(it.matchId))
        : (termTxnIds && termTxnIds.has(it.matchId));
      if (!matched) return false;
    }
    if (FILTERS.type !== "all" && it.kind !== FILTERS.type) return false;
    if (sourcesNorm.length && !sourcesNorm.some((s) => it._fromNorm.includes(s))) return false;
    if (categoriesNorm.length) {
      if (it.kind !== "expense") return false;
      if (!categoriesNorm.some((c) => norm(it.category).includes(c))) return false;
    }
    if (fTime && tTime) {
      const dTime = new Date(it.date).getTime();
      if (isNaN(dTime) || !(dTime >= fTime && dTime <= tTime)) return false;
    }
    return true;
  });

  out = out.slice().sort((a, b) => {
    switch (FILTERS.sortBy) {
      case "oldest": return new Date(a.date || 0) - new Date(b.date || 0);
      case "amount_desc": return b.amount - a.amount;
      case "amount_asc": return a.amount - b.amount;
      case "newest":
      default: return new Date(b.date || 0) - new Date(a.date || 0);
    }
  });

  return out;
}

/* ---------------- Summary ---------------- */

function renderSummary(items) {
  let income = 0, expense = 0;
  items.forEach((it) => { if (it.kind === "income") income += it.amount; else expense += it.amount; });
  const balance = income - expense;
  summaryEl.innerHTML = `
    <div class="sm-item"><span class="sm-label">Results</span><span class="sm-val">${items.length}</span></div>
    <div class="sm-item"><span class="sm-label">Income</span><span class="sm-val">${fmtMoney(income)}</span></div>
    <div class="sm-item"><span class="sm-label">Expense</span><span class="sm-val">${fmtMoney(expense)}</span></div>
    <div class="sm-item"><span class="sm-label">Net</span><span class="sm-val">${fmtMoney(balance)}</span></div>
  `;
  summaryEl.classList.add("show");
}

/* ---------------- Results (flat, tappable native-list rows) ---------------- */

function renderResults() {
  const rawTerm = searchInput.value.trim();
  const term = norm(rawTerm);
  const active = rawTerm || hasActiveFilters();

  if (!active) {
    resultsEl.innerHTML = "";
    searchStatus.style.display = "none";
    summaryEl.classList.remove("show");
    exportMenuBtn.style.display = "none";
    return;
  }

  const items = getFilteredItems(term);

  searchStatus.style.display = "block";
  searchStatus.textContent = items.length === 0
    ? (rawTerm ? `No matches for "${rawTerm}"` : "No transactions match these filters")
    : `${items.length} result${items.length === 1 ? "" : "s"}`;

  if (items.length === 0) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-search"></i></span>
        <h3>No matches</h3>
        <p>Nothing in your ledger matches${rawTerm ? ` "${escapeHTML(rawTerm)}"` : " these filters"}. Try different terms or filters.</p>
      </div>`;
    summaryEl.classList.remove("show");
    exportMenuBtn.style.display = "none";
    return;
  }

  renderSummary(items);
  exportMenuBtn.style.display = "inline-flex";

  resultsEl.innerHTML = `<div class="result-list">${items.map((it) => `
    <div class="result-row" onclick="location.href='statement.html?open=${it.entryId}'">
      <span class="result-ico ${it.kind}"><i class="bi ${it.kind === "income" ? "bi-arrow-down-left" : "bi-arrow-up-right"}"></i></span>
      <div class="result-main">
        <div class="result-desc">${escapeHTML(it.desc)}</div>
        <div class="result-meta">
          ${it.category ? `<span>${escapeHTML(it.category)}</span>` : (it.kind === "income" ? "<span>Income</span>" : "")}
        </div>
      </div>
      <div class="result-side">
        <span class="result-amt ${it.kind}">${it.kind === "income" ? "+" : "-"}${fmtMoney(it.amount)}</span>
        <span class="result-date">${it.date || ""}</span>
      </div>
    </div>`).join("")}</div>`;
}

/* ---------------- PDF export ---------------- */

function currentFilterLines(rawTerm) {
  const lines = [];
  if (rawTerm) lines.push(`Search term: "${rawTerm}"`);
  if (FILTERS.sources.length) lines.push(`Source: ${FILTERS.sources.join(", ")}`);
  if (FILTERS.categories.length) lines.push(`Category: ${FILTERS.categories.join(", ")}`);
  if (FILTERS.type !== "all") lines.push(`Type: ${FILTERS.type}`);
  if (FILTERS.fromDate || FILTERS.toDate) lines.push(`Date range: ${FILTERS.fromDate || "…"} to ${FILTERS.toDate || "…"}`);
  lines.push(`Sort: ${sortSelect.options[sortSelect.selectedIndex].text}`);
  return lines;
}

/* ---------------- Export progress dialog (SweetAlert2) ----------------
   Same visual language as the main dashboard's backup progress: a
   spinning status ring, a live "now processing" line, an animated
   bar, and a short scrolling log — paced with small delays so even
   a fast, synchronous export reads as a clean, gradual progression
   instead of an instant jump. ---------------- */

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function exportProgressMarkup(icon) {
  return `
    <div class="br-progress-icon-wrap" id="brIconWrap">
      <div class="br-progress-icon"><i class="bi ${icon}" id="brProgressIcon"></i></div>
    </div>
    <div class="br-current-row">
      <span class="br-current-dot"></span>
      <span class="br-current-label" id="brCurrentLabel">Getting ready…</span>
    </div>
    <div class="br-progress-track"><div class="br-progress-fill" id="brProgressFill" style="width:0%"><span class="br-shimmer"></span></div></div>
    <div class="br-progress-meta">
      <span id="brProgressStep">Step 0 of 0</span>
      <span id="brProgressPercent">0%</span>
    </div>
    <div class="br-progress-log" id="brProgressLog"></div>
  `;
}

function openExportProgress(title, icon) {
  Swal.fire({
    title,
    html: exportProgressMarkup(icon),
    showConfirmButton: false,
    allowOutsideClick: false,
    allowEscapeKey: false,
    customClass: { popup: "br-swal-popup", title: "br-swal-title" },
  });
}

function markCurrentItem(label, step, total) {
  const cur = document.getElementById("brCurrentLabel");
  const stepEl = document.getElementById("brProgressStep");
  if (cur) {
    cur.classList.remove("br-fade-swap");
    void cur.offsetWidth; // restart the fade animation on every step
    cur.textContent = label;
    cur.classList.add("br-fade-swap");
  }
  if (stepEl) stepEl.textContent = `Step ${step} of ${total}`;
}

function completeCurrentItem(label, percent) {
  const fillEl = document.getElementById("brProgressFill");
  const pctEl = document.getElementById("brProgressPercent");
  const logEl = document.getElementById("brProgressLog");
  if (fillEl) {
    fillEl.style.width = percent + "%";
    fillEl.classList.remove("br-bump");
    void fillEl.offsetWidth;
    fillEl.classList.add("br-bump");
  }
  if (pctEl) pctEl.textContent = percent + "%";
  if (logEl) {
    const row = document.createElement("div");
    row.className = "br-log-row";
    row.innerHTML = `<i class="bi bi-check-circle-fill"></i><span>${escapeHTML(label)}</span>`;
    logEl.prepend(row);
    while (logEl.children.length > 3) logEl.removeChild(logEl.lastChild);
  }
}

/** Advances the open progress dialog for one step and waits briefly
 *  between "now processing" and "done" so the motion stays readable. */
async function stepExportProgress(step, total, label) {
  markCurrentItem(label, step, total);
  await sleep(160 + Math.random() * 140);
  completeCurrentItem(label, Math.round((step / total) * 100));
  await sleep(80 + Math.random() * 60);
}

/** Settles the dialog into a calm "done" state — ring and bar turn
 *  green, icon pops into a checkmark — right before the result alert. */
async function finishExportProgress() {
  const iconWrap = document.getElementById("brIconWrap");
  const icon = document.getElementById("brProgressIcon");
  const fillEl = document.getElementById("brProgressFill");
  const cur = document.getElementById("brCurrentLabel");
  if (iconWrap) iconWrap.classList.add("br-icon-done");
  if (icon) icon.className = "bi bi-check-lg";
  if (fillEl) fillEl.classList.add("br-fill-done");
  if (cur) cur.textContent = "All done";
  await sleep(500);
}

function exportResultAlert(success, title, text) {
  Swal.fire({
    icon: success ? "success" : "error",
    title,
    text,
    customClass: { popup: "br-swal-popup" },
    timer: success ? 2000 : undefined,
    timerProgressBar: success,
    confirmButtonText: "OK",
  });
}

async function downloadPDF() {
  const rawTerm = searchInput.value.trim();
  const term = norm(rawTerm);
  const items = getFilteredItems(term);
  if (items.length === 0) { showToast("No results to export"); return; }

  openExportProgress("Exporting PDF", "bi-file-earmark-pdf");
  try {
    await sleep(280); // let "Getting ready…" register before the real steps start
    await stepExportProgress(1, 4, "Preparing results…");

    let globalIncome = 0, globalExpense = 0;
    const categorySummary = {};
    items.forEach((it) => {
      if (it.kind === "income") globalIncome += it.amount;
      else {
        globalExpense += it.amount;
        const key = it.category || "Uncategorized";
        categorySummary[key] = (categorySummary[key] || 0) + it.amount;
      }
    });
    await stepExportProgress(2, 4, "Calculating summary…");

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

    currentFilterLines(rawTerm).forEach((line) => {
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
    await stepExportProgress(3, 4, "Formatting report…");

    y = pdf.lastAutoTable.finalY + 20;
    if (y > 240) { pdf.addPage(); y = 20; }
    pdf.setFontSize(14);
    pdf.setTextColor(0);
    pdf.text("Matching Transactions", 15, y);
    pdf.autoTable({
      startY: y + 5,
      head: [["Date", "Type", "Description", "Category", "Amount"]],
      body: items.map((it) => [
        it.date || "", it.kind, it.desc, it.category || "",
        (it.kind === "income" ? "+" : "-") + it.amount.toFixed(2),
      ]),
      theme: "striped",
      styles: { fontSize: 8 },
    });

    pdf.save("BlackRoad_Search_Report.pdf");
    await stepExportProgress(4, 4, "Generating PDF…");

    await finishExportProgress();
    exportResultAlert(true, "PDF downloaded", "Your search report was exported successfully.");
  } catch (err) {
    console.error("PDF export failed", err);
    exportResultAlert(false, "Export failed", "Something went wrong generating the PDF.");
  }
}

/* ---------------- CSV export ---------------- */

async function downloadCSV() {
  const rawTerm = searchInput.value.trim();
  const term = norm(rawTerm);
  const items = getFilteredItems(term);
  if (items.length === 0) { showToast("No results to export"); return; }

  openExportProgress("Exporting CSV", "bi-filetype-csv");
  try {
    await sleep(280);
    await stepExportProgress(1, 3, "Preparing results…");

    const rows = [["Date", "Type", "Description", "Category", "Amount"]];
    items.forEach((it) => {
      rows.push([it.date || "", it.kind, it.desc, it.category || "", it.amount.toFixed(2)]);
    });
    await stepExportProgress(2, 3, "Formatting rows…");

    const csv = rows.map((r) => r.map((cell) => {
      const s = String(cell ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "BlackRoad_Search_Results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await stepExportProgress(3, 3, "Generating CSV…");

    await finishExportProgress();
    exportResultAlert(true, "CSV exported", "Your search results were exported successfully.");
  } catch (err) {
    console.error("CSV export failed", err);
    exportResultAlert(false, "Export failed", "Something went wrong generating the CSV.");
  }
}

/* ---------------- Filter sheet open/close ---------------- */

function openSheet() {
  // seed pending state from current FILTERS + inputs each time it opens
  filterFromEl.value = FILTERS.fromDate;
  filterToEl.value = FILTERS.toDate;
  setSeg(typeSeg, FILTERS.type);
  filterPanel.classList.add("open");
  sheetBackdrop.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  filterPanel.classList.remove("open");
  sheetBackdrop.classList.remove("open");
  document.body.style.overflow = "";
}
filterToggle.addEventListener("click", openSheet);
filterToggle2.addEventListener("click", openSheet);
sheetCloseBtn.addEventListener("click", closeSheet);
sheetBackdrop.addEventListener("click", closeSheet);

/* ---------------- Apply / Clear ---------------- */

function readSheetIntoFilters() {
  FILTERS.sources = [...pendingSources];
  FILTERS.categories = [...pendingCategories];
  FILTERS.fromDate = filterFromEl.value;
  FILTERS.toDate = filterToEl.value;
  FILTERS.type = typeSeg.dataset.value || "all";
}

filterApplyBtn.addEventListener("click", () => {
  readSheetIntoFilters();
  updateFilterBadge();
  syncQuickChips();
  renderResults();
  closeSheet();
});

filterClearBtn.addEventListener("click", () => {
  pendingSources.clear();
  pendingCategories.clear();
  filterSourceEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  filterCategoryEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  filterFromEl.value = "";
  filterToEl.value = "";
  setSeg(typeSeg, "all");
  FILTERS = { sources: [], categories: [], fromDate: "", toDate: "", type: "all", sortBy: FILTERS.sortBy };
  updateFilterBadge();
  syncQuickChips();
  renderResults();
});

/* ---------------- Sort ---------------- */
sortSelect.addEventListener("change", () => {
  FILTERS.sortBy = sortSelect.value;
  renderResults();
});

/* ---------------- Quick chips (one-tap filters, no sheet) ---------------- */

function syncQuickChips() {
  qchipRow.querySelectorAll(".qchip[data-qf]").forEach((chip) => {
    const qf = chip.dataset.qf;
    let isActive = false;
    if (qf === "expense") isActive = FILTERS.type === "expense";
    else if (qf === "income") isActive = FILTERS.type === "income";
    chip.classList.toggle("active", isActive);
  });
}

qchipRow.querySelectorAll(".qchip[data-qf]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const qf = chip.dataset.qf;
    const isActive = chip.classList.contains("active");

    if (qf === "expense" || qf === "income") {
      FILTERS.type = isActive ? "all" : qf;
    }
    updateFilterBadge();
    syncQuickChips();
    renderResults();
  });
});

/* ---------------- Export menu ---------------- */

function positionExportMenu() {
  // Reset to default (right-aligned to the button) before measuring.
  exportMenu.style.left = "";
  exportMenu.style.right = "0";
  const margin = 12;
  const rect = exportMenu.getBoundingClientRect();
  if (rect.left < margin) {
    // Would spill off the left edge — pin it to the left instead.
    exportMenu.style.right = "auto";
    exportMenu.style.left = `${margin - rect.left}px`;
  } else if (rect.right > window.innerWidth - margin) {
    // Would spill off the right edge — pull it back in.
    exportMenu.style.right = `${rect.right - (window.innerWidth - margin)}px`;
  }
}

exportMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = !exportMenu.classList.contains("open");
  exportMenu.classList.toggle("open");
  if (opening) positionExportMenu();
});
document.addEventListener("click", () => exportMenu.classList.remove("open"));
exportMenu.addEventListener("click", (e) => e.stopPropagation());
downloadPdfBtn.addEventListener("click", () => { exportMenu.classList.remove("open"); downloadPDF(); });
downloadCsvBtn.addEventListener("click", () => { exportMenu.classList.remove("open"); downloadCSV(); });

/* ---------------- Saved filter presets (localStorage) ---------------- */

const PRESETS_KEY = "br-search-presets";

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; }
  catch (e) { return []; }
}
function savePresets(list) {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch (e) {}
}

function renderPresetChips() {
  const list = loadPresets();
  if (!list.length) {
    presetChipsEl.innerHTML = `<span class="preset-empty">No saved filters yet — set some up and tap Save.</span>`;
    return;
  }
  presetChipsEl.innerHTML = list.map((p, i) => `
    <span class="preset-chip" data-idx="${i}">
      <span class="px-label">${escapeHTML(p.name)}</span>
      <span class="px-del" data-idx="${i}" title="Delete"><i class="bi bi-x"></i></span>
    </span>`).join("");

  presetChipsEl.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      if (e.target.closest(".px-del")) return;
      const idx = Number(chip.dataset.idx);
      applyPreset(list[idx]);
    });
  });
  presetChipsEl.querySelectorAll(".px-del").forEach((del) => {
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(del.dataset.idx);
      const l = loadPresets();
      l.splice(idx, 1);
      savePresets(l);
      renderPresetChips();
      showToast("Preset deleted");
    });
  });
}

function applyPreset(p) {
  pendingSources.clear();
  (p.filters.sources || []).forEach((s) => pendingSources.add(s));
  pendingCategories.clear();
  (p.filters.categories || []).forEach((c) => pendingCategories.add(c));
  filterSourceEl.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", pendingSources.has(c.dataset.value)));
  filterCategoryEl.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", pendingCategories.has(c.dataset.value)));

  filterFromEl.value = p.filters.fromDate || "";
  filterToEl.value = p.filters.toDate || "";
  setSeg(typeSeg, p.filters.type || "all");

  readSheetIntoFilters();
  if (p.filters.sortBy) { FILTERS.sortBy = p.filters.sortBy; sortSelect.value = p.filters.sortBy; }
  if (p.term != null) { searchInput.value = p.term; searchClear.style.display = p.term ? "block" : "none"; }

  updateFilterBadge();
  syncQuickChips();
  renderResults();
  closeSheet();
  showToast(`Applied "${p.name}"`);
}

presetSaveBtn.addEventListener("click", () => {
  const name = presetNameEl.value.trim();
  if (!name) { showToast("Name this filter combo first"); return; }
  readSheetIntoFilters();
  const list = loadPresets();
  list.push({
    name,
    term: searchInput.value.trim(),
    filters: { ...FILTERS },
  });
  savePresets(list);
  presetNameEl.value = "";
  renderPresetChips();
  updateFilterBadge();
  showToast("Filter saved");
});

/* ---------------- Search input ---------------- */

let searchDebounceId = null;
searchInput.addEventListener("input", () => {
  searchClear.style.display = searchInput.value.trim() ? "block" : "none";
  clearTimeout(searchDebounceId);
  searchDebounceId = setTimeout(renderResults, 120);
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.style.display = "none";
  renderResults();
  searchInput.focus();
});

/* ---------------- Init ---------------- */

(async function init() {
  try {
    db = await openDB();
    ENTRIES = await getAllEntries();
    ENTRIES.sort((a, b) => new Date(b.date) - new Date(a.date));
    primeSearchCache(ENTRIES);
    populateFilterOptions();
    renderPresetChips();
    searchInput.focus();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

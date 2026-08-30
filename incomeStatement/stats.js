/* =========================================================
   BLACKROAD — stats.js (Statistics page)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   Read-only page: financial summary, ratios/averages,
   per-category gauges, and a zoomable monthly income/expense/
   balance trend chart, all derived from the same "entries"
   store used by the dashboard and statement pages.
========================================================= */

let ENTRIES = [];
let monthlyChart = null;
let summaryChart = null;

/* Cycle of 7, matching the reference design (education=pink, home=blue, ...) */
const CAT_PALETTE = ["#ff6b81", "#4dabf7", "#ffcb47", "#2dd4bf", "#a78bfa", "#ffa94d", "#b0b0b0"];

/* Which category cards are expanded to show their transaction breakdown. Kept
   at module scope so it survives re-renders (theme switch, refresh, etc). */
const expandedCats = new Set();
/* Cached from the most recent renderStats() pass so a click can redraw just
   the category gauges without recomputing every aggregate. */
let lastSortedCats = [];
let lastTotalExpense = 0;
let lastCatTxns = new Map();

/* chartjs-plugin-zoom self-registers via UMD in most builds, but register
   explicitly too so the zoomable monthly chart works regardless of build. */
if (window.Chart && window.ChartZoom && !Chart.registry.plugins.get("zoom")) {
  Chart.register(window.ChartZoom);
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function monthKeyOf(dateStr) {
  const d = new Date((dateStr || "") + "T00:00:00");
  if (isNaN(d)) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthShortLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

async function refresh() {
  ENTRIES = await getAllEntries();
  renderStats();
}

function renderStats() {
  const hasData = ENTRIES.length > 0;
  document.getElementById("statsEmpty").style.display = hasData ? "none" : "block";
  // Clear the inline override (rather than hardcoding "block") so the
  // CSS grid/flex layout in stats.html's <style> block — the one that
  // provides the gap between sections — takes over again.
  document.getElementById("statsBody").style.display = hasData ? "" : "none";
  if (!hasData) return;

  /* ---- Aggregate totals ---- */
  let totalIncome = 0, totalExpense = 0, txnCount = 0;
  const catTotals = new Map();
  const catTxns = new Map(); // category -> [{ note, amount, date }]
  const monthly = new Map(); // key -> { income, expense }
  const txnDates = [];

  ENTRIES.forEach((e) => {
    totalIncome += Number(e.income) || 0;
    totalExpense += Number(e.expense) || 0;

    const mk = monthKeyOf(e.date);
    if (mk) {
      if (!monthly.has(mk)) monthly.set(mk, { income: 0, expense: 0 });
      const m = monthly.get(mk);
      m.income += Number(e.income) || 0;
      m.expense += Number(e.expense) || 0;
    }

    (e.transactions || []).forEach((t) => {
      if (isInvestmentCategory(t.category)) return; // investments aren't spend — excluded from expense-category gauges
      txnCount++;
      const cat = t.category || "Uncategorized";
      const amt = Number(t.amount) || 0;
      catTotals.set(cat, (catTotals.get(cat) || 0) + amt);
      if (!catTxns.has(cat)) catTxns.set(cat, []);
      catTxns.get(cat).push({
        note: t.note || t.desc || t.description || t.title || t.label || cat,
        amount: amt,
        date: t.date || e.date
      });
      if (t.date) txnDates.push(t.date);
    });
  });

  const totalBalance = totalIncome - totalExpense;
  const monthsCount = Math.max(monthly.size, 1);

  /* ---- Ratios & averages ---- */
  const savingsRate = totalIncome > 0 ? (totalBalance / totalIncome) * 100 : 0;
  const expenseRatio = totalIncome > 0 ? (totalExpense / totalIncome) * 100 : (totalExpense > 0 ? 100 : 0);
  const avgTxn = txnCount > 0 ? totalExpense / txnCount : 0;
  const avgMonthlyIncome = totalIncome / monthsCount;
  const avgMonthlyExpense = totalExpense / monthsCount;
  const avgMonthlySavings = totalBalance / monthsCount;

  let daySpan = monthsCount * 30;
  if (txnDates.length > 1) {
    const sorted = txnDates.map((d) => new Date(d + "T00:00:00")).filter((d) => !isNaN(d)).sort((a, b) => a - b);
    if (sorted.length > 1) {
      const span = (sorted[sorted.length - 1] - sorted[0]) / 86400000;
      daySpan = Math.max(1, Math.round(span) + 1);
    }
  }
  const avgDailySpend = totalExpense / daySpan;

  const sortedCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]);
  const topCat = sortedCats[0];
  const topCatShare = topCat && totalExpense > 0 ? topCat[1] / totalExpense : 0;

  renderSummaryChart(totalIncome, totalExpense, totalBalance);
  renderRatios({
    savingsRate, expenseRatio, avgTxn, avgMonthlyIncome, avgMonthlyExpense,
    avgMonthlySavings, avgDailySpend, topCat, txnCount, monthsCount
  });
  renderCategoryGauges(sortedCats, totalExpense, catTxns);
  renderMonthlyChart(monthly);
}

/* ---------------- Ratio / average cards ---------------- */

function renderRatios(s) {
  const cards = [
    {
      label: "Savings rate", ico: "bi-piggy-bank-fill",
      val: s.savingsRate.toFixed(1) + "%", sub: "of income kept",
      cls: s.savingsRate >= 0 ? "pos" : "neg"
    },
    {
      label: "Expense ratio", ico: "bi-graph-down-arrow",
      val: s.expenseRatio.toFixed(1) + "%", sub: "of income spent",
      cls: s.expenseRatio > 100 ? "neg" : ""
    },
    {
      label: "Avg. monthly income", ico: "bi-arrow-down-left",
      val: fmtMoney(s.avgMonthlyIncome), sub: `over ${s.monthsCount} month${s.monthsCount === 1 ? "" : "s"}`
    },
    {
      label: "Avg. monthly expense", ico: "bi-arrow-up-right",
      val: fmtMoney(s.avgMonthlyExpense), sub: `over ${s.monthsCount} month${s.monthsCount === 1 ? "" : "s"}`
    },
    {
      label: "Avg. monthly savings", ico: "bi-wallet2",
      val: fmtMoney(s.avgMonthlySavings), sub: "income minus expense",
      cls: s.avgMonthlySavings >= 0 ? "pos" : "neg"
    },
    {
      label: "Avg. daily spend", ico: "bi-calendar-day",
      val: fmtMoney(s.avgDailySpend), sub: "across logged days"
    },
    {
      label: "Avg. per transaction", ico: "bi-receipt",
      val: fmtMoney(s.avgTxn), sub: `${s.txnCount} transaction${s.txnCount === 1 ? "" : "s"}`
    },
    {
      label: "Top category", ico: "bi-tags-fill",
      val: s.topCat ? escapeHTML(s.topCat[0]) : "—",
      sub: s.topCat ? fmtMoney(s.topCat[1]) + " spent" : "No expenses yet"
    },
  ];

  document.getElementById("ratioGrid").innerHTML = cards.map((c) => `
    <div class="ratio-card ${c.cls || ""}">
      <span class="ratio-card-label"><i class="bi ${c.ico}"></i> ${c.label}</span>
      <span class="ratio-card-val">${c.val}</span>
      <span class="ratio-card-sub">${c.sub}</span>
    </div>
  `).join("");
}

/* ---------------- Expense category gauges ---------------- */

function renderCategoryGauges(sortedCats, totalExpense, catTxns) {
  const grid = document.getElementById("catGaugeGrid");
  const empty = document.getElementById("catGaugeEmpty");

  // cache so toggling a card doesn't require recomputing every aggregate
  lastSortedCats = sortedCats;
  lastTotalExpense = totalExpense;
  lastCatTxns = catTxns;

  if (sortedCats.length === 0 || totalExpense <= 0) {
    grid.style.display = "none";
    empty.style.display = "block";
    return;
  }
  grid.style.display = "flex";
  empty.style.display = "none";

  grid.innerHTML = sortedCats.map(([name, amt], i) => {
    const pct = totalExpense > 0 ? (amt / totalExpense) * 100 : 0;
    const color = CAT_PALETTE[i % CAT_PALETTE.length];
    const isOpen = expandedCats.has(name);

    let txnRows = "";
    if (isOpen) {
      const txns = (catTxns.get(name) || []).slice().sort((a, b) => b.amount - a.amount);
      txnRows = txns.map((t, idx) => {
        const tPct = amt > 0 ? (t.amount / amt) * 100 : 0;
        return `
          <div class="cat-txn-row">
            <span class="cat-txn-idx">${idx + 1}.</span>
            <span class="cat-txn-note">${escapeHTML(t.note)}</span>
            <span>:</span>
            <span class="cat-txn-amt">${fmtMoney(t.amount)}</span>
            <span class="cat-txn-pct">(${tPct.toFixed(1)}%)</span>
          </div>`;
      }).join("");
      if (!txnRows) txnRows = `<div class="cat-txn-row">No transaction detail logged for this category.</div>`;
    }

    return `
      <div class="cat-bar-card${isOpen ? " open" : ""}" data-cat="${escapeHTML(name)}">
        <div class="cat-bar-top">
          <span class="cat-bar-name">${escapeHTML(name)}</span>
          <span class="cat-bar-amt">${fmtMoney(amt)} =&gt; ${pct.toFixed(1)}%</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pct}%; background:${color}"></div>
        </div>
        ${isOpen ? `<div class="cat-txn-list">${txnRows}</div>` : ""}
      </div>`;
  }).join("");
}

/* Click any category card to expand/collapse its transaction breakdown
   (highest amount first). Delegated once on the grid so re-rendering the
   inner HTML doesn't lose the listener. */
document.getElementById("catGaugeGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".cat-bar-card");
  if (!card) return;
  const cat = card.dataset.cat;
  if (expandedCats.has(cat)) expandedCats.delete(cat);
  else expandedCats.add(cat);
  renderCategoryGauges(lastSortedCats, lastTotalExpense, lastCatTxns);
});

/* ---------------- Financial summary (Income / Expense / Balance totals) ---------------- */

function renderSummaryChart(totalIncome, totalExpense, totalBalance) {
  const canvas = document.getElementById("summaryChart");
  const inner = document.getElementById("summaryChartInner");
  const empty = document.getElementById("summaryChartEmpty");

  if (totalIncome <= 0 && totalExpense <= 0) {
    inner.style.display = "none";
    empty.style.display = "block";
    if (summaryChart) { summaryChart.destroy(); summaryChart = null; }
    return;
  }
  inner.style.display = "block";
  empty.style.display = "none";

  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#8891a3";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";
  const inColor = cs.getPropertyValue("--ink-in").trim() || "#2196f3";
  const outColor = cs.getPropertyValue("--ink-out").trim() || "#f44336";
  const balColor = "#3ecf8e";

  if (summaryChart) summaryChart.destroy();
  summaryChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: ["Income", "Expense", "Balance"],
      datasets: [{
        data: [totalIncome, totalExpense, totalBalance],
        backgroundColor: [inColor, outColor, balColor],
        borderRadius: 6,
        maxBarThickness: 90
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtMoney(ctx.parsed.y) } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: dimColor, font: { size: 11.5, family: "Inter" } } },
        y: { beginAtZero: true, grid: { color: lineColor }, ticks: { color: dimColor, font: { size: 9.5, family: "Inter" }, callback: (v) => fmtMoney(v) } }
      }
    }
  });
}

/* ---------------- Monthly income / expense / balance chart ---------------- */

function renderMonthlyChart(monthly) {
  const canvas = document.getElementById("monthlyChart");
  const inner = document.getElementById("monthlyChartInner");
  const empty = document.getElementById("monthlyChartEmpty");

  if (monthly.size === 0) {
    inner.style.display = "none";
    empty.style.display = "block";
    if (monthlyChart) { monthlyChart.destroy(); monthlyChart = null; }
    return;
  }
  inner.style.display = "block";
  empty.style.display = "none";

  const keys = [...monthly.keys()].sort();
  const labels = keys.map(monthShortLabel);
  const incomeData = keys.map((k) => monthly.get(k).income);
  const expenseData = keys.map((k) => monthly.get(k).expense);
  const balanceData = keys.map((k) => monthly.get(k).income - monthly.get(k).expense);

  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#8891a3";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";
  const inColor = cs.getPropertyValue("--ink-in").trim() || "#3ecf8e";
  const outColor = cs.getPropertyValue("--ink-out").trim() || "#f27a8a";
  const accentColor = cs.getPropertyValue("--accent").trim() || "#5b9dff";

  if (monthlyChart) monthlyChart.destroy();
  monthlyChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Income", data: incomeData, borderColor: inColor, backgroundColor: inColor, pointBackgroundColor: inColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: "Expense", data: expenseData, borderColor: outColor, backgroundColor: outColor, pointBackgroundColor: outColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: "Balance", data: balanceData, borderColor: accentColor, backgroundColor: accentColor, pointBackgroundColor: accentColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { color: dimColor, font: { size: 10.5, family: "Inter" }, boxWidth: 10, usePointStyle: true, pointStyle: "circle" } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } },
        zoom: {
          pan: { enabled: true, mode: "x", modifierKey: null },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            drag: { enabled: false },
            mode: "x"
          },
          limits: { x: { min: "original", max: "original" } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: dimColor, font: { size: 10, family: "Inter" } } },
        y: { beginAtZero: true, grid: { color: lineColor }, ticks: { color: dimColor, font: { size: 9, family: "Inter" }, callback: (v) => fmtMoney(v) } }
      }
    }
  });
}

/* Reset the monthly chart's zoom/pan back to the full range. */
document.getElementById("monthlyChartReset").addEventListener("click", () => {
  if (monthlyChart) monthlyChart.resetZoom();
});

/* Redraw with theme-correct colors whenever the theme changes. */
document.addEventListener("br-theme-changed", () => renderStats());

/* ---------------- Boot ---------------- */

(async function init() {
  try {
    db = await openDB();
    await refresh();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

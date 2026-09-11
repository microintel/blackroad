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

/* Same pattern as above, for income-by-category gauges. */
const expandedIncCats = new Set();
let lastSortedIncCats = [];
let lastTotalIncome = 0;
let lastIncCatTxns = new Map();

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
  const incomeCatTotals = new Map();
  const incomeCatTxns = new Map(); // income category -> [{ note, amount, date }]
  const monthly = new Map(); // key -> { income, expense }
  const txnDates = [];

  ENTRIES.forEach((e) => {
    totalIncome += Number(e.income) || 0;
    totalExpense += Number(e.expense) || 0;

    const incCat = e.category || "Uncategorized"; // entries logged before categories existed still show up here
    const incAmt = Number(e.income) || 0;
    if (incAmt > 0) {
      incomeCatTotals.set(incCat, (incomeCatTotals.get(incCat) || 0) + incAmt);
      if (!incomeCatTxns.has(incCat)) incomeCatTxns.set(incCat, []);
      incomeCatTxns.get(incCat).push({ note: e.from || incCat, amount: incAmt, date: e.date });
    }

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
  const topIncCat = [...incomeCatTotals.entries()].sort((a, b) => b[1] - a[1])[0];

  renderSummaryHero(totalIncome, totalExpense, totalBalance);
  renderRatios({
    savingsRate, expenseRatio, avgTxn, avgMonthlyIncome, avgMonthlyExpense,
    avgMonthlySavings, avgDailySpend, topCat, topIncCat, txnCount, monthsCount
  });
  renderCategoryGauges(sortedCats, totalExpense, catTxns);
  const sortedIncCats = [...incomeCatTotals.entries()].sort((a, b) => b[1] - a[1]);
  renderIncomeCategoryGauges(sortedIncCats, totalIncome, incomeCatTxns);
  renderMonthlyChart(monthly);
}

/* ---------------- Ratio / average cards ---------------- */

function renderRatios(s) {
  const cards = [
    {
      label: "Savings rate", ico: "bi-piggy-bank-fill", tone: "in",
      val: s.savingsRate.toFixed(1) + "%", sub: "of income kept",
      cls: s.savingsRate >= 0 ? "pos" : "neg"
    },
    {
      label: "Expense ratio", ico: "bi-graph-down-arrow", tone: "out",
      val: s.expenseRatio.toFixed(1) + "%", sub: "of income spent",
      cls: s.expenseRatio > 100 ? "neg" : ""
    },
    {
      label: "Avg. monthly income", ico: "bi-arrow-down-left", tone: "in",
      val: fmtMoney(s.avgMonthlyIncome), sub: `over ${s.monthsCount} month${s.monthsCount === 1 ? "" : "s"}`
    },
    {
      label: "Avg. monthly expense", ico: "bi-arrow-up-right", tone: "out",
      val: fmtMoney(s.avgMonthlyExpense), sub: `over ${s.monthsCount} month${s.monthsCount === 1 ? "" : "s"}`
    },
    {
      label: "Avg. monthly savings", ico: "bi-wallet2", tone: "in",
      val: fmtMoney(s.avgMonthlySavings), sub: "income minus expense",
      cls: s.avgMonthlySavings >= 0 ? "pos" : "neg"
    },
    {
      label: "Avg. daily spend", ico: "bi-calendar-day", tone: "out",
      val: fmtMoney(s.avgDailySpend), sub: "across logged days"
    },
    {
      label: "Avg. per transaction", ico: "bi-receipt", tone: "accent",
      val: fmtMoney(s.avgTxn), sub: `${s.txnCount} transaction${s.txnCount === 1 ? "" : "s"}`
    },
    {
      label: "Top category", ico: "bi-tags-fill", tone: "out",
      val: s.topCat ? escapeHTML(s.topCat[0]) : "—",
      sub: s.topCat ? fmtMoney(s.topCat[1]) + " spent" : "No expenses yet"
    },
    {
      label: "Top income category", ico: "bi-arrow-down-left", tone: "in",
      val: s.topIncCat ? escapeHTML(s.topIncCat[0]) : "—",
      sub: s.topIncCat ? fmtMoney(s.topIncCat[1]) + " received" : "No income yet"
    },
  ];

  document.getElementById("ratioGrid").innerHTML = cards.map((c) => `
    <div class="ratio-card ${c.cls || ""}">
      <span class="ratio-card-label"><span class="ratio-ico tone-${c.tone || "accent"}"><i class="bi ${c.ico}"></i></span>${c.label}</span>
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

  const maxAmt = sortedCats[0][1]; // sorted descending, so this is the largest category

  grid.innerHTML = sortedCats.map(([name, amt], i) => {
    const pct = totalExpense > 0 ? (amt / totalExpense) * 100 : 0;
    const barPct = maxAmt > 0 ? (amt / maxAmt) * 100 : 0; // relative to the top category, so small ones stay visible
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
            <span class="cat-txn-amt">${fmtMoney(t.amount)}</span>
            <span class="cat-txn-pct">${tPct.toFixed(1)}%</span>
          </div>`;
      }).join("");
      if (!txnRows) txnRows = `<div class="cat-txn-row">No transaction detail logged for this category.</div>`;
    }

    return `
      <div class="cat-row${isOpen ? " open" : ""}" data-cat="${escapeHTML(name)}">
        <div class="cat-row-top">
          <span class="cat-row-dot" style="background:${color}"></span>
          <span class="cat-row-name">${escapeHTML(name)}</span>
          <span class="cat-row-pct">${pct.toFixed(1)}%</span>
          <span class="cat-row-amt">${fmtMoney(amt)}</span>
          <i class="bi bi-chevron-right cat-row-chevron"></i>
        </div>
        <div class="cat-row-track">
          <div class="cat-row-fill" style="width:${barPct}%; background:${color}"></div>
        </div>
        ${isOpen ? `<div class="cat-txn-list">${txnRows}</div>` : ""}
      </div>`;
  }).join("");
}

/* Click any category row to expand/collapse its transaction breakdown
   (highest amount first). Delegated once on the grid so re-rendering the
   inner HTML doesn't lose the listener. */
document.getElementById("catGaugeGrid").addEventListener("click", (e) => {
  const row = e.target.closest(".cat-row");
  if (!row) return;
  const cat = row.dataset.cat;
  if (expandedCats.has(cat)) expandedCats.delete(cat);
  else expandedCats.add(cat);
  renderCategoryGauges(lastSortedCats, lastTotalExpense, lastCatTxns);
});

/* ---------------- Income category gauges ----------------
   Same expandable-bar pattern as the expense gauges above, just driven
   by each income entry's own category (Salary, Return, Interest,
   Profit, or a custom one) instead of a transaction's category. Entries
   with no category yet are grouped under "Uncategorized" so they're
   still visible — and easy to spot for editing from the Statement tab. */

function renderIncomeCategoryGauges(sortedCats, totalIncome, catTxns) {
  const grid = document.getElementById("incCatGaugeGrid");
  const empty = document.getElementById("incCatGaugeEmpty");
  if (!grid || !empty) return; // page not upgraded with this section yet

  lastSortedIncCats = sortedCats;
  lastTotalIncome = totalIncome;
  lastIncCatTxns = catTxns;

  if (sortedCats.length === 0 || totalIncome <= 0) {
    grid.style.display = "none";
    empty.style.display = "block";
    return;
  }
  grid.style.display = "flex";
  empty.style.display = "none";

  const maxAmt = sortedCats[0][1]; // sorted descending, so this is the largest category

  grid.innerHTML = sortedCats.map(([name, amt], i) => {
    const pct = totalIncome > 0 ? (amt / totalIncome) * 100 : 0;
    const barPct = maxAmt > 0 ? (amt / maxAmt) * 100 : 0; // relative to the top category, so small ones stay visible
    const color = CAT_PALETTE[i % CAT_PALETTE.length];
    const isOpen = expandedIncCats.has(name);

    let txnRows = "";
    if (isOpen) {
      const txns = (catTxns.get(name) || []).slice().sort((a, b) => b.amount - a.amount);
      txnRows = txns.map((t, idx) => {
        const tPct = amt > 0 ? (t.amount / amt) * 100 : 0;
        return `
          <div class="cat-txn-row">
            <span class="cat-txn-idx">${idx + 1}.</span>
            <span class="cat-txn-note">${escapeHTML(t.note)}</span>
            <span class="cat-txn-amt">${fmtMoney(t.amount)}</span>
            <span class="cat-txn-pct">${tPct.toFixed(1)}%</span>
          </div>`;
      }).join("");
      if (!txnRows) txnRows = `<div class="cat-txn-row">No income logged in this category.</div>`;
    }

    return `
      <div class="cat-row${isOpen ? " open" : ""}" data-cat="${escapeHTML(name)}">
        <div class="cat-row-top">
          <span class="cat-row-dot" style="background:${color}"></span>
          <span class="cat-row-name">${escapeHTML(name)}</span>
          <span class="cat-row-pct">${pct.toFixed(1)}%</span>
          <span class="cat-row-amt">${fmtMoney(amt)}</span>
          <i class="bi bi-chevron-right cat-row-chevron"></i>
        </div>
        <div class="cat-row-track">
          <div class="cat-row-fill" style="width:${barPct}%; background:${color}"></div>
        </div>
        ${isOpen ? `<div class="cat-txn-list">${txnRows}</div>` : ""}
      </div>`;
  }).join("");
}

document.getElementById("incCatGaugeGrid") && document.getElementById("incCatGaugeGrid").addEventListener("click", (e) => {
  const row = e.target.closest(".cat-row");
  if (!row) return;
  const cat = row.dataset.cat;
  if (expandedIncCats.has(cat)) expandedIncCats.delete(cat);
  else expandedIncCats.add(cat);
  renderIncomeCategoryGauges(lastSortedIncCats, lastTotalIncome, lastIncCatTxns);
});

/* ---------------- Overview hero (Income / Expense / Balance headline) ----------------
   Three big stat tiles plus one shared proportional bar showing how income
   splits into expense vs. balance — carries more at-a-glance meaning than a
   generic 3-bar chart did, and reads as the page's headline instead of a
   plain, low-priority chart competing visually with everything below it. */

function renderSummaryHero(totalIncome, totalExpense, totalBalance) {
  const hero = document.getElementById("summaryHero");
  const empty = document.getElementById("summaryChartEmpty");

  if (totalIncome <= 0 && totalExpense <= 0) {
    hero.style.display = "none";
    empty.style.display = "block";
    return;
  }
  hero.style.display = "block";
  empty.style.display = "none";

  const expenseShare = totalIncome > 0
    ? clamp01(totalExpense / totalIncome) * 100
    : (totalExpense > 0 ? 100 : 0);
  const balanceShare = Math.max(0, 100 - expenseShare);

  hero.innerHTML = `
    <div class="fin-hero">
      <div class="fh-tile in">
        <div class="fh-top"><span class="fh-ico"><i class="bi bi-arrow-down-left"></i></span><span class="fh-label">Income</span></div>
        <span class="fh-val">${fmtMoney(totalIncome)}</span>
      </div>
      <div class="fh-tile out">
        <div class="fh-top"><span class="fh-ico"><i class="bi bi-arrow-up-right"></i></span><span class="fh-label">Expense</span></div>
        <span class="fh-val">${fmtMoney(totalExpense)}</span>
      </div>
      <div class="fh-tile bal">
        <div class="fh-top"><span class="fh-ico"><i class="bi bi-wallet2"></i></span><span class="fh-label">Balance</span></div>
        <span class="fh-val">${fmtMoney(totalBalance)}</span>
      </div>
    </div>
    <div class="fh-split-track">
      <div class="fh-split-fill out" style="width:${expenseShare}%"></div>
      <div class="fh-split-fill bal" style="width:${balanceShare}%"></div>
    </div>
    <div class="fh-split-legend">
      <span><i class="fh-dot out"></i> Expense ${expenseShare.toFixed(1)}% of income</span>
      <span><i class="fh-dot bal"></i> Balance ${balanceShare.toFixed(1)}% of income</span>
    </div>`;
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

  // Soft gradient fill under each line (fading to transparent) instead of
  // flat color or no fill at all — reads as a modern app chart rather than
  // a bare spreadsheet plot, while staying subtle enough that three
  // overlapping series don't turn into visual noise.
  const ctx = canvas.getContext("2d");
  const plotHeight = (canvas.parentElement && canvas.parentElement.clientHeight) || 300;
  function fadeFill(hex) {
    const g = ctx.createLinearGradient(0, 0, 0, plotHeight);
    g.addColorStop(0, hex + "38");
    g.addColorStop(1, hex + "00");
    return g;
  }

  if (monthlyChart) monthlyChart.destroy();
  monthlyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Income", data: incomeData, borderColor: inColor, backgroundColor: fadeFill(inColor), fill: true, pointBackgroundColor: inColor, tension: 0.35, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: "#fff" },
        { label: "Expense", data: expenseData, borderColor: outColor, backgroundColor: fadeFill(outColor), fill: true, pointBackgroundColor: outColor, tension: 0.35, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: "#fff" },
        { label: "Balance", data: balanceData, borderColor: accentColor, backgroundColor: fadeFill(accentColor), fill: true, pointBackgroundColor: accentColor, tension: 0.35, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: "#fff" },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start", labels: { color: dimColor, font: { size: 10.5, family: "Inter", weight: "600" }, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: "circle", padding: 16 } },
        tooltip: {
          backgroundColor: cs.getPropertyValue("--card").trim() || "#1a1b20",
          titleColor: cs.getPropertyValue("--text").trim() || "#f2f3f5",
          bodyColor: cs.getPropertyValue("--text").trim() || "#f2f3f5",
          borderColor: lineColor, borderWidth: 1,
          padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` }
        },
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

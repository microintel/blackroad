/* =========================================================
   BLACKROAD — stats.js (Statistics page)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   Read-only page: financial health score, ratios/averages,
   per-category gauges, and a monthly income/expense/balance
   trend chart, all derived from the same "entries" store used
   by the dashboard and statement pages.
========================================================= */

let ENTRIES = [];
let monthlyChart = null;

const CAT_PALETTE = ["#b5583f", "#6f7bb3", "#4f8f6b", "#c99a4f", "#8a6bb0", "#5c9bc9", "#c96c8c", "#7fa06a"];

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
  document.getElementById("statsBody").style.display = hasData ? "block" : "none";
  if (!hasData) return;

  /* ---- Aggregate totals ---- */
  let totalIncome = 0, totalExpense = 0, txnCount = 0;
  const catTotals = new Map();
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
      txnCount++;
      const cat = t.category || "Uncategorized";
      catTotals.set(cat, (catTotals.get(cat) || 0) + (Number(t.amount) || 0));
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

  renderHealthScore({ savingsRate, expenseRatio, topCatShare, hasIncome: totalIncome > 0, hasExpense: totalExpense > 0 });
  renderRatios({
    savingsRate, expenseRatio, avgTxn, avgMonthlyIncome, avgMonthlyExpense,
    avgMonthlySavings, avgDailySpend, topCat, txnCount, monthsCount
  });
  renderCategoryGauges(sortedCats, totalExpense);
  renderMonthlyChart(monthly);
}

/* ---------------- Financial health score ---------------- */

function renderHealthScore({ savingsRate, expenseRatio, topCatShare, hasIncome, hasExpense }) {
  // Savings rate: 45 pts, full marks at a 25%+ savings rate
  const savingsPts = hasIncome ? clamp01(savingsRate / 25) * 45 : 0;
  // Expense control: 35 pts, full marks at 0% of income spent, 0 pts at 100%+
  const expensePts = clamp01(1 - expenseRatio / 100) * 35;
  // Category spread: 20 pts, penalized only once one category dominates spend
  const diversityPts = hasExpense ? clamp01(1 - topCatShare) * 20 : 20;

  const total = Math.round(savingsPts + expensePts + diversityPts);

  let bucket, tagText, desc, color;
  if (total >= 80) { bucket = "excellent"; tagText = "Excellent"; color = "var(--ink-in)"; desc = "You're saving well and spending is under control. Keep it up."; }
  else if (total >= 60) { bucket = "good"; tagText = "Good"; color = "var(--accent)"; desc = "Solid footing overall, with some room to tighten savings or spending."; }
  else if (total >= 40) { bucket = "fair"; tagText = "Fair"; color = "var(--accent2)"; desc = "Finances are workable but stretched — a higher savings rate would help most."; }
  else { bucket = "needs-attention"; tagText = "Needs attention"; color = "var(--ink-out)"; desc = "Expenses are close to or above income. Consider trimming your largest category first."; }

  const gauge = document.getElementById("healthGauge");
  gauge.style.setProperty("--pct", total);
  gauge.style.setProperty("--gauge-color", color);
  document.getElementById("healthScoreNum").textContent = String(total);

  const tag = document.getElementById("healthScoreTag");
  tag.textContent = tagText;
  tag.className = "score-tag " + bucket;
  document.getElementById("healthScoreDesc").textContent = desc;

  const rows = [
    { label: "Savings rate", pts: savingsPts, max: 45, color: "var(--ink-in)" },
    { label: "Expense control", pts: expensePts, max: 35, color: "var(--accent)" },
    { label: "Category spread", pts: diversityPts, max: 20, color: "var(--accent2)" },
  ];
  document.getElementById("healthBreakdown").innerHTML = rows.map((r) => `
    <div class="score-bd-row">
      <span class="score-bd-label">${r.label}</span>
      <span class="score-bd-track"><span class="score-bd-fill" style="width:${Math.round((r.pts / r.max) * 100)}%; --gauge-color:${r.color}"></span></span>
      <span class="score-bd-pts">${Math.round(r.pts)}/${r.max}</span>
    </div>
  `).join("");
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

function renderCategoryGauges(sortedCats, totalExpense) {
  const grid = document.getElementById("catGaugeGrid");
  const empty = document.getElementById("catGaugeEmpty");
  if (sortedCats.length === 0 || totalExpense <= 0) {
    grid.style.display = "none";
    empty.style.display = "block";
    return;
  }
  grid.style.display = "grid";
  empty.style.display = "none";

  grid.innerHTML = sortedCats.map(([name, amt], i) => {
    const pct = (amt / totalExpense) * 100;
    const color = CAT_PALETTE[i % CAT_PALETTE.length];
    return `
      <div class="cat-gauge">
        <div class="gauge-half" style="--pct:${pct}; --gauge-color:${color}">
          <div class="gauge-half-inner"></div>
        </div>
        <div class="gauge-readout"><span class="gauge-pct">${pct.toFixed(0)}%</span></div>
        <div class="cat-gauge-name" title="${escapeHTML(name)}">${escapeHTML(name)}</div>
        <div class="cat-gauge-amt">${fmtMoney(amt)}</div>
      </div>`;
  }).join("");
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
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: incomeData, backgroundColor: inColor, borderRadius: 4, maxBarThickness: 22 },
        { label: "Expense", data: expenseData, backgroundColor: outColor, borderRadius: 4, maxBarThickness: 22 },
        { label: "Balance", data: balanceData, backgroundColor: accentColor, borderRadius: 4, maxBarThickness: 22 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: dimColor, font: { size: 10.5, family: "Inter" }, boxWidth: 10, usePointStyle: true, pointStyle: "circle" } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: dimColor, font: { size: 10, family: "Inter" } } },
        y: { beginAtZero: true, grid: { color: lineColor }, ticks: { color: dimColor, font: { size: 9, family: "Inter" }, callback: (v) => fmtMoney(v) } }
      }
    }
  });
}

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

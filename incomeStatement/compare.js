/* =========================================================
   BLACKROAD — compare.js (Compare page)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).

   Lets the user pick any two periods — either two months or
   two years — and see them side by side: totals, the same
   delta-pill comparison used on the dashboard hero, and a
   quick chart. All calculation mirrors the "This month" logic
   on the dashboard (app.js), just generalized to any period
   the user picks instead of "this month vs last month".
========================================================= */

let ENTRIES = [];
let MODE = "month";       // "month" | "year"
let cmpChart = null;
let trendChart = null;
let trendRange = "1y";    // "1m" | "6m" | "1y" | "3y" | "5y" | "10y" | "max"

/* ---------------- Period-key helpers ----------------
   month key: "YYYY-MM"  (e.g. "2026-08")
   year key:  "YYYY"     (e.g. "2026")               */

function monthKeyOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function yearKeyOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  return String(d.getFullYear());
}

function periodKeyOf(dateStr) {
  return MODE === "year" ? yearKeyOf(dateStr) : monthKeyOf(dateStr);
}

function monthKeyLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function periodLabel(key) {
  return MODE === "year" ? key : monthKeyLabel(key);
}

/* ---------------- Delta helpers (same math as the dashboard hero) ---------------- */

function fmtPct(n) {
  return (n > 0 ? "+" : "") + Math.round(n) + "%";
}

function computeDelta(curr, prev) {
  if (!prev) return { text: curr > 0 ? "New" : "—", cls: "flat" };
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.5) return { text: "flat", cls: "flat" };
  return { text: fmtPct(pct), cls: pct > 0 ? "up" : "down" };
}

function setDeltaPill(id, delta, invert) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = delta.text;
  let cls = delta.cls;
  if (invert && cls !== "flat") cls = cls === "up" ? "down" : "up";
  el.className = "delta-pill " + cls;
}

/* ---------------- Totals for a given period ---------------- */

function periodTotals(key) {
  let income = 0, expense = 0, txnCount = 0;
  const sourceTotals = new Map();   // e.from -> income sum   (income source)
  const categoryTotals = new Map(); // t.category -> expense sum (per-transaction)

  ENTRIES.forEach((e) => {
    if (periodKeyOf(e.date) !== key) return;
    const eIncome = Number(e.income) || 0;
    const eExpense = Number(e.expense) || 0;
    income += eIncome;
    expense += eExpense;

    if (eIncome > 0) {
      const src = e.from || "Other";
      sourceTotals.set(src, (sourceTotals.get(src) || 0) + eIncome);
    }

    (e.transactions || []).forEach((t) => {
      const amt = Number(t.amount) || 0;
      txnCount++;
      const cat = t.category || "uncategorized";
      categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + amt);
    });
  });

  const net = income - expense;
  const rate = income > 0 ? (net / income) * 100 : (expense > 0 ? -100 : 0);
  const topCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const topSource = [...sourceTotals.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return { income, expense, net, rate, txnCount, sourceTotals, categoryTotals, topCategory, topSource };
}

/* ---------------- Populate the period pickers ---------------- */

function availableKeys() {
  const keys = new Set();
  ENTRIES.forEach((e) => {
    const k = periodKeyOf(e.date);
    if (k) keys.add(k);
  });
  // newest first
  const sorted = [...keys].sort().reverse();
  if (sorted.length === 0) {
    // no data at all yet — still offer the current period so the page isn't empty
    sorted.push(periodKeyOf(todayISO()));
  }
  return sorted;
}

function populateSelects() {
  const keys = availableKeys();
  const selA = document.getElementById("cmpSelectA");
  const selB = document.getElementById("cmpSelectB");

  const prevA = selA.value, prevB = selB.value;
  const options = keys.map((k) => `<option value="${k}">${periodLabel(k)}</option>`).join("");
  selA.innerHTML = options;
  selB.innerHTML = options;

  // keep the previous selection if it's still valid for this mode,
  // otherwise default to the two most recent periods available
  selA.value = keys.includes(prevA) ? prevA : keys[0];
  selB.value = keys.includes(prevB) ? prevB : (keys[1] || keys[0]);
}

/* ---------------- Render ---------------- */

function renderCompare() {
  const keyA = document.getElementById("cmpSelectA").value;
  const keyB = document.getElementById("cmpSelectB").value;
  if (!keyA || !keyB) return;

  const a = periodTotals(keyA);
  const b = periodTotals(keyB);

  document.getElementById("cmpTitleA").textContent = periodLabel(keyA);
  document.getElementById("cmpTitleB").textContent = periodLabel(keyB);

  document.getElementById("cmpAIncome").textContent = fmtMoney(a.income);
  document.getElementById("cmpAExpense").textContent = fmtMoney(a.expense);
  document.getElementById("cmpANet").textContent = fmtMoney(a.net);
  document.getElementById("cmpARate").textContent = (a.income > 0 || a.expense > 0) ? Math.round(a.rate) + "%" : "—";
  document.getElementById("cmpANet").className = "cmp-row-val " + (a.net >= 0 ? "pos" : "neg");
  document.getElementById("cmpATxnCount").textContent = String(a.txnCount);
  document.getElementById("cmpATopCat").textContent = a.topCategory ? `${a.topCategory[0]} (${fmtMoney(a.topCategory[1])})` : "—";
  document.getElementById("cmpATopSrc").textContent = a.topSource ? `${a.topSource[0]} (${fmtMoney(a.topSource[1])})` : "—";

  document.getElementById("cmpBIncome").textContent = fmtMoney(b.income);
  document.getElementById("cmpBExpense").textContent = fmtMoney(b.expense);
  document.getElementById("cmpBNet").textContent = fmtMoney(b.net);
  document.getElementById("cmpBRate").textContent = (b.income > 0 || b.expense > 0) ? Math.round(b.rate) + "%" : "—";
  document.getElementById("cmpBNet").className = "cmp-row-val " + (b.net >= 0 ? "pos" : "neg");
  document.getElementById("cmpBTxnCount").textContent = String(b.txnCount);
  document.getElementById("cmpBTopCat").textContent = b.topCategory ? `${b.topCategory[0]} (${fmtMoney(b.topCategory[1])})` : "—";
  document.getElementById("cmpBTopSrc").textContent = b.topSource ? `${b.topSource[0]} (${fmtMoney(b.topSource[1])})` : "—";

  // ---- Deltas: A relative to B (B is the baseline, same role "prev" plays on the dashboard) ----
  document.getElementById("cmpDeltaIncomeVal").textContent = fmtMoney(a.income - b.income);
  document.getElementById("cmpDeltaExpenseVal").textContent = fmtMoney(a.expense - b.expense);
  document.getElementById("cmpDeltaNetVal").textContent = fmtMoney(a.net - b.net);
  document.getElementById("cmpDeltaRateVal").textContent = Math.round(a.rate - b.rate) + " pts";

  setDeltaPill("cmpDeltaIncome", computeDelta(a.income, b.income));
  setDeltaPill("cmpDeltaExpense", computeDelta(a.expense, b.expense), true);
  setDeltaPill("cmpDeltaNet", computeDelta(a.net, b.net));
  setDeltaPill("cmpDeltaRate", computeDelta(a.rate, b.rate));

  renderVerdict(keyA, keyB, a, b);
  renderChart(keyA, keyB, a, b);
  renderCategoryBreakdown(keyA, keyB, a, b);
}

/* ---------------- Expense-category breakdown, A vs B ----------------
   Pulled straight from each transaction's `category` field — the same
   field the Statistics page's gauges use, just grouped per period here
   instead of over all-time. */

function renderCategoryBreakdown(keyA, keyB, a, b) {
  const wrap = document.getElementById("cmpCatList");
  const empty = document.getElementById("cmpCatEmpty");

  const cats = new Set([...a.categoryTotals.keys(), ...b.categoryTotals.keys()]);
  if (cats.size === 0) {
    wrap.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const rows = [...cats].map((cat) => {
    const av = a.categoryTotals.get(cat) || 0;
    const bv = b.categoryTotals.get(cat) || 0;
    return { cat, av, bv, total: av + bv };
  }).sort((x, y) => y.total - x.total).slice(0, 8);

  const maxVal = Math.max(...rows.map((r) => Math.max(r.av, r.bv)), 1);

  wrap.innerHTML = rows.map((r) => `
    <div class="cmp-cat-row">
      <div class="cmp-cat-name">${escapeHTML(r.cat)}</div>
      <div class="cmp-cat-bars">
        <div class="cmp-cat-bar-line">
          <span class="cmp-cat-bar-track"><span class="cmp-cat-bar-fill a" style="width:${(r.av / maxVal) * 100}%"></span></span>
          <span class="cmp-cat-bar-amt">${fmtMoney(r.av)}</span>
        </div>
        <div class="cmp-cat-bar-line">
          <span class="cmp-cat-bar-track"><span class="cmp-cat-bar-fill b" style="width:${(r.bv / maxVal) * 100}%"></span></span>
          <span class="cmp-cat-bar-amt">${fmtMoney(r.bv)}</span>
        </div>
      </div>
    </div>
  `).join("");
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderVerdict(keyA, keyB, a, b) {
  const box = document.getElementById("cmpVerdict");
  const icon = box.querySelector("i");
  const text = document.getElementById("cmpVerdictText");
  const labelA = periodLabel(keyA), labelB = periodLabel(keyB);

  if (a.income === 0 && a.expense === 0 && b.income === 0 && b.expense === 0) {
    box.className = "cmp-verdict flat";
    icon.className = "bi bi-dash-circle";
    text.innerHTML = "No data logged for either period yet.";
    return;
  }

  const netDiff = a.net - b.net;
  if (Math.abs(netDiff) < 1) {
    box.className = "cmp-verdict flat";
    icon.className = "bi bi-arrow-left-right";
    text.innerHTML = `<strong>${labelA}</strong> and <strong>${labelB}</strong> netted about the same.`;
    return;
  }

  const better = netDiff > 0 ? labelA : labelB;
  const worse = netDiff > 0 ? labelB : labelA;
  const diffAbs = fmtMoney(Math.abs(netDiff));

  box.className = "cmp-verdict good";
  icon.className = "bi bi-graph-up-arrow";
  text.innerHTML = `<strong>${better}</strong> came out ${diffAbs} ahead of <strong>${worse}</strong> on net balance.`;
}

function renderChart(keyA, keyB, a, b) {
  const canvas = document.getElementById("cmpChart");
  const empty = document.getElementById("cmpChartEmpty");

  if (a.income === 0 && a.expense === 0 && b.income === 0 && b.expense === 0) {
    canvas.style.display = "none";
    empty.style.display = "block";
    if (cmpChart) { cmpChart.destroy(); cmpChart = null; }
    return;
  }
  canvas.style.display = "block";
  empty.style.display = "none";

  const style = getComputedStyle(document.documentElement);
  const inColor = style.getPropertyValue("--ink-in").trim() || "#3ddc84";
  const outColor = style.getPropertyValue("--ink-out").trim() || "#ff5c5c";
  const textDim = style.getPropertyValue("--text-dim").trim() || "#8891a3";
  const lineSoft = style.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";

  const data = {
    labels: [periodLabel(keyA), periodLabel(keyB)],
    datasets: [
      { label: "Income", data: [a.income, b.income], backgroundColor: inColor, borderRadius: 6 },
      { label: "Expense", data: [a.expense, b.expense], backgroundColor: outColor, borderRadius: 6 },
    ],
  };

  if (cmpChart) cmpChart.destroy();
  cmpChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textDim } },
      },
      scales: {
        x: { ticks: { color: textDim }, grid: { color: lineSoft } },
        y: { ticks: { color: textDim }, grid: { color: lineSoft }, beginAtZero: true },
      },
    },
  });
}

/* ---------------- Monthly trend (income / expense / balance) ----------------
   Independent of the Month/Year mode toggle above — this always groups
   by calendar month across every entry in the store, then the range
   buttons (1M/6M/.../MAX) just slice how many of those months show. */

function monthShortLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function monthlySeries() {
  const map = new Map(); // "YYYY-MM" -> { income, expense }
  ENTRIES.forEach((e) => {
    const mk = monthKeyOf(e.date);
    if (!mk) return;
    if (!map.has(mk)) map.set(mk, { income: 0, expense: 0 });
    const m = map.get(mk);
    m.income += Number(e.income) || 0;
    m.expense += Number(e.expense) || 0;
  });
  return map;
}

const RANGE_MONTHS = { "1m": 1, "6m": 6, "1y": 12, "3y": 36, "5y": 60, "10y": 120 };

function renderTrendChart() {
  const inner = document.getElementById("cmpTrendInner");
  const empty = document.getElementById("cmpTrendEmpty");
  const canvas = document.getElementById("cmpTrendChart");

  const series = monthlySeries();
  let keys = [...series.keys()].sort(); // chronological (zero-padded months sort correctly)

  if (trendRange !== "max") {
    const n = RANGE_MONTHS[trendRange];
    keys = keys.slice(-n);
  }

  if (keys.length === 0) {
    inner.style.display = "none";
    empty.style.display = "block";
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    return;
  }
  inner.style.display = "block";
  empty.style.display = "none";

  const labels = keys.map(monthShortLabel);
  const incomeData = keys.map((k) => series.get(k).income);
  const expenseData = keys.map((k) => series.get(k).expense);
  const balanceData = keys.map((k) => series.get(k).income - series.get(k).expense);

  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#8891a3";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";
  const inColor = cs.getPropertyValue("--ink-in").trim() || "#3ecf8e";
  const outColor = cs.getPropertyValue("--ink-out").trim() || "#f27a8a";
  const accentColor = cs.getPropertyValue("--accent").trim() || "#5b9dff";

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Income", data: incomeData, borderColor: inColor, backgroundColor: inColor, pointBackgroundColor: inColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: "Expense", data: expenseData, borderColor: outColor, backgroundColor: outColor, pointBackgroundColor: outColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
        { label: "Balance", data: balanceData, borderColor: accentColor, backgroundColor: accentColor, pointBackgroundColor: accentColor, tension: 0.3, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 },
      ],
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
            mode: "x",
          },
          limits: { x: { min: "original", max: "original" } },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: dimColor, font: { size: 10, family: "Inter" } } },
        y: { beginAtZero: true, grid: { color: lineColor }, ticks: { color: dimColor, font: { size: 9, family: "Inter" }, callback: (v) => fmtMoney(v) } },
      },
    },
  });
}

/* ---------------- Wiring ---------------- */

function setMode(mode) {
  MODE = mode;
  document.querySelectorAll("#cmpModeSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  populateSelects();
  renderCompare();
}

async function refresh() {
  ENTRIES = await getAllEntries();

  const empty = document.getElementById("cmpEmpty");
  const body = document.getElementById("cmpBody");
  if (ENTRIES.length === 0) {
    empty.style.display = "block";
    body.style.display = "none";
    return;
  }
  empty.style.display = "none";
  body.style.display = "";

  populateSelects();
  renderCompare();
  renderTrendChart();
}

document.getElementById("cmpModeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  setMode(btn.dataset.mode);
});

document.getElementById("cmpSelectA").addEventListener("change", renderCompare);
document.getElementById("cmpSelectB").addEventListener("change", renderCompare);

document.getElementById("cmpSwapBtn").addEventListener("click", () => {
  const selA = document.getElementById("cmpSelectA");
  const selB = document.getElementById("cmpSelectB");
  const tmp = selA.value;
  selA.value = selB.value;
  selB.value = tmp;
  renderCompare();
});

document.getElementById("cmpRangeSeg").addEventListener("click", (e) => {
  const btn = e.target.closest(".cmp-range-btn");
  if (!btn) return;
  trendRange = btn.dataset.range;
  document.querySelectorAll("#cmpRangeSeg .cmp-range-btn").forEach((b) => {
    b.classList.toggle("active", b === btn);
  });
  renderTrendChart();
});

document.getElementById("cmpTrendResetZoom").addEventListener("click", () => {
  if (trendChart) trendChart.resetZoom();
});

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

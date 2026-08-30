/* =========================================================
   BLACKROAD — app.js (dashboard page — summary only)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   This page is read-only: adding/editing income and expenses
   now happens on the Statement tab (statement.html / statement.js).
========================================================= */

let catChart = null;
let ENTRIES = [];

async function refresh() {
  ENTRIES = await getAllEntries();
  renderDashboard();
  renderThisMonth();
  renderRecentTransactions();
  renderTopExpenses();
  renderTopIncomeSources();
  await renderUpdateDateBadge();
}

async function renderUpdateDateBadge() {
  const el = document.getElementById("updateDateBadgeVal");
  if (el) el.textContent = fmtUpdateDate(await getUpdateDate());
}

function renderDashboard() {
  let totalIncome = 0, totalExpense = 0, totalInvestment = 0, totalCount = 0;
  const catTotals = new Map();
  const sourceTotals = new Map();

  ENTRIES.forEach((e) => {
    totalIncome += Number(e.income) || 0;
    totalExpense += Number(e.expense) || 0;
    totalInvestment += Number(e.investment) || 0;
    totalCount += (e.transactions || []).length;
    sourceTotals.set(e.from || "Other", (sourceTotals.get(e.from || "Other") || 0) + (Number(e.income) || 0));
    (e.transactions || []).forEach((t) => {
      if (isInvestmentCategory(t.category)) return; // investments aren't spend — kept out of the expense chart
      const cat = t.category || "uncategorized";
      catTotals.set(cat, (catTotals.get(cat) || 0) + (Number(t.amount) || 0));
    });
  });

  // ---- 4 quick-stat cards ----
  document.getElementById("qsIncome").textContent = fmtMoney(totalIncome);
  document.getElementById("qsExpense").textContent = fmtMoney(totalExpense);
  document.getElementById("qsBalance").textContent = fmtMoney(totalIncome - totalExpense);
  document.getElementById("qsCount").textContent = String(totalCount);
  const qsInv = document.getElementById("qsInvestment");
  if (qsInv) qsInv.textContent = fmtMoney(totalInvestment);

  // ---- Net balance hero card ----
  document.getElementById("statIncome").textContent = fmtMoney(totalIncome);
  document.getElementById("statExpense").textContent = fmtMoney(totalExpense);
  document.getElementById("statNet").textContent = fmtMoney(totalIncome - totalExpense);

  // ---- Income by source ----
  const sourceList = document.getElementById("sourceList");
  if (sourceTotals.size === 0) {
    sourceList.innerHTML = `<div class="chart-empty">No income logged yet</div>`;
  } else {
    sourceList.innerHTML = [...sourceTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, val]) => `
        <div class="source-row">
          <span>${escapeHTML(name)}</span>
          <span class="val">${fmtMoney(val)}</span>
        </div>`).join("");
  }

  // ---- Expense by category chart ----
  const chartEmpty = document.getElementById("catChartEmpty");
  const canvas = document.getElementById("catChart");
  const chartInner = document.getElementById("catChartInner");
  if (catTotals.size === 0) {
    chartEmpty.style.display = "block";
    chartInner.style.display = "none";
    if (catChart) { catChart.destroy(); catChart = null; }
    return;
  }
  chartEmpty.style.display = "none";
  chartInner.style.display = "block";

  // sort categories highest-spend first so the biggest bars are on top
  const sortedCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]);
  const labels = sortedCats.map(([name]) => name);
  const data = sortedCats.map(([, val]) => val);
  const palette = ["#b5583f", "#6f7bb3", "#4f8f6b", "#c99a4f", "#8a6bb0", "#5c9bc9", "#c96c8c"];
  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#8891a3";
  const textColor = cs.getPropertyValue("--text").trim() || "#e6e9ef";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";

  // one row per category, so the chart grows with the data instead of
  // squeezing everything into a fixed-size wheel — the outer .chart-wrap
  // scrolls once there are more rows than fit comfortably
  const rowHeight = 30;
  chartInner.style.height = Math.max(160, labels.length * rowHeight) + "px";

  if (catChart) catChart.destroy();
  catChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderRadius: 4,
        barThickness: 16,
        maxBarThickness: 18
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => fmtMoney(ctx.parsed.x) }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: lineColor },
          ticks: { color: dimColor, font: { size: 9, family: "Inter" }, callback: (v) => fmtMoney(v) }
        },
        y: {
          grid: { display: false },
          ticks: { color: textColor, font: { size: 10.5, family: "Inter" } }
        }
      }
    }
  });
}

/* Redraw the category chart with theme-correct colors whenever the
   theme changes (theme switching itself is handled in shared.js so
   every page — dashboard, statement, search, jump-to, backup — stays
   in sync). */
document.addEventListener("br-theme-changed", () => {
  renderDashboard();
});

/* =========================================================
   "This month" command-center — month summary, cash-flow
   trend, recent activity, and top movers. Reads the same
   ENTRIES cache as renderDashboard(); doesn't touch it.
   Entry shape: { id, income, date, from, expense, balance,
                  transactions:[{ id, amount, description,
                                  category, date, type }] }
========================================================= */

function monthKeyOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthKeyLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function fmtPct(n) {
  return (n > 0 ? "+" : "") + Math.round(n) + "%";
}

/* Compares curr vs prev and returns a { text, cls } pill descriptor.
   cls is "up" / "down" / "flat" based on curr vs prev, not on whether
   that direction is "good" — callers invert it for expense-like metrics
   where a smaller number is the favorable outcome. */
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

function monthTotals(key) {
  let income = 0, expense = 0;
  ENTRIES.forEach((e) => {
    if (monthKeyOf(e.date) === key) {
      income += Number(e.income) || 0;
      expense += Number(e.expense) || 0;
    }
  });
  return { income, expense, net: income - expense };
}

function renderThisMonth() {
  const nowKey = monthKeyOf(todayISO());
  const prevKey = shiftMonthKey(nowKey, -1);

  const cur = monthTotals(nowKey);
  const prev = monthTotals(prevKey);
  const curRate = cur.income > 0 ? (cur.net / cur.income) * 100 : (cur.expense > 0 ? -100 : 0);
  const prevRate = prev.income > 0 ? (prev.net / prev.income) * 100 : (prev.expense > 0 ? -100 : 0);

  document.getElementById("monthIndicator").textContent = monthKeyLabel(nowKey);
  document.getElementById("mIncome").textContent = fmtMoney(cur.income);
  document.getElementById("mExpense").textContent = fmtMoney(cur.expense);
  document.getElementById("mNet").textContent = fmtMoney(cur.net);
  document.getElementById("mSavingsRate").textContent =
    (cur.income > 0 || cur.expense > 0) ? Math.round(curRate) + "%" : "—";

  setDeltaPill("mIncomeDelta", computeDelta(cur.income, prev.income));
  setDeltaPill("mExpenseDelta", computeDelta(cur.expense, prev.expense), true);
  setDeltaPill("mNetDelta", computeDelta(cur.net, prev.net));
  setDeltaPill("mSavingsDelta", computeDelta(curRate, prevRate));

  renderHealthSummary(cur, curRate);
}

function renderHealthSummary(cur, rate) {
  const badge = document.getElementById("healthBadge");
  const summary = document.getElementById("healthSummary");

  if (cur.income === 0 && cur.expense === 0) {
    badge.textContent = "No data";
    badge.className = "health-badge";
    summary.textContent = "Log income or expenses this month to see your financial health here.";
    return;
  }

  let label, cls, msg;
  if (rate >= 20) {
    label = "Healthy"; cls = "good"; msg = "You're saving well — keep it up.";
  } else if (rate >= 10) {
    label = "Good"; cls = "good"; msg = "Solid savings this month.";
  } else if (rate >= 0) {
    label = "Tight"; cls = "warn"; msg = "Expenses are close to income — worth a closer look.";
  } else {
    label = "Overspending"; cls = "bad"; msg = "Expenses are outpacing income this month.";
  }
  badge.textContent = label;
  badge.className = "health-badge " + cls;
  summary.textContent = msg + " Savings rate: " + Math.round(rate) + "%.";
}

/* ---------------- Recent transactions (income + expense) ---------------- */

function renderRecentTransactions() {
  const list = document.getElementById("recentTxnList");
  const items = [];

  ENTRIES.forEach((e) => {
    items.push({ kind: "income", desc: e.from || "Income", cat: null, date: e.date, amount: Number(e.income) || 0 });
    (e.transactions || []).forEach((t) => {
      items.push({ kind: "expense", desc: t.description || "Expense", cat: t.category, date: t.date || e.date, amount: Number(t.amount) || 0 });
    });
  });

  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const recent = items.slice(0, 8);

  if (recent.length === 0) {
    list.innerHTML = `<div class="chart-empty">No transactions yet</div>`;
    return;
  }

  list.innerHTML = recent.map((it) => `
    <div class="mini-row">
      <span class="mini-ico ${it.kind}"><i class="bi ${it.kind === "income" ? "bi-arrow-down-left" : "bi-arrow-up-right"}"></i></span>
      <div class="mini-main">
        <span class="mini-desc">${escapeHTML(it.desc)}</span>
        ${it.cat ? `<span class="mini-cat">${escapeHTML(it.cat)}</span>` : ""}
      </div>
      <div class="mini-side">
        <span class="mini-amt ${it.kind}">${it.kind === "income" ? "+" : "-"}${fmtMoney(it.amount)}</span>
        <span class="mini-date">${it.date || ""}</span>
      </div>
    </div>`).join("");
}

/* ---------------- Top expenses this month ---------------- */

function renderTopExpenses() {
  const list = document.getElementById("topExpensesList");
  const nowKey = monthKeyOf(todayISO());
  const expenses = [];

  ENTRIES.forEach((e) => {
    (e.transactions || []).forEach((t) => {
      if (isInvestmentCategory(t.category)) return; // investments have their own list, not "expenses"
      const d = t.date || e.date;
      if (monthKeyOf(d) === nowKey) {
        expenses.push({ desc: t.description || "Expense", cat: t.category, date: d, amount: Number(t.amount) || 0 });
      }
    });
  });

  expenses.sort((a, b) => b.amount - a.amount);
  const top = expenses.slice(0, 5);

  if (top.length === 0) {
    list.innerHTML = `<div class="chart-empty">No expenses logged this month</div>`;
    return;
  }

  list.innerHTML = top.map((it) => `
    <div class="mini-row">
      <span class="mini-ico expense"><i class="bi bi-arrow-up-right"></i></span>
      <div class="mini-main">
        <span class="mini-desc">${escapeHTML(it.desc)}</span>
        ${it.cat ? `<span class="mini-cat">${escapeHTML(it.cat)}</span>` : ""}
      </div>
      <div class="mini-side">
        <span class="mini-amt expense">-${fmtMoney(it.amount)}</span>
        <span class="mini-date">${it.date || ""}</span>
      </div>
    </div>`).join("");
}

/* ---------------- Top income sources this month ---------------- */

function renderTopIncomeSources() {
  const list = document.getElementById("topIncomeList");
  const nowKey = monthKeyOf(todayISO());
  const totals = new Map();

  ENTRIES.forEach((e) => {
    if (monthKeyOf(e.date) === nowKey) {
      const name = e.from || "Other";
      totals.set(name, (totals.get(name) || 0) + (Number(e.income) || 0));
    }
  });

  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (top.length === 0) {
    list.innerHTML = `<div class="chart-empty">No income logged this month</div>`;
    return;
  }

  list.innerHTML = top.map(([name, val]) => `
    <div class="mini-row">
      <span class="mini-ico income"><i class="bi bi-arrow-down-left"></i></span>
      <div class="mini-main">
        <span class="mini-desc">${escapeHTML(name)}</span>
      </div>
      <div class="mini-side">
        <span class="mini-amt income">+${fmtMoney(val)}</span>
      </div>
    </div>`).join("");
}

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

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
}

function renderDashboard() {
  let totalIncome = 0, totalExpense = 0, totalCount = 0;
  const catTotals = new Map();
  const sourceTotals = new Map();

  ENTRIES.forEach((e) => {
    totalIncome += Number(e.income) || 0;
    totalExpense += Number(e.expense) || 0;
    totalCount += (e.transactions || []).length;
    sourceTotals.set(e.from || "Other", (sourceTotals.get(e.from || "Other") || 0) + (Number(e.income) || 0));
    (e.transactions || []).forEach((t) => {
      const cat = t.category || "uncategorized";
      catTotals.set(cat, (catTotals.get(cat) || 0) + (Number(t.amount) || 0));
    });
  });

  // ---- 4 quick-stat cards ----
  document.getElementById("qsIncome").textContent = fmtMoney(totalIncome);
  document.getElementById("qsExpense").textContent = fmtMoney(totalExpense);
  document.getElementById("qsBalance").textContent = fmtMoney(totalIncome - totalExpense);
  document.getElementById("qsCount").textContent = String(totalCount);

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
document.addEventListener("br-theme-changed", () => renderDashboard());

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

/* =========================================================
   BLACKROAD — expand.js (expand.html — full view of one dashboard
   breakdown panel: Expense by category / Income by source /
   Income by category / Investment returns)
   Depends on shared.js (DB helpers, format utilities, theme
   system, left-nav wiring). Reads which panel to show from the
   ?panel= query string set by the expand button on index.html.
========================================================= */

const PANEL_CONFIG = {
  "expense": {
    title: "Expense by category",
    icon: "bi-pie-chart-fill",
    kind: "chart",
    palette: ["#b5583f", "#6f7bb3", "#4f8f6b", "#c99a4f", "#8a6bb0", "#5c9bc9", "#c96c8c"],
    emptyText: "No expenses logged yet"
  },
  "income-source": {
    title: "Income by source",
    icon: "bi-cash-coin",
    kind: "list",
    emptyText: "No income logged yet"
  },
  "income-category": {
    title: "Income by category",
    icon: "bi-pie-chart-fill",
    kind: "chart",
    palette: ["#3ecf8e", "#5b9dff", "#e3ac54", "#7fd0d9", "#c07fe0", "#8fbf5e", "#e08fa8"],
    emptyText: "No income logged yet"
  },
  "investment-returns": {
    title: "Investment returns",
    icon: "bi-graph-up-arrow",
    kind: "list",
    sub: "Dividends, interest and other portfolio earnings — kept separate from salary/genuine income above.",
    emptyText: "No investment returns logged yet"
  }
};

let expandChart = null;
let currentPanelKey = null;
let ENTRIES = [];

/* Same totals computed on the dashboard (app.js renderDashboard) —
   kept in one place here since this page only ever needs one of
   the four at a time, but they're cheap to compute together. */
function computeBreakdownTotals(entries) {
  const catTotals = new Map();          // expense by category
  const sourceTotals = new Map();       // genuine income by source
  const incomeCatTotals = new Map();    // genuine income by category
  const invReturnTotals = new Map();    // investment-return categories

  entries.forEach((e) => {
    const genuineAmt = entryGenuineIncomeAmount(e);
    if (genuineAmt > 0) {
      sourceTotals.set(e.from || "Other", (sourceTotals.get(e.from || "Other") || 0) + genuineAmt);
      const incCat = e.category || "Uncategorized";
      incomeCatTotals.set(incCat, (incomeCatTotals.get(incCat) || 0) + genuineAmt);
    }
    const returnAmt = entryInvestmentReturnAmount(e);
    if (returnAmt > 0) {
      const key = e.category || "Investment return";
      invReturnTotals.set(key, (invReturnTotals.get(key) || 0) + returnAmt);
    }
    (e.transactions || []).forEach((t) => {
      if (isInvestmentCategory(t.category)) return;
      const cat = t.category || "uncategorized";
      catTotals.set(cat, (catTotals.get(cat) || 0) + (Number(t.amount) || 0));
    });
  });

  return { catTotals, sourceTotals, incomeCatTotals, invReturnTotals };
}

function totalsForPanel(key, totals) {
  if (key === "expense") return totals.catTotals;
  if (key === "income-source") return totals.sourceTotals;
  if (key === "income-category") return totals.incomeCatTotals;
  if (key === "investment-returns") return totals.invReturnTotals;
  return new Map();
}

function renderChart(totals, palette) {
  const wrap = document.getElementById("expandChartWrap");
  const innerEl = document.getElementById("expandChartInner");
  const emptyEl = document.getElementById("expandChartEmpty");
  const canvasEl = document.getElementById("expandChart");
  const listEl = document.getElementById("expandList");

  wrap.style.display = "block";
  listEl.style.display = "none";

  if (totals.size === 0) {
    innerEl.style.display = "none";
    emptyEl.style.display = "block";
    if (expandChart) { expandChart.destroy(); expandChart = null; }
    return;
  }
  innerEl.style.display = "block";
  emptyEl.style.display = "none";

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([name]) => name);
  const data = sorted.map(([, val]) => val);
  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#9AA8B6";
  const textColor = cs.getPropertyValue("--text").trim() || "#F1F5F9";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(38,52,67,0.6)";

  // No 340px card to fit inside here, so each row gets more room to
  // breathe than the compact dashboard version does.
  const rowHeight = 38;
  innerEl.style.height = Math.max(360, labels.length * rowHeight) + "px";

  if (expandChart) expandChart.destroy();
  expandChart = new Chart(canvasEl.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        borderRadius: 5,
        barThickness: 20,
        maxBarThickness: 24
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 10 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtMoney(ctx.parsed.x) } }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: lineColor },
          ticks: { color: dimColor, font: { size: 10, family: "Inter" }, callback: (v) => fmtMoney(v) }
        },
        y: {
          grid: { display: false },
          ticks: { color: textColor, font: { size: 12, family: "Inter" } }
        }
      }
    }
  });
}

function renderList(totals, emptyText) {
  const wrap = document.getElementById("expandChartWrap");
  const listEl = document.getElementById("expandList");
  wrap.style.display = "none";
  listEl.style.display = "block";

  if (expandChart) { expandChart.destroy(); expandChart = null; }

  if (totals.size === 0) {
    listEl.innerHTML = `<div class="chart-empty">${escapeHTML(emptyText)}</div>`;
    return;
  }
  listEl.innerHTML = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, val]) => `
      <div class="source-row">
        <span>${escapeHTML(name)}</span>
        <span class="val">${fmtMoney(val)}</span>
      </div>`).join("");
}

function renderExpandPanel() {
  const cfg = PANEL_CONFIG[currentPanelKey];
  if (!cfg) return;

  document.title = "BlackRoad — " + cfg.title;
  document.getElementById("expandTitle").textContent = cfg.title;
  document.getElementById("expandIco").className = "bi " + cfg.icon;
  document.getElementById("expandSub").textContent = cfg.sub || "";

  const totals = totalsForPanel(currentPanelKey, computeBreakdownTotals(ENTRIES));
  if (cfg.kind === "chart") {
    renderChart(totals, cfg.palette);
  } else {
    renderList(totals, cfg.emptyText);
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  currentPanelKey = params.get("panel");

  if (!PANEL_CONFIG[currentPanelKey]) {
    // Unknown or missing ?panel= — send back to the dashboard rather
    // than showing a blank page.
    window.location.replace("index.html");
    return;
  }

  db = await openDB();
  ENTRIES = await getAllEntries();
  renderExpandPanel();
  revealPage("expandBody", "expandSkeleton");
}

document.addEventListener("br-theme-changed", () => {
  if (currentPanelKey) renderExpandPanel();
});

init();

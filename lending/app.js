/* =========================================================
   LENDLEDGER — app.js (dashboard page — summary only)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   This page is read-only: adding/editing people and entries
   happens on the People tab (people.html / person.html).
========================================================= */

let partyChart = null;
let PARTIES = [];
let ENTRIES = [];

async function refresh() {
  PARTIES = await getAllParties();
  ENTRIES = await getAllEntries();
  renderDashboard();
}

function entriesFor(partyId) {
  return ENTRIES.filter((e) => e.partyId === partyId);
}

function renderDashboard() {
  let totalReceivable = 0, totalPayable = 0;
  const rows = PARTIES.map((p) => {
    const { balance } = computeBalance(entriesFor(p.id));
    if (balance > 0) totalReceivable += balance;
    else totalPayable += -balance;
    return { name: p.name, balance };
  });

  const net = totalReceivable - totalPayable;

  document.getElementById("qsReceivable").textContent = fmtMoney(totalReceivable);
  document.getElementById("qsPayable").textContent = fmtMoney(totalPayable);
  document.getElementById("qsNet").textContent = fmtMoney(net);
  document.getElementById("qsCount").textContent = String(PARTIES.length);

  document.getElementById("statReceivable").textContent = fmtMoney(totalReceivable);
  document.getElementById("statPayable").textContent = fmtMoney(totalPayable);
  document.getElementById("statNet").textContent = fmtMoney(net);

  // ---- People list ----
  const sourceList = document.getElementById("sourceList");
  if (rows.length === 0) {
    sourceList.innerHTML = `<div class="chart-empty">No people added yet</div>`;
  } else {
    sourceList.innerHTML = rows
      .slice()
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
      .map((r) => `
        <div class="source-row">
          <span>${escapeHTML(r.name)}</span>
          <span class="val" style="color:${r.balance < 0 ? "var(--ink-out)" : r.balance > 0 ? "var(--ink-in)" : "var(--text-dim)"}">
            ${r.balance < 0 ? "You'll give " : r.balance > 0 ? "You'll get " : "Settled"}${r.balance !== 0 ? fmtMoney(Math.abs(r.balance)) : ""}
          </span>
        </div>`).join("");
  }

  // ---- Balance by person chart ----
  const chartEmpty = document.getElementById("partyChartEmpty");
  const canvas = document.getElementById("partyChart");
  const chartInner = document.getElementById("partyChartInner");
  const nonZero = rows.filter((r) => r.balance !== 0);
  if (nonZero.length === 0) {
    chartEmpty.style.display = "block";
    chartInner.style.display = "none";
    if (partyChart) { partyChart.destroy(); partyChart = null; }
    return;
  }
  chartEmpty.style.display = "none";
  chartInner.style.display = "block";

  const sorted = nonZero.slice().sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  const labels = sorted.map((r) => r.name);
  const data = sorted.map((r) => r.balance);
  const cs = getComputedStyle(document.documentElement);
  const dimColor = cs.getPropertyValue("--text-dim").trim() || "#8891a3";
  const textColor = cs.getPropertyValue("--text").trim() || "#e6e9ef";
  const lineColor = cs.getPropertyValue("--line-soft").trim() || "rgba(255,255,255,0.08)";
  const inColor = cs.getPropertyValue("--ink-in").trim() || "#3ecf8e";
  const outColor = cs.getPropertyValue("--ink-out").trim() || "#f27a8a";

  const rowHeight = 30;
  chartInner.style.height = Math.max(160, labels.length * rowHeight) + "px";

  if (partyChart) partyChart.destroy();
  partyChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: data.map((v) => (v < 0 ? outColor : inColor)),
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
          callbacks: {
            label: (ctx) => (ctx.parsed.x < 0 ? "You'll give " : "You'll get ") + fmtMoney(Math.abs(ctx.parsed.x))
          }
        }
      },
      scales: {
        x: {
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

document.addEventListener("ll-theme-changed", () => renderDashboard());

(async function init() {
  try {
    db = await openDB();
    await refresh();
  } catch (err) {
    console.error("LendLedger DB error:", err);
    showToast("Could not open local database — " + (err && err.message ? err.message : "try clearing site data"));
  }
})();

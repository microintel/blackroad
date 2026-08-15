/* =========================================================
   BLACKROAD — jumpto.js
   Standalone jump-to page. Depends on shared.js.
========================================================= */

const jumpList = document.getElementById("jumpList");

(async function init() {
  try {
    db = await openDB();
    const entries = await getAllEntries();

    // year -> Map(monthLabel -> {anchorId, count, latestDate})
    const years = new Map();
    entries.forEach((e) => {
      const y = yearOf(e.date);
      const label = monthLabel(e.date);
      if (!years.has(y)) years.set(y, new Map());
      const monthMap = years.get(y);
      if (!monthMap.has(label)) {
        monthMap.set(label, { anchorId: monthAnchorId(y, label), count: 0 });
      }
      monthMap.get(label).count += 1;
    });

    if (years.size === 0) {
      jumpList.innerHTML = `
        <div class="empty-state">
          <span class="mark-big"><i class="bi bi-calendar3"></i></span>
          <h3>Nothing to jump to yet</h3>
          <p>Add an income entry on the Statement page and it'll show up here.</p>
        </div>`;
      return;
    }

    // sort years descending
    const sortedYears = [...years.keys()].sort((a, b) => b.localeCompare(a));

    jumpList.innerHTML = sortedYears.map((year) => {
      const monthMap = years.get(year);
      const monthsHTML = [...monthMap.entries()].map(([label, info]) => `
        <a class="jump-month-link" href="statement.html?jump=${encodeURIComponent(info.anchorId)}">
          <span>${label}</span>
          <span class="arrow">${info.count} entr${info.count === 1 ? "y" : "ies"} <i class="bi bi-arrow-right"></i></span>
        </a>`).join("");
      return `
        <div class="jump-year">
          <h3><i class="bi bi-calendar3"></i> ${year}</h3>
          <div class="jump-months">${monthsHTML}</div>
        </div>`;
    }).join("");
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

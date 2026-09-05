/* =========================================================
   LENDLEDGER — person.js (one person's running ledger)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
========================================================= */

const partyId = Number(new URLSearchParams(location.search).get("id"));

let PARTY = null;
let ENTRIES = [];
let openYears = null;
let yearsSeen = new Set();

async function refresh() {
  const parties = await getAllParties();
  PARTY = parties.find((p) => p.id === partyId);
  if (!PARTY) {
    document.getElementById("ledgerBody").innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-person-x"></i></span>
        <h3>Person not found</h3>
        <p>This person may have been deleted.</p>
        <a class="add-income-btn" href="people.html"><i class="bi bi-arrow-left"></i> Back to people</a>
      </div>`;
    document.getElementById("personName").textContent = "Not found";
    return;
  }
  const all = await getAllEntries();
  ENTRIES = all.filter((e) => e.partyId === partyId);
  ENTRIES.sort((a, b) => new Date(b.date) - new Date(a.date));
  renderHeader();
  renderLedger();
}

function renderHeader() {
  document.getElementById("personName").textContent = PARTY.name || "Unnamed";
  const { totalGave, totalGot, balance } = computeBalance(ENTRIES);
  document.getElementById("statGave").textContent = fmtMoney(totalGave);
  document.getElementById("statGot").textContent = fmtMoney(totalGot);
  document.getElementById("statBalance").textContent = fmtMoney(Math.abs(balance));
  document.getElementById("statBalanceLabel").textContent =
    balance > 0 ? "You'll get" : balance < 0 ? "You'll give" : "Settled";
}

function renderLedger() {
  const body = document.getElementById("ledgerBody");

  if (ENTRIES.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-piggy-bank"></i></span>
        <h3>No entries yet</h3>
        <p>Log the first "You gave" or "You got" entry with ${escapeHTML(PARTY.name || "this person")}.</p>
        <button class="add-income-btn" onclick="document.getElementById('addEntryBtn').click()"><i class="bi bi-plus-lg"></i> Add entry</button>
      </div>`;
    return;
  }

  const years = new Map();
  ENTRIES.forEach((e) => {
    const y = yearOf(e.date);
    const label = monthLabel(e.date);
    if (!years.has(y)) years.set(y, new Map());
    const monthMap = years.get(y);
    if (!monthMap.has(label)) monthMap.set(label, []);
    monthMap.get(label).push(e);
  });

  if (openYears === null) openYears = new Set();
  const sortedYearKeys = [...years.keys()];
  sortedYearKeys.forEach((y, idx) => {
    if (!yearsSeen.has(y)) {
      yearsSeen.add(y);
      if (idx === 0) openYears.add(y);
    }
  });

  let html = "";
  for (const [year, monthMap] of years) {
    let yGave = 0, yGot = 0, yCount = 0;
    monthMap.forEach((entries) => {
      entries.forEach((e) => {
        if (e.type === "gave") yGave += Number(e.amount) || 0;
        else yGot += Number(e.amount) || 0;
        yCount++;
      });
    });
    const isOpen = openYears.has(year);
    html += `<div class="year-group ${isOpen ? "open" : ""}" data-year="${year}">
      <div class="year-header" onclick="toggleYear('${year}')">
        <span class="year-caret"><i class="bi bi-chevron-right"></i></span>
        <span class="year-title">${year}</span>
        <span class="year-summary">
          <span class="yin">+${fmtMoney(yGave)}</span>
          <span class="yout">-${fmtMoney(yGot)}</span>
          <span>${yCount} entr${yCount === 1 ? "y" : "ies"}</span>
        </span>
      </div>
      <div class="year-body">`;
    for (const [label, entries] of monthMap) {
      html += `<div class="month-group">
        <div class="month-label">${label}</div>
        <div class="spine">`;
      entries.forEach((e) => { html += renderEntryRow(e); });
      html += `</div></div>`;
    }
    html += `</div></div>`;
  }
  body.innerHTML = html;
}

function toggleYear(year) {
  if (openYears.has(year)) openYears.delete(year); else openYears.add(year);
  renderLedger();
}

function renderEntryRow(e) {
  const isGave = e.type === "gave";

  let dueBadge = "";
  if (e.dueDate) {
    const days = daysUntil(e.dueDate);
    const overdue = days !== null && days < 0;
    const dueSoon = days !== null && days >= 0 && days <= 7;
    const cls = overdue ? "warn" : "";
    const label = overdue ? `Overdue · was due ${e.dueDate}` : dueSoon ? `Due soon · ${e.dueDate}` : `Due ${e.dueDate}`;
    dueBadge = `<span class="cat ${cls}"><i class="bi bi-calendar-event"></i> ${label}</span>`;
  }

  return `
    <div class="txn-row">
      <span class="txn-ico"><i class="bi ${isGave ? "bi-arrow-down-left" : "bi-arrow-up-right"}"></i></span>
      <div class="txn-amt" style="color:${isGave ? "var(--ink-in)" : "var(--ink-out)"}">${isGave ? "+" : "-"}${fmtMoney(e.amount)}</div>
      <div class="txn-date">${e.date || ""}</div>
      <div class="txn-desc">
        ${isGave ? "You gave" : "You got"}
        ${e.note ? `<span class="cat">${escapeHTML(e.note)}</span>` : ""}
        ${dueBadge}
      </div>
      <div class="entry-actions">
        <button class="icon-btn" title="Edit" onclick="openEntryDialog(${e.id})"><i class="bi bi-pencil"></i></button>
        <button class="icon-btn danger" title="Delete" onclick="confirmDeleteEntry(${e.id})"><i class="bi bi-trash3"></i></button>
      </div>
    </div>`;
}

/* ---------------- Dialog wiring ---------------- */

function openDialog(id) {
  const el = document.getElementById(id);
  if (el.open) return; // already showing — calling showModal() again throws
  el.showModal();
}
function closeDialog(id) { document.getElementById(id).close(); }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.dataset.close));
});

/* -- Entry dialog -- */
let editingEntryId = null;

function openEntryDialog(entryId) {
  try {
    editingEntryId = entryId || null;
    const form = document.getElementById("entryForm");
    form.reset();
    document.getElementById("entryDate").value = todayISO();
    const title = document.getElementById("entryDialogTitle");

    if (entryId) {
      const e = ENTRIES.find((x) => x.id === entryId);
      if (!e) throw new Error("That entry couldn't be found — try refreshing the page.");
      title.textContent = "Edit entry";
      document.getElementById("entryType").value = e.type;
      document.getElementById("entryAmount").value = e.amount;
      document.getElementById("entryDate").value = e.date;
      document.getElementById("entryDueDate").value = e.dueDate || "";
      document.getElementById("entryNote").value = e.note || "";
    } else {
      title.textContent = "Add entry";
    }
    openDialog("entryDialog");
  } catch (err) {
    console.error("Failed to open entry dialog:", err);
    editingEntryId = null;
    showToast(err && err.message ? err.message : "Couldn't open the entry form");
  }
}

document.getElementById("addEntryBtn").addEventListener("click", () => openEntryDialog(null));

document.getElementById("entryForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to save entries — guest mode is view-only.");
    closeDialog("entryDialog");
    return;
  }
  const type = document.getElementById("entryType").value;
  const amount = parseFloat(document.getElementById("entryAmount").value) || 0;
  const date = document.getElementById("entryDate").value;
  const dueDate = document.getElementById("entryDueDate").value || "";
  const note = document.getElementById("entryNote").value.trim();

  try {
    if (editingEntryId) {
      const e = ENTRIES.find((x) => x.id === editingEntryId);
      Object.assign(e, { type, amount, date, dueDate, note });
      await putEntry(e);
      showToast("Entry updated");
    } else {
      await putEntry({ partyId, type, amount, date, dueDate, note });
      showToast("Entry added");
    }
    closeDialog("entryDialog");
    editingEntryId = null;
    await refresh();
  } catch (err) {
    console.error("Failed to save entry:", err);
    showToast("Couldn't save — " + (err && err.message ? err.message : "database error"));
  }
});

/* -- Edit person dialog -- */
document.getElementById("editPersonBtn").addEventListener("click", () => {
  document.getElementById("personNameInput").value = PARTY.name || "";
  document.getElementById("personPhoneInput").value = PARTY.phone || "";
  document.getElementById("personNoteInput").value = PARTY.note || "";
  openDialog("personDialog");
});

document.getElementById("personForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to save changes — guest mode is view-only.");
    closeDialog("personDialog");
    return;
  }
  PARTY.name = document.getElementById("personNameInput").value.trim();
  PARTY.phone = document.getElementById("personPhoneInput").value.trim();
  PARTY.note = document.getElementById("personNoteInput").value.trim();
  try {
    await putParty(PARTY);
    closeDialog("personDialog");
    showToast("Person updated");
    await refresh();
  } catch (err) {
    console.error("Failed to update person:", err);
    showToast("Couldn't save — " + (err && err.message ? err.message : "database error"));
  }
});

/* -- Confirm delete (entry or whole person) -- */
let pendingDelete = null; // { type: 'entry'|'person', entryId }

function confirmDeleteEntry(entryId) {
  pendingDelete = { type: "entry", entryId };
  document.getElementById("confirmTitle").textContent = "Delete this entry?";
  document.getElementById("confirmBody").textContent = "This can't be undone.";
  openDialog("confirmDialog");
}

document.getElementById("confirmYesBtn").addEventListener("click", async () => {
  if (!pendingDelete) return;
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to delete entries — guest mode is view-only.");
    pendingDelete = null;
    closeDialog("confirmDialog");
    return;
  }
  if (pendingDelete.type === "entry") {
    await deleteEntryDB(pendingDelete.entryId);
    showToast("Entry deleted");
  }
  pendingDelete = null;
  closeDialog("confirmDialog");
  await refresh();
});

/* ---------------- Boot ---------------- */

(async function init() {
  try {
    db = await openDB();
    await refresh();
  } catch (err) {
    console.error("LendLedger DB error:", err);
    showToast("Could not open local database — " + (err && err.message ? err.message : "try clearing site data"));
  }
})();

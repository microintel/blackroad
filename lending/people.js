/* =========================================================
   LENDLEDGER — people.js (the People directory)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, theme system and left-nav wiring live there).
   Individual transactions ("You Gave" / "You Got") are added
   and edited on each person's own page (person.html?id=..).
========================================================= */

let PARTIES = [];
let ENTRIES = [];
let searchTerm = "";
let balanceFilter = "";

async function refresh() {
  PARTIES = await getAllParties();
  ENTRIES = await getAllEntries();
  PARTIES.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  renderPeople();
}

function entriesFor(partyId) {
  return ENTRIES.filter((e) => e.partyId === partyId);
}

function renderPeople() {
  const body = document.getElementById("peopleBody");
  const statusEl = document.getElementById("searchStatus");

  const rows = PARTIES.map((p) => {
    const { balance } = computeBalance(entriesFor(p.id));
    return { party: p, balance };
  });

  let visible = rows;
  const hasFilter = !!(searchTerm || balanceFilter);
  if (hasFilter) {
    visible = rows.filter((r) => {
      const nameMatch = !searchTerm || (r.party.name || "").toLowerCase().includes(searchTerm.toLowerCase());
      let balMatch = true;
      if (balanceFilter === "get") balMatch = r.balance > 0;
      else if (balanceFilter === "give") balMatch = r.balance < 0;
      else if (balanceFilter === "settled") balMatch = r.balance === 0;
      return nameMatch && balMatch;
    });
    statusEl.style.display = "block";
    statusEl.textContent = visible.length === 0
      ? "No people match this filter"
      : `${visible.length} ${visible.length === 1 ? "person matches" : "people match"} this filter`;
  } else {
    statusEl.style.display = "none";
  }

  if (PARTIES.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-people"></i></span>
        <h3>No people yet</h3>
        <p>Add the first person you lend to or borrow from to start tracking your balance with them.</p>
        <button class="add-income-btn" onclick="document.getElementById('addPersonBtn').click()"><i class="bi bi-plus-lg"></i> Add person</button>
      </div>`;
    return;
  }

  if (hasFilter && visible.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-search"></i></span>
        <h3>No matches</h3>
        <p>Nobody in your list matches this search or filter.</p>
      </div>`;
    return;
  }

  visible.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  let html = `<div class="month-group"><div class="spine">`;
  visible.forEach((r) => { html += renderPersonRow(r.party, r.balance); });
  html += `</div></div>`;
  body.innerHTML = html;
}

function renderPersonRow(p, balance) {
  const isGet = balance > 0;
  const isGive = balance < 0;
  const statusLabel = isGet ? "You'll get" : isGive ? "You'll give" : "Settled";
  const balanceClass = balance === 0 ? "zero" : "";
  const amountColor = isGive ? "var(--ink-out)" : isGet ? "var(--ink-in)" : "var(--text-dim)";

  return `
    <div class="entry" data-id="${p.id}">
      <div class="entry-card">
        <div class="entry-head" style="cursor:pointer;" onclick="location.href='person.html?id=${p.id}'">
          <div class="entry-row-top">
            <div class="entry-from">${escapeHTML(p.name || "Unnamed")}</div>
            <div class="entry-income" style="color:${amountColor}">${balance === 0 ? "—" : fmtMoney(Math.abs(balance))}</div>
            <div class="entry-actions">
              <button class="icon-btn" title="Edit" onclick="event.stopPropagation(); openPersonDialog(${p.id})"><i class="bi bi-pencil"></i></button>
              <button class="icon-btn danger" title="Delete" onclick="event.stopPropagation(); confirmDeletePerson(${p.id})"><i class="bi bi-trash3"></i></button>
            </div>
          </div>
          <div class="entry-row-bottom">
            <div class="entry-date">${escapeHTML(p.phone || p.note || "")}</div>
            <div class="entry-meta-pills">
              <span class="entry-balance ${balanceClass}">${statusLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ---------------- Dialog wiring ---------------- */

function openDialog(id) {
  const el = document.getElementById(id);
  if (el.open) return;
  el.showModal();
}
function closeDialog(id) { document.getElementById(id).close(); }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.dataset.close));
});

let editingPersonId = null;

function openPersonDialog(id) {
  editingPersonId = id || null;
  const form = document.getElementById("personForm");
  form.reset();
  const title = document.getElementById("personDialogTitle");

  if (id) {
    const p = PARTIES.find((x) => x.id === id);
    title.textContent = "Edit person";
    document.getElementById("personName").value = p.name || "";
    document.getElementById("personPhone").value = p.phone || "";
    document.getElementById("personNote").value = p.note || "";
  } else {
    title.textContent = "Add person";
  }
  openDialog("personDialog");
}

document.getElementById("addPersonBtn").addEventListener("click", () => openPersonDialog(null));

document.getElementById("personForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = document.getElementById("personName").value.trim();
  const phone = document.getElementById("personPhone").value.trim();
  const note = document.getElementById("personNote").value.trim();

  try {
    if (editingPersonId) {
      const p = PARTIES.find((x) => x.id === editingPersonId);
      Object.assign(p, { name, phone, note });
      await putParty(p);
      showToast("Person updated");
    } else {
      await putParty({ name, phone, note });
      showToast("Person added");
    }
    closeDialog("personDialog");
    editingPersonId = null;
    await refresh();
  } catch (err) {
    console.error("Failed to save person:", err);
    showToast("Couldn't save — " + (err && err.message ? err.message : "database error"));
  }
});

/* -- Confirm delete -- */
let pendingDeleteId = null;

function confirmDeletePerson(id) {
  const p = PARTIES.find((x) => x.id === id);
  const count = entriesFor(id).length;
  pendingDeleteId = id;
  document.getElementById("confirmTitle").textContent = "Delete this person?";
  document.getElementById("confirmBody").textContent =
    `This removes "${p.name}" and all ${count} linked entr${count === 1 ? "y" : "ies"}. This can't be undone.`;
  openDialog("confirmDialog");
}

document.getElementById("confirmYesBtn").addEventListener("click", async () => {
  if (pendingDeleteId == null) return;
  await deleteEntriesForParty(pendingDeleteId);
  await deletePartyDB(pendingDeleteId);
  showToast("Person deleted");
  pendingDeleteId = null;
  closeDialog("confirmDialog");
  await refresh();
});

/* ---------------- Search / filter ---------------- */

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim();
  renderPeople();
});
document.getElementById("balanceFilter").addEventListener("change", (e) => {
  balanceFilter = e.target.value;
  renderPeople();
});

/* ---------------- Boot ---------------- */

function handleDeepLink() {
  const params = new URLSearchParams(location.search);
  if (params.get("addPerson")) {
    openPersonDialog(null);
    const url = new URL(window.location);
    url.searchParams.delete("addPerson");
    window.history.replaceState({}, "", url);
  }
}

(async function init() {
  try {
    db = await openDB();
    await refresh();
    handleDeepLink();
  } catch (err) {
    console.error("LendLedger DB error:", err);
    showToast("Could not open local database — " + (err && err.message ? err.message : "try clearing site data"));
  }
})();

/* =========================================================
   BLACKROAD — backup.js
   Standalone import / export / clear-all page. Depends on shared.js.
========================================================= */

let ENTRIES = [];

function openDialog(id) { document.getElementById(id).showModal(); }
function closeDialog(id) { document.getElementById(id).close(); }
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.dataset.close));
});

function updateSummary() {
  const txnCount = ENTRIES.reduce((sum, e) => sum + (e.transactions || []).length, 0);
  document.getElementById("dataSummary").textContent =
    ENTRIES.length === 0
      ? "Your ledger is currently empty."
      : `${ENTRIES.length} income entr${ENTRIES.length === 1 ? "y" : "ies"} · ${txnCount} expense${txnCount === 1 ? "" : "s"} stored on this device.`;
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const entries = ENTRIES.map((e) => ({
    income: String(e.income),
    date: e.date,
    from: e.from,
    expense: String(e.expense),
    investment: String(e.investment || 0),
    balance: String(e.balance),
    transactions: (e.transactions || []).map((t) => ({
      amount: String(t.amount),
      date: t.date,
      description: t.description,
      category: t.category,
      type: t.type || ""
    }))
  }));
  // Tag the export with whoever is signed in, so a backup file always
  // says which account it came from.
  const owner = window.BRAuth ? await BRAuth.currentUser() : null;
  const data = {
    exportedBy: owner ? { name: owner.name, email: owner.email } : null,
    exportedAt: new Date().toISOString(),
    entries,
  };
  const blob = new Blob([JSON.stringify(data, null, 4)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `BlackRoad_export_${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Ledger exported");
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.getElementById("importFile").addEventListener("change", async (ev) => {
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to import data — guest mode is view-only.");
    ev.target.value = "";
    return;
  }
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsedRaw = JSON.parse(text);
    // Accept both the current export shape ({ exportedBy, entries }) and
    // older plain-array exports, so nothing already backed up breaks.
    const parsed = Array.isArray(parsedRaw) ? parsedRaw : parsedRaw.entries;
    if (!Array.isArray(parsed)) throw new Error("Expected an array of entries");

    const normalized = parsed.map((raw) => recalcEntry({
      income: Number(raw.income) || 0,
      date: raw.date || todayISO(),
      from: raw.from || "Imported",
      transactions: (raw.transactions || []).map((t) => ({
        id: uid(),
        amount: Number(t.amount) || 0,
        date: t.date || raw.date || todayISO(),
        description: t.description || "",
        category: t.category || "",
        type: t.type || "expense"
      }))
    }));

    for (const entry of normalized) {
      await putEntry(entry);
    }
    showToast(`Imported ${normalized.length} entr${normalized.length === 1 ? "y" : "ies"}`);
    ENTRIES = await getAllEntries();
    updateSummary();
  } catch (err) {
    showToast(err && err.code === "GUEST_READONLY" ? err.message : "Import failed: invalid JSON file");
    console.error(err);
  } finally {
    ev.target.value = "";
  }
});

document.getElementById("clearAllBtn").addEventListener("click", () => {
  if (window.BRAuth && BRAuth.isGuestSync()) {
    showToast("Sign in to clear data — guest mode is view-only.");
    return;
  }
  document.getElementById("confirmTitle").textContent = "Clear all data?";
  document.getElementById("confirmBody").textContent =
    "This permanently deletes every income entry and expense in BlackRoad. This can't be undone.";
  openDialog("confirmDialog");
});

document.getElementById("confirmYesBtn").addEventListener("click", async () => {
  try {
    await clearAllDB();
    showToast("All data cleared");
    ENTRIES = [];
    updateSummary();
  } catch (err) {
    showToast(err && err.code === "GUEST_READONLY" ? err.message : "Could not clear data");
  } finally {
    closeDialog("confirmDialog");
  }
});

(async function init() {
  try {
    db = await openDB();
    ENTRIES = await getAllEntries();
    updateSummary();
  } catch (err) {
    console.error("BlackRoad DB error:", err);
    showToast("Could not open local database");
  }
})();

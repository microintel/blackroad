/* =========================================================
   LENDLEDGER — loans.js (bank loans / EMI schedules)
   Depends on shared.js being loaded first (DB helpers, format
   utilities, date helpers, theme system and left-nav wiring
   live there). Loans aren't tied to a Person — they live in
   their own "loans" store.

   Record shape:
     { id, lender, principal, emiAmount, tenureMonths,
       interestRate, date, notes, payments:[] }
   payments[]: { id, amount, date, note }
   "outstanding" is always derived: principal - sum(payments.amount).
========================================================= */

let LOANS = [];
let openIds = new Set(); // which cards are expanded

/* ---------------- Derived figures ---------------- */

function paidSoFar(r) {
  return (r.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

function outstanding(r) {
  return Math.max(0, (Number(r.principal) || 0) - paidSoFar(r));
}

// How many EMI installments the amount actually paid so far covers.
// Based on cumulative rupees paid ÷ EMI amount, not the number of
// payment records — otherwise two part-payments that add up to one
// EMI would wrongly skip a due date, and a lump sum covering three
// EMIs would wrongly only advance the schedule by one.
function loanInstallmentsCovered(r) {
  const emi = Number(r.emiAmount) || 0;
  if (emi <= 0) return (r.payments || []).length; // fallback if EMI wasn't set
  return Math.floor((paidSoFar(r) / emi) + 1e-9); // epsilon guards float rounding
}

// Next due date, derived from start date + EMIs actually covered so far.
// Only returns null once the loan is fully settled — a loan that's
// fallen behind (or run past its nominal tenure) still needs to show
// a due date so it correctly surfaces as overdue.
function nextDue(r) {
  if (outstanding(r) <= 0) return null;
  return addMonths(r.date, loanInstallmentsCovered(r));
}

function statusOf(r) {
  const out = outstanding(r);
  if (out <= 0) return "settled";
  const due = nextDue(r);
  if (!due) return "open";
  const days = daysUntil(due);
  if (days < 0) return "overdue";
  if (days <= 7) return "due-soon";
  return "open";
}

const STATUS_LABEL = { open: "Open", "due-soon": "Due soon", overdue: "Overdue", settled: "Settled" };
const STATUS_RANK = { overdue: 0, "due-soon": 1, open: 2, settled: 3 };

/* ---------------- Refresh / summary ---------------- */

async function refresh() {
  LOANS = await getAllLoans();
  renderQuickStats();
  renderBody();
}

function renderQuickStats() {
  let totalOut = 0, totalEmi = 0;
  let nextDueDate = null, nextDueLabel = "";

  LOANS.forEach((r) => {
    const out = outstanding(r);
    totalOut += out;
    if (out > 0) totalEmi += Number(r.emiAmount) || 0;

    if (out > 0) {
      const due = nextDue(r);
      if (due && (!nextDueDate || due < nextDueDate)) {
        nextDueDate = due;
        nextDueLabel = r.lender || "EMI";
      }
    }
  });

  document.getElementById("qsLoanBalance").textContent = fmtMoney(totalOut);
  document.getElementById("qsMonthlyEmi").textContent = fmtMoney(totalEmi);
  document.getElementById("qsCount").textContent = String(LOANS.filter((r) => outstanding(r) > 0).length);

  const nextDueEl = document.getElementById("qsNextDue");
  if (nextDueDate) {
    const days = daysUntil(nextDueDate);
    const when = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `in ${days}d`;
    nextDueEl.textContent = `${escapeHTML(nextDueLabel)} · ${when}`;
  } else {
    nextDueEl.textContent = "—";
  }
}

/* ---------------- Rendering ---------------- */

function renderBody() {
  const body = document.getElementById("loansBody");

  if (LOANS.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="mark-big"><i class="bi bi-bank2"></i></span>
        <h3>No loans set up</h3>
        <p>Add a bank loan or EMI to track the schedule and what's still outstanding.</p>
        <button class="add-income-btn" onclick="document.getElementById('addLoanBtn').click()"><i class="bi bi-plus-lg"></i> Add loan</button>
      </div>`;
    return;
  }

  const sorted = [...LOANS].sort((a, b) => {
    const sa = statusOf(a), sb = statusOf(b);
    if (STATUS_RANK[sa] !== STATUS_RANK[sb]) return STATUS_RANK[sa] - STATUS_RANK[sb];
    const da = nextDue(a) || "9999-99-99";
    const db_ = nextDue(b) || "9999-99-99";
    return da < db_ ? -1 : da > db_ ? 1 : 0;
  });

  body.innerHTML = `<div class="spine">${sorted.map(renderCard).join("")}</div>`;
}

function renderCard(r) {
  const isOpen = openIds.has(r.id);
  const paid = paidSoFar(r);
  const out = outstanding(r);
  const status = statusOf(r);
  const due = nextDue(r);
  const pct = r.principal > 0 ? Math.min(100, Math.round((paid / r.principal) * 100)) : 0;
  const title = r.lender || "Loan";

  const dueLine = due
    ? `<div class="lend-sub-item ${status === "overdue" ? "warn" : ""}"><i class="bi bi-calendar-event"></i> Due <b>${due}</b></div>`
    : `<div class="lend-sub-item"><i class="bi bi-calendar-x"></i> No due date</div>`;

  const emiLine = `<div class="lend-sub-item"><i class="bi bi-arrow-repeat"></i> EMI <b>${fmtMoney(r.emiAmount)}</b></div>
       <div class="lend-sub-item"><i class="bi bi-collection"></i> <b>${Math.min(loanInstallmentsCovered(r), r.tenureMonths)}/${r.tenureMonths}</b> installments</div>`;

  let payHTML = "";
  const payments = r.payments || [];
  if (payments.length === 0) {
    payHTML = `<div class="no-txns">No payments recorded yet</div>`;
  } else {
    [...payments].sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((p) => {
      payHTML += `
        <div class="txn-row">
          <span class="txn-ico"><i class="bi bi-dot"></i></span>
          <div class="txn-amt">${fmtMoney(p.amount)}</div>
          <div class="txn-date">${p.date || ""}</div>
          <div class="txn-desc">${escapeHTML(p.note || "EMI payment")}</div>
          <div class="entry-actions">
            <button class="icon-btn" title="Edit" onclick="event.stopPropagation(); openPaymentDialog(${r.id}, '${p.id}')"><i class="bi bi-pencil"></i></button>
            <button class="icon-btn danger" title="Delete" onclick="event.stopPropagation(); confirmDeletePayment(${r.id}, '${p.id}')"><i class="bi bi-trash3"></i></button>
          </div>
        </div>`;
    });
  }

  return `
    <div class="entry ${isOpen ? "open" : ""}" data-id="${r.id}">
      <div class="entry-card">
        <div class="entry-head" onclick="toggleCard(${r.id})">
          <div class="entry-row-top">
            <div class="entry-from">${escapeHTML(title)}</div>
            <div class="lend-amt out">${fmtMoney(r.principal)}</div>
            <div class="entry-actions">
              <button class="icon-btn add" title="Pay EMI" onclick="event.stopPropagation(); openPaymentDialog(${r.id})"><i class="bi bi-plus-lg"></i></button>
            </div>
          </div>
          <div class="entry-row-bottom">
            <span class="status-pill status-${status}">${STATUS_LABEL[status]}</span>
            <div class="entry-meta-pills">
              <span class="entry-expense">Outstanding&nbsp;${fmtMoney(out)}</span>
            </div>
          </div>
          <div class="lend-progress"><div class="lend-progress-fill ${status === "settled" ? "settled" : ""}" style="width:${pct}%"></div></div>
          <div class="lend-sub">
            ${dueLine}
            ${emiLine}
          </div>
        </div>
        <div class="entry-body">
          <div class="entry-body-actions">
            <button class="body-action-btn" type="button" onclick="event.stopPropagation(); openLoanDialog(${r.id})"><i class="bi bi-pencil"></i> Edit</button>
            <button class="body-action-btn danger" type="button" onclick="event.stopPropagation(); confirmDeleteLoan(${r.id})"><i class="bi bi-trash3"></i> Delete</button>
          </div>
          ${r.notes ? `<div class="no-txns" style="padding-top:2px;"><i class="bi bi-sticky"></i> ${escapeHTML(r.notes)}</div>` : ""}
          ${payHTML}
          <button class="add-txn-btn" type="button" onclick="openPaymentDialog(${r.id})"><i class="bi bi-plus-lg"></i> Pay EMI</button>
        </div>
      </div>
    </div>`;
}

function toggleCard(id) {
  if (openIds.has(id)) openIds.delete(id); else openIds.add(id);
  renderBody();
}

/* ---------------- Dialog helpers ---------------- */

function openDialog(id) {
  const el = document.getElementById(id);
  if (el.open) return;
  el.showModal();
}
function closeDialog(id) { document.getElementById(id).close(); }
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.dataset.close));
});

document.getElementById("addLoanBtn").addEventListener("click", () => openLoanDialog(null));

/* -- Add/edit loan -- */
let editingLoanId = null;

function openLoanDialog(id) {
  editingLoanId = id || null;
  const r = id ? LOANS.find((x) => x.id === id) : null;
  const form = document.getElementById("loanForm");
  form.reset();
  document.getElementById("loanStart").value = todayISO();
  document.getElementById("loanDialogTitle").textContent = r ? "Edit loan" : "Add loan";
  if (r) {
    document.getElementById("loanLender").value = r.lender || "";
    document.getElementById("loanPrincipal").value = r.principal;
    document.getElementById("loanEmi").value = r.emiAmount;
    document.getElementById("loanTenure").value = r.tenureMonths;
    document.getElementById("loanRate").value = r.interestRate || "";
    document.getElementById("loanStart").value = r.date;
    document.getElementById("loanNotes").value = r.notes || "";
  }
  openDialog("loanDialog");
}

document.getElementById("loanForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const record = {
    lender: document.getElementById("loanLender").value.trim(),
    principal: parseFloat(document.getElementById("loanPrincipal").value) || 0,
    emiAmount: parseFloat(document.getElementById("loanEmi").value) || 0,
    tenureMonths: parseInt(document.getElementById("loanTenure").value, 10) || 1,
    interestRate: parseFloat(document.getElementById("loanRate").value) || 0,
    date: document.getElementById("loanStart").value,
    notes: document.getElementById("loanNotes").value.trim(),
    payments: [],
  };

  try {
    if (editingLoanId) {
      const existing = LOANS.find((x) => x.id === editingLoanId);
      record.payments = existing.payments || [];
      record.id = editingLoanId;
      await putLoan(record);
      showToast("Loan updated");
    } else {
      await putLoan(record);
      showToast("Loan added");
    }
    editingLoanId = null;
    closeDialog("loanDialog");
    await refresh();
  } catch (err) {
    console.error("Failed to save loan:", err);
    showToast("Couldn't save — " + (err && err.message ? err.message : "database error"));
  }
});

/* -- Record payment dialog -- */
let paymentContext = { loanId: null, paymentId: null };

function openPaymentDialog(loanId, paymentId) {
  paymentContext = { loanId, paymentId: paymentId || null };
  const r = LOANS.find((x) => x.id === loanId);
  const form = document.getElementById("paymentForm");
  form.reset();
  document.getElementById("payDate").value = todayISO();
  const title = document.getElementById("paymentDialogTitle");

  if (paymentId) {
    const p = (r.payments || []).find((x) => x.id === paymentId);
    title.innerHTML = `<i class="bi bi-cash-coin"></i> Edit payment`;
    document.getElementById("payAmount").value = p.amount;
    document.getElementById("payDate").value = p.date;
    document.getElementById("payNote").value = p.note || "";
  } else {
    title.innerHTML = `<i class="bi bi-cash-coin"></i> Pay EMI`;
    document.getElementById("payAmount").value = r.emiAmount;
  }
  openDialog("paymentDialog");
}

document.getElementById("paymentForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = parseFloat(document.getElementById("payAmount").value) || 0;
  const date = document.getElementById("payDate").value;
  const note = document.getElementById("payNote").value.trim();

  const r = LOANS.find((x) => x.id === paymentContext.loanId);
  if (!r.payments) r.payments = [];

  if (paymentContext.paymentId) {
    const p = r.payments.find((x) => x.id === paymentContext.paymentId);
    Object.assign(p, { amount, date, note });
  } else {
    r.payments.push({ id: uid(), amount, date, note });
  }

  try {
    await putLoan(r);
    showToast(paymentContext.paymentId ? "Payment updated" : "Payment recorded");
    closeDialog("paymentDialog");
    await refresh();
  } catch (err) {
    console.error("Failed to save payment:", err);
    showToast("Couldn't save — " + (err && err.message ? err.message : "database error"));
  }
});

/* -- Confirm delete dialog (loan or single payment) -- */
let pendingDelete = null; // { type: 'loan'|'payment', loanId, paymentId }

function confirmDeleteLoan(loanId) {
  const r = LOANS.find((x) => x.id === loanId);
  pendingDelete = { type: "loan", loanId };
  document.getElementById("confirmTitle").textContent = "Delete this loan?";
  document.getElementById("confirmBody").textContent =
    `This removes "${r.lender || "this loan"}" and its ${((r.payments || []).length)} linked payment(s). This can't be undone.`;
  openDialog("confirmDialog");
}

function confirmDeletePayment(loanId, paymentId) {
  pendingDelete = { type: "payment", loanId, paymentId };
  document.getElementById("confirmTitle").textContent = "Delete this payment?";
  document.getElementById("confirmBody").textContent = "This can't be undone.";
  openDialog("confirmDialog");
}

document.getElementById("confirmYesBtn").addEventListener("click", async () => {
  if (!pendingDelete) return;
  try {
    if (pendingDelete.type === "loan") {
      await deleteLoanDB(pendingDelete.loanId);
      showToast("Loan deleted");
    } else {
      const r = LOANS.find((x) => x.id === pendingDelete.loanId);
      r.payments = (r.payments || []).filter((p) => p.id !== pendingDelete.paymentId);
      await putLoan(r);
      showToast("Payment deleted");
    }
  } catch (err) {
    console.error("Failed to delete:", err);
    showToast("Couldn't delete — " + (err && err.message ? err.message : "database error"));
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

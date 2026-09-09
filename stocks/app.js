// app.js — Ledger: modals, filters, demo data, toast, and app init

// Wraps saveState() so a guest's attempted write shows a friendly toast
// instead of a silent console error (guests can look around freely but
// nothing they do is ever persisted — see BRAuth.isGuestSync).
function saveStateGuarded(){
  return saveState().catch(err => {
    if (err && err.code === 'GUEST_READONLY') showToast("Sign in to save changes — guest mode is view-only.");
  });
}

/* ---------------------------------------------------------------
   LIVE LTP FETCHING (Vercel endpoint — CORS enabled)
   Fetches last-traded-price per symbol from the indian-stock-ltp
   Vercel API (ltp.js), which proxies Yahoo Finance server-side and
   now sends Access-Control-Allow-Origin so browser calls work.
   Manual price entry (in the stock detail modal) always remains
   available as a fallback/override — a successful fetch just
   overwrites prices[symbol], same as typing a number does.
------------------------------------------------------------------*/
const LTP_API_BASE = 'https://indian-stock-ltp.vercel.app/api/ltp';
const CHART_API_BASE = 'https://indian-stock-ltp.vercel.app/api/chart';

// Sends the request, gets the JSON response, pulls out the LTP.
// Matches ltp.js's response shape: { symbol, yahooSymbol, ltp } on
// success, or { error } with a 4xx/5xx status on failure.
async function fetchLTP(symbol){
  const res = await fetch(`${LTP_API_BASE}?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data.ltp;
}


// Fetches LTP for every currently-held symbol and updates `prices`.
// Pass silent=true to skip toasts (used for the on-load fetch).
async function refreshAllPrices(silent){
  const symbols = getAllSymbols().filter(sym => calculateRemainingQuantity(sym) > 0);
  if(symbols.length === 0){
    if(!silent) showToast('No holdings to refresh');
    return;
  }
  if(!silent) showToast('Refreshing prices…');
  const results = await Promise.all(symbols.map(async sym => {
    try{ return { sym, ltp: await fetchLTP(sym) }; }
    catch(err){ return { sym, ltp: null }; }
  }));
  let updated = 0, failed = 0;
  results.forEach(({ sym, ltp }) => {
    if(ltp !== null){ prices[sym] = ltp; updated++; }
    else failed++;
  });
  if(updated > 0){ saveStateGuarded(); renderAll(); }
  if(!silent){
    showToast(failed === 0
      ? `Updated ${updated} price${updated === 1 ? '' : 's'}`
      : `Updated ${updated}, ${failed} failed — enter manually`);
  }
}

// Fetches a symbol's daily closing-price history from the same Vercel
// API. The endpoint currently always returns roughly its last 1 year of
// daily closes (query params like range/startDate don't extend it), so
// a purchase date older than that just gets clipped to what's available —
// handled by the caller, loadDetailChart().
async function fetchChartHistory(symbol){
  const res = await fetch(`${CHART_API_BASE}?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

// Fetches LTP for one symbol (used by the "Fetch LTP" button in the
// stock detail modal). Falls back silently to manual entry on failure.
async function refreshSinglePrice(symbol){
  showToast('Getting the latest price…');
  try{
    const ltp = await fetchLTP(symbol);
    prices[symbol] = ltp;
    saveStateGuarded();
    renderDetailModal();
    renderAll();
    showToast(`Price updated: ${fmtMoney(ltp)}`);
  }catch(err){
    showToast("Couldn't fetch the price — enter it manually");
  }
}

/* ---------------------------------------------------------------
   DUPLICATE TRANSACTION
   Opens the normal "Add" modal pre-filled from an existing row (dated
   today, ready to tweak) rather than silently cloning a record —
   it goes through the exact same validated save path as any other
   new transaction, so it can't create an invalid state.
------------------------------------------------------------------*/
function duplicateTransaction(id){
  const t = transactions.find(x => x.id === id);
  if(!t) return;
  openTxnModal(); // resets the form to "Add" mode first
  document.getElementById('txnModalTitle').textContent = 'Duplicate transaction';
  document.getElementById('txnType').value = t.type;
  document.getElementById('txnDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('txnName').value = t.name;
  document.getElementById('txnSymbol').value = t.symbol;
  document.getElementById('txnQty').value = t.quantity;
  document.getElementById('txnPrice').value = t.price;
  document.getElementById('txnNotes').value = t.notes || '';
  setTxnTypeFields();
  if(t.type === 'SELL'){
    const held = calculateStockHolding(t.symbol);
    sellStockSearch.value = `${t.name} (${t.symbol})`;
    sellStockHint.textContent = `You hold ${held.quantity} share${held.quantity === 1 ? '' : 's'} of ${t.symbol}.`;
    sellStockHint.classList.add('show');
  }
}

/* ---------------------------------------------------------------
   TRANSACTION MODAL (add / edit)
------------------------------------------------------------------*/
const txnModal = document.getElementById('txnModalOverlay');

function openTxnModal(id){
  document.getElementById('txnError').style.display = 'none';
  if(id){
    const t = transactions.find(x => x.id === id);
    if(!t) return;
    document.getElementById('txnModalTitle').textContent = 'Edit transaction';
    document.getElementById('txnId').value = t.id;
    document.getElementById('txnType').value = t.type;
    document.getElementById('txnDate').value = t.date;
    document.getElementById('txnName').value = t.name;
    document.getElementById('txnSymbol').value = t.symbol;
    document.getElementById('txnQty').value = t.quantity;
    document.getElementById('txnPrice').value = t.price;
    document.getElementById('txnNotes').value = t.notes || '';
    setTxnTypeFields();
    if(t.type === 'SELL'){
      const held = calculateStockHolding(t.symbol);
      // The quantity available to re-sell while editing this transaction
      // includes the quantity this very transaction already accounts for.
      const available = held.quantity + t.quantity;
      sellStockSearch.value = `${t.name} (${t.symbol})`;
      sellStockHint.textContent = `You hold ${available} share${available === 1 ? '' : 's'} of ${t.symbol}.`;
      sellStockHint.classList.add('show');
    }
  } else {
    document.getElementById('txnModalTitle').textContent = 'Add transaction';
    document.getElementById('txnId').value = '';
    document.getElementById('txnType').value = 'BUY';
    document.getElementById('txnDate').value = new Date().toISOString().slice(0,10);
    document.getElementById('txnName').value = '';
    document.getElementById('txnSymbol').value = '';
    document.getElementById('txnQty').value = '';
    document.getElementById('txnPrice').value = '';
    document.getElementById('txnNotes').value = '';
    sellStockSearch.value = '';
    sellStockHint.classList.remove('show');
    setTxnTypeFields();
  }
  txnModal.classList.add('active');
}
function closeTxnModal(){ txnModal.classList.remove('active'); }

document.getElementById('addTxnBtn').addEventListener('click', () => openTxnModal());
document.getElementById('fabAddTxn').addEventListener('click', () => openTxnModal());
document.getElementById('txnCancelBtn').addEventListener('click', closeTxnModal);
txnModal.addEventListener('click', e => { if(e.target === txnModal) closeTxnModal(); });

/* ---------------------------------------------------------------
   SEARCHABLE STOCK PICKER (sell flow only — restricted to holdings
   the user actually owns, so it's impossible to "sell" a stock
   that was never bought).
------------------------------------------------------------------*/
const buyStockRow = document.getElementById('buyStockRow');
const sellStockRow = document.getElementById('sellStockRow');
const stockPicker = document.getElementById('stockPicker');
const sellStockSearch = document.getElementById('sellStockSearch');
const sellStockList = document.getElementById('sellStockList');
const sellStockHint = document.getElementById('sellStockHint');

function setTxnTypeFields(){
  const isSell = document.getElementById('txnType').value === 'SELL';
  buyStockRow.style.display = isSell ? 'none' : '';
  sellStockRow.style.display = isSell ? '' : 'none';
  sellStockList.classList.remove('open');
}
document.getElementById('txnType').addEventListener('change', () => {
  // Switching type clears whichever stock was chosen, since a BUY's
  // free-typed stock and a SELL's picked holding aren't interchangeable.
  document.getElementById('txnName').value = '';
  document.getElementById('txnSymbol').value = '';
  sellStockSearch.value = '';
  sellStockHint.classList.remove('show');
  setTxnTypeFields();
});

function renderSellStockList(filterText){
  const term = (filterText || '').trim().toLowerCase();
  const holdings = getActiveHoldings().sort((a,b) => a.name.localeCompare(b.name));
  const matches = term
    ? holdings.filter(h => h.name.toLowerCase().includes(term) || h.symbol.toLowerCase().includes(term))
    : holdings;

  if(holdings.length === 0){
    sellStockList.innerHTML = `<div class="sp-empty">You don't hold any stocks to sell yet.</div>`;
  } else if(matches.length === 0){
    sellStockList.innerHTML = `<div class="sp-empty">No holdings match "${escHtml(filterText)}".</div>`;
  } else {
    sellStockList.innerHTML = matches.map(h => `
      <div class="sp-item" data-symbol="${escAttr(h.symbol)}" data-name="${escAttr(h.name)}" data-qty="${h.quantity}">
        <div class="sp-item-id">
          <div class="stock-name">${escHtml(h.name)}</div>
          <div class="stock-symbol">${escHtml(h.symbol)}</div>
        </div>
        <div class="sp-item-qty">${h.quantity} held</div>
      </div>
    `).join('');
  }
  sellStockList.classList.add('open');
}

function selectSellStock(symbol, name, qty){
  document.getElementById('txnSymbol').value = symbol;
  document.getElementById('txnName').value = name;
  sellStockSearch.value = `${name} (${symbol})`;
  sellStockHint.textContent = `You hold ${qty} share${Number(qty) === 1 ? '' : 's'} of ${symbol}.`;
  sellStockHint.classList.add('show');
  sellStockList.classList.remove('open');
}

sellStockSearch.addEventListener('focus', () => renderSellStockList(''));
sellStockSearch.addEventListener('input', () => {
  // Typing invalidates whatever was previously picked until a fresh
  // selection is made from the (now re-filtered) list.
  document.getElementById('txnSymbol').value = '';
  document.getElementById('txnName').value = '';
  sellStockHint.classList.remove('show');
  renderSellStockList(sellStockSearch.value);
});
sellStockList.addEventListener('click', e => {
  const item = e.target.closest('.sp-item');
  if(!item) return;
  selectSellStock(item.dataset.symbol, item.dataset.name, item.dataset.qty);
});
document.addEventListener('click', e => {
  if(!stockPicker.contains(e.target)) sellStockList.classList.remove('open');
});

document.getElementById('txnSaveBtn').addEventListener('click', () => {
  if(window.BRAuth && BRAuth.isGuestSync()){
    showToast("Sign in to save transactions — guest mode is view-only.");
    closeTxnModal();
    return;
  }
  const errEl = document.getElementById('txnError');
  errEl.style.display = 'none';

  const id = document.getElementById('txnId').value || null;
  const type = document.getElementById('txnType').value;
  const date = document.getElementById('txnDate').value;
  const name = document.getElementById('txnName').value.trim();
  const symbol = document.getElementById('txnSymbol').value.trim().toUpperCase();
  const quantity = round6(parseFloat(document.getElementById('txnQty').value));
  const price = round2(parseFloat(document.getElementById('txnPrice').value));
  const notes = document.getElementById('txnNotes').value.trim();

  if(!date || !name || !symbol || !quantity || quantity <= 0 || isNaN(price) || price < 0){
    errEl.textContent = 'Fill in date, stock name, symbol, a positive quantity, and a valid price.';
    errEl.style.display = 'block';
    return;
  }

  const candidate = { id: id || genId(), seq: id ? transactions.find(t=>t.id===id).seq : ++seqCounter, date, type, symbol, name, quantity, price, notes };
  const check = validateTransaction(candidate, id);
  if(!check.ok){
    errEl.textContent = `You don't have that many shares to sell — you only hold ${check.available}.`;
    errEl.style.display = 'block';
    return;
  }

  if(id){
    const idx = transactions.findIndex(t => t.id === id);
    transactions[idx] = candidate;
    showToast('Transaction updated');
  } else {
    transactions.push(candidate);
    showToast('Transaction added');
  }

  saveStateGuarded();
  closeTxnModal();
  renderAll();
});

/* ---------------------------------------------------------------
   DELETE MODAL
------------------------------------------------------------------*/
const deleteModal = document.getElementById('deleteModalOverlay');
let pendingDeleteId = null;

function openDeleteModal(id){
  pendingDeleteId = id;
  deleteModal.classList.add('active');
}
document.getElementById('deleteCancelBtn').addEventListener('click', () => {
  pendingDeleteId = null;
  deleteModal.classList.remove('active');
});
deleteModal.addEventListener('click', e => { if(e.target === deleteModal){ pendingDeleteId=null; deleteModal.classList.remove('active'); } });

document.getElementById('deleteConfirmBtn').addEventListener('click', () => {
  if(!pendingDeleteId) return;
  if(window.BRAuth && BRAuth.isGuestSync()){
    showToast("Sign in to delete transactions — guest mode is view-only.");
    pendingDeleteId = null;
    deleteModal.classList.remove('active');
    return;
  }
  const idx = transactions.findIndex(t => t.id === pendingDeleteId);
  const removed = idx !== -1 ? transactions[idx] : null;
  transactions = transactions.filter(t => t.id !== pendingDeleteId);
  pendingDeleteId = null;
  saveStateGuarded();
  deleteModal.classList.remove('active');
  renderAll();
  if(removed){
    showToast('Transaction deleted', {
      label: 'Undo',
      onClick: () => {
        // Re-insert at its original position (by id) rather than pushing
        // to the end, so unrelated transactions' relative order — and
        // therefore every downstream calculation — is restored exactly.
        const insertAt = Math.min(idx, transactions.length);
        transactions.splice(insertAt, 0, removed);
        saveStateGuarded();
        renderAll();
        showToast('Transaction restored');
      }
    });
  } else {
    showToast('Transaction deleted');
  }
});

/* ---------------------------------------------------------------
   CLEAR ALL DATA MODAL
------------------------------------------------------------------*/
const clearModal = document.getElementById('clearModalOverlay');
document.getElementById('clearDataBtn').addEventListener('click', () => clearModal.classList.add('active'));
document.getElementById('clearCancelBtn').addEventListener('click', () => clearModal.classList.remove('active'));
clearModal.addEventListener('click', e => { if(e.target === clearModal) clearModal.classList.remove('active'); });
document.getElementById('clearConfirmBtn').addEventListener('click', () => {
  if(window.BRAuth && BRAuth.isGuestSync()){
    showToast("Sign in to clear data — guest mode is view-only.");
    clearModal.classList.remove('active');
    return;
  }
  transactions = [];
  prices = {};
  seqCounter = 0;
  saveStateGuarded();
  clearModal.classList.remove('active');
  renderAll();
  showToast('All data cleared');
});

/* ---------------------------------------------------------------
   EXPORT / IMPORT DATA
------------------------------------------------------------------*/
document.getElementById('exportDataBtn').addEventListener('click', async () => {
  const owner = window.BRAuth ? await BRAuth.currentUser() : null;
  const payload = {
    app: 'stocks-portfolio-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: owner ? { name: owner.name, email: owner.email } : null,
    transactions,
    prices,
    seqCounter
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `portfolio-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Data exported');
});

const importModal = document.getElementById('importModalOverlay');
const importFileInput = document.getElementById('importFileInput');
const importError = document.getElementById('importError');
let pendingImportData = null;

document.getElementById('importDataBtn').addEventListener('click', () => {
  if(window.BRAuth && BRAuth.isGuestSync()){
    showToast("Sign in to import data — guest mode is view-only.");
    return;
  }
  importFileInput.click();
});

importFileInput.addEventListener('change', () => {
  const file = importFileInput.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importError.style.display = 'none';
    try {
      const data = JSON.parse(reader.result);
      if(!Array.isArray(data.transactions) || typeof data.prices !== 'object' || data.prices === null){
        throw new Error('Invalid backup file');
      }
      pendingImportData = data;
      importModal.classList.add('active');
    } catch(e){
      pendingImportData = null;
      importError.style.display = 'block';
      importModal.classList.add('active');
    }
  };
  reader.onerror = () => {
    pendingImportData = null;
    importError.style.display = 'block';
    importModal.classList.add('active');
  };
  reader.readAsText(file);
  importFileInput.value = '';
});

document.getElementById('importConfirmBtn').addEventListener('click', () => {
  if(!pendingImportData){
    importError.style.display = 'block';
    return;
  }
  transactions = pendingImportData.transactions || [];
  prices = pendingImportData.prices || {};
  seqCounter = typeof pendingImportData.seqCounter === 'number'
    ? pendingImportData.seqCounter
    : transactions.reduce((m, t) => Math.max(m, t.seq || 0), 0);
  pendingImportData = null;
  saveStateGuarded();
  importModal.classList.remove('active');
  renderAll();
  showToast('Data imported');
});
document.getElementById('importCancelBtn').addEventListener('click', () => {
  pendingImportData = null;
  importError.style.display = 'none';
  importModal.classList.remove('active');
});
importModal.addEventListener('click', e => {
  if(e.target === importModal){
    pendingImportData = null;
    importError.style.display = 'none';
    importModal.classList.remove('active');
  }
});

/* ---------------------------------------------------------------
   STOCK DETAIL — opens inline in the page (no popup window).
   Tapping a holding swaps the current tab's content out for the
   detail panel; the Back button (or switching tabs) brings it back.
------------------------------------------------------------------*/
const inlineDetailPanel = document.getElementById('inlineDetailPanel');
let detailSymbol = null;
let inlineDetailOpen = false;

function openDetailModal(symbol){
  detailSymbol = symbol;
  renderDetailModal();
  inlineDetailOpen = true;
  const activeView = document.getElementById('view-' + currentView);
  if(activeView) activeView.classList.remove('active');
  inlineDetailPanel.classList.add('active');
  document.getElementById('viewTitle').textContent = 'Stock detail';
  document.getElementById('viewSub').textContent = "Everything about this one holding, in one place";
  window.scrollTo(0, 0);
  loadDetailChart(symbol);
}

// Called both by the Back button and by switchView() (render.js) so
// jumping to another tab while the detail panel is open always lands
// back on the right tab instead of leaving things in a stuck state.
function closeInlineDetail(){
  if(!inlineDetailOpen) return;
  inlineDetailOpen = false;
  inlineDetailPanel.classList.remove('active');
  const activeView = document.getElementById('view-' + currentView);
  if(activeView) activeView.classList.add('active');
  document.getElementById('viewTitle').textContent = viewTitles[currentView][0];
  document.getElementById('viewSub').textContent = viewTitles[currentView][1];
  window.scrollTo(0, 0);
}
document.getElementById('detailBackBtn').addEventListener('click', closeInlineDetail);

// Loads the "price chart since purchase" panel in the stock detail modal:
// fetches the symbol's price history, clips it to the user's earliest
// transaction date for that stock (their "start date"), computes actual
// growth %/profit off the real holding (avg buy price vs LTP), and hands
// everything to renderChartInteractive() for an interactive, zoomable draw.
async function loadDetailChart(symbol){
  const body = document.getElementById('detailChartBody');
  const rangeEl = document.getElementById('detailChartRange');
  if(!body) return;
  const requestSymbol = symbol;
  body.innerHTML = `<div class="chart-loading">Loading price history…</div>`;
  rangeEl.textContent = '';

  const txns = getSymbolTransactions(symbol);
  const buyDate = txns.length ? txns[0].date : null;

  try{
    const data = await fetchChartHistory(symbol);
    if(requestSymbol !== detailSymbol) return; // modal moved on to another stock
    const fullHistory = Array.isArray(data.history) ? data.history : [];
    let history = fullHistory;
    if(buyDate){
      const clipped = fullHistory.filter(p => p.date >= buyDate);
      if(clipped.length >= 2) history = clipped;
    }
    if(history.length < 2){
      body.innerHTML = `<div class="chart-empty">Not enough price history available yet for ${escHtml(symbol)}.</div>`;
      return;
    }
    const clippedToApiStart = buyDate && fullHistory.length && fullHistory[0].date > buyDate;
    const sourceStartNote = clippedToApiStart
      ? `<span class="chart-range-note">· source data starts ${fmtDate(fullHistory[0].date)}</span>`
      : '';
    renderChartInteractive(body, history, {
      buyDate,
      holding: calculateStockHolding(symbol),
      sourceStartNote
    });
  }catch(err){
    if(requestSymbol !== detailSymbol) return;
    body.innerHTML = `<div class="chart-empty">Couldn't load price chart.
      <button type="button" class="chart-retry" id="chartRetryBtn">Retry</button></div>`;
    const retryBtn = document.getElementById('chartRetryBtn');
    if(retryBtn) retryBtn.addEventListener('click', () => loadDetailChart(detailSymbol));
  }
}

// Draws the interactive chart: growth/profit stat chips (from the actual
// holding — avg buy price vs current LTP, unaffected by zoom), the SVG
// chart itself, and a drag-to-zoom + hover-tooltip interaction layer.
// Drag horizontally across the chart to zoom into a date range; double-
// click/tap or "Reset zoom" returns to the full view. Hovering (or
// touching, when not dragging) shows a crosshair + price tooltip.
function renderChartInteractive(container, fullHistory, meta){
  const rangeEl = document.getElementById('detailChartRange');
  let current = fullHistory;
  let dragging = false;
  let pointerDownClientX = null;

  const h = meta.holding;
  container.innerHTML = `
    <div class="chart-stats-row">
      <div class="chart-stat">
        <span class="chart-stat-label">Grown by</span>
        <span class="chart-stat-value ${pnlClass(h.unrealizedPnLPct)}">${fmtPct(h.unrealizedPnLPct)}</span>
      </div>
      <div class="chart-stat">
        <span class="chart-stat-label">Profit if sold today</span>
        <span class="chart-stat-value ${pnlClass(h.unrealizedPnL)}">${fmtSigned(h.unrealizedPnL, true)}</span>
      </div>
    </div>
    <div class="price-chart-wrap" id="priceChartWrap">
      <div id="priceChartSvgHolder"></div>
      <div class="chart-crosshair-line" id="chartCrosshair"></div>
      <div class="chart-tooltip" id="chartTooltip"></div>
      <div class="chart-drag-band" id="chartDragBand"></div>
    </div>
    <div class="chart-zoom-row">
      <span class="chart-zoom-hint" id="chartZoomHint">Drag, pinch, or scroll to zoom in</span>
      <button type="button" class="chart-reset-btn" id="chartResetZoomBtn" style="display:none;">Reset zoom</button>
    </div>
  `;

  const wrap = document.getElementById('priceChartWrap');
  const svgHolder = document.getElementById('priceChartSvgHolder');
  const crosshair = document.getElementById('chartCrosshair');
  const tooltip = document.getElementById('chartTooltip');
  const dragBand = document.getElementById('chartDragBand');
  const resetBtn = document.getElementById('chartResetZoomBtn');
  const zoomHint = document.getElementById('chartZoomHint');

  // The zoomed-in window is tracked as a pair of indices into fullHistory
  // (not just "whatever's on screen"), so drag, pinch, and scroll zoom can
  // all build on top of each other instead of fighting over what "current"
  // means.
  let rangeStart = 0, rangeEnd = fullHistory.length - 1;

  function draw(slice){
    current = slice;
    svgHolder.innerHTML = buildPriceLineChart(slice, { buyDate: meta.buyDate });
    const startP = slice[0].close, endP = slice[slice.length-1].close;
    const pct = startP ? ((endP - startP) / startP) * 100 : 0;
    const isZoomed = slice.length < fullHistory.length;
    rangeEl.innerHTML = `${fmtDate(slice[0].date)} → ${fmtDate(slice[slice.length-1].date)}
      <span class="${pnlClass(pct)}">${fmtPct(pct)}</span>
      ${isZoomed ? '<span class="chart-range-note">· zoomed in</span>' : (meta.sourceStartNote || '')}`;
    resetBtn.style.display = isZoomed ? '' : 'none';
    zoomHint.style.display = isZoomed ? 'none' : '';
  }

  // Clamps a candidate [s, e] index range to fullHistory's bounds, enforces
  // a minimum span (so you can't zoom into a single dot), and redraws.
  function setRange(s, e){
    const minSpan = Math.min(3, fullHistory.length - 1);
    s = Math.max(0, Math.min(s, fullHistory.length - 1));
    e = Math.max(0, Math.min(e, fullHistory.length - 1));
    if(e - s < minSpan){
      const mid = (s + e) / 2;
      s = mid - minSpan / 2;
      e = s + minSpan;
      if(s < 0){ e -= s; s = 0; }
      if(e > fullHistory.length - 1){ s -= (e - (fullHistory.length - 1)); e = fullHistory.length - 1; }
      s = Math.max(0, s);
    }
    rangeStart = Math.round(s);
    rangeEnd = Math.round(e);
    draw(fullHistory.slice(rangeStart, rangeEnd + 1));
  }

  // Zooms in/out by `factor` (< 1 zooms in, > 1 zooms out) while keeping
  // whatever point sits at `frac` (0..1 across the current view) fixed in
  // place — used by both scroll-wheel and pinch zoom.
  function zoomAtFraction(frac, factor){
    const spanNow = rangeEnd - rangeStart;
    const anchorIdx = rangeStart + frac * spanNow;
    let newSpan = spanNow * factor;
    newSpan = Math.max(3, Math.min(fullHistory.length - 1, newSpan));
    let s = anchorIdx - frac * newSpan;
    let e = s + newSpan;
    if(s < 0){ e -= s; s = 0; }
    if(e > fullHistory.length - 1){ s -= (e - (fullHistory.length - 1)); e = fullHistory.length - 1; }
    s = Math.max(0, s);
    setRange(s, e);
  }

  setRange(0, fullHistory.length - 1);

  function svgEl(){ return svgHolder.querySelector('svg'); }

  // Converts a pointer's clientX into a 0..1 fraction across the rendered SVG.
  function clientToFrac(clientX){
    const svg = svgEl();
    if(!svg) return 0;
    const rect = svg.getBoundingClientRect();
    if(rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }
  // Maps a 0..1 fraction of chart width to the nearest data index, using
  // the same padded-plot-area math as buildPriceLineChart's x().
  function fracToIndex(frac){
    const geo = getChartGeometry(current);
    const svgX = frac * geo.w;
    const rel = (svgX - geo.padL) / geo.plotW;
    return Math.round(Math.max(0, Math.min(1, rel)) * (current.length - 1));
  }

  function showTooltip(clientX, idx){
    const p = current[idx];
    const svg = svgEl();
    if(!p || !svg) return;
    const rect = svg.getBoundingClientRect();
    const geo = getChartGeometry(current);
    const xPx = (geo.x(idx) / geo.w) * rect.width;
    crosshair.style.left = `${xPx}px`;
    crosshair.style.display = 'block';
    tooltip.innerHTML = `<div class="chart-tooltip-date">${fmtDate(p.date)}</div><div class="chart-tooltip-price">${fmtMoney(p.close)}</div>`;
    tooltip.style.display = 'block';
    const tooltipW = 96;
    let leftPx = xPx + 10;
    if(leftPx + tooltipW > rect.width) leftPx = xPx - tooltipW - 6;
    tooltip.style.left = `${Math.max(2, leftPx)}px`;
  }
  function hideTooltip(){
    crosshair.style.display = 'none';
    tooltip.style.display = 'none';
  }

  wrap.addEventListener('pointerdown', e => {
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    if(e.pointerType === 'touch' && !e.isPrimary) return; // let a second finger start a pinch, not a drag
    wrap.setPointerCapture(e.pointerId);
    pointerDownClientX = e.clientX;
    dragging = true;
    hideTooltip();
    const svg = svgEl();
    if(!svg) return;
    const rect = svg.getBoundingClientRect();
    const startFrac = clientToFrac(e.clientX);
    dragBand.style.display = 'block';
    dragBand.style.left = `${startFrac * rect.width}px`;
    dragBand.style.width = '0px';
  });

  wrap.addEventListener('pointermove', e => {
    if(pinchStartDist) return; // a pinch is in progress — let the touch handlers drive the zoom
    const svg = svgEl();
    if(!svg) return;
    const rect = svg.getBoundingClientRect();
    if(dragging && pointerDownClientX !== null){
      const f1 = clientToFrac(pointerDownClientX);
      const f2 = clientToFrac(e.clientX);
      dragBand.style.left = `${Math.min(f1, f2) * rect.width}px`;
      dragBand.style.width = `${Math.abs(f2 - f1) * rect.width}px`;
    } else {
      const idx = fracToIndex(clientToFrac(e.clientX));
      showTooltip(e.clientX, idx);
    }
  });

  function endDrag(e){
    if(!dragging) return;
    dragging = false;
    dragBand.style.display = 'none';
    if(pointerDownClientX === null) return;
    const f1 = clientToFrac(pointerDownClientX);
    const f2 = clientToFrac(e.clientX);
    pointerDownClientX = null;
    const i1 = fracToIndex(Math.min(f1, f2));
    const i2 = fracToIndex(Math.max(f1, f2));
    if(i2 - i1 >= 3){
      setRange(rangeStart + i1, rangeStart + i2);
    }
  }
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', () => {
    dragging = false;
    pointerDownClientX = null;
    dragBand.style.display = 'none';
  });
  wrap.addEventListener('pointerleave', () => { if(!dragging) hideTooltip(); });
  wrap.addEventListener('dblclick', () => setRange(0, fullHistory.length - 1));
  resetBtn.addEventListener('click', () => setRange(0, fullHistory.length - 1));

  // Scroll-wheel / trackpad zoom (desktop): zoom in around the cursor.
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const frac = clientToFrac(e.clientX);
    const factor = e.deltaY < 0 ? 0.85 : (1 / 0.85);
    zoomAtFraction(frac, factor);
  }, { passive: false });

  // Two-finger pinch zoom (touch): zoom around the midpoint between fingers.
  let pinchStartDist = null;
  let pinchStartRange = null;
  function touchDist(t0, t1){
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  }
  wrap.addEventListener('touchstart', e => {
    if(e.touches.length === 2){
      dragging = false;
      pointerDownClientX = null;
      dragBand.style.display = 'none';
      hideTooltip();
      pinchStartDist = touchDist(e.touches[0], e.touches[1]);
      pinchStartRange = { start: rangeStart, end: rangeEnd };
    }
  }, { passive: true });
  wrap.addEventListener('touchmove', e => {
    if(e.touches.length === 2 && pinchStartDist && pinchStartRange){
      e.preventDefault();
      const dist = touchDist(e.touches[0], e.touches[1]);
      const scale = dist / pinchStartDist; // fingers spreading apart -> zoom in
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const frac = clientToFrac(midX);
      const spanNow = pinchStartRange.end - pinchStartRange.start;
      const anchorIdx = pinchStartRange.start + frac * spanNow;
      let newSpan = spanNow / Math.max(0.05, scale);
      newSpan = Math.max(3, Math.min(fullHistory.length - 1, newSpan));
      let s = anchorIdx - frac * newSpan;
      let e2 = s + newSpan;
      if(s < 0){ e2 -= s; s = 0; }
      if(e2 > fullHistory.length - 1){ s -= (e2 - (fullHistory.length - 1)); e2 = fullHistory.length - 1; }
      s = Math.max(0, s);
      setRange(s, e2);
    }
  }, { passive: false });
  wrap.addEventListener('touchend', e => {
    if(e.touches.length < 2){ pinchStartDist = null; pinchStartRange = null; }
  });
}
function renderDetailModal(){
  const h = calculateStockHolding(detailSymbol);
  document.getElementById('detailTitle').textContent = `${h.name} (${h.symbol})`;
  document.getElementById('detailGrid').innerHTML = `
    <div><div class="k">Shares you own</div><div class="v">${h.quantity}</div></div>
    <div><div class="k">Average price you paid</div><div class="v">${fmtMoney(h.avgPrice)}</div></div>
    <div><div class="k">Price today</div><div class="v">${fmtMoney(h.currentPrice)}</div></div>
    <div><div class="k">Share of your portfolio</div><div class="v">${calculatePortfolioWeight(h.symbol).toFixed(1)}%</div></div>
    <div><div class="k">Money you put in</div><div class="v">${fmtMoney(h.investedValue, true)}</div></div>
    <div><div class="k">What it's worth now</div><div class="v">${fmtMoney(h.currentValue, true)}</div></div>
    <div><div class="k">Profit if you sold today</div><div class="v ${pnlClass(h.unrealizedPnL)}">${fmtSigned(h.unrealizedPnL, true)}</div></div>
    <div><div class="k">Growth so far</div><div class="v ${pnlClass(h.unrealizedPnLPct)}">${fmtPct(h.unrealizedPnLPct)}</div></div>
    <div><div class="k">Shares bought in total</div><div class="v">${h.totalBuyQty}</div></div>
    <div><div class="k">Shares sold in total</div><div class="v">${h.totalSellQty}</div></div>
    <div><div class="k">Profit already banked on this stock</div><div class="v ${pnlClass(h.realizedPnL)}">${fmtSigned(h.realizedPnL, true)}</div></div>
  `;
  document.getElementById('detailPriceInput').value = h.currentPrice;

  const txns = getSymbolTransactions(detailSymbol).slice().reverse();
  document.querySelector('#detailTxnTable tbody').innerHTML = txns.map(t => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td><span class="badge ${t.type==='BUY'?'badge-buy':'badge-sell'}">${t.type}</span></td>
      <td class="num">${t.quantity}</td>
      <td class="num">${fmtMoney(t.price)}</td>
    </tr>
  `).join('');
}
document.getElementById('detailPriceInput').addEventListener('change', (e) => {
  const val = parseFloat(e.target.value);
  if(isNaN(val) || val < 0) return;
  prices[detailSymbol] = val;
  saveStateGuarded();
  renderDetailModal();
  renderAll();
  showToast('Current price updated');
});
document.getElementById('detailFetchLtpBtn').addEventListener('click', () => {
  if(detailSymbol) refreshSinglePrice(detailSymbol);
});

/* ---------------------------------------------------------------
   TRANSACTION FILTERS
------------------------------------------------------------------*/
document.getElementById('filterStock').addEventListener('change', renderTransactions);
document.getElementById('filterType').addEventListener('change', renderTransactions);
document.getElementById('sortOrder').addEventListener('change', renderTransactions);
document.getElementById('filterSearch').addEventListener('input', renderTransactions);
document.getElementById('filterTag').addEventListener('change', renderTransactions);

// Transactions view toggle — full cards vs. compact "symbol + P&L only".
let txnViewMode = 'cards';
document.getElementById('txnViewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.tvt-btn');
  if(!btn || btn.classList.contains('active')) return;
  document.querySelectorAll('#txnViewToggle .tvt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  txnViewMode = btn.dataset.mode;
  renderTransactions();
  if(window.lucide) lucide.createIcons();
});

/* ---------------------------------------------------------------
   REPORTS (Settings tab)
------------------------------------------------------------------*/
document.getElementById('reportMonthSelect').addEventListener('change', renderSettingsReports);
document.getElementById('printReportBtn').addEventListener('click', () => {
  const monthSel = document.getElementById('reportMonthSelect');
  const ym = monthSel.value;
  if(!ym){ showToast('No transactions to report on yet'); return; }
  generatePrintReport(ym);
  // Let the freshly-built DOM paint before handing off to the browser's
  // print dialog — printing synchronously right after innerHTML can
  // occasionally print a stale/empty frame in some browsers.
  setTimeout(() => window.print(), 50);
});

// Builds the hidden #printReport DOM for one month, then window.print()
// (triggered by the caller) hands the rest to the browser's native
// print/"Save as PDF" flow — no PDF library, no extra dependency, and it
// always renders the exact same numbers as the on-screen Reports panel
// because it reads from the same calculateMonthlySummary().
function generatePrintReport(ym){
  const s = calculateMonthlySummary(ym);
  const [y, m] = ym.split('-');
  const monthLabel = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const generatedAt = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const monthTxns = transactions
    .filter(t => t.date && t.date.slice(0, 7) === ym)
    .slice()
    .sort((a, b) => (a.date === b.date) ? a.seq - b.seq : (a.date < b.date ? -1 : 1));
  const pnlMap = getTxnPnLMap();

  const rowsHTML = monthTxns.length ? monthTxns.map(t => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td>${escHtml(t.type)}</td>
      <td>${escHtml(t.name)} (${escHtml(t.symbol)})</td>
      <td class="num">${t.quantity}</td>
      <td class="num">${fmtMoney(t.price)}</td>
      <td class="num">${fmtMoney(t.quantity * t.price, true)}</td>
      <td class="num">${t.type === 'SELL' && pnlMap[t.id] !== undefined ? fmtSigned(pnlMap[t.id], true) : '—'}</td>
    </tr>
  `).join('') : `<tr><td colspan="7" class="pr-empty">No transactions this month.</td></tr>`;

  document.getElementById('printReport').innerHTML = `
    <div class="pr-title">Blackboard's Equity Report — ${monthLabel}</div>
    <div class="pr-sub">Generated ${generatedAt}</div>
    <div class="pr-grid">
      <div class="pr-cell"><div class="pr-lbl">Invested</div><div class="pr-val">${fmtMoney(s.invested, true)}</div></div>
      <div class="pr-cell"><div class="pr-lbl">Withdrawn</div><div class="pr-val">${fmtMoney(s.withdrawn, true)}</div></div>
      <div class="pr-cell"><div class="pr-lbl">Transactions</div><div class="pr-val">${s.transactionCount}</div></div>
      <div class="pr-cell"><div class="pr-lbl">Realized P&amp;L (month)</div><div class="pr-val ${pnlClass(s.realizedPnLThisMonth)}">${fmtSigned(s.realizedPnLThisMonth, true)}</div></div>
      <div class="pr-cell"><div class="pr-lbl">Current portfolio</div><div class="pr-val">${fmtMoney(s.currentPortfolioValue, true)}</div></div>
      <div class="pr-cell"><div class="pr-lbl">Unrealized P&amp;L (now)</div><div class="pr-val ${pnlClass(s.unrealizedPnL)}">${fmtSigned(s.unrealizedPnL, true)}</div></div>
    </div>
    <table class="pr-table">
      <thead><tr><th>Date</th><th>Type</th><th>Stock</th><th>Qty</th><th>Price</th><th>Amount</th><th>Realized P&amp;L</th></tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>
    <div class="pr-footer">Blackboard's Equity Report · This report is informational only, not investment advice.</div>
  `;
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if(transactions.length === 0){ showToast('No transactions to export'); return; }
  const csv = transactionsToCSV();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `transactions-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV exported');
});

/* ---------------------------------------------------------------
   DEMO DATA
------------------------------------------------------------------*/
document.getElementById('demoBtn').addEventListener('click', () => {
  const demoTxns = [
    { date:'2026-06-01', type:'BUY', symbol:'RELIANCE', name:'Reliance Industries', quantity:10, price:1000 },
    { date:'2026-06-15', type:'BUY', symbol:'RELIANCE', name:'Reliance Industries', quantity:5, price:1200 },
    { date:'2026-07-10', type:'SELL', symbol:'RELIANCE', name:'Reliance Industries', quantity:5, price:1500 },
    { date:'2026-06-05', type:'BUY', symbol:'TCS', name:'Tata Consultancy Services', quantity:10, price:3000 },
    { date:'2026-06-20', type:'BUY', symbol:'ITC', name:'ITC Limited', quantity:20, price:400 },
    { date:'2026-07-20', type:'SELL', symbol:'ITC', name:'ITC Limited', quantity:5, price:450 }
  ];
  transactions = demoTxns.map(t => ({ id: genId(), seq: ++seqCounter, notes:'', ...t }));
  prices = { RELIANCE: 1650, TCS: 3350, ITC: 430 };
  saveStateGuarded();
  renderAll();
  showToast('Demo data loaded');
});

/* ---------------------------------------------------------------
   GLOBAL SEARCH (Ctrl/Cmd+K on desktop, search icon everywhere)
   Searches across stock name/symbol and transaction name/symbol/notes
   (which also covers #tags, since a tag is just text inside notes).
------------------------------------------------------------------*/
const searchModal = document.getElementById('searchModalOverlay');
const globalSearchInput = document.getElementById('globalSearchInput');
const searchResultsEl = document.getElementById('searchResults');

function openSearchModal(){
  searchModal.classList.add('active');
  globalSearchInput.value = '';
  renderSearchResults('');
  syncSearchModalToViewport();
  if(window.visualViewport) window.visualViewport.addEventListener('resize', syncSearchModalToViewport);
  setTimeout(() => globalSearchInput.focus(), 30);
}
function closeSearchModal(){
  searchModal.classList.remove('active');
  if(window.visualViewport) window.visualViewport.removeEventListener('resize', syncSearchModalToViewport);
  const modalEl = searchModal.querySelector('.search-modal');
  if(modalEl) modalEl.style.height = '';
}
// 100dvh (set in CSS) already shrinks with the keyboard on browsers that
// support dynamic-viewport units. This is the fallback for the ones that
// don't (mainly older Android WebViews): pin the modal's actual pixel
// height to window.visualViewport.height, which always reflects the
// space really left on screen once the keyboard is up — so the input
// and results never end up rendered underneath it.
function syncSearchModalToViewport(){
  if(!searchModal.classList.contains('active')) return;
  const modalEl = searchModal.querySelector('.search-modal');
  if(!modalEl || !window.visualViewport) return;
  if(window.matchMedia('(max-width:860px)').matches){
    modalEl.style.height = window.visualViewport.height + 'px';
  }
}
document.getElementById('globalSearchBtn').addEventListener('click', openSearchModal);
searchModal.addEventListener('click', e => { if(e.target === searchModal) closeSearchModal(); });

function renderSearchResults(rawTerm){
  const term = rawTerm.trim().toLowerCase();

  const stockMatches = getAllSymbols()
    .map(sym => ({ symbol: sym, name: getSymbolName(sym) }))
    .filter(s => !term || s.name.toLowerCase().includes(term) || s.symbol.toLowerCase().includes(term))
    .slice(0, 6);

  const txnMatches = (!term ? [] : transactions.filter(t =>
      t.name.toLowerCase().includes(term) ||
      t.symbol.toLowerCase().includes(term) ||
      (t.notes || '').toLowerCase().includes(term)
    ))
    .slice()
    .sort((a,b) => (a.date < b.date ? 1 : -1))
    .slice(0, 8);

  if(!term && stockMatches.length === 0){
    searchResultsEl.innerHTML = `<div class="search-empty">Start typing to search your stocks, transactions, notes, and tags.</div>`;
    return;
  }
  if(term && stockMatches.length === 0 && txnMatches.length === 0){
    searchResultsEl.innerHTML = `<div class="search-empty">No matches for "${escHtml(rawTerm)}".</div>`;
    return;
  }

  let html = '';
  if(stockMatches.length){
    html += `<div class="search-group-label">Stocks</div>` + stockMatches.map(s => `
      <div class="search-result" data-kind="stock" data-symbol="${escAttr(s.symbol)}">
        <div class="stock-avatar"><i data-lucide="building-2"></i></div>
        <div class="tc-id-text"><div class="stock-name">${escHtml(s.name)}</div><div class="stock-symbol">${escHtml(s.symbol)}</div></div>
      </div>`).join('');
  }
  if(txnMatches.length){
    html += `<div class="search-group-label">Transactions</div>` + txnMatches.map(t => `
      <div class="search-result" data-kind="txn" data-symbol="${escAttr(t.symbol)}">
        <span class="type-badge ${t.type==='BUY'?'buy':'sell'} pnl-row-badge">${t.type==='BUY'?'B':'S'}</span>
        <div class="tc-id-text">
          <div class="stock-name">${escHtml(t.name)} <span class="stock-symbol">(${escHtml(t.symbol)})</span></div>
          <div class="stock-symbol">${fmtDate(t.date)} · ${t.quantity} @ ${fmtMoney(t.price)}${t.notes ? ' · ' + escHtml(t.notes) : ''}</div>
        </div>
      </div>`).join('');
  }
  searchResultsEl.innerHTML = html;
  if(window.lucide) lucide.createIcons();
}

globalSearchInput.addEventListener('input', () => renderSearchResults(globalSearchInput.value));
searchResultsEl.addEventListener('click', e => {
  const row = e.target.closest('.search-result');
  if(!row) return;
  const symbol = row.dataset.symbol;
  closeSearchModal();
  switchView('holdings');
  openDetailModal(symbol);
});

/* ---------------------------------------------------------------
   KEYBOARD SHORTCUTS (desktop)
   Ctrl/Cmd+K -> search, N -> new transaction, Esc -> close whatever
   overlay is on top. Ignored while typing in a text field so normal
   browser/editing shortcuts (and just typing the letter "n") aren't
   hijacked.
------------------------------------------------------------------*/
function isTypingInField(el){
  if(!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
document.addEventListener('keydown', (e) => {
  const cmdK = (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey);
  if(cmdK){
    e.preventDefault();
    if(searchModal.classList.contains('active')) closeSearchModal();
    else openSearchModal();
    return;
  }
  if(e.key === 'Escape'){
    // Close whichever overlay is actually open, topmost concern first.
    if(searchModal.classList.contains('active')) return closeSearchModal();
    if(txnModal.classList.contains('active')) return closeTxnModal();
    if(deleteModal.classList.contains('active')){ pendingDeleteId = null; return deleteModal.classList.remove('active'); }
    if(clearModal.classList.contains('active')) return clearModal.classList.remove('active');
    if(importModal.classList.contains('active')){ pendingImportData = null; return importModal.classList.remove('active'); }
    if(typeof inlineDetailOpen !== 'undefined' && inlineDetailOpen) return closeInlineDetail();
    return;
  }
  if((e.key === 'n' || e.key === 'N') && !isTypingInField(document.activeElement)){
    const anyModalOpen = document.querySelector('.modal-overlay.active');
    if(anyModalOpen) return;
    e.preventDefault();
    openTxnModal();
  }
});

/* ---------------------------------------------------------------
   TOAST + ESCAPING HELPERS
------------------------------------------------------------------*/
let toastTimer = null;
// action = { label, onClick } — optional. Existing showToast('message')
// calls elsewhere keep working exactly as before.
function showToast(msg, action){
  const el = document.getElementById('toast');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(msg));
  if(action){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.classList.remove('show');
      clearTimeout(toastTimer);
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2200);
}
function escHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escAttr(s){ return escHtml(s); }

/* ---------------------------------------------------------------
   REFRESH PRICES (global button, e.g. in Holdings header)
------------------------------------------------------------------*/
const refreshPricesBtn = document.getElementById('refreshPricesBtn');
if(refreshPricesBtn){
  refreshPricesBtn.addEventListener('click', () => refreshAllPrices(false));
}

/* ---------------------------------------------------------------
   INIT
------------------------------------------------------------------*/
loadState().then(() => {
  renderAll();
  if(window.lucide) lucide.createIcons();
  const loader = document.getElementById('initialLoader');
  if(loader){
    loader.classList.add('hide');
    setTimeout(() => loader.remove(), 250);
  }
  // Silently fetch live LTPs for all held symbols on load. If any
  // fetch fails, that symbol just keeps its last known / manual price.
  refreshAllPrices(true);
});

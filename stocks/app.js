// app.js — Ledger: modals, filters, demo data, toast, and app init

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
  if(updated > 0){ saveState(); renderAll(); }
  if(!silent){
    showToast(failed === 0
      ? `Updated ${updated} price${updated === 1 ? '' : 's'}`
      : `Updated ${updated}, ${failed} failed — enter manually`);
  }
}

// Fetches LTP for one symbol (used by the "Fetch LTP" button in the
// stock detail modal). Falls back silently to manual entry on failure.
async function refreshSinglePrice(symbol){
  showToast('Fetching LTP…');
  try{
    const ltp = await fetchLTP(symbol);
    prices[symbol] = ltp;
    saveState();
    renderDetailModal();
    renderAll();
    showToast(`LTP updated: ${fmtMoney(ltp)}`);
  }catch(err){
    showToast('Could not fetch LTP — enter price manually');
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
  const errEl = document.getElementById('txnError');
  errEl.style.display = 'none';

  const id = document.getElementById('txnId').value || null;
  const type = document.getElementById('txnType').value;
  const date = document.getElementById('txnDate').value;
  const name = document.getElementById('txnName').value.trim();
  const symbol = document.getElementById('txnSymbol').value.trim().toUpperCase();
  const quantity = parseFloat(document.getElementById('txnQty').value);
  const price = parseFloat(document.getElementById('txnPrice').value);
  const notes = document.getElementById('txnNotes').value.trim();

  if(!date || !name || !symbol || !quantity || quantity <= 0 || isNaN(price) || price < 0){
    errEl.textContent = 'Fill in date, stock name, symbol, a positive quantity, and a valid price.';
    errEl.style.display = 'block';
    return;
  }

  const candidate = { id: id || genId(), seq: id ? transactions.find(t=>t.id===id).seq : ++seqCounter, date, type, symbol, name, quantity, price, notes };
  const check = validateTransaction(candidate, id);
  if(!check.ok){
    errEl.textContent = `Insufficient quantity. Available quantity: ${check.available}`;
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

  saveState();
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
  transactions = transactions.filter(t => t.id !== pendingDeleteId);
  pendingDeleteId = null;
  saveState();
  deleteModal.classList.remove('active');
  renderAll();
  showToast('Transaction deleted');
});

/* ---------------------------------------------------------------
   CLEAR ALL DATA MODAL
------------------------------------------------------------------*/
const clearModal = document.getElementById('clearModalOverlay');
document.getElementById('clearDataBtn').addEventListener('click', () => clearModal.classList.add('active'));
document.getElementById('clearCancelBtn').addEventListener('click', () => clearModal.classList.remove('active'));
clearModal.addEventListener('click', e => { if(e.target === clearModal) clearModal.classList.remove('active'); });
document.getElementById('clearConfirmBtn').addEventListener('click', () => {
  transactions = [];
  prices = {};
  seqCounter = 0;
  saveState();
  clearModal.classList.remove('active');
  renderAll();
  showToast('All data cleared');
});

/* ---------------------------------------------------------------
   EXPORT / IMPORT DATA
------------------------------------------------------------------*/
document.getElementById('exportDataBtn').addEventListener('click', () => {
  const payload = {
    app: 'stocks-portfolio-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
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

document.getElementById('importDataBtn').addEventListener('click', () => importFileInput.click());

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
  saveState();
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
   STOCK DETAIL MODAL
------------------------------------------------------------------*/
const detailModal = document.getElementById('detailModalOverlay');
let detailSymbol = null;

function openDetailModal(symbol){
  detailSymbol = symbol;
  renderDetailModal();
  detailModal.classList.add('active');
}
function renderDetailModal(){
  const h = calculateStockHolding(detailSymbol);
  document.getElementById('detailTitle').textContent = `${h.name} (${h.symbol})`;
  document.getElementById('detailGrid').innerHTML = `
    <div><div class="k">Quantity held</div><div class="v">${h.quantity}</div></div>
    <div><div class="k">Average buy price</div><div class="v">${fmtMoney(h.avgPrice)}</div></div>
    <div><div class="k">Current price</div><div class="v">${fmtMoney(h.currentPrice)}</div></div>
    <div><div class="k">Portfolio weight</div><div class="v">${calculatePortfolioWeight(h.symbol).toFixed(1)}%</div></div>
    <div><div class="k">Invested cost</div><div class="v">${fmtMoney(h.investedValue, true)}</div></div>
    <div><div class="k">Current value</div><div class="v">${fmtMoney(h.currentValue, true)}</div></div>
    <div><div class="k">Unrealized P&amp;L</div><div class="v ${pnlClass(h.unrealizedPnL)}">${fmtSigned(h.unrealizedPnL, true)}</div></div>
    <div><div class="k">Unrealized P&amp;L %</div><div class="v ${pnlClass(h.unrealizedPnLPct)}">${fmtPct(h.unrealizedPnLPct)}</div></div>
    <div><div class="k">Total bought</div><div class="v">${h.totalBuyQty}</div></div>
    <div><div class="k">Total sold</div><div class="v">${h.totalSellQty}</div></div>
    <div><div class="k">Realized P&amp;L (this stock)</div><div class="v ${pnlClass(h.realizedPnL)}">${fmtSigned(h.realizedPnL, true)}</div></div>
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
  saveState();
  renderDetailModal();
  renderAll();
  showToast('Current price updated');
});
document.getElementById('detailFetchLtpBtn').addEventListener('click', () => {
  if(detailSymbol) refreshSinglePrice(detailSymbol);
});
document.getElementById('detailCloseBtn').addEventListener('click', () => detailModal.classList.remove('active'));
detailModal.addEventListener('click', e => { if(e.target === detailModal) detailModal.classList.remove('active'); });

/* ---------------------------------------------------------------
   TRANSACTION FILTERS
------------------------------------------------------------------*/
document.getElementById('filterStock').addEventListener('change', renderTransactions);
document.getElementById('filterType').addEventListener('change', renderTransactions);
document.getElementById('sortOrder').addEventListener('change', renderTransactions);
document.getElementById('filterSearch').addEventListener('input', renderTransactions);

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
  saveState();
  renderAll();
  showToast('Demo data loaded');
});

/* ---------------------------------------------------------------
   TOAST + ESCAPING HELPERS
------------------------------------------------------------------*/
let toastTimer = null;
function showToast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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
  // Silently fetch live LTPs for all held symbols on load. If any
  // fetch fails, that symbol just keeps its last known / manual price.
  refreshAllPrices(true);
});

// state.js — Ledger: storage, calculation engine, and formatting helpers

// STOCK PORTFOLIO TRACKER — CALCULATION ENGINE + UI
// ============================================================

/* ---------------------------------------------------------------
   STATE + PERSISTENCE
   transactions is the single source of truth. Nothing calculated
   (avg price, invested value, current value, P&L, weight) is ever
   stored — it's derived fresh every render from transactions + prices.

   Persisted in IndexedDB (database "blackStocks") instead of
   localStorage so data survives as structured records rather than
   flat strings.
------------------------------------------------------------------*/
const STORAGE_KEY_TXNS = 'ledger_transactions_v1';   // legacy localStorage keys, used only for one-time migration
const STORAGE_KEY_PRICES = 'ledger_prices_v1';
const STORAGE_KEY_SEQ = 'ledger_seq_v1';

const IDB_NAME_BASE = 'blackStocks';
// Namespaced per signed-in user so two accounts on the same browser never
// share a portfolio (see BRAuth.scopeSuffix in ../auth.js).
const IDB_NAME = window.BRAuth ? IDB_NAME_BASE + '::' + BRAuth.scopeSuffix() : IDB_NAME_BASE;
const IDB_VERSION = 1;
const IDB_STORE = 'state';

let transactions = [];   // [{id, seq, date, type, symbol, name, quantity, price, notes}]
let prices = {};         // { SYMBOL: currentPrice }
let seqCounter = 0;      // tie-breaker for same-date ordering

let idbPromise = null;
function openIdb(){
  if(idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    if(!window.indexedDB){
      reject(new Error('IndexedDB not supported in this browser'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)){
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

function idbGet(key){
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key, value){
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Async — resolves once transactions/prices/seqCounter have been loaded
// from IndexedDB (or migrated in from an older localStorage-based version,
// or an older un-namespaced version of this same IndexedDB database).
async function loadState(){
  try{
    let [t, p, s] = await Promise.all([
      idbGet('transactions'),
      idbGet('prices'),
      idbGet('seqCounter')
    ]);

    // Nothing in this user's namespaced IndexedDB yet — check for data left
    // over from the old shared (un-namespaced) database and migrate it in,
    // once, so existing data isn't lost by this update. Guests never get
    // their own persistent copy of anyone's data, so skip this for them.
    if(t === undefined && p === undefined && s === undefined && IDB_NAME !== IDB_NAME_BASE && !(window.BRAuth && BRAuth.isGuestSync())){
      const legacy = await loadLegacyIdbState();
      if(legacy){
        transactions = legacy.transactions || [];
        prices = legacy.prices || {};
        seqCounter = legacy.seqCounter || 0;
        await saveState();
        return;
      }
    }

    // Nothing in IndexedDB yet — check for data left over from the old
    // localStorage-based version and migrate it in, once.
    if(t === undefined && p === undefined && s === undefined && !(window.BRAuth && BRAuth.isGuestSync())){
      const legacyT = localStorage.getItem(STORAGE_KEY_TXNS);
      const legacyP = localStorage.getItem(STORAGE_KEY_PRICES);
      const legacyS = localStorage.getItem(STORAGE_KEY_SEQ);
      if(legacyT || legacyP || legacyS){
        t = legacyT ? JSON.parse(legacyT) : [];
        p = legacyP ? JSON.parse(legacyP) : {};
        s = legacyS ? parseInt(legacyS, 10) : 0;
        transactions = t;
        prices = p;
        seqCounter = s;
        await saveState();
        localStorage.removeItem(STORAGE_KEY_TXNS);
        localStorage.removeItem(STORAGE_KEY_PRICES);
        localStorage.removeItem(STORAGE_KEY_SEQ);
        return;
      }
    }

    transactions = t || [];
    prices = p || {};
    seqCounter = s || 0;
  }catch(e){
    console.error('loadState failed:', e);
    transactions = [];
    prices = {};
    seqCounter = 0;
  }
}

function loadLegacyIdbState(){
  return new Promise((resolve) => {
    try {
      const flag = 'br_migrated::' + IDB_NAME;
      if (localStorage.getItem(flag)) return resolve(null);
      const req = indexedDB.open(IDB_NAME_BASE);
      req.onupgradeneeded = (e) => e.target.transaction.abort();
      req.onerror = () => resolve(null);
      req.onsuccess = (e) => {
        const legacyDb = e.target.result;
        if (!legacyDb.objectStoreNames.contains(IDB_STORE)) {
          localStorage.setItem(flag, '1');
          legacyDb.close();
          return resolve(null);
        }
        const tx = legacyDb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
        Promise.all([
          new Promise((res) => { const r = tx.get('transactions'); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }),
          new Promise((res) => { const r = tx.get('prices'); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }),
          new Promise((res) => { const r = tx.get('seqCounter'); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }),
        ]).then(([legT, legP, legS]) => {
          localStorage.setItem(flag, '1');
          legacyDb.close();
          if (legT === undefined && legP === undefined && legS === undefined) resolve(null);
          else resolve({ transactions: legT, prices: legP, seqCounter: legS });
        });
      };
    } catch (e) {
      resolve(null);
    }
  });
}

// Fire-and-forget from most call sites (in-memory state is already
// updated by the time this is called); returns a Promise so callers
// that need to be sure a write landed — e.g. migration — can await it.
function saveState(){
  if (window.BRAuth && BRAuth.isGuestSync()) {
    return Promise.reject(Object.assign(new Error('Guest mode is view-only.'), { code: 'GUEST_READONLY' }));
  }
  return Promise.all([
    idbSet('transactions', transactions),
    idbSet('prices', prices),
    idbSet('seqCounter', seqCounter)
  ]).catch(e => console.error('saveState failed:', e));
}

function genId(){
  return 'txn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
}

/* ---------------------------------------------------------------
   CALCULATION ENGINE
   All figures are derived by replaying a symbol's transactions in
   chronological order using the average-cost method. This is the
   only place average price / invested value / realized P&L are
   computed — the UI never calculates these itself.
------------------------------------------------------------------*/

// Returns transactions for a symbol sorted chronologically (date, then insertion order).
function getSymbolTransactions(symbol, txnList){
  return (txnList || transactions)
    .filter(t => t.symbol === symbol)
    .sort((a,b) => (a.date === b.date) ? (a.seq - b.seq) : (a.date < b.date ? -1 : 1));
}

// Rounds a money figure to the nearest paisa. Repeated addition/subtraction
// of floating-point rupee amounts (the replay below does a lot of it) drifts
// into values like 149.99999999999997 or 1000.0000000000001 — invisible in
// a quick glance but wrong under the hood, and occasionally visible as a
// stray extra digit. Every money figure the calculation engine produces
// passes through this before it's used again or shown to anyone.
function round2(n){
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
// Same idea for share quantities, rounded to 6 decimal places — comfortably
// generous for fractional holdings while still killing dust like
// 9.999999999999998 so an exact sell-everything transaction doesn't get
// mistaken for "insufficient quantity" by a hair's-width rounding error.
function round6(n){
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

// Core replay: walks a symbol's transactions and derives running state.
// Returns { quantity, avgPrice, investedValue, realizedPnL, totalBuyQty, totalSellQty, error }
// error is set (with .atDate / .available) if a SELL would exceed holdings at that point.
function replaySymbol(symbol, txnList){
  const txns = getSymbolTransactions(symbol, txnList);
  let qty = 0, totalCost = 0, realizedPnL = 0, totalBuyQty = 0, totalSellQty = 0;

  for(const t of txns){
    if(t.type === 'BUY'){
      totalCost = round2(totalCost + t.quantity * t.price);
      qty = round6(qty + t.quantity);
      totalBuyQty = round6(totalBuyQty + t.quantity);
    } else { // SELL
      // A tiny tolerance instead of a bare ">" comparison, so selling every
      // last share you hold never gets wrongly rejected over float dust.
      if(round6(t.quantity - qty) > 1e-6){
        return { error: { available: qty, txnId: t.id, date: t.date } };
      }
      const avgCostAtSale = qty > 0 ? totalCost / qty : 0;
      const costBasis = round2(avgCostAtSale * t.quantity);
      const saleValue = round2(t.quantity * t.price);
      realizedPnL = round2(realizedPnL + (saleValue - costBasis));
      totalCost = round2(totalCost - costBasis);
      qty = round6(qty - t.quantity);
      totalSellQty = round6(totalSellQty + t.quantity);
    }
  }

  return {
    quantity: qty,
    avgPrice: qty > 0 ? round2(totalCost / qty) : 0,
    investedValue: qty > 0 ? round2(totalCost) : 0,
    realizedPnL,
    totalBuyQty,
    totalSellQty,
    error: null
  };
}

function calculateAveragePrice(symbol){ return replaySymbol(symbol).avgPrice; }
function calculateRemainingQuantity(symbol){ return replaySymbol(symbol).quantity; }
function calculateInvestedValue(symbol){ return replaySymbol(symbol).investedValue; }
function calculateRealizedPnL(symbol){ return replaySymbol(symbol).realizedPnL; }

function getCurrentPrice(symbol){
  if(prices[symbol] !== undefined && prices[symbol] !== null) return prices[symbol];
  // Fall back to the most recent transaction price for the symbol so a
  // brand-new holding doesn't show a ₹0 valuation before a manual price is set.
  const txns = getSymbolTransactions(symbol);
  if(txns.length) return txns[txns.length - 1].price;
  return 0;
}

function calculateCurrentValue(symbol){
  return round2(calculateRemainingQuantity(symbol) * getCurrentPrice(symbol));
}

function calculateUnrealizedPnL(symbol){
  return round2(calculateCurrentValue(symbol) - calculateInvestedValue(symbol));
}

function calculateUnrealizedPnLPercent(symbol){
  const invested = calculateInvestedValue(symbol);
  if(invested <= 0) return 0;
  return round2((calculateUnrealizedPnL(symbol) / invested) * 100);
}

// Full derived holding object for a symbol (only symbols with quantity > 0
// belong in "active holdings" per the spec).
function calculateStockHolding(symbol){
  const r = replaySymbol(symbol);
  const name = getSymbolName(symbol);
  const currentPrice = getCurrentPrice(symbol);
  const currentValue = round2(r.quantity * currentPrice);
  const unrealizedPnL = round2(currentValue - r.investedValue);
  const unrealizedPnLPct = r.investedValue > 0 ? round2((unrealizedPnL / r.investedValue) * 100) : 0;
  return {
    symbol, name,
    quantity: r.quantity,
    avgPrice: r.avgPrice,
    currentPrice,
    investedValue: r.investedValue,
    currentValue,
    unrealizedPnL,
    unrealizedPnLPct,
    realizedPnL: r.realizedPnL,
    totalBuyQty: r.totalBuyQty,
    totalSellQty: r.totalSellQty
  };
}

function getAllSymbols(){
  return [...new Set(transactions.map(t => t.symbol))];
}

function getSymbolName(symbol){
  // Most recent transaction's stock name wins, in case it was edited.
  const txns = getSymbolTransactions(symbol);
  return txns.length ? txns[txns.length - 1].name : symbol;
}

// Active holdings = quantity > 0 only. Sold-out stocks vanish from here
// but their transactions + realized P&L remain intact elsewhere.
function getActiveHoldings(){
  return getAllSymbols()
    .map(calculateStockHolding)
    .filter(h => h.quantity > 0);
}

function calculatePortfolioWeight(symbol){
  const totals = calculatePortfolioTotals();
  if(totals.currentValue <= 0) return 0;
  return round2((calculateCurrentValue(symbol) / totals.currentValue) * 100);
}

function calculatePortfolioTotals(){
  const holdings = getActiveHoldings();
  const investedValue = round2(holdings.reduce((s,h) => s + h.investedValue, 0));
  const currentValue = round2(holdings.reduce((s,h) => s + h.currentValue, 0));
  const unrealizedPnL = round2(currentValue - investedValue);
  const unrealizedPnLPct = investedValue > 0 ? round2((unrealizedPnL / investedValue) * 100) : 0;

  // Realized P&L is summed across ALL symbols ever traded, not just active ones,
  // so a fully-sold stock's profit is never dropped from the total.
  const realizedPnL = round2(getAllSymbols().reduce((s, sym) => s + calculateRealizedPnL(sym), 0));

  const totalPnL = round2(realizedPnL + unrealizedPnL);
  const totalPnLPct = investedValue > 0 ? round2((totalPnL / investedValue) * 100) : 0;

  return {
    investedValue, currentValue, unrealizedPnL, unrealizedPnLPct,
    realizedPnL, totalPnL, totalPnLPct,
    holdingsCount: holdings.length
  };
}

// Validates a prospective transaction (new or edited) against a symbol's
// full chronological history without allowing negative holdings anywhere
// along the timeline — not just at the end.
function validateTransaction(candidate, excludeId){
  if(candidate.type !== 'SELL') return { ok: true };
  const others = transactions.filter(t => t.id !== excludeId && t.symbol === candidate.symbol);
  const trial = others.concat([candidate]);
  const result = replaySymbol(candidate.symbol, trial);
  if(result.error){
    return { ok: false, available: result.error.available };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------
   FORMATTING
------------------------------------------------------------------*/
const inrFull = new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2, minimumFractionDigits:0 });
const inrWhole = new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 });

function fmtMoney(n, whole){
  const v = Number(n) || 0;
  return (whole ? inrWhole : inrFull).format(v);
}
function fmtSigned(n, whole){
  const v = Number(n) || 0;
  const s = fmtMoney(Math.abs(v), whole);
  return (v < 0 ? '-' : '+') + s;
}
function fmtPct(n){
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
function pnlClass(n){ return (Number(n) || 0) >= 0 ? 'pos' : 'neg'; }
function fmtDate(d){
  const dt = new Date(d + 'T00:00:00');
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}

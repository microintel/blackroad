// render.js — Ledger: navigation + all view-rendering functions

/* ---------------------------------------------------------------
   NAVIGATION
------------------------------------------------------------------*/
const viewTitles = {
  dashboard: ['Dashboard', 'Your holdings, calculated from transaction history'],
  holdings: ['Holdings', 'Everything currently in your portfolio'],
  transactions: ['Transactions', 'The full record — the source of truth for every calculation'],
  analytics: ['Analytics', 'Allocation and performance across your holdings'],
  settings: ['Settings', 'Back up your data or start fresh']
};

let currentView = 'dashboard';

function switchView(view){
  if(view === currentView) return;
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('viewTitle').textContent = viewTitles[view][0];
  document.getElementById('viewSub').textContent = viewTitles[view][1];
  // Each tab starts fresh at the top instead of inheriting the scroll
  // position left behind by whichever tab was open before it.
  window.scrollTo(0, 0);
  renderAll();
}

document.querySelectorAll('.nav-btn, .bnav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ---------------------------------------------------------------
   RENDER: DASHBOARD
------------------------------------------------------------------*/
function renderDashboard(){
  const t = calculatePortfolioTotals();
  const hero = document.getElementById('statementHero');
  hero.innerHTML = `
    <div class="statement-top">
      <div>
        <div class="statement-label">Current portfolio value</div>
        <div class="statement-value-row">
          <div class="statement-value">${fmtMoney(t.currentValue, true)}</div>
          <span class="pill ${pnlClass(t.totalPnL)}">${fmtPct(t.totalPnLPct)}</span>
        </div>
      </div>
      <div class="statement-aside">
        Total P&amp;L
        <span class="n ${pnlClass(t.totalPnL)}">${fmtSigned(t.totalPnL, true)}</span>
        realized + unrealized combined
      </div>
    </div>
    <div class="stat-strip">
      <div class="stat-item">
        <div class="lbl">Total invested</div>
        <div class="val sm">${fmtMoney(t.investedValue, true)}</div>
      </div>
      <div class="stat-item">
        <div class="lbl">Realized P&amp;L</div>
        <div class="val sm ${pnlClass(t.realizedPnL)}">${fmtSigned(t.realizedPnL, true)}</div>
      </div>
      <div class="stat-item">
        <div class="lbl">Unrealized P&amp;L</div>
        <div class="val sm ${pnlClass(t.unrealizedPnL)}">${fmtSigned(t.unrealizedPnL, true)} <span style="font-family:var(--sans); font-size:12px; font-weight:500;">(${fmtPct(t.unrealizedPnLPct)})</span></div>
      </div>
      <div class="stat-item">
        <div class="lbl">Stocks held</div>
        <div class="val sm">${t.holdingsCount}</div>
      </div>
    </div>
  `;

  const holdings = getActiveHoldings().sort((a,b) => b.currentValue - a.currentValue).slice(0, 6);
  const grid = document.getElementById('dashHoldingsCards');
  document.getElementById('dashHoldingsCount').textContent = getActiveHoldings().length + ' total';

  if(holdings.length === 0){
    grid.innerHTML = `<div class="empty-state">
      <div class="es-icon"><i data-lucide="inbox"></i></div>
      <div class="es-title">No holdings yet</div>
      <div class="es-body">Add your first buy transaction to start tracking your portfolio.</div>
      <button class="btn btn-primary" onclick="openTxnModal()"><i data-lucide="plus"></i>Add transaction</button></div>`;
    return;
  }

  grid.innerHTML = holdings.map(h => holdingCardHTML(h, false)).join('');
}

/* ---------------------------------------------------------------
   SHARED CARD TEMPLATES
------------------------------------------------------------------*/
function holdingCardHTML(h, full){
  const cls = pnlClass(h.unrealizedPnL);
  const weight = calculatePortfolioWeight(h.symbol);
  return `
    <div class="holding-card" onclick="openDetailModal('${escAttr(h.symbol)}')" role="button" tabindex="0" aria-label="View details for ${escAttr(h.name)}" onkeydown="if(event.key==='Enter')this.click()">
      <div class="hc-top">
        <div class="hc-id">
          <div class="hc-avatar">${escHtml(h.symbol.slice(0,2))}</div>
          <div class="hc-id-text"><div class="stock-name">${escHtml(h.name)}</div><div class="stock-symbol">${escHtml(h.symbol)}</div></div>
        </div>
        <div class="hc-pnl-block">
          <div class="hc-pnl ${cls}">${fmtSigned(h.unrealizedPnL, true)}</div>
          <div class="hc-pnlpct ${pnlClass(h.unrealizedPnLPct)}">${fmtPct(h.unrealizedPnLPct)}</div>
        </div>
      </div>
      <div class="hc-value-row">
        <div><span class="k">Current value</span><span class="v">${fmtMoney(h.currentValue, true)}</span></div>
        ${full ? `<div><span class="k">Invested</span><span class="v">${fmtMoney(h.investedValue, true)}</span></div>` : ''}
      </div>
      <div class="hc-meta">
        <span>Qty <b>${h.quantity}</b></span>
        <span>Avg <b>${fmtMoney(h.avgPrice)}</b></span>
        <span>LTP <b>${fmtMoney(h.currentPrice)}</b></span>
      </div>
      ${full ? `<div class="hc-weight">
        <div class="weight-bar-full"><div style="width:${Math.min(100,weight)}%"></div></div>
        <span>${weight.toFixed(1)}% of portfolio</span>
      </div>` : ''}
    </div>
  `;
}

function txnCardHTML(t){
  const isBuy = t.type === 'BUY';
  const typeIcon = isBuy ? 'arrow-down-left' : 'arrow-up-right';
  const amount = fmtMoney(t.quantity * t.price, true);
  return `
    <div class="txn-card">
      <div class="tc-top">
        <div class="tc-id">
          <div class="stock-avatar"><i data-lucide="building-2"></i></div>
          <div class="tc-id-text">
            <div class="stock-name">${escHtml(t.name)}</div>
            <div class="stock-symbol">${escHtml(t.symbol)} · ${fmtDate(t.date)}</div>
          </div>
        </div>
        <div class="tc-amount">${amount}</div>
      </div>
      <div class="tc-meta">
        <span class="type-badge ${isBuy ? 'buy' : 'sell'}"><i data-lucide="${typeIcon}"></i>${t.type}</span>
        <span>${t.quantity} shares · ${fmtMoney(t.price)}</span>
      </div>
      <div class="tc-actions">
        <button class="btn btn-sm btn-icon" onclick="openTxnModal('${escAttr(t.id)}')" title="Edit" aria-label="Edit"><i data-lucide="pencil"></i></button>
        <button class="btn btn-sm btn-icon btn-danger" onclick="openDeleteModal('${escAttr(t.id)}')" title="Delete" aria-label="Delete"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------
   RENDER: HOLDINGS
------------------------------------------------------------------*/
function renderHoldings(){
  const holdings = getActiveHoldings().sort((a,b) => b.currentValue - a.currentValue);
  const grid = document.getElementById('holdingsCards');

  if(holdings.length === 0){
    grid.innerHTML = `<div class="empty-state">
      <div class="es-icon"><i data-lucide="briefcase"></i></div>
      <div class="es-title">Nothing held right now</div>
      <div class="es-body">Stocks appear here once you buy shares, and disappear once you sell out completely — their history always stays in Transactions.</div>
      <button class="btn btn-primary" onclick="openTxnModal()"><i data-lucide="plus"></i>Add transaction</button></div>`;
    return;
  }

  grid.innerHTML = holdings.map(h => holdingCardHTML(h, true)).join('');
}

/* ---------------------------------------------------------------
   RENDER: TRANSACTIONS
------------------------------------------------------------------*/
function populateStockFilter(){
  const sel = document.getElementById('filterStock');
  const current = sel.value;
  const symbols = getAllSymbols().sort();
  sel.innerHTML = '<option value="">All stocks</option>' +
    symbols.map(s => `<option value="${escAttr(s)}">${escHtml(getSymbolName(s))} (${escHtml(s)})</option>`).join('');
  sel.value = symbols.includes(current) ? current : '';
}

function renderTransactions(){
  populateStockFilter();
  const stockFilter = document.getElementById('filterStock').value;
  const typeFilter = document.getElementById('filterType').value;
  const order = document.getElementById('sortOrder').value;
  const searchTerm = document.getElementById('filterSearch').value.trim().toLowerCase();

  /* Summary metrics — derived from the full transaction set (unfiltered),
     same underlying `transactions` array the rest of the app uses. */
  const totalCount = transactions.length;
  const buyCount = transactions.filter(t => t.type === 'BUY').length;
  const sellCount = transactions.filter(t => t.type === 'SELL').length;
  const totalValue = transactions.reduce((s,t) => s + (t.quantity * t.price), 0);

  document.getElementById('txnSummaryGrid').innerHTML = `
    <div class="metric-card">
      <div class="metric-icon accent"><i data-lucide="history"></i></div>
      <div class="metric-body"><div class="metric-label">Total Transactions</div><div class="metric-value">${totalCount}</div></div>
    </div>
    <div class="metric-card">
      <div class="metric-icon gain"><i data-lucide="trending-up"></i></div>
      <div class="metric-body"><div class="metric-label">Buy Orders</div><div class="metric-value">${buyCount}</div></div>
    </div>
    <div class="metric-card">
      <div class="metric-icon loss"><i data-lucide="trending-down"></i></div>
      <div class="metric-body"><div class="metric-label">Sell Orders</div><div class="metric-value">${sellCount}</div></div>
    </div>
    <div class="metric-card">
      <div class="metric-icon amber"><i data-lucide="indian-rupee"></i></div>
      <div class="metric-body"><div class="metric-label">Total Value</div><div class="metric-value">${fmtMoney(totalValue, true)}</div></div>
    </div>
  `;

  let list = transactions.slice();
  if(stockFilter) list = list.filter(t => t.symbol === stockFilter);
  if(typeFilter) list = list.filter(t => t.type === typeFilter);
  if(searchTerm) list = list.filter(t => t.name.toLowerCase().includes(searchTerm) || t.symbol.toLowerCase().includes(searchTerm));
  list.sort((a,b) => {
    if(a.date === b.date) return order === 'asc' ? a.seq - b.seq : b.seq - a.seq;
    return order === 'asc' ? (a.date < b.date ? -1 : 1) : (a.date > b.date ? -1 : 1);
  });

  const grid = document.getElementById('txnCards');
  if(list.length === 0){
    const hasAny = transactions.length > 0;
    grid.innerHTML = `<div class="empty-state">
      <div class="es-icon"><i data-lucide="receipt-text"></i></div>
      <div class="es-title">${hasAny ? 'No matching transactions' : 'No transactions yet'}</div>
      <div class="es-body">${hasAny ? 'Try adjusting your search or filters to see more activity.' : 'Add your first buy or sell transaction to start tracking your portfolio.'}</div>
      <button class="btn btn-primary" onclick="openTxnModal()"><i data-lucide="plus"></i>Add transaction</button></div>`;
    return;
  }

  grid.innerHTML = list.map(txnCardHTML).join('');
}

/* ---------------------------------------------------------------
   RENDER: ANALYTICS
------------------------------------------------------------------*/
function renderAnalytics(){
  const holdings = getActiveHoldings();
  const totals = calculatePortfolioTotals();

  // Performance overview hero
  const heroCls = pnlClass(totals.totalPnL);
  document.getElementById('perfHero').innerHTML = `
    <div class="perf-hero-main">
      <div class="perf-hero-icon"><i data-lucide="chart-no-axes-combined"></i></div>
      <div>
        <div class="perf-hero-value ${heroCls}">${fmtSigned(totals.totalPnL, true)}</div>
        <div class="perf-hero-pct ${heroCls}">${fmtPct(totals.totalPnLPct)}</div>
      </div>
    </div>
    <div class="perf-hero-split">
      <div class="phs-item">
        <div class="phs-icon"><i data-lucide="badge-check"></i></div>
        <div class="phs-body"><div class="phs-label">Realized P&amp;L</div><div class="phs-value ${pnlClass(totals.realizedPnL)}">${fmtSigned(totals.realizedPnL, true)}</div></div>
      </div>
      <div class="phs-item">
        <div class="phs-icon"><i data-lucide="activity"></i></div>
        <div class="phs-body"><div class="phs-label">Unrealized P&amp;L</div><div class="phs-value ${pnlClass(totals.unrealizedPnL)}">${fmtSigned(totals.unrealizedPnL, true)}</div></div>
      </div>
    </div>
  `;

  // Allocation — donut chart + list
  const allocDiv = document.getElementById('allocationList');
  const donutDiv = document.getElementById('allocDonut');
  if(holdings.length === 0){
    donutDiv.innerHTML = '';
    allocDiv.innerHTML = `<div class="empty-state" style="padding:20px 0;">
      <div class="es-icon"><i data-lucide="pie-chart"></i></div>
      <div class="es-title">No active holdings</div>
      <div class="es-body">Allocation appears here once you hold at least one stock.</div>
    </div>`;
  } else {
    const sorted = holdings.slice().sort((a,b) => b.currentValue - a.currentValue);
    const weighted = sorted.map(h => ({ ...h, weight: calculatePortfolioWeight(h.symbol) }));
    donutDiv.innerHTML = buildDonutChart(weighted);
    allocDiv.innerHTML = weighted.map((h, i) => {
      return `<div class="alloc-row">
        <div class="name"><span class="alloc-avatar" style="background:${chartColor(i)}22; color:${chartColor(i)};">${escHtml(h.symbol.slice(0,2))}</span><span class="alloc-label">${escHtml(h.symbol)}</span></div>
        <div class="alloc-bar-track"><div class="alloc-bar-fill" style="width:${Math.min(100,h.weight)}%; background:${chartColor(i)};"></div></div>
        <div class="alloc-pct">${h.weight.toFixed(1)}%</div>
      </div>`;
    }).join('');
  }

  // Holdings performance — horizontal bar chart of unrealized P&L %
  const barDiv = document.getElementById('perfBarChart');
  if(holdings.length === 0){
    barDiv.innerHTML = `<div class="empty-state" style="padding:20px 0;">
      <div class="es-icon"><i data-lucide="bar-chart-3"></i></div>
      <div class="es-title">No performance data yet</div>
      <div class="es-body">Once you hold at least one stock, its P&amp;L% shows up here.</div>
    </div>`;
  } else {
    barDiv.innerHTML = buildPerfBarChart(holdings);
  }

  document.getElementById('anRealized').innerHTML = `<span class="${pnlClass(totals.realizedPnL)}">${fmtSigned(totals.realizedPnL, true)}</span>`;
  document.getElementById('anUnrealized').innerHTML = `<span class="${pnlClass(totals.unrealizedPnL)}">${fmtSigned(totals.unrealizedPnL, true)}</span>`;
  document.getElementById('anTotal').innerHTML = `<span class="${pnlClass(totals.totalPnL)}" style="font-weight:700;">${fmtSigned(totals.totalPnL, true)}</span>`;

  const perfStrip = document.getElementById('perfStrip');

  if(holdings.length === 0){
    perfStrip.innerHTML = `
      <div class="insight-card"><div class="insight-icon"><i data-lucide="trophy"></i></div><div class="insight-label">Best Performing Stock</div><div class="insight-name">No holdings yet</div></div>
      <div class="insight-card"><div class="insight-icon"><i data-lucide="triangle-alert"></i></div><div class="insight-label">Worst Performing Stock</div><div class="insight-name">No holdings yet</div></div>
      <div class="insight-card"><div class="insight-icon"><i data-lucide="scale"></i></div><div class="insight-label">Largest Holding</div><div class="insight-name">No holdings yet</div></div>
    `;
  } else {
    const best = holdings.slice().sort((a,b) => b.unrealizedPnLPct - a.unrealizedPnLPct)[0];
    const worst = holdings.slice().sort((a,b) => a.unrealizedPnLPct - b.unrealizedPnLPct)[0];
    const largest = holdings.slice().sort((a,b) => b.currentValue - a.currentValue)[0];

    perfStrip.innerHTML = `
      <div class="insight-card">
        <div class="insight-icon"><i data-lucide="trophy"></i></div>
        <div class="insight-label">Best Performing Stock</div>
        <div class="insight-name">${escHtml(best.name)}</div>
        <div class="insight-value ${pnlClass(best.unrealizedPnLPct)}">${fmtPct(best.unrealizedPnLPct)}</div>
      </div>
      <div class="insight-card">
        <div class="insight-icon"><i data-lucide="triangle-alert"></i></div>
        <div class="insight-label">Worst Performing Stock</div>
        <div class="insight-name">${escHtml(worst.name)}</div>
        <div class="insight-value ${pnlClass(worst.unrealizedPnLPct)}">${fmtPct(worst.unrealizedPnLPct)}</div>
      </div>
      <div class="insight-card">
        <div class="insight-icon"><i data-lucide="scale"></i></div>
        <div class="insight-label">Largest Holding</div>
        <div class="insight-name">${escHtml(largest.name)}</div>
        <div class="insight-value">${fmtMoney(largest.currentValue, true)}</div>
      </div>
    `;
  }
}

/* ---------------------------------------------------------------
   ANALYTICS CHART HELPERS (plain SVG, no external chart library)
------------------------------------------------------------------*/
const CHART_PALETTE = ['#5B9DFF','#E3AC54','#3ECF8E','#B98CF0','#F27A8A','#4FD1C5','#F0B429','#7C93FF','#E879B0','#8FD14F'];
function chartColor(i){ return CHART_PALETTE[i % CHART_PALETTE.length]; }

// Donut chart of portfolio weight per holding, built with stroke-dasharray
// arcs on a single SVG circle — no charting library required.
function buildDonutChart(weightedHoldings){
  const size = 168, cx = size/2, cy = size/2, r = 58, strokeW = 24;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = weightedHoldings.map((h, i) => {
    const frac = Math.max(0, Math.min(100, h.weight)) / 100;
    const dash = frac * circumference;
    const gap = Math.max(circumference - dash, 0);
    const arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${chartColor(i)}"
      stroke-width="${strokeW}" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    offset += dash;
    return arc;
  }).join('');
  const totals = calculatePortfolioTotals();
  return `
    <svg viewBox="0 0 ${size} ${size}" class="donut-chart" role="img" aria-label="Portfolio allocation by holding">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="${strokeW}"></circle>
      ${arcs}
    </svg>
    <div class="donut-center">
      <div class="donut-center-label">Total value</div>
      <div class="donut-center-value">${fmtMoney(totals.currentValue, true)}</div>
    </div>
  `;
}

// Horizontal bar chart of unrealized P&L % per holding, sorted best to worst.
function buildPerfBarChart(holdings){
  const sorted = holdings.slice().sort((a,b) => b.unrealizedPnLPct - a.unrealizedPnLPct);
  const maxAbs = Math.max(1, ...sorted.map(h => Math.abs(h.unrealizedPnLPct)));
  return `<div class="bar-chart">` + sorted.map(h => {
    const cls = pnlClass(h.unrealizedPnLPct);
    const widthPct = Math.min(100, (Math.abs(h.unrealizedPnLPct) / maxAbs) * 100);
    return `
      <div class="bar-row">
        <div class="bar-label" title="${escAttr(h.name)}">${escHtml(h.symbol)}</div>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${widthPct}%"></div></div>
        <div class="bar-val ${cls}">${fmtPct(h.unrealizedPnLPct)}</div>
      </div>
    `;
  }).join('') + `</div>`;
}

// Line chart of a single stock's closing price history, with an optional
// marker for the user's purchase date. Pure SVG, styled with CSS vars so
// it follows the light/dark theme automatically.
function buildPriceLineChart(history, opts){
  opts = opts || {};
  const w = 600, h = 220;
  const padL = 54, padR = 12, padT = 14, padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = history.length;

  const closes = history.map(p => p.close);
  let min = Math.min(...closes), max = Math.max(...closes);
  if(min === max){ min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const x = i => padL + (n === 1 ? plotW/2 : (i/(n-1)) * plotW);
  const y = v => padT + plotH - ((v - min) / (max - min)) * plotH;

  const up = closes[n-1] >= closes[0];
  const lineColor = up ? 'var(--gain)' : 'var(--loss)';
  const gradId = 'priceGrad' + Math.random().toString(36).slice(2, 9);

  const pts = history.map((p, i) => `${x(i).toFixed(2)},${y(p.close).toFixed(2)}`);
  const areaPath = `M${x(0).toFixed(2)},${(padT+plotH).toFixed(2)} L${pts.join(' L')} L${x(n-1).toFixed(2)},${(padT+plotH).toFixed(2)} Z`;

  // Marker for the user's purchase date — first history point on/after it.
  let marker = null;
  if(opts.buyDate){
    let idx = history.findIndex(p => p.date >= opts.buyDate);
    if(idx === -1) idx = 0;
    marker = { x: x(idx), y: y(history[idx].close) };
  }

  const yTicks = [max - pad, (max + min) / 2, min + pad];
  const xTickIdx = n > 1 ? [0, Math.floor((n-1)/2), n-1] : [0];

  return `
    <svg viewBox="0 0 ${w} ${h}" class="price-chart" preserveAspectRatio="none" role="img" aria-label="Price chart">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.3"></stop>
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${yTicks.map(v => `<line x1="${padL}" x2="${w-padR}" y1="${y(v).toFixed(2)}" y2="${y(v).toFixed(2)}" class="chart-gridline"></line>`).join('')}
      <path d="${areaPath}" fill="url(#${gradId})"></path>
      <polyline points="${pts.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${marker ? `<line x1="${marker.x.toFixed(2)}" x2="${marker.x.toFixed(2)}" y1="${padT}" y2="${padT+plotH}" class="chart-buy-line"></line>
      <circle cx="${marker.x.toFixed(2)}" cy="${marker.y.toFixed(2)}" r="4.5" class="chart-buy-marker"></circle>` : ''}
      ${yTicks.map(v => `<text x="2" y="${(y(v)+4).toFixed(2)}" class="chart-axis-label">${fmtMoney(v, true)}</text>`).join('')}
      ${xTickIdx.map(i => `<text x="${x(i).toFixed(2)}" y="${h-6}" text-anchor="${i===0?'start':(i===n-1?'end':'middle')}" class="chart-axis-label">${fmtDate(history[i].date).replace(/\s\d{4}$/,'')}</text>`).join('')}
    </svg>
    ${marker ? `<div class="chart-legend"><span class="chart-legend-dot"></span>Bought ${fmtDate(opts.buyDate)}</div>` : ''}
  `;
}

function renderAll(){
  // Only the visible tab needs to be rendered right now — the others
  // will render themselves the moment switchView() makes them active.
  // Re-rendering all four on every data change/tab switch was the
  // main source of the sluggish feel.
  switch(currentView){
    case 'dashboard':    renderDashboard();    break;
    case 'holdings':     renderHoldings();     break;
    case 'transactions': renderTransactions(); break;
    case 'analytics':    renderAnalytics();    break;
    case 'settings':     break; // static content, nothing to compute
  }
  if(window.lucide) lucide.createIcons();
}

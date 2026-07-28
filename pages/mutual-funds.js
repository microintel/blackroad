/* ═══════════════════════════════════════════════════════════════
   BlackRoad — Mutual Fund (Step-Up SIP) tracker
   Consolidated from: helpers.js, db.js, calc.js, charts.js,
   render.js, pdf-report.js, app.js

   Storage: shared BlackRoadDB IndexedDB database (see db.js
   section below) — same database used by pages/stocks.html,
   so blackroad-dashboard.html can read a live summary.
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────── helpers.js ───────────────── */
/* ══════════════════════════════════════════════════════
   helpers.js — Formatting, toast, date utils
══════════════════════════════════════════════════════ */

function fmt(n)    { return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtK(n)   { return Math.abs(n) >= 1e5 ? '₹' + (n / 1e5).toFixed(2) + 'L' : fmt(n); }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toast(msg, dur = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

/**
 * Format a Date object as YYYY-MM-DD using LOCAL timezone.
 * Never use .toISOString().slice(0,10) for locally-constructed dates —
 * in IST (UTC+5:30) midnight local = 18:30 previous day UTC, which shifts
 * the date back by one day.
 */
function dateToStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function todayStr() {
  return dateToStr(new Date());
}

/* ───────────────── db.js ───────────────── */
/* ══════════════════════════════════════════════════════
   db.js — IndexedDB helpers (multi-profile)
══════════════════════════════════════════════════════ */

/* Shared with the rest of BlackRoad (see /pages/stocks-store.js and
   blackroad-dashboard.html). All BlackRoad pages open this same database
   name/version so a single connection upgrade can create every store,
   regardless of which page happens to open it first. */
const DB_NAME = 'BlackRoadDB', DB_VERSION = 2;
let db;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const d = e.target.result;

      /* ── this app's stores ── */
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries'))  d.createObjectStore('entries',  { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'id', autoIncrement: true });

      /* ── other BlackRoad pages' stores (created here too, in case this
         page is the one that performs the version upgrade first) ── */
      if (!d.objectStoreNames.contains('stocks')) {
        const stocksStore = d.createObjectStore('stocks', { keyPath: 'id', autoIncrement: true });
        stocksStore.createIndex('symbol', 'symbol', { unique: false });
      }
    };
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror   = e => rej(e.target.error);
  });
}

const txs   = (s, m = 'readonly') => db.transaction(s, m).objectStore(s);
const dbGet = (s, k) => new Promise((res, rej) => { const r = txs(s).get(k);        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbPut = (s, v) => new Promise((res, rej) => { const r = txs(s, 'readwrite').put(v);    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbDel = (s, k) => new Promise((res, rej) => { const r = txs(s, 'readwrite').delete(k); r.onsuccess = () => res();         r.onerror = () => rej(r.error); });
const dbAll = (s)    => new Promise((res, rej) => { const r = txs(s).getAll();               r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbClr = (s)    => new Promise((res, rej) => { const r = txs(s, 'readwrite').clear();   r.onsuccess = () => res();         r.onerror = () => rej(r.error); });

/* ── Profile-scoped keys ── */
/* settings key: "settings:{profileId}", entries key prefix: "p{profileId}:" */

/**
 * Get settings for a specific profile.
 * Settings are stored in the 'settings' store with id = profileId.
 */
function dbGetSettings(profileId) {
  return dbGet('settings', profileId);
}

/**
 * Put settings for a specific profile.
 */
function dbPutSettings(profileId, data) {
  return dbPut('settings', { ...data, id: profileId });
}

/**
 * Get all entries for a specific profile.
 * Each entry has a `profileId` field.
 */
function dbGetEntries(profileId) {
  return new Promise((res, rej) => {
    const store = db.transaction('entries', 'readonly').objectStore('entries');
    const results = [];
    const cursor = store.openCursor();
    cursor.onsuccess = e => {
      const c = e.target.result;
      if (!c) { res(results); return; }
      if (c.value.profileId === profileId) results.push(c.value);
      c.continue();
    };
    cursor.onerror = e => rej(e.target.error);
  });
}

/**
 * Put an entry for a specific profile.
 */
function dbPutEntry(profileId, entry) {
  return dbPut('entries', { ...entry, profileId });
}

/**
 * Delete an entry by id.
 */
function dbDelEntry(id) {
  return dbDel('entries', id);
}

/**
 * Clear all entries for a specific profile.
 */
function dbClearEntries(profileId) {
  return new Promise((res, rej) => {
    const store = db.transaction('entries', 'readwrite').objectStore('entries');
    const toDelete = [];
    const cursor = store.openCursor();
    cursor.onsuccess = e => {
      const c = e.target.result;
      if (!c) {
        // Now delete
        const tx = db.transaction('entries', 'readwrite');
        const st = tx.objectStore('entries');
        let done = 0;
        if (!toDelete.length) { res(); return; }
        toDelete.forEach(id => {
          const r = st.delete(id);
          r.onsuccess = () => { done++; if (done === toDelete.length) res(); };
          r.onerror   = e => rej(e.target.error);
        });
        return;
      }
      if (c.value.profileId === profileId) toDelete.push(c.value.id);
      c.continue();
    };
    cursor.onerror = e => rej(e.target.error);
  });
}

/* ── Profile CRUD ── */
function dbGetAllProfiles() { return dbAll('profiles'); }
function dbPutProfile(p)    { return dbPut('profiles', p); }
function dbDelProfile(id)   { return dbDel('profiles', id); }

/* ───────────────── calc.js ───────────────── */
/* ══════════════════════════════════════════════════════
   calc.js — SIP recalculation logic
══════════════════════════════════════════════════════ */


/**
 * Get the actual SIP date for a given year+month,
 * clamped to the last day of that month.
 */
function sipDateForMonth(sipDay, year, month) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(sipDay, lastDay);
  return new Date(year, month, day);
}

/**
 * Generate all SIP instalment dates from startDate up to and including endDate.
 * Each entry: { date: Date, dateStr: 'YYYY-MM-DD' }
 *
 * IMPORTANT: dateToStr() is used (not .toISOString()) to avoid the UTC midnight
 * shift bug in IST (UTC+5:30) where new Date(y,m,d).toISOString() returns the
 * previous day's date.
 */
function allSipDates(startStr, endStr) {
  const start  = new Date(startStr);
  const end    = new Date(endStr);
  const sipDay = start.getDate();
  const dates  = [];

  let year  = start.getFullYear();
  let month = start.getMonth();

  while (true) {
    const d  = sipDateForMonth(sipDay, year, month);
    if (d > end) break;
    dates.push({ date: d, dateStr: dateToStr(d) });   // ← timezone-safe
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return dates;
}

/**
 * Given a sipSchedule array (sorted by fromDate asc), return the SIP amount
 * active on a given SIP date string.
 */
function amountForDate(sipSchedule, dateStr) {
  if (!sipSchedule || !sipSchedule.length) return 0;
  let amount = sipSchedule[0].amount;
  for (const seg of sipSchedule) {
    if (seg.fromDate <= dateStr) amount = seg.amount;
    else break;
  }
  return amount;
}

/**
 * Returns array of { dateStr, amount } for each active SIP between
 * prevStr (exclusive) and currStr (inclusive), skipping any in skippedSipDates.
 */
function sipsBetween(cfg, prevStr, currStr) {
  if (!cfg || !cfg.startDate) return [];
  const prev = prevStr ? new Date(prevStr) : null;
  const curr = new Date(currStr);

  const skipped  = new Set(cfg.skippedSipDates || []);
  const schedule = (cfg.sipSchedule && cfg.sipSchedule.length)
    ? cfg.sipSchedule
    : [{ fromDate: cfg.startDate, amount: cfg.sipAmount || 0 }];

  return allSipDates(cfg.startDate, currStr)
    .filter(({ date, dateStr }) => {
      if (date > curr) return false;
      if (prev) {
        const p = new Date(prev); p.setHours(0, 0, 0, 0);
        if (date <= p) return false;
      }
      if (skipped.has(dateStr)) return false;
      return true;
    })
    .map(({ dateStr }) => ({
      dateStr,
      amount: amountForDate(schedule, dateStr),
    }));
}

/** Legacy helper for entry preview — just counts instalments. */
function sipCountBetween(startStr, prevStr, currStr) {
  if (!startStr) return 0;
  return sipsBetween({ startDate: startStr, skippedSipDates: [] }, prevStr, currStr).length;
}

/**
 * Rebuild portfolioValue & investedAmount for all entries in order.
 * Supports step-up SIP (sipSchedule) and skipped months (skippedSipDates).
 */
function recalcAll(raw, cfg) {
  if (!raw.length || !cfg) return [];
  const sorted = [...raw].sort((a, b) => a.date.localeCompare(b.date));
  let portfolioValue = 0, investedAmount = 0, prevDate = null;

  return sorted.map(entry => {
    const sips = sipsBetween(cfg, prevDate, entry.date);

    let sipTotal = 0;
    for (const s of sips) {
      portfolioValue += s.amount;
      investedAmount += s.amount;
      sipTotal       += s.amount;
    }

    portfolioValue = portfolioValue * (1 + entry.percentChange / 100);

    prevDate = entry.date;
    return {
      ...entry,
      sipAdded:       sips.length > 0,
      sipCount:       sips.length,
      sipTotal,
      sipDetails:     sips,
      portfolioValue: +portfolioValue.toFixed(4),
      investedAmount: +investedAmount.toFixed(4),
    };
  });
}

/** Persist the recalculated values back to IndexedDB. */
async function saveCalcEntries(calc, profileId) {
  for (const e of calc) {
    await dbPutEntry(profileId, {
      id:             e.id,
      date:           e.date,
      percentChange:  e.percentChange,
      portfolioValue: e.portfolioValue,
      investedAmount: e.investedAmount,
    });
  }
}

/* ───────────────── charts.js ───────────────── */
/* ══════════════════════════════════════════════════════
   charts.js — Line chart + overview navigator + donut
══════════════════════════════════════════════════════ */


const charts = {};
let fullLabels   = [];
let fullValues   = [];
let fullInvested = [];
let selRange     = { min: 0, max: 0 };

/* ── Shared utils ── */
function makeChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id).getContext('2d'), config);
  return charts[id];
}

function getTooltipStyle() {
  return {
    backgroundColor: themeColor('--surface2'),
    borderColor:     themeColor('--border'),
    borderWidth:     1,
    titleColor:      themeColor('--text'),
    bodyColor:       themeColor('--muted'),
    padding:         10,
  };
}

function buildFullSeries(calc) {
  fullLabels   = calc.map(e => e.date);
  fullValues   = calc.map(e => e.portfolioValue);
  fullInvested = calc.map(e => e.investedAmount);
}

/* ── Overview band plugin ── */
const overviewBandPlugin = {
  id: 'overviewBand',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { x } } = chart;
    if (!chartArea || !fullLabels.length) return;
    const left  = x.getPixelForValue(selRange.min);
    const right = x.getPixelForValue(selRange.max);
    ctx.save();
    ctx.fillStyle = 'rgba(47,129,247,.07)';
    ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
    ctx.restore();
  },
};

/* ── Touch scroll lock ── */
function lockChartTouch(canvasEl) {
  canvasEl._touchLocked = true;
  const prevent = e => { if (canvasEl._touchLocked) e.preventDefault(); };
  canvasEl.addEventListener('touchstart', prevent, { passive: false });
  canvasEl.addEventListener('touchmove',  prevent, { passive: false });
}

/* ══════════════════════════════════════════════════════
   Main Line Chart
══════════════════════════════════════════════════════ */
function renderLineChart(calc) {
  buildFullSeries(calc);
  const muted    = themeColor('--muted');
  const positive = fullValues[fullValues.length - 1] >= fullInvested[fullInvested.length - 1];

  makeChart('chart-line', {
    type: 'line',
    data: {
      labels: fullLabels,
      datasets: [{
        label:                 'Portfolio Value',
        data:                  fullValues,
        borderColor:           positive ? '#00c853' : '#ff5252',
        borderWidth:           3,
        tension:               0.45,
        pointRadius:           0,
        pointHoverRadius:      6,
        pointHoverBorderWidth: 3,
        fill:                  true,
        backgroundColor: ctx => {
          const { ctx: canvas, chartArea } = ctx.chart;
          if (!chartArea) return null;
          const gradient = canvas.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          if (positive) {
            gradient.addColorStop(0, 'rgba(0,200,83,0.35)');
            gradient.addColorStop(1, 'rgba(0,200,83,0)');
          } else {
            gradient.addColorStop(0, 'rgba(255,82,82,0.35)');
            gradient.addColorStop(1, 'rgba(255,82,82,0)');
          }
          return gradient;
        },
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { intersect: false, mode: 'index' },
      plugins: {
        legend:  { labels: { color: muted, font: { size: 11 } } },
        tooltip: {
          ...getTooltipStyle(),
          callbacks: { label: c => ` ${c.dataset.label}: ${fmtK(c.parsed.y)}` },
        },
        zoom: {
          pan: {
            enabled: true,
            mode:    'x',
            onPanComplete: ({ chart }) => syncSelectionFromMain(chart),
          },
          zoom: {
            wheel:          { enabled: true },
            pinch:          { enabled: true },
            drag:           { enabled: false },
            mode:           'x',
            onZoomComplete: ({ chart }) => syncSelectionFromMain(chart),
          },
          limits: {
            x: { min: 0, max: Math.max(fullLabels.length - 1, 0), minRange: 5 },
          },
        },
      },
      scales: { x: { display: false }, y: { display: false } },
    },
  });

  lockChartTouch(document.getElementById('chart-line'));
  renderOverviewChart();
  applyRangeToMain(_activeRange.line);
}

/* ══════════════════════════════════════════════════════
   Overview Mini Strip
══════════════════════════════════════════════════════ */
function renderOverviewChart() {
  const grey = 'rgba(125,133,144,.55)';
  makeChart('chart-overview', {
    type: 'line',
    data: {
      labels: fullLabels,
      datasets: [{
        data:        fullValues,
        borderWidth: 1.2,
        pointRadius: 0,
        fill:        false,
        tension:     .3,
        segment: {
          borderColor: ctx =>
            (ctx.p0DataIndex >= selRange.min && ctx.p1DataIndex <= selRange.max)
              ? '#2f81f7' : grey,
        },
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales:  { x: { display: false }, y: { display: false } },
    },
    plugins: [overviewBandPlugin],
  });
}

/* ══════════════════════════════════════════════════════
   Selection Sync
══════════════════════════════════════════════════════ */
function syncSelectionFromMain(chart) {
  const xs = chart.scales.x;
  let min  = Math.round(xs.min), max = Math.round(xs.max);
  min = Math.max(0, min);
  max = Math.min(fullLabels.length - 1, max);
  selRange = { min, max };
  refreshSelectionUI();
}

function refreshSelectionUI() {
  if (charts['chart-overview']) charts['chart-overview'].update('none');
  positionSelectionBox();
}

function positionSelectionBox() {
  const ov   = charts['chart-overview'];
  const wrap = document.getElementById('overview-wrap');
  const box  = document.getElementById('selection-box');
  if (!ov || !wrap || !box || !fullLabels.length) return;
  const xs    = ov.scales.x;
  const left  = xs.getPixelForValue(selRange.min);
  const right = xs.getPixelForValue(selRange.max);
  box.style.left  = left + 'px';
  box.style.width = Math.max(right - left, 16) + 'px';
}

/* ══════════════════════════════════════════════════════
   Range / Zoom
══════════════════════════════════════════════════════ */
let _activeRange = { line: 'all' };
function setActiveRange(key, val) { _activeRange[key] = val; }
function getActiveRange()         { return _activeRange; }

function applyRangeToMain(rangeVal) {
  const n = fullLabels.length;
  if (!n) { selRange = { min: 0, max: 0 }; refreshSelectionUI(); return; }
  let minIdx = 0;
  if (rangeVal !== 'all') {
    const lastDate = new Date(fullLabels[n - 1]), cutoff = new Date(lastDate);
    if (rangeVal === '7d') cutoff.setDate(cutoff.getDate() - 7);
    else cutoff.setMonth(cutoff.getMonth() - parseInt(rangeVal));
    const idx = fullLabels.findIndex(d => new Date(d) >= cutoff);
    minIdx = idx === -1 ? 0 : idx;
  }
  const chart = charts['chart-line'];
  if (chart) chart.zoomScale('x', { min: minIdx, max: n - 1 }, 'none');
  selRange = { min: minIdx, max: n - 1 };
  refreshSelectionUI();
}

function filterByRange(calc, rangeVal) {
  if (rangeVal === 'all' || !calc.length) return calc;
  const last   = new Date(calc[calc.length - 1].date);
  const cutoff = new Date(last);
  if (rangeVal === '7d') cutoff.setDate(cutoff.getDate() - 7);
  else cutoff.setMonth(cutoff.getMonth() - parseInt(rangeVal));
  return calc.filter(e => new Date(e.date) >= cutoff);
}

function getChart(id) { return charts[id]; }

/* ══════════════════════════════════════════════════════
   Dashboard Donut — Invested vs Profit / Loss
══════════════════════════════════════════════════════ */
function fmtDonut(n) {
  return Math.abs(n) >= 1e5
    ? '₹' + (n / 1e5).toFixed(2) + 'L'
    : '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function renderDonutChart(invested, pnl) {
  const canvas = document.getElementById('chart-donut');
  if (!canvas) return;

  const profit  = pnl > 0 ? pnl : 0;
  const loss    = pnl < 0 ? Math.abs(pnl) : 0;
  const isLoss  = loss > 0;
  const isEmpty = invested <= 0;

  /* Update text labels */
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('donut-total',    isEmpty ? '₹0' : fmtDonut(invested + pnl));
  set('donut-invested', isEmpty ? '₹0' : fmtDonut(invested));
  set('donut-profit',   profit > 0 ? '+' + fmtDonut(profit) : '₹0');
  set('donut-loss',     loss   > 0 ? '-' + fmtDonut(loss)   : '₹0');

  /* Build data + colors fresh each call so tooltip closure is always current */
  const data   = isEmpty  ? [1]
               : isLoss   ? [invested, loss]
               :             [invested, profit || 0.001];

  const colors = isEmpty  ? ['#21262d']
               : isLoss   ? ['#58a6ff', '#f85149']
               :             ['#58a6ff', '#00c853'];

  const tooltipLabels = isLoss ? ['Invested', 'Loss'] : ['Invested', 'Profit'];

  /* If chart already exists — update data in-place (no flicker) */
  if (charts['chart-donut']) {
    const ch = charts['chart-donut'];
    ch.data.datasets[0].data            = data;
    ch.data.datasets[0].backgroundColor = colors;
    /* Re-assign tooltip callback so labels stay correct after update */
    ch.options.plugins.tooltip.callbacks.label = ctx =>
      ` ${tooltipLabels[ctx.dataIndex] ?? ''}: ${fmtDonut(ctx.parsed)}`;
    ch.update();
    return;
  }

  /* First render */
  charts['chart-donut'] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      datasets: [{
        data,
        backgroundColor:  colors,
        borderColor:      'transparent',
        borderWidth:      0,
        hoverOffset:      6,
        borderRadius:     4,
      }],
    },
    options: {
      responsive:          false,
      maintainAspectRatio: false,
      cutout:              '70%',
      plugins: {
        legend:  { display: false },
        tooltip: {
          ...getTooltipStyle(),
          callbacks: {
            label: ctx =>
              ` ${tooltipLabels[ctx.dataIndex] ?? ''}: ${fmtDonut(ctx.parsed)}`,
          },
        },
      },
      animation: { duration: 500 },
    },
  });
}

/* ══════════════════════════════════════════════════════
   Draggable / Resizable Navigator Selection Box
══════════════════════════════════════════════════════ */
function wireSelectionDrag() {
  const box  = document.getElementById('selection-box');
  const wrap = document.getElementById('overview-wrap');
  let mode = null, startX = 0, startMin = 0, startMax = 0;

  function pxToIdx(px) {
    const ov = charts['chart-overview']; if (!ov) return 0;
    const v  = ov.scales.x.getValueForPixel(px);
    return Math.max(0, Math.min(fullLabels.length - 1, Math.round(v)));
  }

  function applySelToMain() {
    const chart = charts['chart-line'];
    if (chart) chart.zoomScale('x', { min: selRange.min, max: selRange.max }, 'none');
    refreshSelectionUI();
  }

  function onDown(handle, e) {
    mode     = handle;
    startX   = (e.touches ? e.touches[0] : e).clientX;
    startMin = selRange.min;
    startMax = selRange.max;
    e.preventDefault();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onUp);
  }

  function onMove(e) {
    if (!mode) return;
    e.preventDefault();
    const clientX = (e.touches ? e.touches[0] : e).clientX;
    const ov = charts['chart-overview']; if (!ov) return;
    const xs   = ov.scales.x;
    const dxPx = clientX - startX;
    if (mode === 'move') {
      const startMinPx = xs.getPixelForValue(startMin);
      const startMaxPx = xs.getPixelForValue(startMax);
      let newMinIdx = pxToIdx(startMinPx + dxPx);
      const span    = startMax - startMin;
      newMinIdx     = Math.max(0, Math.min(fullLabels.length - 1 - span, newMinIdx));
      selRange      = { min: newMinIdx, max: newMinIdx + span };
    } else if (mode === 'left') {
      const px = xs.getPixelForValue(startMin) + dxPx;
      selRange = { min: Math.min(pxToIdx(px), selRange.max - 3), max: selRange.max };
      if (selRange.min < 0) selRange.min = 0;
    } else if (mode === 'right') {
      const px = xs.getPixelForValue(startMax) + dxPx;
      selRange = { min: selRange.min, max: Math.max(pxToIdx(px), selRange.min + 3) };
      if (selRange.max > fullLabels.length - 1) selRange.max = fullLabels.length - 1;
    }
    positionSelectionBox();
    if (charts['chart-overview']) charts['chart-overview'].update('none');
  }

  function onUp() {
    mode = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onUp);
    applySelToMain();
  }

  /* Lock overview strip touch so it doesn't scroll the page */
  wrap.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  wrap.addEventListener('touchmove',  e => e.preventDefault(), { passive: false });

  box.addEventListener('mousedown',  e => { if (e.target.dataset.handle) return; onDown('move', e); });
  box.addEventListener('touchstart', e => { if (e.target.dataset.handle) return; onDown('move', e); }, { passive: false });
  box.querySelector('.sel-handle-l').addEventListener('mousedown',  e => onDown('left',  e));
  box.querySelector('.sel-handle-l').addEventListener('touchstart', e => onDown('left',  e), { passive: false });
  box.querySelector('.sel-handle-r').addEventListener('mousedown',  e => onDown('right', e));
  box.querySelector('.sel-handle-r').addEventListener('touchstart', e => onDown('right', e), { passive: false });

  window.addEventListener('resize', positionSelectionBox);
}

/* ───────────────── render.js ───────────────── */
/* ══════════════════════════════════════════════════════
   render.js — Dashboard cards, history table, user page
══════════════════════════════════════════════════════ */


let historySortDir    = 'desc';
let historySearchDate = '';

function setHistorySortDir(val)    { historySortDir    = val; }
function setHistorySearchDate(val) { historySearchDate = val; }

/**
 * True XIRR via Newton-Raphson, matching the standard brokerage/Excel formula.
 * flows: [{ date: Date, amount: number }], negative = outflow, positive = inflow.
 * Returns the annual rate (e.g. 0.15 for 15%) or null if it doesn't converge.
 */
function computeXIRR(flows) {
  if (flows.length < 2) return null;
  const t0 = flows[0].date;
  const years = flows.map(f => (f.date - t0) / (365 * 86400000));

  const npv = rate => flows.reduce((sum, f, i) => sum + f.amount / Math.pow(1 + rate, years[i]), 0);
  const dnpv = rate => flows.reduce((sum, f, i) =>
    sum - years[i] * f.amount / Math.pow(1 + rate, years[i] + 1), 0);

  let rate = 0.1; // initial guess: 10%
  for (let i = 0; i < 100; i++) {
    const f  = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-10) break;
    const next = rate - f / df;
    if (!isFinite(next) || next <= -1) return null;
    if (Math.abs(next - rate) < 1e-7) return next;
    rate = next;
  }
  return Math.abs(npv(rate)) < 1 ? rate : null;
}

/* ══════════════════════════════════════════════════════
   Dashboard Cards
══════════════════════════════════════════════════════ */
function renderDashboard(calc, settings) {

  /* ── Reset all cards when no data ── */
  if (!calc.length || !settings) {
    ['c-invested','c-value','c-pnl','c-ret','c-sips',
     'c-xirr','c-days','c-next-sip','c-streak','c-avg-day'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = 'card-value' +
        (id === 'c-invested' ? ' blue' :
         id === 'c-sips'     ? ' amber' : '');
      el.textContent =
        id === 'c-ret'  ? '0.00%' :
        id === 'c-days' || id === 'c-sips' || id === 'c-streak' ? '0' : '—';
    });
    const sub = document.getElementById('c-sips-sub');
    if (sub) sub.textContent = '';
    const nextSub = document.getElementById('c-next-sip-sub');
    if (nextSub) nextSub.textContent = '';
    renderDonutChart(0, 0);
    return;
  }

  const last = calc[calc.length - 1];
  const pnl  = last.portfolioValue - last.investedAmount;
  const ret  = last.investedAmount > 0 ? (pnl / last.investedAmount) * 100 : 0;
  const sips = calc.filter(e => e.sipAdded).length;

  /* ── 1. Total Invested ── */
  document.getElementById('c-invested').textContent = fmtK(last.investedAmount);

  /* ── 2. Portfolio Value ── */
  const vEl = document.getElementById('c-value');
  vEl.textContent = fmtK(last.portfolioValue);
  vEl.className   = 'card-value ' + (last.portfolioValue >= last.investedAmount ? 'green' : 'red');

  /* ── 3. Profit / Loss ── */
  const pEl = document.getElementById('c-pnl');
  pEl.textContent = (pnl >= 0 ? '+' : '') + fmtK(pnl);
  pEl.className   = 'card-value ' + (pnl >= 0 ? 'green' : 'red');

  /* ── 4. Return % — Simple absolute return ──
     This is what brokerage apps (Zerodha, Groww, etc.) show as "Returns":
     plain (current value − invested) / invested. It will naturally look
     smaller while SIPs are still young, since recently-added money hasn't
     had time to grow yet — that's expected, not a bug.
  ── */
  const rEl = document.getElementById('c-ret');
  rEl.textContent = fmtPct(ret);
  rEl.className   = 'card-value ' + (ret >= 0 ? 'green' : 'red');

  /* ── 5. SIP Contributions ── */
  document.getElementById('c-sips').textContent = sips;
  const schedule = settings.sipSchedule || [];
  const subLabel = schedule.length > 1
    ? `stepped`
    : `×₹${settings.sipAmount.toLocaleString('en-IN')}`;
  document.getElementById('c-sips-sub').textContent = subLabel;

  /* ── 6. XIRR — true money-weighted annualized return ──
     Real brokerages build the actual cash-flow ledger:
       • a negative outflow on each SIP date (money leaving your pocket)
       • one positive inflow today = current portfolio value
     then solve for the single annual rate that makes those flows net to
     zero (Newton-Raphson on the XIRR equation). This is what Zerodha/Groww
     call XIRR — it is NOT the same as annualizing the TWR.
  ── */
  const xirrEl = document.getElementById('c-xirr');
  if (xirrEl) {
    const flows = [];
    for (const e of calc) {
      if (e.sipAdded && e.sipTotal > 0) {
        flows.push({ date: new Date(e.date), amount: -e.sipTotal });
      }
    }
    flows.push({ date: new Date(last.date), amount: last.portfolioValue });

    const firstD = flows[0].date;
    const lastD  = flows[flows.length - 1].date;
    const days   = Math.round((lastD - firstD) / 86400000);

    const xirrValue = computeXIRR(flows);

    if (days >= 30 && xirrValue !== null) {
      const ann = xirrValue * 100;
      xirrEl.textContent = (ann >= 0 ? '+' : '') + ann.toFixed(1) + '%';
      xirrEl.className   = 'card-value ' + (ann >= 0 ? 'green' : 'red');
    } else {
      xirrEl.textContent = days < 30 ? `~${30 - days}d to unlock` : '—';
      xirrEl.className   = 'card-value';
    }
  }

  /* ── 7. Days Active ── */
  const daysEl = document.getElementById('c-days');
  if (daysEl && calc.length) {
    const first = new Date(calc[0].date);
    const lastD = new Date(calc[calc.length - 1].date);
    daysEl.textContent = Math.round((lastD - first) / 86400000) + 'd';
    daysEl.className   = 'card-value blue';
  }

  /* ── 8. Next SIP Date ── */
  const nextSipEl = document.getElementById('c-next-sip');
  if (nextSipEl && settings.startDate) {
    const start = new Date(settings.startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = new Date(start);
    while (next <= today) next.setMonth(next.getMonth() + 1);
    const daysLeft = Math.ceil((next - today) / 86400000);
    nextSipEl.textContent = next.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    nextSipEl.className   = 'card-value amber';
    const nextSub = document.getElementById('c-next-sip-sub');
    if (nextSub) nextSub.textContent = `in ${daysLeft}d`;
  }

  /* ── 9. Win Streak (consecutive positive days) ── */
  const streakEl = document.getElementById('c-streak');
  if (streakEl) {
    let streak = 0;
    for (let i = calc.length - 1; i >= 0; i--) {
      if (calc[i].percentChange > 0) streak++;
      else break;
    }
    streakEl.textContent = streak + (streak === 1 ? ' day' : ' days');
    streakEl.className   = 'card-value ' + (streak >= 3 ? 'green' : streak > 0 ? 'amber' : 'red');
  }

  /* ── 10. Avg Daily Change ── */
  const avgEl = document.getElementById('c-avg-day');
  if (avgEl && calc.length) {
    const avg = calc.reduce((s, e) => s + e.percentChange, 0) / calc.length;
    avgEl.textContent = (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%';
    avgEl.className   = 'card-value ' + (avg >= 0 ? 'green' : 'red');
  }

  /* ── Donut Chart ── */
  renderDonutChart(last.investedAmount, pnl);
}

/* ══════════════════════════════════════════════════════
   History Table
══════════════════════════════════════════════════════ */
function renderTable(calc, settings) {
  const tbody = document.getElementById('history-body');
  document.getElementById('entry-count').textContent = calc.length ? `${calc.length} entries` : '';

  let filtered = calc;
  if (historySearchDate) filtered = calc.filter(e => e.date === historySearchDate);

  const sorted = [...filtered];
  if (historySortDir === 'asc') sorted.sort((a, b) => a.date.localeCompare(b.date));
  else                          sorted.sort((a, b) => b.date.localeCompare(a.date));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty">${
      historySearchDate ? 'No entry found for this date.' : 'No entries yet — add your first daily % change.'
    }</div></td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((e, i) => {
    const pct      = e.percentChange;
    const sipBadge = e.sipAdded
      ? `<span class="sip-badge sip-yes">+₹${(e.sipTotal || e.sipCount * settings.sipAmount).toLocaleString('en-IN')}</span>`
      : `<span class="sip-badge sip-no">—</span>`;
    return `<tr>
      <td class="mono" style="color:var(--muted)">${i + 1}</td>
      <td>${e.date}</td>
      <td class="mono ${pct >= 0 ? 'pct-up' : 'pct-down'}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</td>
      <td>${sipBadge}</td>
      <td class="mono">${fmtK(e.portfolioValue)}</td>
      <td class="mono" style="color:var(--blue)">${fmtK(e.investedAmount)}</td>
      <td style="text-align:right;">
        <button class="btn-icon" onclick="startEdit(${e.id})" title="Edit">✏️</button>
        <button class="btn-icon" onclick="deleteEntry(${e.id})" title="Delete" style="color:var(--red)">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   User / Account Page
══════════════════════════════════════════════════════ */
function renderUserPage(entries, settings) {
  const calc = recalcAll(entries, settings);
  if (settings) {
    document.getElementById('user-sub-line').textContent        = `₹${settings.sipAmount.toLocaleString('en-IN')} SIP · from ${settings.startDate}`;
    document.getElementById('settings-info-header').textContent = `₹${settings.sipAmount.toLocaleString('en-IN')}/mo`;
  } else {
    document.getElementById('user-sub-line').textContent = 'No settings configured yet';
  }

  document.getElementById('us-entries').textContent = calc.length;

  if (calc.length >= 2) {
    const first  = new Date(calc[0].date), last = new Date(calc[calc.length - 1].date);
    const months = Math.round((last - first) / (1000 * 60 * 60 * 24 * 30));
    document.getElementById('us-months').textContent = months || 1;
  } else {
    document.getElementById('us-months').textContent = calc.length ? 1 : 0;
  }

  if (calc.length) {
    const pcts  = calc.map(e => e.percentChange);
    const best  = Math.max(...pcts), worst = Math.min(...pcts);
    document.getElementById('us-best').textContent  = (best  >= 0 ? '+' : '') + best.toFixed(2)  + '%';
    document.getElementById('us-worst').textContent = (worst >= 0 ? '+' : '') + worst.toFixed(2) + '%';
  } else {
    document.getElementById('us-best').textContent  = '—';
    document.getElementById('us-worst').textContent = '—';
  }
}

/* ══════════════════════════════════════════════════════
   Full Render
══════════════════════════════════════════════════════ */
function renderAll(entries, settings) {
  const calc = recalcAll(entries, settings);
  renderDashboard(calc, settings);
  renderTable(calc, settings);
  if (document.getElementById('page-graph').classList.contains('active')) {
    renderLineChart(calc);
  }
}

/* ───────────────── pdf-report.js ───────────────── */
/* ══════════════════════════════════════════════════════
   pdf-report.js — Full SIP PDF report (core jsPDF only)
   No autoTable plugin dependency — tables are hand-drawn.

   Rupee symbol fix: jsPDF's built-in Helvetica font has no glyph
   for ₹ (U+20B9), which is why it printed as a stray superscript
   "1". We fetch a Unicode font (Noto Sans, which includes the
   Currency Symbols block) at report-generation time, embed it in
   the PDF, and use it for every piece of text so ₹ renders correctly.

   Includes: daily % change, invested/value, SIP amounts, skipped
   instalments, step-up schedule, and an overall portfolio-value
   line chart. Header = project name + fund name. Footer =
   "Developed by Microintel" on every page.
══════════════════════════════════════════════════════ */


const PROJECT_NAME = 'StepUP';
const FOOTER_TEXT  = 'Developed by Microintel';

/* Noto Sans includes the Currency Symbols Unicode block (incl. ₹),
   unlike jsPDF's built-in Helvetica/Times/Courier. */
const FONT_REGULAR_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf';
const FONT_BOLD_URL    = 'https://cdn.jsdelivr.net/gh/notofonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Bold.ttf';

let fontsReady = null; // cached promise so repeat reports don't re-download

/** Fetch a font file and return it as a base64 string (chunked to avoid call-stack limits). */
async function fetchFontBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font fetch failed (${res.status}): ${url}`);
  const buf   = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary  = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Registers NotoSans (normal + bold) into a jsPDF doc's virtual filesystem. */
async function ensureUnicodeFont(doc) {
  if (!fontsReady) {
    fontsReady = Promise.all([
      fetchFontBase64(FONT_REGULAR_URL),
      fetchFontBase64(FONT_BOLD_URL).catch(() => null), // bold is a nice-to-have
    ]);
  }
  const [regularB64, boldB64] = await fontsReady;

  doc.addFileToVFS('NotoSans-Regular.ttf', regularB64);
  doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
  if (boldB64) {
    doc.addFileToVFS('NotoSans-Bold.ttf', boldB64);
    doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');
  } else {
    doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'bold'); // fallback: regular weight
  }
  doc.setFont('NotoSans', 'normal');
}

/** Amount active on a given SIP date, per the step-up schedule (mirrors calc.js). */
function pdfAmountForDate(sipSchedule, dateStr) {
  if (!sipSchedule || !sipSchedule.length) return 0;
  let amount = sipSchedule[0].amount;
  for (const seg of sipSchedule) {
    if (seg.fromDate <= dateStr) amount = seg.amount;
    else break;
  }
  return amount;
}

/**
 * Render the full portfolio-value history as an off-screen Chart.js line
 * chart and return { dataUrl, width, height } for embedding as an image.
 */
async function renderOverallChartImage(calc) {
  if (!window.Chart || !calc.length) return null;

  const canvas = document.createElement('canvas');
  const W = 1200, H = 480;
  canvas.width = W;
  canvas.height = H;
  canvas.style.position = 'fixed';
  canvas.style.left = '-99999px';
  canvas.style.top  = '0';
  document.body.appendChild(canvas);

  const labels = calc.map(e => e.date);
  const values = calc.map(e => e.portfolioValue);
  const invested = calc.map(e => e.investedAmount);
  const positive = values[values.length - 1] >= invested[invested.length - 1];

  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Portfolio Value',
          data: values,
          borderColor: positive ? '#16a34a' : '#dc2626',
          backgroundColor: positive ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
          borderWidth: 3,
          tension: 0.35,
          pointRadius: 0,
          fill: true,
        },
        {
          label: 'Invested',
          data: invested,
          borderColor: '#64748b',
          borderDash: [6, 4],
          borderWidth: 2,
          tension: 0,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 2,
      layout: { padding: 12 },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#334155', font: { size: 16 } } },
        tooltip: { enabled: false },
      },
      scales: {
        x: { display: true, ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 12 } }, grid: { color: '#e2e8f0' } },
        y: { display: true, ticks: { color: '#64748b', font: { size: 12 } }, grid: { color: '#e2e8f0' } },
      },
    },
  });

  // Two rAF ticks so Chart.js has fully painted the static (non-animated) canvas.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const dataUrl = chart.toBase64Image('image/png', 1.0);
  chart.destroy();
  canvas.remove();

  return { dataUrl, width: W, height: H };
}

/**
 * Hand-drawn table with automatic pagination + repeating header row.
 * @returns {number} the Y position after the table.
 */
function drawTable(doc, { startY, margin, pageW, pageH, head, rows, widths, aligns = [], headFill = [30, 41, 59], fontSize = 8.5, rowH = 16, headH = 20, footerLimit = 55 }) {
  const tableW = widths.reduce((a, b) => a + b, 0);
  let y = startY;

  function drawHeader() {
    doc.setFillColor(headFill[0], headFill[1], headFill[2]);
    doc.rect(margin, y, tableW, headH, 'F');
    doc.setFont('NotoSans', 'bold');
    doc.setFontSize(fontSize);
    doc.setTextColor(255, 255, 255);
    let x = margin;
    head.forEach((h, i) => {
      const align = aligns[i] || 'left';
      const w = widths[i];
      doc.text(String(h), align === 'right' ? x + w - 6 : x + 6, y + headH - 7, { align: align === 'right' ? 'right' : 'left' });
      x += w;
    });
    y += headH;
  }

  drawHeader();
  doc.setFont('NotoSans', 'normal');
  doc.setFontSize(fontSize);

  rows.forEach((row, ri) => {
    if (y + rowH > pageH - footerLimit) {
      doc.addPage();
      y = 50;
      drawHeader();
      doc.setFont('NotoSans', 'normal');
      doc.setFontSize(fontSize);
    }
    if (ri % 2 === 1) {
      doc.setFillColor(244, 246, 250);
      doc.rect(margin, y, tableW, rowH, 'F');
    }
    let x = margin;
    row.forEach((cell, ci) => {
      const align = aligns[ci] || 'left';
      const w = widths[ci];
      const isObj = cell && typeof cell === 'object';
      const text  = isObj ? cell.text : String(cell);
      const color = isObj && cell.color ? cell.color : [30, 30, 30];
      doc.setTextColor(color[0], color[1], color[2]);
      doc.text(text, align === 'right' ? x + w - 6 : x + 6, y + rowH - 6, { align: align === 'right' ? 'right' : 'left' });
      x += w;
    });
    y += rowH;
  });

  doc.setTextColor(0, 0, 0);
  return y;
}

/**
 * Generate and download a full PDF report for the active SIP.
 * @param {Array}  entries  raw entries for the profile
 * @param {Object} settings settings/config for the profile
 * @param {string} fundName display name of the active profile/fund
 */
async function generatePdfReport(entries, settings, fundName) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library failed to load — check your connection and try again.');
    return;
  }
  if (!entries || !entries.length || !settings) {
    alert('No SIP data to report yet.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc    = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW  = doc.internal.pageSize.getWidth();
  const pageH  = doc.internal.pageSize.getHeight();
  const margin = 40;

  try {
    await ensureUnicodeFont(doc);
  } catch (err) {
    console.error(err);
    alert('Could not load the font needed for the ₹ symbol — check your internet connection and try again.');
    return;
  }

  const calc  = recalcAll(entries, settings);
  const last  = calc[calc.length - 1];
  const pnl   = last.portfolioValue - last.investedAmount;
  const ret   = last.investedAmount > 0 ? (pnl / last.investedAmount) * 100 : 0;
  const sipCount = calc.filter(e => e.sipAdded).length;

  const schedule = (settings.sipSchedule && settings.sipSchedule.length)
    ? settings.sipSchedule
    : [{ fromDate: settings.startDate, amount: settings.sipAmount || 0 }];
  const skipped = (settings.skippedSipDates || []).slice().sort();

  /* ── Header: project name + fund name ── */
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text(PROJECT_NAME, margin, 50);

  doc.setFont('NotoSans', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text('SIP Report', pageW - margin, 50, { align: 'right' });

  doc.setDrawColor(220, 220, 220);
  doc.line(margin, 60, pageW - margin, 60);

  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.text(`Fund: ${fundName || 'Untitled SIP'}`, margin, 82);

  doc.setFont('NotoSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text(`Generated on ${todayStr()}`, margin, 96);

  /* ── Summary ── */
  let y = 118;
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('Summary', margin, y);
  y += 10;

  const summary = [
    ['Total Invested',       fmt(last.investedAmount)],
    ['Current Value',        fmt(last.portfolioValue)],
    ['Profit / Loss',        (pnl >= 0 ? '+' : '') + fmt(pnl)],
    ['Return %',             (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%'],
    ['SIP Instalments Made', String(sipCount)],
    ['Skipped Instalments',  String(skipped.length)],
  ];
  doc.setFontSize(10);
  summary.forEach(([label, value]) => {
    y += 18;
    doc.setFont('NotoSans', 'bold');
    doc.setTextColor(90, 90, 90);
    doc.text(label, margin, y);
    doc.setFont('NotoSans', 'normal');
    doc.setTextColor(20, 20, 20);
    doc.text(value, pageW - margin, y, { align: 'right' });
  });
  y += 26;

  /* ── Overall portfolio growth chart ── */
  toast('Generating chart…');
  const chartImg = await renderOverallChartImage(calc);
  if (chartImg) {
    const imgW = pageW - margin * 2;
    const imgH = imgW * (chartImg.height / chartImg.width);
    if (y + imgH > pageH - 60) { doc.addPage(); y = 50; }
    doc.setFont('NotoSans', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 20);
    doc.text('Overall Portfolio Growth', margin, y);
    y += 8;
    doc.addImage(chartImg.dataUrl, 'PNG', margin, y, imgW, imgH);
    y += imgH + 22;
  }

  /* ── Step-up schedule ── */
  if (y > pageH - 100) { doc.addPage(); y = 50; }
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('Step-Up Schedule', margin, y);
  y += 8;

  y = drawTable(doc, {
    startY: y, margin, pageW, pageH,
    head: ['Effective From', 'Monthly Amount'],
    rows: schedule.map(s => [s.fromDate, fmt(s.amount)]),
    widths: [(pageW - margin * 2) * 0.5, (pageW - margin * 2) * 0.5],
    aligns: ['left', 'right'],
  });
  y += 22;

  /* ── Skipped instalments ── */
  if (y > pageH - 100) { doc.addPage(); y = 50; }
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('Skipped SIP Instalments', margin, y);
  y += 8;

  if (skipped.length) {
    y = drawTable(doc, {
      startY: y, margin, pageW, pageH,
      head: ['Date', 'Amount That Was Skipped'],
      rows: skipped.map(d => [d, fmt(pdfAmountForDate(schedule, d))]),
      widths: [(pageW - margin * 2) * 0.5, (pageW - margin * 2) * 0.5],
      aligns: ['left', 'right'],
      headFill: [153, 27, 27],
    });
    y += 22;
  } else {
    doc.setFont('NotoSans', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text('No instalments skipped.', margin, y + 14);
    y += 34;
  }

  /* ── Daily change history (newest first) ── */
  if (y > pageH - 100) { doc.addPage(); y = 50; }
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('Daily Change History', margin, y);
  y += 8;

  const usableW = pageW - margin * 2;
  const widths  = [usableW * 0.16, usableW * 0.16, usableW * 0.20, usableW * 0.24, usableW * 0.24];

  const rows = [...calc]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(e => {
      const pctText = (e.percentChange >= 0 ? '+' : '') + e.percentChange.toFixed(2) + '%';
      const pctColor = e.percentChange >= 0 ? [22, 163, 74] : [220, 38, 38];
      return [
        e.date,
        { text: pctText, color: pctColor },
        e.sipAdded ? `+${fmt(e.sipTotal)}` : '—',
        fmt(e.investedAmount),
        fmt(e.portfolioValue),
      ];
    });

  drawTable(doc, {
    startY: y, margin, pageW, pageH,
    head: ['Date', 'Daily Change', 'SIP Added', 'Invested', 'Portfolio Value'],
    rows,
    widths,
    aligns: ['left', 'right', 'right', 'right', 'right'],
    fontSize: 8.5,
    rowH: 15,
  });

  /* ── Footer on every page: "Developed by Microintel" ── */
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const h = doc.internal.pageSize.getHeight();
    doc.setDrawColor(230, 230, 230);
    doc.line(margin, h - 40, pageW - margin, h - 40);
    doc.setFont('NotoSans', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(140, 140, 140);
    doc.text(FOOTER_TEXT, margin, h - 25);
    doc.text(`Page ${i} of ${pageCount}`, pageW - margin, h - 25, { align: 'right' });
  }

  const filename = `${PROJECT_NAME}-${(fundName || 'SIP').replace(/\s+/g, '-')}-${todayStr()}.pdf`;
  doc.save(filename);
  toast('PDF downloaded ✓');
}

/* ───────────────── app.js ───────────────── */
/* ══════════════════════════════════════════════════════
   app.js — Navigation, events, settings, entry CRUD, boot
            Multi-SIP profile support
══════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════
   App State
══════════════════════════════════════════════════════ */
let profiles       = [];   // internal single-entry list — see loadProfiles()
let activeProfile  = null; // {id, name} — auto-created single "fund" record
let settings       = null;
let entries        = [];

/* Re-export for inline onclick handlers */
window.startEdit    = startEdit;
window.deleteEntry  = deleteEntry;

/* ══════════════════════════════════════════════════════
   Profile helpers — internal plumbing only. BlackRoad shows a single
   Mutual Fund tracker (no multi-account/profile switcher UI), but the
   storage layer still keeps one auto-created default profile record so
   entries/settings continue to work exactly as before.
══════════════════════════════════════════════════════ */
async function loadProfiles() {
  profiles = await dbGetAllProfiles();
  profiles.sort((a, b) => a.id - b.id);

  // First-time migration: if no profiles exist but legacy settings do,
  // create a default profile from them.
  if (!profiles.length) {
    const legacySettings = await dbGet('settings', 1);
    const pid = await dbPutProfile({ name: 'My SIP' });
    // Migrate legacy settings
    if (legacySettings) {
      await dbPutSettings(pid, { ...legacySettings, id: pid });
    }
    // Migrate legacy entries (those without profileId)
    const allEntries = await dbAll('entries');
    for (const e of allEntries) {
      if (!e.profileId) {
        await dbPut('entries', { ...e, profileId: pid });
      }
    }
    profiles = await dbGetAllProfiles();
    profiles.sort((a, b) => a.id - b.id);
  }
}



/* ══════════════════════════════════════════════════════
   Load (profile-scoped)
══════════════════════════════════════════════════════ */
async function loadAll() {
  if (!activeProfile) return;
  settings = await dbGetSettings(activeProfile.id) || null;
  entries  = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
}

/* ══════════════════════════════════════════════════════
   Navigation
══════════════════════════════════════════════════════ */
function syncSwipeDots(pageId) {
  document.querySelectorAll('.swipe-dot').forEach(dot => {
    dot.classList.toggle('active', dot.dataset.page === pageId);
  });
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.page).classList.add('active');
    syncSwipeDots(btn.dataset.page);
    if (btn.dataset.page === 'page-graph')   setTimeout(() => renderLineChart(recalcAll(entries, settings)), 50);
    if (btn.dataset.page === 'page-history') renderTable(recalcAll(entries, settings), settings);
    if (btn.dataset.page === 'page-user')    {
      renderUserPage(entries, settings);
      renderScheduleList();
      renderSkipList();
    }
    if (btn.dataset.page === 'page-add')     initHelper();
  });
});

/* ══════════════════════════════════════════════════════
   Swipe Navigation (mobile only)
══════════════════════════════════════════════════════ */
(function initSwipe() {
  // Tab order matches bottom nav order
  const PAGE_ORDER = ['page-home', 'page-history', 'page-add', 'page-graph', 'page-user'];

  function getActivePage() {
    return PAGE_ORDER.find(id => document.getElementById(id)?.classList.contains('active')) || PAGE_ORDER[0];
  }

  function navigateToPage(pageId) {
    const btn = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (btn) btn.click();
  }

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isSwiping = false;

  // Only activate on touch devices / mobile widths
  function isMobile() { return window.innerWidth <= 768; }

  document.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartTime = Date.now();
    isSwiping = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isMobile()) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    // Mark as a horizontal swipe candidate early
    if (!isSwiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
      isSwiping = true;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isMobile() || !isSwiping) return;

    const t = e.changedTouches[0];
    const dx       = t.clientX - touchStartX;
    const dy       = t.clientY - touchStartY;
    const elapsed  = Date.now() - touchStartTime;

    // Ignore vertical-dominant swipes, very slow gestures, and tiny movements
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < 50)           return;   // min distance threshold
    if (elapsed > 500)               return;   // max duration threshold

    // Ignore swipes that originate inside a horizontally-scrollable element
    // (e.g. the history table-scroll, chart canvas)
    const originEl = document.elementFromPoint(touchStartX, touchStartY);
    const scrollParent = originEl?.closest('.table-scroll, canvas, .chart-area, [data-no-swipe]');
    if (scrollParent) return;

    const currentId  = getActivePage();
    const currentIdx = PAGE_ORDER.indexOf(currentId);

    // Swipe LEFT → go to next tab; swipe RIGHT → go to previous tab
    if (dx < 0 && currentIdx < PAGE_ORDER.length - 1) {
      navigateToPage(PAGE_ORDER[currentIdx + 1]);
    } else if (dx > 0 && currentIdx > 0) {
      navigateToPage(PAGE_ORDER[currentIdx - 1]);
    }

    isSwiping = false;
  }, { passive: true });
})();

/* ══════════════════════════════════════════════════════
   Settings — helpers
══════════════════════════════════════════════════════ */
function normalizeSettings(s) {
  if (!s) return s;
  if (!s.sipSchedule || !s.sipSchedule.length) {
    s.sipSchedule = [{ fromDate: s.startDate, amount: s.sipAmount || 0 }];
  }
  if (!s.skippedSipDates) s.skippedSipDates = [];
  const last = s.sipSchedule[s.sipSchedule.length - 1];
  s.sipAmount = last ? last.amount : s.sipAmount;
  return s;
}

function currentSipAmount() {
  if (!settings || !settings.sipSchedule || !settings.sipSchedule.length) return 0;
  return settings.sipSchedule[settings.sipSchedule.length - 1].amount;
}

function applySettingsToUI() {
  if (!settings) return;
  const amt = currentSipAmount();
  document.getElementById('sip-amount').value          = amt;
  document.getElementById('sip-start').value           = settings.startDate;
  document.getElementById('settings-info').textContent =
    `Active: ₹${amt.toLocaleString('en-IN')} SIP from ${settings.startDate}`;
  document.getElementById('settings-info-header').textContent = `₹${amt.toLocaleString('en-IN')}/mo`;
}

/* ══════════════════════════════════════════════════════
   Save Settings (profile-scoped)
══════════════════════════════════════════════════════ */
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  if (!activeProfile) { toast('No active SIP profile.'); return; }
  const amt  = parseFloat(document.getElementById('sip-amount').value);
  const date = document.getElementById('sip-start').value;
  if (!amt || amt <= 0 || !date) { toast('Enter a valid SIP amount and start date.'); return; }

  if (settings && settings.startDate === date) {
    settings.sipSchedule[0] = { fromDate: date, amount: amt };
    settings.sipSchedule = settings.sipSchedule.filter(s => s.fromDate >= date);
  } else {
    settings = {
      id: activeProfile.id,
      startDate: date,
      sipAmount: amt,
      sipSchedule: [{ fromDate: date, amount: amt }],
      skippedSipDates: settings ? (settings.skippedSipDates || []) : [],
    };
  }
  normalizeSettings(settings);
  await dbPutSettings(activeProfile.id, settings);
  applySettingsToUI();
  renderScheduleList();
  renderSkipList();
  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast('Settings saved ✓');
});

/* ══════════════════════════════════════════════════════
   Step-Up SIP
══════════════════════════════════════════════════════ */
document.getElementById('btn-add-stepup').addEventListener('click', async () => {
  if (!settings) { toast('Save base SIP settings first.'); return; }
  const newAmt  = parseFloat(document.getElementById('stepup-amount').value);
  const fromDate = document.getElementById('stepup-date').value;
  if (!newAmt || newAmt <= 0 || !fromDate) { toast('Enter a valid new amount and effective date.'); return; }
  if (fromDate < settings.startDate) { toast('Step-up date cannot be before SIP start date.'); return; }

  settings.sipSchedule = settings.sipSchedule.filter(s => s.fromDate !== fromDate);
  settings.sipSchedule.push({ fromDate, amount: newAmt });
  settings.sipSchedule.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  normalizeSettings(settings);

  await dbPutSettings(activeProfile.id, settings);
  applySettingsToUI();
  renderScheduleList();
  document.getElementById('stepup-amount').value = '';
  document.getElementById('stepup-date').value   = '';

  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast(`Step-up to ₹${newAmt.toLocaleString('en-IN')} from ${fromDate} ✓`);
});

function renderScheduleList() {
  const el = document.getElementById('stepup-schedule-list');
  if (!el || !settings || !settings.sipSchedule) return;
  if (!settings.sipSchedule.length) { el.innerHTML = ''; return; }
  el.innerHTML = settings.sipSchedule.map((s, i) => `
    <div class="schedule-row">
      <div class="schedule-info">
        <span class="schedule-amt">₹${s.amount.toLocaleString('en-IN')}</span>
        <span class="schedule-from">from ${s.fromDate}</span>
      </div>
      ${i === 0
        ? '<span class="schedule-badge">Base</span>'
        : `<button class="btn-icon schedule-del" data-idx="${i}" title="Remove step-up" style="color:var(--red)">🗑</button>`
      }
    </div>`).join('');

  el.querySelectorAll('.schedule-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      settings.sipSchedule.splice(idx, 1);
      normalizeSettings(settings);
      await dbPutSettings(activeProfile.id, settings);
      applySettingsToUI();
      renderScheduleList();
      const calc = recalcAll(entries, settings);
      await saveCalcEntries(calc, activeProfile.id);
      entries = await dbGetEntries(activeProfile.id);
      entries.sort((a, b) => a.date.localeCompare(b.date));
      renderAll(entries, settings);
      toast('Step-up removed ✓');
    });
  });
}

/* ══════════════════════════════════════════════════════
   Skip a SIP Instalment
══════════════════════════════════════════════════════ */
document.getElementById('btn-skip-sip').addEventListener('click', async () => {
  if (!settings) { toast('Save base SIP settings first.'); return; }
  const skipDate = document.getElementById('skip-sip-date').value;
  if (!skipDate) { toast('Pick a SIP date to skip.'); return; }

  const allDates = getAllUpcomingSipDates();
  const isValid  = allDates.some(d => d === skipDate);
  if (!isValid) { toast('That date is not a SIP instalment date.'); return; }

  if ((settings.skippedSipDates || []).includes(skipDate)) {
    toast('Already skipped for that date.'); return;
  }

  settings.skippedSipDates = [...(settings.skippedSipDates || []), skipDate].sort();
  await dbPutSettings(activeProfile.id, settings);
  renderSkipList();
  document.getElementById('skip-sip-date').value = '';

  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast(`SIP skipped for ${skipDate} ✓`);
});

function getAllUpcomingSipDates() {
  if (!settings || !settings.startDate) return [];
  const start  = new Date(settings.startDate);
  const sipDay = start.getDate();
  const results = [];
  let y = start.getFullYear(), m = start.getMonth();
  const end = new Date();
  end.setMonth(end.getMonth() + 12);
  while (true) {
    const lastDay = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(sipDay, lastDay));
    if (d > end) break;
    if (d >= start) results.push(dateToStr(d));
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return results;
}

function renderSkipList() {
  const el = document.getElementById('skip-list');
  if (!el || !settings) return;
  const skipped = settings.skippedSipDates || [];
  if (!skipped.length) { el.innerHTML = '<span class="muted-note">No skipped months.</span>'; return; }
  el.innerHTML = skipped.map(d => `
    <div class="schedule-row">
      <div class="schedule-info">
        <span class="schedule-from">⏭ ${d}</span>
      </div>
      <button class="btn-icon schedule-del" data-date="${d}" title="Restore" style="color:var(--green)">↩</button>
    </div>`).join('');

  el.querySelectorAll('.schedule-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      settings.skippedSipDates = settings.skippedSipDates.filter(d => d !== btn.dataset.date);
      await dbPutSettings(activeProfile.id, settings);
      renderSkipList();
      const calc = recalcAll(entries, settings);
      await saveCalcEntries(calc, activeProfile.id);
      entries = await dbGetEntries(activeProfile.id);
      entries.sort((a, b) => a.date.localeCompare(b.date));
      renderAll(entries, settings);
      toast('SIP restored ✓');
    });
  });
}

/* ══════════════════════════════════════════════════════
   Daily % Helper
══════════════════════════════════════════════════════ */
function getLastTotalReturnPct() {
  const calc = recalcAll(entries, settings);
  if (!calc.length) return null;
  const last = calc[calc.length - 1];
  if (!last.investedAmount) return null;
  return ((last.portfolioValue - last.investedAmount) / last.investedAmount) * 100;
}

function initHelper() {
  const prevInput  = document.getElementById('helper-prev');
  const todayInput = document.getElementById('helper-today');
  const resultBox  = document.getElementById('helper-result');
  const resultVal  = document.getElementById('helper-result-value');
  const useBtn     = document.getElementById('helper-use-btn');
  const prevHint   = document.getElementById('helper-prev-hint');

  const lastPct = getLastTotalReturnPct();
  if (lastPct !== null) {
    prevInput.value = lastPct.toFixed(2);
    prevHint.textContent = 'auto-filled from last entry';
  } else {
    prevInput.value = '';
    prevHint.textContent = 'enter manually if no entries yet';
  }

  todayInput.value = '';
  resultBox.style.display = 'none';

  function computeDaily() {
    const prev  = parseFloat(prevInput.value);
    const today = parseFloat(todayInput.value);
    if (isNaN(prev) || isNaN(today)) { resultBox.style.display = 'none'; return; }
    const daily = ((1 + today / 100) / (1 + prev / 100) - 1) * 100;
    resultVal.textContent = (daily >= 0 ? '+' : '') + daily.toFixed(2) + '%';
    resultVal.className   = 'helper-result-value ' + (daily >= 0 ? 'pos' : 'neg');
    resultBox.style.display = 'flex';
    useBtn.dataset.daily = daily.toFixed(4);
  }

  prevInput.addEventListener('input',  computeDaily);
  todayInput.addEventListener('input', computeDaily);

  useBtn.addEventListener('click', () => {
    const val = useBtn.dataset.daily;
    if (!val) return;
    document.getElementById('entry-pct').value = parseFloat(val).toFixed(2);
    updateEntryPreview();
    document.getElementById('entry-pct').focus();
  });
}

function updateEntryPreview() {
  const pctStr  = document.getElementById('entry-pct').value.trim();
  const dateVal = document.getElementById('entry-date').value;
  const pct     = parseFloat(pctStr);
  if (!settings || isNaN(pct) || !dateVal) {
    document.getElementById('entry-preview').textContent = ''; return;
  }
  const calc = recalcAll(entries, settings);
  const last = calc.length ? calc[calc.length - 1] : null;
  let base = last ? last.portfolioValue : 0;
  let inv  = last ? last.investedAmount : 0;

  const sips = sipsBetween(settings, last ? last.date : null, dateVal);
  const sipTotal = sips.reduce((s, x) => s + x.amount, 0);
  base += sipTotal;
  inv  += sipTotal;
  const newVal  = base * (1 + pct / 100);
  const sipNote = sipTotal > 0 ? ` (+ ₹${sipTotal.toLocaleString('en-IN')} SIP)` : '';
  document.getElementById('entry-preview').textContent =
    `→ ₹${base.toFixed(2)} × (1 ${pct >= 0 ? '+' : '-'} ${Math.abs(pct)}%) = ₹${newVal.toFixed(2)}${sipNote}`;
}
document.getElementById('entry-pct').addEventListener('input',  updateEntryPreview);
document.getElementById('entry-date').addEventListener('change', updateEntryPreview);

/* ══════════════════════════════════════════════════════
   Add Entry (profile-scoped)
══════════════════════════════════════════════════════ */
document.getElementById('btn-add-entry').addEventListener('click', async () => {
  if (!settings) { toast('Save SIP settings first.'); return; }
  const dateVal = document.getElementById('entry-date').value;
  const pctStr  = document.getElementById('entry-pct').value.trim();
  if (!dateVal || !pctStr) { toast('Enter date and % change.'); return; }
  const pct = parseFloat(pctStr);
  if (isNaN(pct)) { toast('Invalid % — e.g. +4.73 or -3.32'); return; }
  if (entries.find(e => e.date === dateVal)) { toast('Entry for this date already exists.'); return; }
  await dbPutEntry(activeProfile.id, { date: dateVal, percentChange: pct, portfolioValue: 0, investedAmount: 0 });
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  document.getElementById('entry-pct').value = '';
  document.getElementById('entry-preview').textContent = '';
  renderAll(entries, settings);
  toast(`Entry added for ${dateVal} ✓`);
});

/* ══════════════════════════════════════════════════════
   Edit Entry
══════════════════════════════════════════════════════ */
let editId = null;
function startEdit(id) {
  editId = id;
  const e = entries.find(x => x.id === id); if (!e) return;
  document.getElementById('edit-date').value = e.date;
  document.getElementById('edit-pct').value  = e.percentChange;
  document.getElementById('edit-modal').classList.add('open');
}
document.getElementById('edit-cancel').addEventListener('click', () =>
  document.getElementById('edit-modal').classList.remove('open'));

document.getElementById('edit-save').addEventListener('click', async () => {
  const dateVal = document.getElementById('edit-date').value;
  const pct     = parseFloat(document.getElementById('edit-pct').value);
  if (!dateVal || isNaN(pct)) { toast('Invalid values.'); return; }
  if (entries.find(e => e.date === dateVal && e.id !== editId)) { toast('Another entry already exists for that date.'); return; }
  await dbPutEntry(activeProfile.id, { id: editId, date: dateVal, percentChange: pct, portfolioValue: 0, investedAmount: 0 });
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  document.getElementById('edit-modal').classList.remove('open');
  renderAll(entries, settings);
  toast('Entry updated ✓');
});

/* ══════════════════════════════════════════════════════
   Delete Entry
══════════════════════════════════════════════════════ */
async function deleteEntry(id) {
  if (!confirm('Delete this entry?')) return;
  await dbDelEntry(id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast('Entry deleted ✓');
}

/* ══════════════════════════════════════════════════════
   Export / Import / Reset (profile-scoped)
══════════════════════════════════════════════════════ */
document.getElementById('btn-pdf-report-row').addEventListener('click', async () => {
  toast('Generating PDF report…');
  try {
    await generatePdfReport(entries, settings, activeProfile?.name);
  } catch (err) {
    console.error(err);
    toast('PDF generation failed.');
  }
});

document.getElementById('btn-export-row').addEventListener('click', () => {
  const a   = document.createElement('a');
  const payload = { profileName: activeProfile?.name, settings, entries };
  a.href    = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.download = `sip-${(activeProfile?.name || 'data').replace(/\s+/g,'-')}-${todayStr()}.json`;
  a.click();
  toast('Exported ✓');
});

document.getElementById('btn-import-row').addEventListener('click', () =>
  document.getElementById('import-file').click());

document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.settings) {
      settings = normalizeSettings({ ...data.settings, id: activeProfile.id });
      await dbPutSettings(activeProfile.id, settings);
    }
    if (Array.isArray(data.entries)) {
      await dbClearEntries(activeProfile.id);
      for (const en of data.entries) {
        const { id, profileId, ...r } = en;
        await dbPutEntry(activeProfile.id, r);
      }
      entries = await dbGetEntries(activeProfile.id);
      entries.sort((a, b) => a.date.localeCompare(b.date));
      await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
      entries = await dbGetEntries(activeProfile.id);
      entries.sort((a, b) => a.date.localeCompare(b.date));
    }
    applySettingsToUI();
    renderAll(entries, settings);
    renderUserPage(entries, settings);
    renderScheduleList();
    renderSkipList();
    toast('Imported ✓');
  } catch { toast('Import failed — invalid JSON.'); }
  e.target.value = '';
});

document.getElementById('btn-reset-row').addEventListener('click', async () => {
  if (!confirm(`Reset ALL data for "${activeProfile?.name}"? This cannot be undone.`)) return;
  await dbClearEntries(activeProfile.id);
  try { await dbDel('settings', activeProfile.id); } catch(_) {}
  settings = null; entries = [];
  document.getElementById('sip-amount').value             = '';
  document.getElementById('sip-start').value              = '';
  document.getElementById('settings-info').textContent    = '';
  document.getElementById('settings-info-header').textContent = '';
  renderAll(entries, settings);
  renderUserPage(entries, settings);
  renderScheduleList();
  renderSkipList();
  toast('All data cleared.');
});

/* ══════════════════════════════════════════════════════
   History Search & Sort
══════════════════════════════════════════════════════ */
document.getElementById('history-search-date').addEventListener('input', function () {
  setHistorySearchDate(this.value);
  renderTable(recalcAll(entries, settings), settings);
});

const sortBtn = document.getElementById('sort-toggle-btn');
let _sortDir = 'desc';
sortBtn.addEventListener('click', () => {
  _sortDir = _sortDir === 'desc' ? 'asc' : 'desc';
  sortBtn.className = `sort-btn sort-${_sortDir}`;
  setHistorySortDir(_sortDir);
  renderTable(recalcAll(entries, settings), settings);
});

/* ══════════════════════════════════════════════════════
   Range Pills & Reset Zoom
══════════════════════════════════════════════════════ */
document.querySelectorAll('#range-pills-line .range-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#range-pills-line .range-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    setActiveRange('line', pill.dataset.range);
    applyRangeToMain(pill.dataset.range);
  });
});

document.getElementById('btn-reset-zoom').addEventListener('click', () => {
  applyRangeToMain('all');
  document.querySelectorAll('#range-pills-line .range-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.range === 'all'));
  setActiveRange('line', 'all');
});

/* ══════════════════════════════════════════════════════
   Theme
══════════════════════════════════════════════════════ */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sip-theme', theme);
  document.querySelectorAll('.theme-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === theme));
  if (document.getElementById('page-graph').classList.contains('active')) {
    renderLineChart(recalcAll(entries, settings));
  }
}
document.querySelectorAll('.theme-btn').forEach(btn =>
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));

/* ══════════════════════════════════════════════════════
   Boot
══════════════════════════════════════════════════════ */
(async () => {
  if (window.Chart && window.ChartZoom) Chart.register(ChartZoom);
  applyTheme(localStorage.getItem('sip-theme') || 'dark');
  await openDB();

  // Load profiles and determine active one
  await loadProfiles();
  const savedId = parseInt(localStorage.getItem('sip-active-profile') || '0');
  const saved   = profiles.find(p => p.id === savedId);
  activeProfile = saved || profiles[0];

  await loadAll();
  if (settings) settings = normalizeSettings(settings);
  applySettingsToUI();
  document.getElementById('entry-date').value = todayStr();
  renderAll(entries, settings);
  initHelper();
  wireSelectionDrag();
  renderScheduleList();
  renderSkipList();
})();

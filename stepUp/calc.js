/* ══════════════════════════════════════════════════════
   calc.js — SIP recalculation logic
══════════════════════════════════════════════════════ */

import { dbPutEntry } from './db.js';
import { dateToStr }  from './helpers.js';

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
export function amountForDate(sipSchedule, dateStr) {
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
export function sipsBetween(cfg, prevStr, currStr) {
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
export function sipCountBetween(startStr, prevStr, currStr) {
  if (!startStr) return 0;
  return sipsBetween({ startDate: startStr, skippedSipDates: [] }, prevStr, currStr).length;
}

/**
 * Rebuild portfolioValue & investedAmount for all entries in order.
 * Supports step-up SIP (sipSchedule) and skipped months (skippedSipDates).
 */
export function recalcAll(raw, cfg) {
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

/**
 * Growth/Loss broken down by month or year.
 * For each period, growth = change in unrealized P&L (portfolioValue - investedAmount)
 * from the end of the previous period to the end of this one — i.e. pure market
 * performance for that period, not counting new SIP money added.
 *
 * @param {Array}  calc        output of recalcAll()
 * @param {'month'|'year'} granularity
 * @returns {Array<{ period, label, pnl, invested, value, growth }>}
 */
export function periodGrowth(calc, granularity) {
  if (!calc || !calc.length) return [];
  const keyFor = e => (granularity === 'year' ? e.date.slice(0, 4) : e.date.slice(0, 7));

  const lastByPeriod = new Map();
  for (const e of calc) lastByPeriod.set(keyFor(e), e); // sorted asc → last write wins = last entry in period

  const keys = [...lastByPeriod.keys()];
  let prevPnl = 0, prevValue = 0;
  return keys.map(k => {
    const e   = lastByPeriod.get(k);
    const pnl = e.portfolioValue - e.investedAmount;
    const growth    = pnl - prevPnl;
    const growthPct = prevValue > 0 ? (growth / prevValue) * 100 : null;
    prevPnl   = pnl;
    prevValue = e.portfolioValue;
    return {
      period:   k,
      label:    granularity === 'year' ? k : formatMonthLabel(k),
      pnl,
      invested: e.investedAmount,
      value:    e.portfolioValue,
      growth,
      growthPct,
    };
  });
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

/** Persist the recalculated values back to IndexedDB. */
export async function saveCalcEntries(calc, profileId) {
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

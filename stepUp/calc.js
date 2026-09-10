/* ══════════════════════════════════════════════════════
   calc.js — SIP recalculation logic
══════════════════════════════════════════════════════ */

import { dbPutEntry } from './db.js';
import { dateToStr, todayStr } from './helpers.js';

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
const NAV_BASE = 10; // synthetic starting NAV, same face-value convention real funds use

export function recalcAll(raw, cfg) {
  if (!raw.length || !cfg) return [];
  const sorted = [...raw].sort((a, b) => a.date.localeCompare(b.date));
  let portfolioValue = 0, investedAmount = 0, prevDate = null;
  let navValue = NAV_BASE, unitsHeld = 0;

  return sorted.map(entry => {
    const sips = sipsBetween(cfg, prevDate, entry.date);

    let sipTotal = 0;
    for (const s of sips) {
      portfolioValue += s.amount;
      investedAmount += s.amount;
      sipTotal       += s.amount;
    }

    const baseBeforeGrowth = portfolioValue; // after SIP added, before this day's % change applied
    portfolioValue = portfolioValue * (1 + entry.percentChange / 100);
    const dailyReturnAmount = portfolioValue - baseBeforeGrowth;

    // NAV tracked independently of cash flow, chained purely off the daily
    // % change — same day's NAV the SIP for this date is deemed bought at.
    navValue = entry.nav != null ? entry.nav : navValue * (1 + entry.percentChange / 100);
    const sipUnits = sipTotal > 0 ? sipTotal / navValue : 0;
    unitsHeld += sipUnits;

    prevDate = entry.date;
    return {
      ...entry,
      sipAdded:          sips.length > 0,
      sipCount:          sips.length,
      sipTotal,
      sipDetails:        sips,
      portfolioValue:    +portfolioValue.toFixed(4),
      investedAmount:    +investedAmount.toFixed(4),
      dailyReturnAmount: +dailyReturnAmount.toFixed(4),
      navValue:          +navValue.toFixed(4),
      sipUnits:          +sipUnits.toFixed(4),
      unitsHeld:         +unitsHeld.toFixed(4),
    };
  });
}

/**
 * Find the fund's real NAV on a given date from a fetched navHistory series
 * (ascending, ISO dates — the shape buildFundGrowthSeries() returns: [{date,
 * nav, growth}, ...]). Funds don't declare a NAV on weekends/holidays, so
 * this returns the closest trading day ON OR BEFORE the target date (the
 * actual NAV your SIP would have been bought at). Binary search since a
 * full fund history can run to thousands of rows.
 */
export function navOnOrBefore(navSeriesAsc, targetIso) {
  if (!navSeriesAsc || !navSeriesAsc.length) return null;
  let lo = 0, hi = navSeriesAsc.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (navSeriesAsc[mid].date <= targetIso) { ans = navSeriesAsc[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * Full instalment-by-instalment SIP ledger, start date → today, covering
 * EVERY scheduled SIP date — not just the ones a daily entry happens to
 * exist for. Each row is one instalment:
 *   { date, amount, status, navValue, units, unitsRunningTotal, stepChange }
 *
 * status: 'paid'     — swept into an entry, units computed at that entry's NAV
 *         'skipped'  — explicitly marked skipped in settings
 *         'missed'   — date has passed, not skipped, but no entry covers it yet
 *         'upcoming' — date hasn't arrived yet
 *
 * stepChange: amount − previous instalment's amount (0 on the very first
 * instalment or whenever the amount didn't change) — flags step-ups/downs
 * inline on the exact date they took effect.
 *
 * @param {Array} calc  output of recalcAll()
 * @param {Object} cfg  SIP settings
 * @param {Array|null} navSeriesAsc  optional real fund NAV history (ascending,
 *   ISO dates, from buildFundGrowthSeries().series) — when given, each paid
 *   instalment's units are computed off the ACTUAL NAV for its exact date
 *   (fetched from mfapi.in) instead of the app's synthetic tracked NAV.
 */
export function buildSipLedger(calc, cfg, navSeriesAsc = null) {
  if (!cfg || !cfg.startDate) return [];
  const schedule = (cfg.sipSchedule && cfg.sipSchedule.length)
    ? cfg.sipSchedule
    : [{ fromDate: cfg.startDate, amount: cfg.sipAmount || 0 }];
  const skippedSet = new Set(cfg.skippedSipDates || []);

  /* Every SIP date this app has actually swept into a recorded entry,
     mapped to the entry's NAV that day (same NAV used for all instalments
     an entry sweeps up, matching recalcAll's own simplification) — used as
     a fallback when no real fund NAV history is available for this date. */
  const paidByDate = new Map();
  for (const e of calc) {
    for (const s of (e.sipDetails || [])) {
      paidByDate.set(s.dateStr, { amount: s.amount, navValue: e.navValue });
    }
  }

  const today   = todayStr();
  const lastCalc = calc.length ? calc[calc.length - 1].date : null;
  const endStr  = lastCalc && lastCalc > today ? lastCalc : today;

  let prevAmount = null;
  let unitsRunning = 0;

  return allSipDates(cfg.startDate, endStr).map(({ dateStr }) => {
    const amount = amountForDate(schedule, dateStr);
    const stepChange = prevAmount === null ? 0 : +(amount - prevAmount).toFixed(2);
    prevAmount = amount;

    if (skippedSet.has(dateStr)) {
      return { date: dateStr, amount, status: 'skipped', navValue: null, units: 0, unitsRunningTotal: unitsRunning, stepChange };
    }

    const paid = paidByDate.get(dateStr);
    if (paid) {
      const real = navSeriesAsc ? navOnOrBefore(navSeriesAsc, dateStr) : null;
      const navValue = real ? real.nav : paid.navValue;
      const units = navValue ? +(paid.amount / navValue).toFixed(4) : 0;
      unitsRunning = +(unitsRunning + units).toFixed(4);
      return { date: dateStr, amount: paid.amount, status: 'paid', navValue, units, unitsRunningTotal: unitsRunning, stepChange };
    }

    const status = dateStr <= today ? 'missed' : 'upcoming';
    return { date: dateStr, amount, status, navValue: null, units: 0, unitsRunningTotal: unitsRunning, stepChange };
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

/**
 * Project forward from the current portfolio value to a target goal amount,
 * compounding monthly at annualRate and adding monthlyContribution each
 * month, starting the month after fromDateStr.
 *
 * @param {number} currentValue        latest portfolioValue
 * @param {number} goalAmount          target corpus
 * @param {number} annualRate          e.g. 0.12 for 12% (typically the XIRR)
 * @param {number} monthlyContribution current monthly SIP amount
 * @param {string} fromDateStr         'YYYY-MM-DD' — latest entry date
 * @returns {{ date: string, months: number } | null} projected reach date,
 *          or null if unreachable within 50 years at this rate/contribution
 */
export function projectGoalDate(currentValue, goalAmount, annualRate, monthlyContribution, fromDateStr) {
  if (!goalAmount || goalAmount <= 0) return null;
  if (currentValue >= goalAmount) return { date: fromDateStr, months: 0 };

  const monthlyRate = Math.pow(1 + (annualRate || 0), 1 / 12) - 1;
  let value = currentValue;
  const maxMonths = 600; // 50-year cap

  for (let m = 1; m <= maxMonths; m++) {
    value = value * (1 + monthlyRate) + (monthlyContribution || 0);
    if (value >= goalAmount) {
      const d = new Date(fromDateStr);
      d.setMonth(d.getMonth() + m);
      return { date: dateToStr(d), months: m };
    }
  }
  return null;
}

/**
 * Project the SIP portfolio forward toward a target corpus using three
 * annual-return scenarios drawn from the LINKED FUND's own historical
 * calendar-year returns (best / average / worst year on record) — not a
 * market-wide assumption. Unlike projectGoalDate (single XIRR-based line),
 * this compounds monthly and keeps adding the current SIP contribution,
 * producing three full point series so the chart can show a spread.
 *
 * @param {number} currentValue        latest portfolioValue
 * @param {number} monthlyContribution current monthly SIP amount
 * @param {{avg:number, best:number, worst:number}} rates  annual % figures
 * @param {number} monthsAhead         how many months to project
 * @param {string} fromDateStr         'YYYY-MM-DD' — latest entry date
 * @returns {{expected:Array, optimistic:Array, pessimistic:Array}}
 *          each an array of { date, value } points, anchored at fromDateStr
 */
export function projectGoalScenarios(currentValue, monthlyContribution, rates, monthsAhead, fromDateStr) {
  function scenario(annualPct) {
    const monthlyRate = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
    const anchorDate   = new Date(fromDateStr);
    const points = [{ date: fromDateStr, value: +currentValue.toFixed(2) }];
    let value = currentValue;
    for (let m = 1; m <= monthsAhead; m++) {
      value = value * (1 + monthlyRate) + (monthlyContribution || 0);
      const d = new Date(anchorDate);
      d.setMonth(d.getMonth() + m);
      points.push({ date: dateToStr(d), value: +value.toFixed(2) });
    }
    return points;
  }

  return {
    expected:    scenario(rates.avg),
    optimistic:  scenario(rates.best),
    pessimistic: scenario(rates.worst),
  };
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

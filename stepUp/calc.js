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

/* ══════════════════════════════════════════════════════
   SIP payment → processing → NAV allocation tracking
   ------------------------------------------------------
   Every SIP instalment now carries its OWN lifecycle, stored in
   cfg.sipAllocations = { [sipDueDateStr]: {
     status,          // scheduled | payment_initiated | paid | processing |
                       // allocated | failed | cancelled
     paymentDate, processingDate, allocationDate,  // 'YYYY-MM-DD' | null
     nav, units, amount,
     legacy,          // true for instalments grandfathered in by the
                       // one-time migration (see buildLegacyAllocations)
   } }.

   Only an instalment whose recorded status is 'allocated' is treated as
   real, held investment — see sipsBetween() below. The scheduled SIP due
   date itself is NEVER moved or reinterpreted as the allocation date.
══════════════════════════════════════════════════════ */
export const SIP_ALLOCATION_STATUSES =
  ['scheduled', 'payment_initiated', 'paid', 'processing', 'allocated', 'failed', 'cancelled'];

/**
 * Original (pre-tracking-feature) sweep logic: every non-skipped SIP date
 * counts, unconditionally, the moment a covering entry exists. Kept ONLY so
 * buildLegacyAllocations() can figure out exactly what old data already
 * had swept in, so it can be grandfathered in byte-for-byte unchanged.
 * Do not use this for new calculations — see sipsBetween() instead.
 */
function legacySipsBetween(cfg, prevStr, currStr) {
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

/**
 * Returns array of { dateStr, amount, navOverride?, unitsOverride? } for
 * each SIP instalment between prevStr (exclusive) and currStr (inclusive)
 * that should count as real, held investment.
 *
 * An instalment only counts once its recorded allocation status is
 * 'allocated' — i.e. the user has confirmed the actual AMC/broker
 * allocation. Everything else (no record yet, payment_initiated, paid,
 * processing, failed, cancelled) is held OUT of invested amount/units,
 * exactly per the SIP payment → processing → allocation tracking feature.
 * Skipped dates are excluded as before.
 */
export function sipsBetween(cfg, prevStr, currStr) {
  if (!cfg || !cfg.startDate) return [];
  const prev = prevStr ? new Date(prevStr) : null;
  const curr = new Date(currStr);

  const skipped     = new Set(cfg.skippedSipDates || []);
  const allocations = cfg.sipAllocations || {};
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
      const alloc = allocations[dateStr];
      if (!alloc || alloc.status !== 'allocated') return false;
      return true;
    })
    .map(({ dateStr }) => {
      const alloc  = allocations[dateStr];
      const amount = alloc.amount != null ? alloc.amount : amountForDate(schedule, dateStr);
      const out = { dateStr, amount };
      if (alloc.nav != null)   out.navOverride   = alloc.nav;
      if (alloc.units != null) out.unitsOverride = alloc.units;
      return out;
    });
}

/** Legacy helper for entry preview — just counts instalments. */
export function sipCountBetween(startStr, prevStr, currStr) {
  if (!startStr) return 0;
  return legacySipsBetween({ startDate: startStr, skippedSipDates: [] }, prevStr, currStr).length;
}

/**
 * One-time migration: figures out exactly which SIP instalments this app's
 * OLD (pre-tracking-feature) logic had already swept into invested amount —
 * using the same NAV each instalment was bought at back then — and returns
 * them as pre-'allocated' allocation records. Merged into cfg.sipAllocations
 * so existing users' numbers never change; only instalments due AFTER this
 * update requires the explicit payment → processing → allocation workflow.
 */
export function buildLegacyAllocations(raw, cfg) {
  if (!cfg || !cfg.startDate || !raw || !raw.length) return {};
  const legacyCalc = recalcAllWith(raw, cfg, legacySipsBetween);
  const out = {};
  for (const e of legacyCalc) {
    for (const s of (e.sipDetails || [])) {
      if (out[s.dateStr]) continue; // first entry to sweep a date wins, same as old paidByDate map
      const nav   = e.navValue;
      const units = nav ? +(s.amount / nav).toFixed(4) : 0;
      out[s.dateStr] = {
        status:         'allocated',
        paymentDate:    s.dateStr,
        processingDate: null,
        allocationDate: s.dateStr,
        nav:            nav != null ? +nav.toFixed(4) : null,
        units,
        amount:         s.amount,
        legacy:         true,
      };
    }
  }
  return out;
}

/**
 * Rebuild portfolioValue & investedAmount for all entries in order.
 * Supports step-up SIP (sipSchedule) and skipped months (skippedSipDates).
 */
const NAV_BASE = 10; // synthetic starting NAV, same face-value convention real funds use

export function recalcAll(raw, cfg) {
  return recalcAllWith(raw, cfg, sipsBetween);
}

/**
 * Shared engine behind recalcAll() — parameterized on which sweep function
 * decides which SIP instalments count between two entry dates, so the same
 * logic can run either the current allocation-aware sipsBetween(), or (only
 * for one-time migration purposes) the original unconditional
 * legacySipsBetween(). Not exported — use recalcAll() for real calculations.
 */
function recalcAllWith(raw, cfg, sweepFn) {
  if (!raw.length || !cfg) return [];
  const sorted = [...raw].sort((a, b) => a.date.localeCompare(b.date));
  let portfolioValue = 0, investedAmount = 0, prevDate = null;
  let navValue = NAV_BASE, unitsHeld = 0;

  return sorted.map(entry => {
    const sips = sweepFn(cfg, prevDate, entry.date);

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
    // % change — same day's NAV the SIP for this date is deemed bought at,
    // unless an instalment carries its own actual/recorded NAV or units
    // (real allocation info the user entered), in which case that wins.
    navValue = entry.nav != null ? entry.nav : navValue * (1 + entry.percentChange / 100);
    let sipUnits = 0;
    for (const s of sips) {
      if (s.unitsOverride != null)     sipUnits += s.unitsOverride;
      else if (s.navOverride != null)  sipUnits += s.navOverride > 0 ? s.amount / s.navOverride : 0;
      else                             sipUnits += navValue > 0 ? s.amount / navValue : 0;
    }
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
  const skippedSet   = new Set(cfg.skippedSipDates || []);
  const allocations  = cfg.sipAllocations || {};

  const today   = todayStr();
  const lastCalc = calc.length ? calc[calc.length - 1].date : null;
  const endStr  = lastCalc && lastCalc > today ? lastCalc : today;

  let prevAmount = null;
  let unitsRunning = 0;

  return allSipDates(cfg.startDate, endStr).map(({ dateStr }) => {
    const amount = amountForDate(schedule, dateStr);
    const stepChange = prevAmount === null ? 0 : +(amount - prevAmount).toFixed(2);
    prevAmount = amount;

    const emptyDates = { paymentDate: null, processingDate: null, allocationDate: null };

    if (skippedSet.has(dateStr)) {
      return { date: dateStr, amount, status: 'skipped', navValue: null, units: 0, unitsRunningTotal: unitsRunning, stepChange, ...emptyDates };
    }

    const alloc = allocations[dateStr];

    // Confirmed allocation — the real, held instalment. Use the user's
    // recorded NAV/units first (their actual AMC/broker data); fall back
    // to the fund's own real NAV history if they only entered a date.
    //
    // EXCEPTION: alloc.legacy === true rows were auto-grandfathered by the
    // one-time migration (buildLegacyAllocations) BEFORE the fund's real
    // NAV was reliably threaded through — their recorded nav/units may just
    // be the old synthetic ₹10-base calculation, never something the user
    // actually confirmed. For those, prefer the fund's real NAV history
    // whenever it's available, and only fall back to the recorded legacy
    // value if there's no real history to check against.
    if (alloc && alloc.status === 'allocated') {
      const real = navSeriesAsc ? navOnOrBefore(navSeriesAsc, dateStr) : null;
      const trustRecorded = alloc.legacy !== true;
      const navValue   = trustRecorded && alloc.nav != null ? alloc.nav
                        : (real ? real.nav : (alloc.nav != null ? alloc.nav : null));
      const allocAmount = alloc.amount != null ? alloc.amount : amount;
      const units = trustRecorded && alloc.units != null ? alloc.units
                  : (navValue ? +(allocAmount / navValue).toFixed(4) : (alloc.units != null ? alloc.units : 0));
      unitsRunning = +(unitsRunning + units).toFixed(4);
      return {
        date: dateStr, amount: allocAmount, status: 'allocated',
        navValue, units, unitsRunningTotal: unitsRunning, stepChange,
        paymentDate: alloc.paymentDate || null,
        processingDate: alloc.processingDate || null,
        allocationDate: alloc.allocationDate || null,
      };
    }

    // Any other explicit lifecycle status the user set manually
    // (payment_initiated / paid / processing / failed / cancelled) —
    // money not yet counted as a real holding.
    if (alloc && alloc.status) {
      return {
        date: dateStr, amount, status: alloc.status, navValue: null, units: 0,
        unitsRunningTotal: unitsRunning, stepChange,
        paymentDate: alloc.paymentDate || null,
        processingDate: alloc.processingDate || null,
        allocationDate: alloc.allocationDate || null,
      };
    }

    // No allocation record at all yet.
    const status = dateStr <= today ? 'processing' : 'upcoming';
    return { date: dateStr, amount, status, navValue: null, units: 0, unitsRunningTotal: unitsRunning, stepChange, ...emptyDates };
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
      nav:            e.nav != null ? e.nav : null,
      portfolioValue: e.portfolioValue,
      investedAmount: e.investedAmount,
    });
  }
}

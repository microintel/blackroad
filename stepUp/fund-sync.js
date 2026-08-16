/* ══════════════════════════════════════════════════════
   fund-sync.js — Fund NAV import & mfapi.in sync helpers
   Pure/utility functions only — no DOM, no IndexedDB.
   app.js wires these into buttons, state and the database.
══════════════════════════════════════════════════════ */

const MFAPI_BASE = 'https://api.mfapi.in/mf';

/** Convert "DD-MM-YYYY" -> "YYYY-MM-DD". */
export function ddmmyyyyToIso(d) {
  const [dd, mm, yyyy] = d.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

/** Sort a navHistory array (any order, DD-MM-YYYY dates) ascending by date. */
export function sortNavHistoryAsc(navHistory) {
  return [...navHistory].sort((a, b) => ddmmyyyyToIso(a.date).localeCompare(ddmmyyyyToIso(b.date)));
}

/** Parse the fund JSON shape the user uploads: { fund: {...}, navHistory: [...] }. */
export function parseFundFile(json) {
  const fund = json.fund || {};
  return {
    schemeCode: String(fund.schemeCode ?? '').trim(),
    schemeName: fund.schemeName ?? '',
    fundHouse:  fund.fundHouse ?? '',
    navHistory: sortNavHistoryAsc(json.navHistory || []),
  };
}

/** Read a File object (from an <input type=file>) as parsed JSON. */
export function readFileAsJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => { try { resolve(JSON.parse(reader.result)); } catch (e) { reject(e); } };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Build { date, percentChange } entries from an ASCENDING navHistory array
 * (DD-MM-YYYY dates), starting at the first date >= startDateIso (inclusive).
 *
 * The first included day gets percentChange 0 — it's the baseline the first
 * SIP instalment lands on. Every day after is chained off the previous
 * day's actual NAV, exactly like the app's manual "daily % change" entries.
 */
export function buildEntriesFromNavHistory(navHistoryAsc, startDateIso) {
  const startIdx = navHistoryAsc.findIndex(r => ddmmyyyyToIso(r.date) >= startDateIso);
  if (startIdx === -1) return [];
  const out = [];
  let prevNav = null;
  for (let i = startIdx; i < navHistoryAsc.length; i++) {
    const nav = parseFloat(navHistoryAsc[i].nav);
    if (isNaN(nav)) continue;
    const dateIso = ddmmyyyyToIso(navHistoryAsc[i].date);
    const pct = prevNav === null ? 0 : ((nav / prevNav) - 1) * 100;
    out.push({ date: dateIso, percentChange: +pct.toFixed(4) });
    prevNav = nav;
  }
  return out;
}

/**
 * Build a normalized "growth of ₹100" day-wise series from an ASCENDING
 * navHistory array (DD-MM-YYYY dates), covering the fund's ENTIRE
 * available history — not tied to the user's SIP start date. Powers the
 * long-range "Fund Performance History" chart, which can span decades
 * (30-50+ years for older schemes/indices) since it reads straight off
 * the fund's own NAV record rather than the user's invested entries.
 *
 * Returns { series, years, totalGrowthPct, cagrPct } — series is
 * [{ date, nav, growth }] where growth is what ₹100 put in on day one
 * would be worth on that day.
 */
export function buildFundGrowthSeries(navHistoryAsc) {
  const series = [];
  let baseNav = null;
  for (const row of navHistoryAsc) {
    const nav = parseFloat(row.nav);
    if (isNaN(nav)) continue;
    if (baseNav === null) baseNav = nav;
    series.push({ date: ddmmyyyyToIso(row.date), nav, growth: +(nav / baseNav * 100).toFixed(4) });
  }

  let years = 0, totalGrowthPct = 0, cagrPct = 0;
  if (series.length >= 2) {
    const first = new Date(series[0].date), last = new Date(series[series.length - 1].date);
    years = (last - first) / (1000 * 60 * 60 * 24 * 365.25);
    totalGrowthPct = (series[series.length - 1].nav / series[0].nav - 1) * 100;
    cagrPct = years > 0 ? (Math.pow(series[series.length - 1].nav / series[0].nav, 1 / years) - 1) * 100 : 0;
  }

  return { series, years, totalGrowthPct, cagrPct };
}

/**
 * Roll a day-wise fund growth series (from buildFundGrowthSeries) up into
 * calendar-year returns — one % figure per completed year-over-year
 * stretch. This is the fund's own track record, used as the basis for
 * projecting it forward.
 */
export function buildFundYearlyReturns(series) {
  if (!series.length) return [];
  const yearEnd = {};
  for (const row of series) yearEnd[row.date.slice(0, 4)] = row; // ascending -> last wins
  const years = Object.keys(yearEnd).sort();
  const out = [];
  for (let i = 1; i < years.length; i++) {
    const prev = yearEnd[years[i - 1]], curr = yearEnd[years[i]];
    out.push({ year: years[i], returnPct: (curr.nav / prev.nav - 1) * 100 });
  }
  return out;
}

/**
 * Project the fund forward from its latest known value using three
 * scenarios drawn from its OWN historical calendar-year returns: the
 * best year on record, the worst year on record, and the plain average
 * across all years — not a market-wide assumption. Returns monthly
 * points (smoother than yearly) each starting at the anchor (today's
 * last known value), so the projection lines connect straight onto the
 * end of the historical line.
 */
export function buildFundProjection(series, yearsAhead = 10) {
  const yearlyReturns = buildFundYearlyReturns(series);
  if (!series.length || !yearlyReturns.length) return null;

  const pcts    = yearlyReturns.map(y => y.returnPct);
  const avgPct  = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const bestPct = Math.max(...pcts);
  const worstPct = Math.min(...pcts);

  const anchor = series[series.length - 1];
  const months = Math.round(yearsAhead * 12);

  function scenario(annualPct) {
    const monthlyRate = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
    const points = [{ date: anchor.date, value: anchor.growth }];
    let value = anchor.growth;
    const anchorDate = new Date(anchor.date);
    for (let m = 1; m <= months; m++) {
      value = value * (1 + monthlyRate);
      const d = new Date(anchorDate);
      d.setMonth(d.getMonth() + m);
      points.push({ date: d.toISOString().slice(0, 10), value: +value.toFixed(4) });
    }
    return points;
  }

  return {
    anchorDate: anchor.date, anchorValue: anchor.growth,
    avgPct, bestPct, worstPct, yearsAhead,
    expected:    scenario(avgPct),
    optimistic:  scenario(bestPct),
    pessimistic: scenario(worstPct),
  };
}

/**
 * Fetch a scheme's full NAV history from mfapi.in.
 * Returns { schemeCode, schemeName, fundHouse, navHistory } with navHistory
 * sorted ascending, dates in DD-MM-YYYY (matches the uploaded-file format).
 */
export async function fetchSchemeFromMfapi(schemeCode) {
  const res = await fetch(`${MFAPI_BASE}/${schemeCode}`);
  if (!res.ok) throw new Error(`mfapi request failed (${res.status})`);
  const json = await res.json();
  return {
    schemeCode: String(json.meta?.scheme_code ?? schemeCode),
    schemeName: json.meta?.scheme_name ?? '',
    fundHouse:  json.meta?.fund_house ?? '',
    navHistory: sortNavHistoryAsc(json.data || []),
  };
}

/**
 * Given the existing local entries (ascending, { date: 'YYYY-MM-DD', ... })
 * and a freshly-fetched ascending navHistory (DD-MM-YYYY) for the SAME fund,
 * return only the NEW entries beyond the last local entry's date, chained
 * off the actual NAV on that date (matched by date, not by the stored %,
 * so rounding never drifts).
 *
 * Returns null if the last local entry's date isn't present in the fetched
 * history — the caller should surface a warning rather than guess.
 */
export function buildSyncDelta(localEntriesAsc, navHistoryAsc) {
  if (!localEntriesAsc.length) return null;
  const lastLocalDate = localEntriesAsc[localEntriesAsc.length - 1].date;
  const idx = navHistoryAsc.findIndex(r => ddmmyyyyToIso(r.date) === lastLocalDate);
  if (idx === -1) return null;

  const out = [];
  let prevNav = parseFloat(navHistoryAsc[idx].nav);
  for (let i = idx + 1; i < navHistoryAsc.length; i++) {
    const nav = parseFloat(navHistoryAsc[i].nav);
    if (isNaN(nav)) continue;
    const dateIso = ddmmyyyyToIso(navHistoryAsc[i].date);
    const pct = ((nav / prevNav) - 1) * 100;
    out.push({ date: dateIso, percentChange: +pct.toFixed(4) });
    prevNav = nav;
  }
  return out;
}

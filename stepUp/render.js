/* ══════════════════════════════════════════════════════
   render.js — Dashboard cards, history table, user page
══════════════════════════════════════════════════════ */

import { fmtK, fmtPct, todayStr } from './helpers.js';
import { recalcAll, periodGrowth, projectGoalDate } from './calc.js';
import { renderLineChart, getActiveRange, renderDonutChart, renderGrowthChart, renderMonthlyLineChart, renderPnlChart } from './charts.js';

let historySortDir      = 'desc';
let historySearchDate   = '';
let growthGranularity   = 'month';
let trendYearRange      = { from: null, to: null };

export function setHistorySortDir(val)     { historySortDir    = val; }
export function setHistorySearchDate(val)  { historySearchDate = val; }
export function setGrowthGranularity(val)  { growthGranularity = val; }
export function setMonthlyTrendYearRange(from, to) { trendYearRange = { from, to }; }

/**
 * Feeds each dashboard/hero card value & sub-line its own character length
 * as a CSS custom property, so style.css can shrink the font responsively
 * as numbers grow longer instead of overflowing or wrapping badly.
 */
function fitCardValueLengths() {
  document.querySelectorAll('#page-home .card-value, #page-home .card-sub')
    .forEach(el => el.style.setProperty('--vlen', el.textContent.length));
}

/**
 * Fill the "From Year" / "To Year" selects on the Monthly Trend panel.
 * Preserves the user's current selection across re-renders; only resets
 * to the full range when the set of available years actually changes.
 */
function populateYearSelects(monthPeriods) {
  const fromSel = document.getElementById('trend-year-from');
  const toSel   = document.getElementById('trend-year-to');
  if (!fromSel || !toSel || !monthPeriods.length) return;

  const years = [...new Set(monthPeriods.map(p => p.period.slice(0, 4)))];
  const key   = years.join(',');

  if (fromSel.dataset.years !== key) {
    const optsHtml = years.map(y => `<option value="${y}">${y}</option>`).join('');
    fromSel.innerHTML = optsHtml;
    toSel.innerHTML   = optsHtml;
    fromSel.dataset.years = key;
    toSel.dataset.years   = key;
    trendYearRange = { from: years[0], to: years[years.length - 1] };
  }
  fromSel.value = trendYearRange.from;
  toSel.value   = trendYearRange.to;
}

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
export function renderDashboard(calc, settings) {

  /* ── Reset all cards when no data ── */
  if (!calc.length || !settings) {
    ['c-invested','c-value','c-pnl','c-ret','c-sips',
     'c-xirr','c-days','c-next-sip','c-streak','c-avg-day',
     'c-month-growth','c-year-growth','c-avg-growth','c-today-pnl'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = 'card-value' +
        (id === 'c-invested' ? ' blue' :
         id === 'c-sips'     ? ' amber' : '');
      el.textContent =
        id === 'c-ret'  ? '0.00%' :
        id === 'c-days' || id === 'c-sips' || id === 'c-streak' ? '0' : '—';
    });
    const mSub = document.getElementById('c-month-growth-sub');
    if (mSub) mSub.textContent = '';
    const ySub = document.getElementById('c-year-growth-sub');
    if (ySub) ySub.textContent = '';
    const avgSub = document.getElementById('c-avg-growth-sub');
    if (avgSub) avgSub.textContent = '';
    const mIcon = document.getElementById('card-icon-month-growth');
    if (mIcon) mIcon.className = 'card-icon-wrap';
    const yIcon = document.getElementById('card-icon-year-growth');
    if (yIcon) yIcon.className = 'card-icon-wrap';
    const avgIcon = document.getElementById('card-icon-avg-growth');
    if (avgIcon) avgIcon.className = 'card-icon-wrap';
    const sub = document.getElementById('c-sips-sub');
    if (sub) sub.textContent = '';
    const nextSub = document.getElementById('c-next-sip-sub');
    if (nextSub) nextSub.textContent = '';
    const todaySub = document.getElementById('c-today-pnl-sub');
    if (todaySub) todaySub.textContent = '';
    const todayIcon = document.getElementById('card-icon-today');
    if (todayIcon) todayIcon.className = 'card-icon-wrap';
    const updownBody = document.getElementById('updown-body');
    if (updownBody) updownBody.innerHTML = `<tr><td colspan="3"><div class="empty"><i class="bi bi-inbox"></i><span>No entries yet.</span></div></td></tr>`;
    const updownBadge = document.getElementById('updown-total-badge');
    if (updownBadge) updownBadge.textContent = '';
    renderDonutChart(0, 0);
    const goalSection = document.getElementById('goal-section');
    if (goalSection) goalSection.style.display = 'none';
    fitCardValueLengths();
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

  /* ── 4b. Today's Growth / Loss ── */
  const todayEl    = document.getElementById('c-today-pnl');
  const todaySubEl = document.getElementById('c-today-pnl-sub');
  const todayIcon  = document.getElementById('card-icon-today');
  if (todayEl) {
    const todayDate = todayStr();
    let idx = calc.findIndex(e => e.date === todayDate);
    const isLive = idx !== -1;
    if (!isLive) idx = calc.length - 1;   // fall back to most recent entry
    const entry = calc[idx];
    const chg   = entry.percentChange;
    const prev  = idx > 0 ? calc[idx - 1] : null;
    const amtChange = prev ? entry.portfolioValue - prev.portfolioValue : entry.portfolioValue;

    todayEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    todayEl.className   = 'card-value ' + (chg >= 0 ? 'green' : 'red');

    if (todaySubEl) {
      const dLabel = new Date(entry.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      const amtText = (amtChange >= 0 ? '+' : '') + fmtK(amtChange);
      todaySubEl.textContent = (isLive ? 'Today' : `As of ${dLabel}`) + ` · ${amtText}`;
    }
    if (todayIcon) todayIcon.className = 'card-icon-wrap ' + (chg >= 0 ? 'green' : 'red');
  }

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
  let xirrValue = null;
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

    xirrValue = computeXIRR(flows);

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

  /* ── 11. Monthly Growth / Loss (current month vs previous) ── */
  const monthPeriods = periodGrowth(calc, 'month');
  const mEl = document.getElementById('c-month-growth');
  if (mEl && monthPeriods.length) {
    const m = monthPeriods[monthPeriods.length - 1];
    mEl.textContent = (m.growth >= 0 ? '+' : '') + fmtK(m.growth);
    mEl.className   = 'card-value ' + (m.growth >= 0 ? 'green' : 'red');
    const mSub = document.getElementById('c-month-growth-sub');
    if (mSub) {
      const pctText = m.growthPct === null ? '' : ` · ${m.growthPct >= 0 ? '+' : ''}${m.growthPct.toFixed(2)}%`;
      mSub.textContent = m.label + pctText;
    }
    const mIcon = document.getElementById('card-icon-month-growth');
    if (mIcon) mIcon.className = 'card-icon-wrap ' + (m.growth >= 0 ? 'green' : 'red');
  }

  /* ── 12. Yearly Growth / Loss (current year vs previous) ── */
  const yearPeriods = periodGrowth(calc, 'year');
  const yEl = document.getElementById('c-year-growth');
  if (yEl && yearPeriods.length) {
    const yy = yearPeriods[yearPeriods.length - 1];
    yEl.textContent = (yy.growth >= 0 ? '+' : '') + fmtK(yy.growth);
    yEl.className   = 'card-value ' + (yy.growth >= 0 ? 'green' : 'red');
    const ySub = document.getElementById('c-year-growth-sub');
    if (ySub) {
      const pctText = yy.growthPct === null ? '' : ` · ${yy.growthPct >= 0 ? '+' : ''}${yy.growthPct.toFixed(2)}%`;
      ySub.textContent = yy.label + pctText;
    }
    const yIcon = document.getElementById('card-icon-year-growth');
    if (yIcon) yIcon.className = 'card-icon-wrap ' + (yy.growth >= 0 ? 'green' : 'red');
  }

  /* ── 13. Average Monthly Growth / Loss (across all months) ── */
  const avgGrowthEl = document.getElementById('c-avg-growth');
  if (avgGrowthEl && monthPeriods.length) {
    const avgGrowth = monthPeriods.reduce((s, p) => s + p.growth, 0) / monthPeriods.length;
    const pctVals   = monthPeriods.map(p => p.growthPct).filter(v => v !== null);
    const avgPct    = pctVals.length ? pctVals.reduce((s, v) => s + v, 0) / pctVals.length : null;

    avgGrowthEl.textContent = (avgGrowth >= 0 ? '+' : '') + fmtK(avgGrowth);
    avgGrowthEl.className   = 'card-value ' + (avgGrowth >= 0 ? 'green' : 'red');
    const avgSub = document.getElementById('c-avg-growth-sub');
    if (avgSub) {
      const pctText = avgPct === null ? '' : ` · ${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(2)}%`;
      avgSub.textContent = `over ${monthPeriods.length} mo${pctText}`;
    }
    const avgIcon = document.getElementById('card-icon-avg-growth');
    if (avgIcon) avgIcon.className = 'card-icon-wrap ' + (avgGrowth >= 0 ? 'green' : 'red');
  }

  /* ── 14. Best / Worst Month by % Growth (highest % gain / loss overall) ── */
  const bestEl  = document.getElementById('c-best-growth');
  const worstEl = document.getElementById('c-worst-growth');
  if ((bestEl || worstEl) && monthPeriods.length) {
    const withPct = monthPeriods.filter(p => p.growthPct !== null);
    if (withPct.length) {
      const best  = withPct.reduce((a, b) => (b.growthPct > a.growthPct ? b : a));
      const worst = withPct.reduce((a, b) => (b.growthPct < a.growthPct ? b : a));

      if (bestEl) {
        bestEl.textContent = (best.growthPct >= 0 ? '+' : '') + best.growthPct.toFixed(2) + '%';
        bestEl.className   = 'card-value ' + (best.growthPct >= 0 ? 'green' : 'red');
        const bestSub = document.getElementById('c-best-growth-sub');
        if (bestSub) bestSub.textContent = best.label + ` · ${(best.growth >= 0 ? '+' : '') + fmtK(best.growth)}`;
        const bestIcon = document.getElementById('card-icon-best-growth');
        if (bestIcon) bestIcon.className = 'card-icon-wrap ' + (best.growthPct >= 0 ? 'green' : 'red');
      }

      if (worstEl) {
        worstEl.textContent = (worst.growthPct >= 0 ? '+' : '') + worst.growthPct.toFixed(2) + '%';
        worstEl.className   = 'card-value ' + (worst.growthPct >= 0 ? 'green' : 'red');
        const worstSub = document.getElementById('c-worst-growth-sub');
        if (worstSub) worstSub.textContent = worst.label + ` · ${(worst.growth >= 0 ? '+' : '') + fmtK(worst.growth)}`;
        const worstIcon = document.getElementById('card-icon-worst-growth');
        if (worstIcon) worstIcon.className = 'card-icon-wrap ' + (worst.growthPct >= 0 ? 'green' : 'red');
      }
    }
  }

  /* ── 15. Up vs Down Days Table ── */
  const updownBody  = document.getElementById('updown-body');
  const updownBadge = document.getElementById('updown-total-badge');
  if (updownBody) {
    const up   = calc.filter(e => e.percentChange > 0).length;
    const down = calc.filter(e => e.percentChange < 0).length;
    const flat = calc.length - up - down;
    const pctOf = n => calc.length ? ((n / calc.length) * 100) : 0;

    const rows = [
      { label: 'Up Days',   icon: 'bi-arrow-up-circle-fill',   count: up,   cls: 'up',   text: 'pct-up' },
      { label: 'Down Days', icon: 'bi-arrow-down-circle-fill', count: down, cls: 'down', text: 'pct-down' },
    ];
    if (flat > 0) rows.push({ label: 'Flat Days', icon: 'bi-dash-circle', count: flat, cls: '', text: '' });

    updownBody.innerHTML = rows.map(r => {
      const pct = pctOf(r.count);
      const bar = r.cls ? `<span class="updown-bar-wrap"><span class="updown-bar ${r.cls}" style="width:${pct.toFixed(1)}%"></span></span>` : '';
      return `<tr>
        <td><span class="updown-type ${r.text}"><i class="bi ${r.icon}"></i> ${r.label}</span></td>
        <td class="mono ${r.text}">${r.count}</td>
        <td class="mono" style="text-align:right;">${bar} ${pct.toFixed(1)}%</td>
      </tr>`;
    }).join('');
  }
  if (updownBadge) updownBadge.textContent = calc.length ? `${calc.length} days` : '';

  /* ── Donut Chart ── */
  renderDonutChart(last.investedAmount, pnl);

  /* ── 16. Goal Progress ── */
  const goalSection = document.getElementById('goal-section');
  if (goalSection) {
    if (settings.goalAmount > 0) {
      goalSection.style.display = '';
      const current  = last.portfolioValue;
      const goalAmt  = settings.goalAmount;
      const pct      = Math.min(100, (current / goalAmt) * 100);

      const pctEl = document.getElementById('goal-pct');
      if (pctEl) pctEl.textContent = pct.toFixed(1) + '%';

      const fillEl = document.getElementById('goal-progress-fill');
      const currentEl = document.getElementById('goal-current');
      const targetEl  = document.getElementById('goal-target');
      if (currentEl) currentEl.textContent = fmtK(current);
      if (targetEl) {
        const dateText = settings.goalDate
          ? ` by ${new Date(settings.goalDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
          : '';
        targetEl.textContent = `of ${fmtK(goalAmt)}${dateText}`;
      }

      const schedule = settings.sipSchedule || [];
      const monthlyContribution = schedule.length
        ? schedule[schedule.length - 1].amount
        : (settings.sipAmount || 0);
      const rate = xirrValue !== null ? xirrValue : 0;

      const projection = projectGoalDate(current, goalAmt, rate, monthlyContribution, last.date);
      const textEl = document.getElementById('goal-projection-text');

      if (current >= goalAmt) {
        if (fillEl) { fillEl.style.width = '100%'; fillEl.className = 'goal-progress-fill'; }
        if (textEl) { textEl.textContent = '🎉 Goal reached!'; textEl.className = 'goal-projection-text on-track'; }
      } else if (!projection) {
        if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
        if (textEl) {
          textEl.textContent = 'Not reachable within 50 years at the current rate and SIP amount.';
          textEl.className = 'goal-projection-text behind';
        }
      } else {
        if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
        const reachLabel = new Date(projection.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        let onTrack = true;
        let extra = '';
        if (settings.goalDate) {
          const target    = new Date(settings.goalDate);
          const projected = new Date(projection.date);
          const diffMonths = Math.round((target - projected) / (30.44 * 86400000));
          onTrack = projected <= target;
          extra = onTrack
            ? ` — ${Math.abs(diffMonths)} mo ahead of your ${new Date(settings.goalDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} target`
            : ` — ${Math.abs(diffMonths)} mo behind your ${new Date(settings.goalDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} target`;
        }
        if (textEl) {
          textEl.textContent = `At this rate, you'll reach ${fmtK(goalAmt)} by ${reachLabel}${extra}`;
          textEl.className = 'goal-projection-text ' + (onTrack ? 'on-track' : 'behind');
        }
        if (fillEl) fillEl.className = 'goal-progress-fill' + (onTrack ? '' : ' behind');
      }
    } else {
      goalSection.style.display = 'none';
    }
  }

  fitCardValueLengths();
}

/* ══════════════════════════════════════════════════════
   History Table
══════════════════════════════════════════════════════ */
export function renderTable(calc, settings) {
  const tbody = document.getElementById('history-body');
  document.getElementById('entry-count').textContent = calc.length ? `${calc.length} entries` : '';

  let filtered = calc;
  if (historySearchDate) filtered = calc.filter(e => e.date === historySearchDate);

  const sorted = [...filtered];
  if (historySortDir === 'asc') sorted.sort((a, b) => a.date.localeCompare(b.date));
  else                          sorted.sort((a, b) => b.date.localeCompare(a.date));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty">${
      historySearchDate ? 'No entry found for this date.' : 'No entries yet — add your first daily % change.'
    }</div></td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((e, i) => {
    const pct      = e.percentChange;
    const pnl      = e.portfolioValue - e.investedAmount;
    const retAmt   = e.dailyReturnAmount ?? 0;
    const sipBadge = e.sipAdded
      ? `<span class="sip-badge sip-yes">+₹${(e.sipTotal || e.sipCount * settings.sipAmount).toLocaleString('en-IN')}</span>`
      : `<span class="sip-badge sip-no">—</span>`;
    return `<tr>
      <td class="mono" style="color:var(--muted)">${i + 1}</td>
      <td>${e.date}</td>
      <td class="mono ${pct >= 0 ? 'pct-up' : 'pct-down'}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</td>
      <td class="mono ${retAmt >= 0 ? 'pct-up' : 'pct-down'}">${(retAmt >= 0 ? '+' : '') + fmtK(retAmt)}</td>
      <td>${sipBadge}</td>
      <td class="mono">${fmtK(e.portfolioValue)}</td>
      <td class="mono" style="color:var(--blue)">${fmtK(e.investedAmount)}</td>
      <td class="mono ${pnl >= 0 ? 'pct-up' : 'pct-down'}">${(pnl >= 0 ? '+' : '') + fmtK(pnl)}</td>
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
export function renderUserPage(entries, settings) {
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
export function renderAll(entries, settings) {
  const calc = recalcAll(entries, settings);
  renderDashboard(calc, settings);
  renderTable(calc, settings);
  if (document.getElementById('page-graph').classList.contains('active')) {
    renderLineChart(calc);
    renderPnlChart(calc);
    renderGrowthChart(periodGrowth(calc, growthGranularity));

    const monthPeriods = periodGrowth(calc, 'month');
    populateYearSelects(monthPeriods);
    const filtered = monthPeriods.filter(p => {
      const yr = p.period.slice(0, 4);
      return (!trendYearRange.from || yr >= trendYearRange.from) &&
             (!trendYearRange.to   || yr <= trendYearRange.to);
    });
    renderMonthlyLineChart(filtered);
  }
}

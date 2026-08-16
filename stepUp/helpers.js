/* ══════════════════════════════════════════════════════
   helpers.js — Formatting, toast, date utils
══════════════════════════════════════════════════════ */

export function fmt(n)    { return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function fmtK(n)   { return Math.abs(n) >= 1e5 ? '₹' + (n / 1e5).toFixed(2) + 'L' : fmt(n); }
export function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }

export function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function toast(msg, dur = 2400) {
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
export function dateToStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

export function todayStr() {
  return dateToStr(new Date());
}

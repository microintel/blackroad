/* ══════════════════════════════════════════════════════
   pdf-report.js — Full SIP PDF report (core jsPDF only)
   No autoTable plugin dependency — tables are hand-drawn.

   Rupee symbol fix: jsPDF's built-in Helvetica font has no glyph
   for ₹ (U+20B9), which is why it printed as a stray superscript
   "1". We fetch a Unicode font (Noto Sans, which includes the
   Currency Symbols block) at report-generation time, embed it in
   the PDF, and use it for every piece of text so ₹ renders correctly.

   Includes: daily % change, invested/value, P&L, SIP amounts, skipped
   instalments, step-up schedule, and an overall portfolio-value
   line chart. Header = project name + fund name. Footer =
   "Developed by Microintel" on every page.
══════════════════════════════════════════════════════ */

import { recalcAll, periodGrowth } from './calc.js';
import { fmt, todayStr, toast } from './helpers.js';

const PROJECT_NAME = 'StepUP';
const REPORT_TITLE = "Blackboard's Mutual Fund Report";
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
 * Render the pure Profit/Loss (portfolioValue - investedAmount) history as
 * an off-screen Chart.js line chart and return { dataUrl, width, height }
 * for embedding as an image — the "Profit Growth Chart".
 */
async function renderProfitGrowthChartImage(calc) {
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
  const pnl    = calc.map(e => +(e.portfolioValue - e.investedAmount).toFixed(2));
  const positive = pnl.length ? pnl[pnl.length - 1] >= 0 : true;

  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Profit / Loss',
          data: pnl,
          borderColor: positive ? '#16a34a' : '#dc2626',
          backgroundColor: positive ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
          borderWidth: 3,
          tension: 0.35,
          pointRadius: 0,
          fill: true,
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
export async function generatePdfReport(entries, settings, fundName) {
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
  doc.text(REPORT_TITLE, margin, 50);

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

  /* ── Profit Growth chart ── */
  toast('Generating chart…');
  const profitChartImg = await renderProfitGrowthChartImage(calc);
  if (profitChartImg) {
    const imgW = pageW - margin * 2;
    const imgH = imgW * (profitChartImg.height / profitChartImg.width);
    if (y + imgH > pageH - 60) { doc.addPage(); y = 50; }
    doc.setFont('NotoSans', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 20);
    doc.text('Profit Growth Chart', margin, y);
    y += 8;
    doc.addImage(profitChartImg.dataUrl, 'PNG', margin, y, imgW, imgH);
    y += imgH + 22;
  }

  /* ── Monthly Growth / Loss ── */
  const monthPeriods = periodGrowth(calc, 'month');
  if (monthPeriods.length) {
    if (y > pageH - 100) { doc.addPage(); y = 50; }
    doc.setFont('NotoSans', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 20);
    doc.text('Monthly Growth / Loss', margin, y);
    y += 8;

    const usableW2 = pageW - margin * 2;
    const growthRows = [...monthPeriods].reverse().map(p => {
      const pctText = p.growthPct === null ? '—' : `${p.growthPct >= 0 ? '+' : ''}${p.growthPct.toFixed(2)}%`;
      const text  = (p.growth >= 0 ? '+' : '') + fmt(p.growth);
      const color = p.growth >= 0 ? [22, 163, 74] : [220, 38, 38];
      const pnlText  = (p.pnl >= 0 ? '+' : '') + fmt(p.pnl);
      const pnlColor = p.pnl >= 0 ? [22, 163, 74] : [220, 38, 38];
      return [p.label, fmt(p.invested), fmt(p.value), { text: pnlText, color: pnlColor }, { text, color }, { text: pctText, color }];
    });

    y = drawTable(doc, {
      startY: y, margin, pageW, pageH,
      head: ['Month', 'Invested', 'Portfolio Value', 'P&L', 'Growth / Loss', '%'],
      rows: growthRows,
      widths: [usableW2 * 0.17, usableW2 * 0.18, usableW2 * 0.19, usableW2 * 0.16, usableW2 * 0.16, usableW2 * 0.14],
      aligns: ['left', 'right', 'right', 'right', 'right', 'right'],
    });
    y += 22;
  }

  /* ── Step-up / step-down schedule ── */
  if (y > pageH - 100) { doc.addPage(); y = 50; }
  doc.setFont('NotoSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('SIP Schedule (Step-Up / Step-Down)', margin, y);
  y += 8;

  y = drawTable(doc, {
    startY: y, margin, pageW, pageH,
    head: ['Effective From', 'Monthly Amount', 'Change'],
    rows: schedule.map((s, i) => {
      if (i === 0) return [s.fromDate, fmt(s.amount), 'Base'];
      const prev = schedule[i - 1].amount;
      const diff = s.amount - prev;
      const change = diff > 0 ? `▲ Step-Up (+${fmt(diff)})`
                   : diff < 0 ? `▼ Step-Down (${fmt(diff)})`
                   : '—';
      return [s.fromDate, fmt(s.amount), change];
    }),
    widths: [(pageW - margin * 2) * 0.32, (pageW - margin * 2) * 0.28, (pageW - margin * 2) * 0.4],
    aligns: ['left', 'right', 'right'],
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
      rows: skipped.map(d => [d, fmt(amountForDate(schedule, d))]),
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
  const widths  = [usableW * 0.14, usableW * 0.14, usableW * 0.17, usableW * 0.19, usableW * 0.19, usableW * 0.17];

  const rows = [...calc]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(e => {
      const pctText = (e.percentChange >= 0 ? '+' : '') + e.percentChange.toFixed(2) + '%';
      const pctColor = e.percentChange >= 0 ? [22, 163, 74] : [220, 38, 38];
      const pnl = e.portfolioValue - e.investedAmount;
      const pnlText  = (pnl >= 0 ? '+' : '') + fmt(pnl);
      const pnlColor = pnl >= 0 ? [22, 163, 74] : [220, 38, 38];
      return [
        e.date,
        { text: pctText, color: pctColor },
        e.sipAdded ? `+${fmt(e.sipTotal)}` : '—',
        fmt(e.investedAmount),
        fmt(e.portfolioValue),
        { text: pnlText, color: pnlColor },
      ];
    });

  drawTable(doc, {
    startY: y, margin, pageW, pageH,
    head: ['Date', 'Daily Change', 'SIP Added', 'Invested', 'Portfolio Value', 'P&L'],
    rows,
    widths,
    aligns: ['left', 'right', 'right', 'right', 'right', 'right'],
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

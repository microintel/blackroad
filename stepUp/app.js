/* ══════════════════════════════════════════════════════
   app.js — Navigation, events, settings, entry CRUD, boot
            Multi-SIP profile support
══════════════════════════════════════════════════════ */

import { openDB, dbGet, dbPut, dbDel, dbAll, dbClr,
         dbGetSettings, dbPutSettings,
         dbGetEntries, dbPutEntry, dbDelEntry, dbClearEntries,
         dbGetAllProfiles, dbPutProfile, dbDelProfile } from './db.js';
import { toast, todayStr, dateToStr, fmtK }                   from './helpers.js';
import { recalcAll, saveCalcEntries, sipsBetween, amountForDate, projectGoalScenarios,
         buildSipLedger, buildLegacyAllocations, SIP_ALLOCATION_STATUSES } from './calc.js';
import {
  renderLineChart, applyRangeToMain,
  setActiveRange, wireSelectionDrag,
  renderFundHistoryChart, resetFundHistoryZoom, renderFundProjectionChart,
  applyRangeToPnl, resetPnlZoom, renderGoalProjectionChart,
} from './charts.js';
import {
  renderAll, renderTable, renderUserPage,
  setHistorySortDir, setHistorySearchDate, setGrowthGranularity,
  setMonthlyTrendYearRange, setUnitsNavHistory,
  setHistoryViewMode, loadMoreHistory,
} from './render.js';
import {
  readFileAsJson, parseFundFile, buildEntriesFromNavHistory,
  fetchSchemeFromMfapi, buildSyncDelta, buildFundGrowthSeries, buildFundProjection,
  buildFundYearlyReturns,
} from './fund-sync.js';

/* ══════════════════════════════════════════════════════
   App State
══════════════════════════════════════════════════════ */
let profiles       = [];   // [{id, name}]
let activeProfile  = null; // {id, name}
let settings       = null;
let entries        = [];

/* Fund's own full NAV history, cached per scheme so the long-range
   "Fund Performance History" chart doesn't refetch on every visit. */
let fundHistCache   = { schemeCode: null, data: null };
let fundProjYears   = 10;

import { generatePdfReport } from './pdf-report.js';

/* Re-export for inline onclick handlers */
window.startEdit    = startEdit;
window.deleteEntry  = deleteEntry;
window.switchProfile = switchProfile;
window.deleteProfile = deleteProfile;

/* ══════════════════════════════════════════════════════
   Profile helpers
══════════════════════════════════════════════════════ */
async function loadProfiles() {
  profiles = await dbGetAllProfiles();
  profiles.sort((a, b) => a.id - b.id);

  if (!profiles.length && window.BRAuth && window.BRAuth.isGuestSync()) {
    // Guests get a transient, in-memory-only profile so the app has
    // something to display — nothing here is ever written to IndexedDB.
    profiles = [{ id: 'guest-preview', name: 'My SIP (guest preview)' }];
    return;
  }

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

async function switchProfile(id) {
  activeProfile = profiles.find(p => p.id === id);
  localStorage.setItem('sip-active-profile', id);
  settings = null; entries = [];
  setUnitsNavHistory(null);
  await loadAll();
  if (settings) settings = normalizeSettings(settings);
  await migrateSipAllocationsIfNeeded();
  applySettingsToUI();
  renderAll(entries, settings);
  renderProfileSwitcher();
  renderScheduleList();
  renderSkipList();
  renderSipAllocationSection();
  renderFundLinkStatus();
  if (document.getElementById('page-user').classList.contains('active')) {
    renderUserPage(entries, settings);
    renderManageSipsSection();
  }
  if (document.getElementById('page-graph').classList.contains('active')) refreshFundHistorySection();
  syncLinkedFund({ silent: true });
}

async function createProfile(name) {
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to create a SIP — guest mode is view-only.'); return; }
  const pid = await dbPutProfile({ name: name.trim() });
  profiles = await dbGetAllProfiles();
  profiles.sort((a, b) => a.id - b.id);
  await switchProfile(pid);
  toast(`"${name}" created ✓`);
}

async function deleteProfile(id) {
  if (profiles.length <= 1) { toast('Cannot delete your only SIP.'); return; }
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to delete a SIP — guest mode is view-only.'); return; }
  const p = profiles.find(p => p.id === id);
  if (!confirm(`Delete "${p ? p.name : 'this SIP'}" and all its data?`)) return;
  await dbDelProfile(id);
  await dbClearEntries(id);
  // Delete settings for this profile
  try { await dbDel('settings', id); } catch(_) {}
  profiles = await dbGetAllProfiles();
  profiles.sort((a, b) => a.id - b.id);
  const nextId = profiles[0]?.id;
  if (nextId) await switchProfile(nextId);
  renderManageSipsSection();
  toast('SIP deleted ✓');
}

async function renameProfile(id, newName) {
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to rename a SIP — guest mode is view-only.'); return; }
  const p = profiles.find(p => p.id === id);
  if (!p) return;
  p.name = newName.trim() || p.name;
  await dbPutProfile(p);
  profiles = await dbGetAllProfiles();
  profiles.sort((a, b) => a.id - b.id);
  if (activeProfile && activeProfile.id === id) activeProfile = p;
  renderProfileSwitcher();
  renderManageSipsSection();
  toast('Renamed ✓');
}

/* ══════════════════════════════════════════════════════
   Profile Switcher UI (header) — dropdown menu
══════════════════════════════════════════════════════ */
function renderProfileSwitcher() {
  const wrap = document.getElementById('profile-switcher');
  const dataLabel = document.getElementById('data-current-sip-name');
  if (dataLabel) dataLabel.textContent = activeProfile?.name || 'My SIP';
  if (!wrap) return;
  if (profiles.length <= 1) {
    // Just show the single name subtly
    wrap.innerHTML = `<span class="profile-single-name">${profiles[0]?.name || 'My SIP'}</span>`;
    return;
  }

  wrap.innerHTML = `
    <div class="profile-dropdown" id="profile-dropdown">
      <button class="profile-dd-trigger" id="profile-dd-trigger" type="button">
        <span class="profile-dd-trigger-label">${activeProfile?.name || 'Select Fund'}</span>
        <i class="bi bi-chevron-down profile-dd-chevron"></i>
      </button>
      <div class="profile-dd-menu" id="profile-dd-menu" role="listbox">
        ${profiles.map(p => `
          <button class="profile-dd-item ${p.id === activeProfile?.id ? 'active' : ''}" data-id="${p.id}" role="option">
            <i class="bi bi-graph-up-arrow profile-dd-item-icon"></i>
            <span class="profile-dd-item-name">${p.name}</span>
            ${p.id === activeProfile?.id ? '<i class="bi bi-check-lg profile-dd-check"></i>' : ''}
          </button>`).join('')}
        <div class="profile-dd-divider"></div>
        <button class="profile-dd-item profile-dd-add" id="btn-add-sip-quick">
          <i class="bi bi-plus-circle profile-dd-item-icon"></i>
          <span class="profile-dd-item-name">Add New SIP</span>
        </button>
      </div>
    </div>`;

  const dd      = document.getElementById('profile-dropdown');
  const trigger = document.getElementById('profile-dd-trigger');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dd.classList.toggle('open');
  });

  dd.querySelectorAll('.profile-dd-item[data-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      dd.classList.remove('open');
      const id = parseInt(btn.dataset.id, 10);
      if (id !== activeProfile?.id) switchProfile(id);
    });
  });

  document.getElementById('btn-add-sip-quick')?.addEventListener('click', () => {
    dd.classList.remove('open');
    promptNewSip();
  });
}

// Close the profile dropdown when tapping/clicking outside it (wired once)
document.addEventListener('click', (e) => {
  const dd = document.getElementById('profile-dropdown');
  if (dd && dd.classList.contains('open') && !dd.contains(e.target)) {
    dd.classList.remove('open');
  }
});

function promptNewSip() {
  const name = prompt('New SIP name (e.g. "HDFC Midcap"):');
  if (!name || !name.trim()) return;
  createProfile(name);
}

/* ══════════════════════════════════════════════════════
   Manage SIPs section in Account page
══════════════════════════════════════════════════════ */
function renderManageSipsSection() {
  const el = document.getElementById('manage-sips-list');
  if (!el) return;

  el.innerHTML = profiles.map(p => `
    <div class="sip-manage-row ${p.id === activeProfile?.id ? 'sip-manage-active' : ''}">
      <div class="sip-manage-left">
        <div class="sip-manage-name" id="sip-name-${p.id}">${p.name}</div>
        ${p.id === activeProfile?.id ? '<span class="sip-manage-badge">Active</span>' : ''}
      </div>
      <div class="sip-manage-actions">
        ${p.id !== activeProfile?.id
          ? `<button class="btn btn-secondary btn-xs" onclick="switchProfile(${p.id})">Switch</button>`
          : ''}
        <button class="btn btn-secondary btn-xs sip-rename-btn" data-id="${p.id}" data-name="${p.name}">
          <i class="bi bi-pencil"></i>
        </button>
        ${profiles.length > 1
          ? `<button class="btn btn-xs sip-del-btn" data-id="${p.id}" style="background:var(--red-dim);color:var(--red);border:1px solid var(--red);">
               <i class="bi bi-trash3"></i>
             </button>`
          : ''}
      </div>
    </div>`).join('');

  el.querySelectorAll('.sip-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id   = parseInt(btn.dataset.id);
      const name = prompt('Rename SIP:', btn.dataset.name);
      if (name && name.trim()) renameProfile(id, name);
    });
  });

  el.querySelectorAll('.sip-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteProfile(parseInt(btn.dataset.id)));
  });
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
    // Mark every nav item pointing at this page as active — not just the one
    // clicked — so the desktop side-nav and the mobile bottom-nav (which
    // duplicate the same 5 pages) always stay in sync with each other.
    document.querySelectorAll(`.nav-item[data-page="${btn.dataset.page}"]`).forEach(b => b.classList.add('active'));
    document.getElementById(btn.dataset.page).classList.add('active');
    // Pages share the same scrolling body element, so switching pages
    // must reset scroll — otherwise a new page opens already scrolled
    // down to wherever the previous page was left.
    window.scrollTo(0, 0);
    syncSwipeDots(btn.dataset.page);
    if (btn.dataset.page === 'page-graph')   {
      setTimeout(() => renderAll(entries, settings), 50);
      refreshFundHistorySection();
    }
    if (btn.dataset.page === 'page-history') renderTable(recalcAll(entries, settings), settings);
    if (btn.dataset.page === 'page-user')    {
      renderUserPage(entries, settings);
      renderScheduleList();
      renderSkipList();
      renderSipAllocationSection();
      renderManageSipsSection();
      resetAccountDrilldown();
    }
    if (btn.dataset.page === 'page-add')     { initHelper(); renderFundLinkStatus(); }
  });
});

/* ══════════════════════════════════════════════════════
   Account page — mobile options list
   ------------------------------------------------------
   Below ~900px wide, the Account page shows a grouped list of options
   (see index.html #account-options-list) instead of every section
   expanded at once. Tapping an option opens ONLY that section — every
   other section stays collapsed until "Back" is tapped. Desktop's
   always-expanded multi-column layout is untouched (CSS media query
   only applies this below 900px — see style.css).
══════════════════════════════════════════════════════ */
function resetAccountDrilldown() {
  document.querySelectorAll('.user-sections-grid .user-section').forEach(s => s.classList.remove('acct-open'));
  const list = document.getElementById('account-options-list');
  const back = document.getElementById('acct-back-btn');
  if (list) list.style.display = '';
  if (back) back.style.display = 'none';
}

function openAccountSection(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  document.querySelectorAll('.user-sections-grid .user-section').forEach(s => s.classList.remove('acct-open'));
  target.classList.add('acct-open');
  const list = document.getElementById('account-options-list');
  const back = document.getElementById('acct-back-btn');
  if (list) list.style.display = 'none';
  if (back) back.style.display = 'flex';
  window.scrollTo(0, 0);
}

document.querySelectorAll('.acct-opt-row').forEach(row => {
  row.addEventListener('click', () => openAccountSection(row.dataset.target));
});
document.getElementById('acct-back-btn')?.addEventListener('click', resetAccountDrilldown);

/* ══════════════════════════════════════════════════════
   Swipe Navigation — removed. Pages now switch only via the
   bottom nav / side nav taps, not left-right swipe gestures.
══════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════
   Settings — helpers
══════════════════════════════════════════════════════ */
function normalizeSettings(s) {
  if (!s) return s;
  if (!s.sipSchedule || !s.sipSchedule.length) {
    s.sipSchedule = [{ fromDate: s.startDate, amount: s.sipAmount || 0 }];
  }
  if (!s.skippedSipDates) s.skippedSipDates = [];
  if (!s.sipAllocations) s.sipAllocations = {};
  const last = s.sipSchedule[s.sipSchedule.length - 1];
  s.sipAmount = last ? last.amount : s.sipAmount;
  return s;
}

/* ══════════════════════════════════════════════════════
   SIP payment → processing → NAV allocation tracking
   ------------------------------------------------------
   One-time, per-profile migration: grandfathers in every SIP instalment
   this app had already swept into invested amount/units under the OLD
   (pre-tracking) logic, so existing numbers never change. Must be called
   only once `settings` AND `entries` for the profile are both loaded —
   see call sites below (boot, switchProfile, save-settings, import).
══════════════════════════════════════════════════════ */
async function migrateSipAllocationsIfNeeded() {
  if (!settings || !activeProfile) return;
  if (!settings.sipAllocations) settings.sipAllocations = {};
  if (settings.sipAllocationsMigrated) return;
  const legacy = buildLegacyAllocations(entries, settings);
  if (Object.keys(legacy).length) {
    settings.sipAllocations = { ...legacy, ...settings.sipAllocations };
  }
  settings.sipAllocationsMigrated = true;
  try { await dbPutSettings(activeProfile.id, settings); } catch (_) { /* best-effort */ }
}

function currentSipAmount() {
  if (!settings || !settings.sipSchedule || !settings.sipSchedule.length) return 0;
  return settings.sipSchedule[settings.sipSchedule.length - 1].amount;
}

function applySettingsToUI() {
  // Fund-link card UI is per-profile — always reset it to THIS profile's
  // state on load/switch, never inherit a value left over from another SIP.
  // Runs even when this profile has no settings yet, so a brand-new SIP
  // never shows a previous profile's leftover date/file.
  const fundStart = document.getElementById('fund-sip-start');
  if (fundStart) fundStart.value = (settings && !settings.linkedFund) ? (settings.startDate || '') : '';
  const fundFile = document.getElementById('fund-json-file');
  if (fundFile) fundFile.value = '';

  if (!settings) return;
  const amt = currentSipAmount();
  document.getElementById('sip-amount').value          = amt;
  document.getElementById('sip-start').value           = settings.startDate;
  document.getElementById('settings-info').textContent =
    `Active: ₹${amt.toLocaleString('en-IN')} SIP from ${settings.startDate}`;
  document.getElementById('settings-info-header').textContent = `₹${amt.toLocaleString('en-IN')}/mo`;

  const goalAmtInput = document.getElementById('goal-amount');
  const goalDateInput = document.getElementById('goal-date');
  if (goalAmtInput)  goalAmtInput.value  = settings.goalAmount || '';
  if (goalDateInput) goalDateInput.value = settings.goalDate   || '';
}

/* ══════════════════════════════════════════════════════
   Save Settings (profile-scoped)
══════════════════════════════════════════════════════ */
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  if (!activeProfile) { toast('No active SIP profile.'); return; }
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to save settings — guest mode is view-only.'); return; }
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
  await migrateSipAllocationsIfNeeded();
  applySettingsToUI();
  renderScheduleList();
  renderSkipList();
  renderSipAllocationSection();
  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast('Settings saved ✓');
});

/* ══════════════════════════════════════════════════════
   Save / Clear Investment Goal (profile-scoped)
══════════════════════════════════════════════════════ */
document.getElementById('btn-save-goal').addEventListener('click', async () => {
  if (!activeProfile) { toast('No active SIP profile.'); return; }
  if (!settings) { toast('Save your SIP settings first.'); return; }
  const amt  = parseFloat(document.getElementById('goal-amount').value);
  const date = document.getElementById('goal-date').value;
  if (!amt || amt <= 0) { toast('Enter a valid target corpus.'); return; }

  settings.goalAmount = amt;
  settings.goalDate   = date || null;
  await dbPutSettings(activeProfile.id, settings);
  renderAll(entries, settings);
  if (fundHistCache.data) renderGoalProjectionSection(fundHistCache.data.series);
  toast('Goal saved ✓');
});

document.getElementById('btn-clear-goal').addEventListener('click', async () => {
  if (!activeProfile || !settings) return;
  settings.goalAmount = null;
  settings.goalDate   = null;
  await dbPutSettings(activeProfile.id, settings);
  document.getElementById('goal-amount').value = '';
  document.getElementById('goal-date').value   = '';
  renderAll(entries, settings);
  document.getElementById('goal-projection-section').style.display = 'none';
  toast('Goal cleared');
});

/* ══════════════════════════════════════════════════════
   Step-Up / Step-Down SIP
══════════════════════════════════════════════════════ */
document.getElementById('btn-add-stepup').addEventListener('click', async () => {
  if (!settings) { toast('Save base SIP settings first.'); return; }
  const newAmt  = parseFloat(document.getElementById('stepup-amount').value);
  const fromDate = document.getElementById('stepup-date').value;
  if (!newAmt || newAmt <= 0 || !fromDate) { toast('Enter a valid new amount and effective date.'); return; }
  if (fromDate < settings.startDate) { toast('Effective date cannot be before SIP start date.'); return; }

  // Amount that was active immediately before this new entry, so we can
  // tell the user whether this was a step-up (increase) or step-down (decrease).
  const priorAmt = amountForDate(settings.sipSchedule, fromDate);

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

  const verb = newAmt > priorAmt ? 'Step-up' : newAmt < priorAmt ? 'Step-down' : 'Amount set';
  toast(`${verb} to ₹${newAmt.toLocaleString('en-IN')} from ${fromDate} ✓`);
});

function renderScheduleList() {
  const el = document.getElementById('stepup-schedule-list');
  if (!el || !settings || !settings.sipSchedule) return;
  if (!settings.sipSchedule.length) { el.innerHTML = ''; return; }
  el.innerHTML = settings.sipSchedule.map((s, i) => {
    const prevAmt = i === 0 ? null : settings.sipSchedule[i - 1].amount;
    const isDown  = prevAmt !== null && s.amount < prevAmt;
    const isUp    = prevAmt !== null && s.amount > prevAmt;
    const arrow   = isDown ? '<i class="bi bi-arrow-down-short" style="color:var(--red)"></i>'
                  : isUp   ? '<i class="bi bi-arrow-up-short" style="color:var(--green)"></i>'
                  : '';
    return `
    <div class="schedule-row">
      <div class="schedule-info">
        <span class="schedule-amt ${isDown ? 'down' : ''}">${arrow}₹${s.amount.toLocaleString('en-IN')}</span>
        <span class="schedule-from">from ${s.fromDate}</span>
      </div>
      ${i === 0
        ? '<span class="schedule-badge">Base</span>'
        : `<button class="btn-icon schedule-del" data-idx="${i}" title="Remove this change" style="color:var(--red)">🗑</button>`
      }
    </div>`;
  }).join('');

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
      toast('Schedule entry removed ✓');
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
  renderSipAllocationSection();
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
      renderSipAllocationSection();
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
   SIP payment → processing → NAV allocation tracking
   ------------------------------------------------------
   Every SIP instalment gets its own lifecycle (see calc.js). This section
   lists whichever instalments still need attention (anything short of
   'allocated' or 'skipped') and lets the user record the real payment /
   allocation details their broker confirms — WITHOUT ever assuming the
   scheduled SIP date is the actual NAV allocation date. Nothing here
   touches invested amount/units until the user explicitly confirms
   allocation (see sipsBetween() in calc.js).
══════════════════════════════════════════════════════ */
const ALLOC_STATUS_LABEL = {
  scheduled:         'Scheduled',
  payment_initiated: 'Payment Initiated',
  paid:              'Paid',
  processing:        'Processing',
  allocated:         'Allocated',
  failed:            'Failed',
  cancelled:         'Cancelled',
};
const ALLOC_STATUS_BADGE = {
  payment_initiated: 'sip-progress',
  paid:              'sip-progress',
  processing:        'sip-pending',
  failed:            'sip-no',
  cancelled:         'sip-no',
};
const ALLOC_PENDING_STATUSES = ['payment_initiated', 'paid', 'processing', 'failed', 'cancelled'];

let allocFormTargetDate = null;

function renderSipAllocationSection() {
  const el = document.getElementById('sip-alloc-list');
  if (!el) return;
  if (!settings || !settings.startDate) {
    el.innerHTML = '<span class="muted-note">No SIP set up yet.</span>';
    closeAllocationForm();
    return;
  }

  const calc    = recalcAll(entries, settings);
  const ledger  = buildSipLedger(calc, settings);
  const pending = ledger.filter(r => ALLOC_PENDING_STATUSES.includes(r.status));

  if (!pending.length) {
    el.innerHTML = '<span class="muted-note">No pending SIP allocations — you\'re all caught up ✓</span>';
    closeAllocationForm();
    return;
  }

  el.innerHTML = pending.map(r => {
    const label = ALLOC_STATUS_LABEL[r.status] || r.status;
    const badge = ALLOC_STATUS_BADGE[r.status] || '';
    const paidNote = r.paymentDate ? ` · Paid ${r.paymentDate}` : '';
    return `
    <div class="schedule-row sip-alloc-row">
      <div class="schedule-info">
        <span class="schedule-amt">₹${r.amount.toLocaleString('en-IN')}</span>
        <span class="schedule-from">Scheduled ${r.date}${paidNote}</span>
        <span class="sip-badge ${badge}">${label}</span>
      </div>
      <div class="sip-alloc-row-actions">
        <select class="sip-alloc-status-select" data-date="${r.date}" title="Update status">
          ${ALLOC_PENDING_STATUSES.map(s =>
            `<option value="${s}" ${r.status === s ? 'selected' : ''}>${ALLOC_STATUS_LABEL[s]}</option>`
          ).join('')}
        </select>
        <button class="btn btn-secondary btn-xs sip-alloc-update-btn" data-date="${r.date}">
          <i class="bi bi-pencil-square"></i> Update Allocation
        </button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sip-alloc-status-select').forEach(sel => {
    sel.addEventListener('change', () => setAllocationStatus(sel.dataset.date, sel.value));
  });
  el.querySelectorAll('.sip-alloc-update-btn').forEach(btn => {
    btn.addEventListener('click', () => openAllocationForm(btn.dataset.date));
  });
}

/** Quick status change — no dates/NAV required. Never marks 'allocated'
 *  (that requires actual allocation details — see openAllocationForm). */
async function setAllocationStatus(dateStr, status) {
  if (!settings || !activeProfile) return;
  if (!settings.sipAllocations) settings.sipAllocations = {};
  const existing = settings.sipAllocations[dateStr] || {};
  settings.sipAllocations[dateStr] = {
    status,
    paymentDate:    existing.paymentDate    || (status === 'paid' || status === 'payment_initiated' ? dateStr : null),
    processingDate: status === 'processing' ? (existing.processingDate || todayStr()) : (existing.processingDate || null),
    allocationDate: existing.allocationDate || null,
    nav:            existing.nav != null ? existing.nav : null,
    units:          existing.units != null ? existing.units : null,
    amount:         existing.amount != null ? existing.amount : amountForDate(settings.sipSchedule, dateStr),
  };
  await dbPutSettings(activeProfile.id, settings);
  renderSipAllocationSection();
  renderTable(recalcAll(entries, settings), settings); // keep History-page ledger's statuses in sync
  toast(`Marked ${ALLOC_STATUS_LABEL[status] || status} ✓`);
}

/** Opens the shared "Update Allocation" form for a given SIP due date —
 *  used both by the pending list above and by the "edit" action in the
 *  full SIP ledger on the History page (works for already-allocated
 *  instalments too, so a wrong NAV/date/units can always be corrected —
 *  it always UPDATES that one instalment, never creates a new one). */
function openAllocationForm(dateStr) {
  if (!settings) return;
  // Jump to the Account page if this was triggered from elsewhere (e.g.
  // the History-page SIP ledger's edit button) so the form is visible.
  const pageUser = document.getElementById('page-user');
  if (pageUser && !pageUser.classList.contains('active')) {
    document.querySelector('.nav-item[data-page="page-user"]')?.click();
  }

  allocFormTargetDate = dateStr;
  const existing = (settings.sipAllocations && settings.sipAllocations[dateStr]) || {};
  document.getElementById('sip-alloc-form-date').textContent    = dateStr;
  document.getElementById('alloc-payment-date').value           = existing.paymentDate    || dateStr;
  document.getElementById('alloc-allocation-date').value        = existing.allocationDate || '';
  document.getElementById('alloc-nav').value                    = existing.nav   != null ? existing.nav   : '';
  document.getElementById('alloc-units').value                  = existing.units != null ? existing.units : '';

  const form = document.getElementById('sip-alloc-form');
  form.style.display = 'block';
  setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
}

function closeAllocationForm() {
  allocFormTargetDate = null;
  const form = document.getElementById('sip-alloc-form');
  if (form) form.style.display = 'none';
}

document.getElementById('btn-cancel-allocation')?.addEventListener('click', closeAllocationForm);

document.getElementById('btn-save-allocation')?.addEventListener('click', async () => {
  if (!allocFormTargetDate || !settings || !activeProfile) return;
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to record allocations — guest mode is view-only.'); return; }

  const dateStr        = allocFormTargetDate;
  const paymentDate    = document.getElementById('alloc-payment-date').value || null;
  const allocationDate = document.getElementById('alloc-allocation-date').value || null;
  const navRaw         = parseFloat(document.getElementById('alloc-nav').value);
  const unitsRaw       = parseFloat(document.getElementById('alloc-units').value);
  const nav            = isNaN(navRaw)   ? null : navRaw;
  const unitsEntered   = isNaN(unitsRaw) ? null : unitsRaw;

  if (!allocationDate) { toast('Enter the actual allocation date.'); return; }
  if (nav == null && unitsEntered == null) { toast('Enter the actual NAV (or units).'); return; }

  const existing = (settings.sipAllocations && settings.sipAllocations[dateStr]) || {};
  const amount   = existing.amount != null ? existing.amount : amountForDate(settings.sipSchedule, dateStr);
  // Preserve actual entered units exactly; only compute units = amount / NAV
  // when the user didn't supply units directly (per the app's existing
  // 4-decimal unit precision).
  const units = unitsEntered != null ? +unitsEntered.toFixed(4)
              : (nav ? +(amount / nav).toFixed(4) : null);

  if (!settings.sipAllocations) settings.sipAllocations = {};
  settings.sipAllocations[dateStr] = {
    status: 'allocated',
    paymentDate,
    processingDate: existing.processingDate || null,
    allocationDate,
    nav,
    units,
    amount,
  };

  await dbPutSettings(activeProfile.id, settings);
  closeAllocationForm();
  renderSipAllocationSection();

  // Same "recalc & save back onto existing entries" pattern used by
  // step-up/skip — updates the invested amount/units on already-existing
  // entries in place; never creates a new investment transaction.
  const calc = recalcAll(entries, settings);
  await saveCalcEntries(calc, activeProfile.id);
  entries = await dbGetEntries(activeProfile.id);
  entries.sort((a, b) => a.date.localeCompare(b.date));
  renderAll(entries, settings);
  toast(`Allocation recorded for ${dateStr} ✓`);
});

/* Re-export for inline onclick handlers generated by render.js's SIP
   ledger table (History page → Units tab → Action column). */
window.openAllocationForm = openAllocationForm;

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
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to save entries — guest mode is view-only.'); return; }
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
   Link a Fund — import NAV history, then auto-sync via mfapi.in
══════════════════════════════════════════════════════ */
function renderFundLinkStatus() {
  const statusEl = document.getElementById('fund-link-status');
  const syncBtn  = document.getElementById('btn-sync-fund');
  if (!statusEl) return;
  const lf = settings && settings.linkedFund;
  if (!lf) {
    statusEl.textContent = 'No fund linked yet — pick a NAV file and your SIP start date.';
    if (syncBtn) syncBtn.style.display = 'none';
    return;
  }
  statusEl.innerHTML = `Linked: <strong>${lf.schemeName || lf.schemeCode}</strong>` +
    (lf.fundHouse ? ` · ${lf.fundHouse}` : '') +
    (lf.lastSync ? ` · last synced ${lf.lastSync}` : '');
  if (syncBtn) syncBtn.style.display = '';
}

/* ══════════════════════════════════════════════════════
   Fund Performance History — long-range chart of the linked
   fund's own NAV life (can span decades), independent of SIP dates
══════════════════════════════════════════════════════ */
async function refreshFundHistorySection({ force = false } = {}) {
  const emptyEl   = document.getElementById('fund-hist-empty');
  const loadingEl = document.getElementById('fund-hist-loading');
  const bodyEl    = document.getElementById('fund-hist-body');
  const resetBtn  = document.getElementById('btn-reset-fund-history-zoom');
  if (!emptyEl || !loadingEl || !bodyEl) return;

  const lf = settings && settings.linkedFund;
  if (!lf || !lf.schemeCode) {
    setUnitsNavHistory(null);
    emptyEl.querySelector('span').textContent =
      'Link a fund on the Add page to see its full NAV track record — however far back it goes.';
    emptyEl.style.display = 'flex';
    loadingEl.style.display = 'none';
    bodyEl.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    document.getElementById('fund-projection-section').style.display = 'none';
    document.getElementById('goal-projection-section').style.display = 'none';
    return;
  }

  if (force || fundHistCache.schemeCode !== lf.schemeCode) {
    emptyEl.style.display = 'none';
    bodyEl.style.display = 'none';
    loadingEl.style.display = 'flex';
    if (resetBtn) resetBtn.style.display = 'none';
    try {
      const fresh = await fetchSchemeFromMfapi(lf.schemeCode);
      fundHistCache = { schemeCode: lf.schemeCode, data: buildFundGrowthSeries(fresh.navHistory) };
      setUnitsNavHistory(fundHistCache.data.series);
      renderAll(entries, settings);
    } catch (err) {
      console.error(err);
      loadingEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      emptyEl.querySelector('span').textContent = "Couldn't load this fund's full history right now — try again later.";
      document.getElementById('fund-projection-section').style.display = 'none';
      document.getElementById('goal-projection-section').style.display = 'none';
      return;
    }
  }

  const { series, years, totalGrowthPct, cagrPct } = fundHistCache.data;
  if (!series.length) {
    loadingEl.style.display = 'none';
    emptyEl.style.display = 'flex';
    document.getElementById('fund-projection-section').style.display = 'none';
    document.getElementById('goal-projection-section').style.display = 'none';
    return;
  }

  document.getElementById('fund-hist-name').textContent =
    (lf.schemeName || lf.schemeCode) + (lf.fundHouse ? ` · ${lf.fundHouse}` : '');
  document.getElementById('fh-years').textContent = years.toFixed(1) + ' yrs';
  document.getElementById('fh-since').textContent = new Date(series[0].date)
    .toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const totalEl = document.getElementById('fh-total');
  totalEl.textContent = (totalGrowthPct >= 0 ? '+' : '') + totalGrowthPct.toFixed(2) + '%';
  totalEl.className = 'stat-cell-value ' + (totalGrowthPct >= 0 ? 'green' : 'red');
  const cagrEl = document.getElementById('fh-cagr');
  cagrEl.textContent = (cagrPct >= 0 ? '+' : '') + cagrPct.toFixed(2) + '%';
  cagrEl.className = 'stat-cell-value ' + (cagrPct >= 0 ? 'green' : 'red');

  loadingEl.style.display = 'none';
  emptyEl.style.display = 'none';
  bodyEl.style.display = 'block';
  if (resetBtn) resetBtn.style.display = '';

  renderFundHistoryChart(series);
  renderFundProjectionSection(series);
  renderGoalProjectionSection(series);
}

function renderFundProjectionSection(series) {
  const sectionEl = document.getElementById('fund-projection-section');
  const legendEl  = document.getElementById('fund-proj-legend');
  const projection = buildFundProjection(series, fundProjYears);
  if (!sectionEl) return;

  if (!projection) { sectionEl.style.display = 'none'; return; }
  sectionEl.style.display = '';

  renderFundProjectionChart(projection);

  if (!legendEl) return;
  const row = (color, label, pct) => `
    <div class="fund-proj-leg-item">
      <span class="fund-proj-leg-dot" style="background:${color}"></span>
      <span class="fund-proj-leg-text">${label}<br><strong>${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%/yr</strong></span>
    </div>`;
  legendEl.innerHTML =
    row('#00c853', 'Optimistic · best year on record', projection.bestPct) +
    row('#f5a623', 'Expected · average year',          projection.avgPct) +
    row('#ff5252', 'Pessimistic · worst year on record', projection.worstPct);
}

document.getElementById('fund-proj-horizon')?.addEventListener('click', e => {
  const btn = e.target.closest('.range-pill');
  if (!btn) return;
  document.querySelectorAll('#fund-proj-horizon .range-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  fundProjYears = parseInt(btn.dataset.years, 10);
  if (fundHistCache.data) {
    renderFundProjectionSection(fundHistCache.data.series);
    renderGoalProjectionSection(fundHistCache.data.series);
  }
});

/* ══════════════════════════════════════════════════════
   Path to Target Corpus — SIP + fund's own historical returns,
   projected toward the goal amount set on the User page.
══════════════════════════════════════════════════════ */
function renderGoalProjectionSection(series) {
  const sectionEl = document.getElementById('goal-projection-section');
  if (!sectionEl) return;

  if (!settings || !settings.goalAmount || !series || !series.length) {
    sectionEl.style.display = 'none';
    return;
  }

  const yearlyReturns = buildFundYearlyReturns(series);
  const calc = recalcAll(entries, settings);
  if (!yearlyReturns.length || !calc.length) { sectionEl.style.display = 'none'; return; }

  const pcts    = yearlyReturns.map(y => y.returnPct);
  const avgPct  = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const bestPct = Math.max(...pcts);
  const worstPct = Math.min(...pcts);

  const last = calc[calc.length - 1];
  const monthlyContribution = currentSipAmount();
  const monthsAhead = fundProjYears * 12;

  const scenarios = projectGoalScenarios(
    last.portfolioValue, monthlyContribution,
    { avg: avgPct, best: bestPct, worst: worstPct },
    monthsAhead, last.date,
  );

  sectionEl.style.display = '';
  renderGoalProjectionChart(scenarios, settings.goalAmount);

  const legendEl = document.getElementById('goal-proj-legend');
  if (legendEl) {
    const row = (color, label, pct) => `
      <div class="fund-proj-leg-item">
        <span class="fund-proj-leg-dot" style="background:${color}"></span>
        <span class="fund-proj-leg-text">${label}<br><strong>${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%/yr</strong></span>
      </div>`;
    legendEl.innerHTML =
      row('#00c853', 'Optimistic · best year on record', bestPct) +
      row('#2f81f7', 'Expected · average year',           avgPct) +
      row('#ff5252', 'Pessimistic · worst year on record', worstPct);
  }

  const reachEl = document.getElementById('goal-proj-reach-text');
  if (reachEl) {
    const hit = scenarios.expected.find(p => p.value >= settings.goalAmount);
    if (hit) {
      const label = new Date(hit.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      reachEl.textContent = `At the expected rate, you'll reach ${fmtK(settings.goalAmount)} by ${label}.`;
      reachEl.className = 'goal-projection-text on-track';
    } else {
      reachEl.textContent = `Not projected to reach ${fmtK(settings.goalAmount)} within ${fundProjYears} years at the expected rate — try a longer horizon above.`;
      reachEl.className = 'goal-projection-text behind';
    }
  }
}

document.getElementById('btn-reset-fund-history-zoom')?.addEventListener('click', resetFundHistoryZoom);

const _btnGetFundData = document.getElementById('btn-get-fund-data');
if (_btnGetFundData) {
  _btnGetFundData.addEventListener('click', () => {
    window.open('https://microintel.github.io/invisible-house/', '_blank', 'noopener,noreferrer');
  });
}

document.getElementById('btn-import-fund').addEventListener('click', async () => {
  if (!activeProfile) { toast('No active SIP profile.'); return; }
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to import data — guest mode is view-only.'); return; }
  const fileInput = document.getElementById('fund-json-file');
  const startDate = document.getElementById('fund-sip-start').value;
  const file = fileInput.files && fileInput.files[0];
  if (!file)      { toast('Choose the fund NAV file.'); return; }
  if (!startDate) { toast('Enter the SIP start date.'); return; }

  const amt = currentSipAmount() || parseFloat(document.getElementById('sip-amount').value) || 0;
  if (!amt) { toast('Set the monthly SIP amount in SIP Settings first.'); return; }

  try {
    const json = await readFileAsJson(file);
    const fund = parseFundFile(json);
    if (!fund.schemeCode || !fund.navHistory.length) {
      toast("That file doesn't look like a fund NAV export."); return;
    }

    const built = buildEntriesFromNavHistory(fund.navHistory, startDate);
    if (!built.length) { toast('No NAV data on/after that start date.'); return; }

    if (entries.length && !confirm(
      `This replaces the ${entries.length} existing entries for this SIP with ${built.length} imported from ${fund.schemeName || fund.schemeCode}. Continue?`
    )) return;

    await dbClearEntries(activeProfile.id);
    for (const e of built) {
      await dbPutEntry(activeProfile.id, { date: e.date, percentChange: e.percentChange, portfolioValue: 0, investedAmount: 0 });
    }

    settings = {
      id: activeProfile.id,
      startDate,
      sipAmount: amt,
      sipSchedule: [{ fromDate: startDate, amount: amt }],
      skippedSipDates: settings ? (settings.skippedSipDates || []) : [],
      linkedFund: {
        schemeCode: fund.schemeCode,
        schemeName: fund.schemeName,
        fundHouse:  fund.fundHouse,
        lastSync:   built[built.length - 1].date,
      },
    };
    normalizeSettings(settings);
    await dbPutSettings(activeProfile.id, settings);

    entries = await dbGetEntries(activeProfile.id);
    entries.sort((a, b) => a.date.localeCompare(b.date));
    await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
    entries = await dbGetEntries(activeProfile.id);
    entries.sort((a, b) => a.date.localeCompare(b.date));

    applySettingsToUI();
    renderFundLinkStatus();
    renderAll(entries, settings);
    fundHistCache = { schemeCode: null, data: null };
    refreshFundHistorySection();
    fileInput.value = '';
    toast(`Linked ${fund.schemeName || fund.schemeCode} — ${built.length} entries imported ✓`);
  } catch (err) {
    console.error(err);
    toast("Could not read that file — check it's valid fund JSON.");
  }
});

async function syncLinkedFund({ silent = false } = {}) {
  if (!activeProfile || !settings || !settings.linkedFund || !entries.length) return;
  try {
    const fresh = await fetchSchemeFromMfapi(settings.linkedFund.schemeCode);
    setUnitsNavHistory(buildFundGrowthSeries(fresh.navHistory).series);
    const delta = buildSyncDelta(entries, fresh.navHistory);

    if (delta === null) {
      if (!silent) toast("Could not match your last entry to mfapi's history — sync it manually.");
      renderAll(entries, settings);
      return;
    }
    if (!delta.length) {
      if (!silent) toast('Already up to date ✓');
      renderAll(entries, settings);
      return;
    }

    for (const e of delta) {
      await dbPutEntry(activeProfile.id, { date: e.date, percentChange: e.percentChange, portfolioValue: 0, investedAmount: 0 });
    }
    entries = await dbGetEntries(activeProfile.id);
    entries.sort((a, b) => a.date.localeCompare(b.date));
    await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
    entries = await dbGetEntries(activeProfile.id);
    entries.sort((a, b) => a.date.localeCompare(b.date));

    settings.linkedFund.schemeName = fresh.schemeName || settings.linkedFund.schemeName;
    settings.linkedFund.fundHouse  = fresh.fundHouse  || settings.linkedFund.fundHouse;
    settings.linkedFund.lastSync   = entries[entries.length - 1].date;
    await dbPutSettings(activeProfile.id, settings);

    renderFundLinkStatus();
    renderAll(entries, settings);
    refreshFundHistorySection({ force: true });
    if (!silent) toast(`Synced ${delta.length} new day${delta.length > 1 ? 's' : ''} ✓`);
  } catch (err) {
    console.error(err);
    if (!silent) toast('Sync failed — check your connection.');
  }
}
document.getElementById('btn-sync-fund').addEventListener('click', () => syncLinkedFund());

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
  if (window.BRAuth && window.BRAuth.isGuestSync()) {
    toast('Sign in to save changes — guest mode is view-only.');
    document.getElementById('edit-modal').classList.remove('open');
    return;
  }
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
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to delete entries — guest mode is view-only.'); return; }
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

document.getElementById('btn-export-row').addEventListener('click', async () => {
  const owner = window.BRAuth ? await window.BRAuth.currentUser() : null;
  const a   = document.createElement('a');
  const payload = {
    exportedBy: owner ? { name: owner.name, email: owner.email } : null,
    exportedAt: new Date().toISOString(),
    profileName: activeProfile?.name,
    settings,
    entries,
  };
  a.href    = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.download = `sip-${(activeProfile?.name || 'data').replace(/\s+/g,'-')}-${todayStr()}.json`;
  a.click();
  toast('Exported ✓');
});

document.getElementById('btn-import-row').addEventListener('click', () => {
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to import data — guest mode is view-only.'); return; }
  document.getElementById('import-file').click();
});

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
      await migrateSipAllocationsIfNeeded();
      await saveCalcEntries(recalcAll(entries, settings), activeProfile.id);
      entries = await dbGetEntries(activeProfile.id);
      entries.sort((a, b) => a.date.localeCompare(b.date));
    }
    applySettingsToUI();
    renderAll(entries, settings);
    renderUserPage(entries, settings);
    renderScheduleList();
    renderSkipList();
    renderSipAllocationSection();
    toast('Imported ✓');
  } catch { toast('Import failed — invalid JSON.'); }
  e.target.value = '';
});

/* ══════════════════════════════════════════════════════
   Export / Import All SIPs (one-click, all profiles)
══════════════════════════════════════════════════════ */
document.getElementById('btn-export-all-row').addEventListener('click', async () => {
  try {
    const owner = window.BRAuth ? await window.BRAuth.currentUser() : null;
    const allProfiles = await dbGetAllProfiles();
    const bundle = [];
    for (const p of allProfiles) {
      const pSettings = await dbGetSettings(p.id);
      const pEntries  = await dbGetEntries(p.id);
      pEntries.sort((a, b) => a.date.localeCompare(b.date));
      bundle.push({ profileName: p.name, settings: pSettings || null, entries: pEntries });
    }
    const payload = {
      type: 'sip-all-export',
      exportedAt: todayStr(),
      exportedBy: owner ? { name: owner.name, email: owner.email } : null,
      profiles: bundle,
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = `sip-all-funds-${todayStr()}.json`;
    a.click();
    toast(`Exported ${bundle.length} SIP${bundle.length === 1 ? '' : 's'} ✓`);
  } catch {
    toast('Export failed.');
  }
});

document.getElementById('btn-import-all-row').addEventListener('click', () => {
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to import data — guest mode is view-only.'); return; }
  document.getElementById('import-all-file').click();
});

document.getElementById('import-all-file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.profiles) || !data.profiles.length) {
      toast('Import failed — no SIPs found in file.');
      e.target.value = '';
      return;
    }
    if (!confirm(`Import ${data.profiles.length} SIP${data.profiles.length === 1 ? '' : 's'} as new fund${data.profiles.length === 1 ? '' : 's'}? Existing funds won't be touched.`)) {
      e.target.value = '';
      return;
    }

    let lastNewId = null;
    for (const entry of data.profiles) {
      const name = (entry.profileName || 'Imported SIP').trim() || 'Imported SIP';
      const pid  = await dbPutProfile({ name });
      lastNewId  = pid;

      if (entry.settings) {
        const cleanSettings = normalizeSettings({ ...entry.settings, id: pid });
        await dbPutSettings(pid, cleanSettings);
      }
      if (Array.isArray(entry.entries)) {
        for (const en of entry.entries) {
          const { id, profileId, ...r } = en;
          await dbPutEntry(pid, r);
        }
      }
    }

    profiles = await dbGetAllProfiles();
    profiles.sort((a, b) => a.id - b.id);

    if (lastNewId) await switchProfile(lastNewId);
    renderManageSipsSection();
    toast(`Imported ${data.profiles.length} SIP${data.profiles.length === 1 ? '' : 's'} ✓`);
  } catch {
    toast('Import failed — invalid JSON.');
  }
  e.target.value = '';
});

document.getElementById('btn-reset-row').addEventListener('click', async () => {
  if (!confirm(`Reset ALL data for "${activeProfile?.name}"? This cannot be undone.`)) return;
  if (window.BRAuth && window.BRAuth.isGuestSync()) { toast('Sign in to reset data — guest mode is view-only.'); return; }
  await dbClearEntries(activeProfile.id);
  try { await dbDel('settings', activeProfile.id); } catch(_) {}
  settings = null; entries = [];
  document.getElementById('sip-amount').value             = '';
  document.getElementById('sip-start').value              = '';
  document.getElementById('settings-info').textContent    = '';
  document.getElementById('settings-info-header').textContent = '';
  document.getElementById('goal-amount').value             = '';
  document.getElementById('goal-date').value                = '';
  renderAll(entries, settings);
  renderUserPage(entries, settings);
  renderScheduleList();
  renderSkipList();
  renderSipAllocationSection();
  toast('All data cleared.');
});

/* ══════════════════════════════════════════════════════
   Add new SIP from Account page
══════════════════════════════════════════════════════ */
document.getElementById('btn-add-new-sip').addEventListener('click', () => {
  const name = document.getElementById('new-sip-name').value.trim();
  if (!name) { toast('Enter a name for the new SIP.'); return; }
  document.getElementById('new-sip-name').value = '';
  createProfile(name);
  renderManageSipsSection();
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

/* Daily history ↔ Units purchase history toggle */
document.querySelectorAll('#history-mode-toggle .range-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#history-mode-toggle .range-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    setHistoryViewMode(pill.dataset.mode);
  });
});

/* "Load 20 more" — only the daily table paginates; the units ledger
   always renders in full (same as it does in the PDF report). Search
   already runs against the complete data set before this slice happens,
   so it finds matches that haven't been loaded into view yet. */
document.getElementById('history-load-more-btn').addEventListener('click', () => {
  loadMoreHistory();
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
   Profit / Loss — Range Pills & Reset Zoom
══════════════════════════════════════════════════════ */
document.querySelectorAll('#range-pills-pnl .range-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#range-pills-pnl .range-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    applyRangeToPnl(pill.dataset.range);
  });
});

document.getElementById('btn-reset-pnl-zoom').addEventListener('click', () => {
  resetPnlZoom();
  document.querySelectorAll('#range-pills-pnl .range-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.range === 'all'));
});

/* ══════════════════════════════════════════════════════
   Growth / Loss Toggle (Monthly / Yearly)
══════════════════════════════════════════════════════ */
document.querySelectorAll('#growth-toggle .range-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#growth-toggle .range-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    setGrowthGranularity(pill.dataset.granularity);
    renderAll(entries, settings);
  });
});

/* ══════════════════════════════════════════════════════
   Monthly Trend — Year Range Selectors
══════════════════════════════════════════════════════ */
function onTrendYearChange() {
  const fromSel = document.getElementById('trend-year-from');
  const toSel   = document.getElementById('trend-year-to');
  let from = fromSel.value, to = toSel.value;
  if (from > to) { from = to; fromSel.value = from; } // keep range valid
  setMonthlyTrendYearRange(from, to);
  renderAll(entries, settings);
}
document.getElementById('trend-year-from')?.addEventListener('change', onTrendYearChange);
document.getElementById('trend-year-to')?.addEventListener('change', onTrendYearChange);

/* ══════════════════════════════════════════════════════
   Theme
   Theme is controlled externally via the shared 'br-theme'
   localStorage key ('dark' or 'white') — there is no in-app
   selector. We just apply whatever is currently set, and stay
   in sync if another BlackRoad app changes it while this tab
   is open.
══════════════════════════════════════════════════════ */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (document.getElementById('page-graph').classList.contains('active')) {
    renderAll(entries, settings);
  }
}
window.addEventListener('storage', (e) => {
  if (e.key === 'br-theme' && e.newValue) applyTheme(e.newValue);
});

/* ══════════════════════════════════════════════════════
   Boot
══════════════════════════════════════════════════════ */
(async () => {
  if (window.Chart && window.ChartZoom) Chart.register(ChartZoom);
  applyTheme(localStorage.getItem('br-theme') || 'dark');
  await openDB();

  // Load profiles and determine active one
  await loadProfiles();
  const savedId = parseInt(localStorage.getItem('sip-active-profile') || '0');
  const saved   = profiles.find(p => p.id === savedId);
  activeProfile = saved || profiles[0];

  await loadAll();
  if (settings) settings = normalizeSettings(settings);
  await migrateSipAllocationsIfNeeded();
  applySettingsToUI();
  document.getElementById('entry-date').value = todayStr();
  renderAll(entries, settings);
  initHelper();
  wireSelectionDrag();
  renderScheduleList();
  renderSkipList();
  renderSipAllocationSection();
  renderProfileSwitcher();
  renderFundLinkStatus();
  resetAccountDrilldown();
  syncLinkedFund({ silent: true });
})();

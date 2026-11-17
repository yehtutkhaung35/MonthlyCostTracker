'use strict';
/*
 * Monthly Cost Tracker — Phase 1
 * Offline-first: all data lives in this device's localStorage.
 * Every record carries id + updatedAt (+ deleted flag) so Phase 2 can sync with Google Sheets.
 */

const STORE_KEY = 'mct.v1';
const APP_VERSION = '0.3.3';

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const monthKeyOf = (y, m) => `${y}-${pad(m + 1)}`; // m is 0-based
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const sumAmt = (list) => list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
const parseAmt = (s) => Number(String(s).replace(/[^\d]/g, '').slice(0, 12)) || 0;
const currentYM = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; };
const colorVar = (c) => (c === 'accent' ? 'var(--accent)' : `var(--s${c})`);

/* ---------- data ---------- */
const PALETTES = ['blue', 'ember', 'forest', 'ocean', 'rose', 'lavender', 'mono'];
// Untouched example data gets the oldest possible timestamp, so real edits from any device always win a sync.
const EPOCH = '1970-01-01T00:00:00.000Z';

function defaultData() {
  const t = EPOCH;
  const types = [
    { id: 'daily', key: 'daily', emoji: '🍜', color: 1, rule: 'day', amount: 8000, days: [0, 1, 2, 3, 4, 5] },
    { id: 'saturday', key: 'saturday', emoji: '🎉', color: 2, rule: 'day', amount: 30000, days: [6] },
    { id: 'groceries', key: 'groceries', emoji: '🧺', color: 3, rule: 'month', amount: 80000, days: [] },
    { id: 'general', key: 'general', emoji: '🛍️', color: 4, rule: 'month', amount: 100000, days: [] },
    { id: 'social', key: 'social', emoji: '💝', color: 5, rule: 'month', amount: 60000, days: [] },
  ].map((x, i) => Object.assign({ name: '', archived: false, order: i, updatedAt: t }, x));
  return {
    version: 1,
    settings: { lang: 'en', theme: 'system', palette: 'blue', currency: 'Ks', monthlyTotal: 600000, totalUpdatedAt: '', example: true, updatedAt: t },
    types,
    entries: [],
    sync: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.entries) && Array.isArray(d.types)) {
        const hadTotalTs = !!(d.settings && d.settings.totalUpdatedAt !== undefined);
        d.settings = Object.assign(defaultData().settings, d.settings || {});
        // Data from before sync existed: treat a customised monthly total as a real edit.
        if (!hadTotalTs && !d.settings.example) d.settings.totalUpdatedAt = nowIso();
        if (!d.sync) d.sync = {};
        d.types.forEach((t) => { if (!Array.isArray(t.days)) t.days = []; });
        return d;
      }
    }
  } catch (e) { /* fall through to defaults */ }
  return defaultData();
}

let data = load();
const ui = { tab: 'home', ym: currentYM(), filter: 'all', sheetOpen: false, histMode: 'day', day: todayStr() };
let persistAsked = false;

/** Save to this device. Unless the save comes from sync itself, also queue a sync to Google. */
function save(opts) {
  const fromSync = !!(opts && opts.fromSync);
  if (!fromSync) Sync.markDirty();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch (e) {
    toast(T('err.save'));
  }
  if (!persistAsked && navigator.storage && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  if (!fromSync) { Sync.updatePill(); Sync.schedule(); }
}

/* ---------- i18n & formatting ---------- */
function T(key, vars) {
  const lang = data.settings.lang;
  let s = (I18N[lang] && I18N[lang][key]) != null ? I18N[lang][key] : (I18N.en[key] != null ? I18N.en[key] : key);
  if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  return s;
}
const isMy = () => data.settings.lang === 'my';
const num = (n) => Math.round(Math.abs(n)).toLocaleString('en-US');
function money(n, opts) {
  const v = Math.round(n);
  const sign = v < 0 ? '−' : (opts && opts.sign && v > 0 ? '+' : '');
  return `${sign}${num(v)} ${data.settings.currency}`;
}
// Browsers often lack Burmese date names, so Myanmar labels are built from i18n.js.
function monthLabel(y, m) {
  if (isMy()) return `${T('months')[m]} ${y}`;
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(y, m, 1));
}
function dateLabel(s) {
  const d = parseYmd(s);
  if (isMy()) return `${T('wd.short')[d.getDay()]} · ${d.getDate()} ${T('months')[d.getMonth()]}`;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/* ---------- budget-type logic ---------- */
const activeTypes = () => data.types.filter((t) => !t.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
const typeById = (id) => data.types.find((t) => t.id === id);
const typeName = (t) => (!t ? T('type.unknown') : t.name || (t.key ? T('type.' + t.key) : T('type.untitled')));
const liveEntries = () => data.entries.filter((e) => !e.deleted);
const monthEntries = (y, m) => { const k = monthKeyOf(y, m); return liveEntries().filter((e) => !e.noSpend && e.date.startsWith(k)); };

function activeDaysCount(t, y, m) {
  if (t.rule !== 'day') return 0;
  let c = 0;
  const n = daysInMonth(y, m);
  for (let d = 1; d <= n; d++) if (t.days.includes(new Date(y, m, d).getDay())) c++;
  return c;
}
function typeBudget(t, y, m) {
  if (t.archived) return 0;
  return t.rule === 'day' ? t.amount * activeDaysCount(t, y, m) : t.amount;
}
function defaultTypeFor(dateStr) {
  const wd = parseYmd(dateStr).getDay();
  const types = activeTypes();
  return types.find((t) => t.rule === 'day' && t.days.includes(wd)) || types[0];
}

/**
 * Per-type numbers for a month.
 * saved = budget for the finished days of the month (1st → yesterday) − what was spent on those days.
 *   Per-day types: allowance of each finished active day (e.g. Sun–Fri for Daily Cost).
 *   Monthly types: the monthly amount spread evenly over the month's days.
 * Per-day types also get today's figures and how many of their days are left.
 */
function typeStats(t, y, m, list) {
  const mine = list.filter((e) => e.typeId === t.id);
  const spent = sumAmt(mine);
  const budget = typeBudget(t, y, m);
  const res = { t, spent, budget, left: budget - spent };
  const today = todayStr();
  const k = monthKeyOf(y, m);
  const n = daysInMonth(y, m);
  const spentBefore = sumAmt(mine.filter((e) => e.date < today));
  if (t.rule !== 'day') {
    let doneDays = 0;
    for (let d = 1; d <= n; d++) if (`${k}-${pad(d)}` < today) doneDays++;
    res.saved = (t.archived ? 0 : Math.round((t.amount * doneDays) / n)) - spentBefore;
  } else {
    let allowance = 0;
    let daysLeft = 0;
    for (let d = 1; d <= n; d++) {
      const ds = `${k}-${pad(d)}`;
      const active = !t.archived && t.days.includes(new Date(y, m, d).getDay());
      if (!active) continue;
      if (ds >= today) daysLeft++;
      else allowance += t.amount;
    }
    res.saved = allowance - spentBefore;
    res.daysLeft = daysLeft; // includes today if today is one of this type's days
    if (today.startsWith(k)) {
      res.isToday = !t.archived && t.days.includes(new Date().getDay());
      res.todaySpent = sumAmt(mine.filter((e) => e.date === today));
      res.todayLeft = (res.isToday ? t.amount : 0) - res.todaySpent;
    }
  }
  return res;
}
function typesForMonth(y, m, list) {
  return data.types
    .filter((t) => !t.archived || list.some((e) => e.typeId === t.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((t) => typeStats(t, y, m, list));
}
function ruleSummary(t) {
  if (t.rule !== 'day') return T('ruleSum.month', { amt: money(t.amount) });
  const wd = T('wd.short');
  const days = t.days.length === 7 ? T('everyDay') : [...t.days].sort().map((d) => wd[d]).join(', ');
  return T('ruleSum.day', { amt: money(t.amount), days });
}
function nextColor() {
  const used = activeTypes().map((t) => t.color);
  for (let c = 1; c <= 8; c++) if (!used.includes(c)) return c;
  return 1;
}

/* ---------- habit / streak ---------- */
const loggedSet = () => new Set(liveEntries().map((e) => e.date));
function streak() {
  const s = loggedSet();
  let d = todayStr();
  if (!s.has(d)) d = addDays(d, -1);
  let n = 0;
  while (s.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------- small view pieces ---------- */
function bar(v, max, color) {
  const over = v > 0 && v > max;
  const pct = max > 0 ? Math.min(100, (v / max) * 100) : (v > 0 ? 100 : 0);
  return `<div class="bar${over ? ' over' : ''}" role="img" aria-label="${num(v)} / ${num(max)}"><span style="width:${pct.toFixed(1)}%;${over ? '' : `background:${colorVar(color)}`}"></span></div>`;
}
function leftLine(left) {
  return left >= 0
    ? `<span>${T('leftAmt', { amt: money(left) })}</span>`
    : `<span class="neg">⚠ ${T('overAmt', { amt: money(-left) })}</span>`;
}
function savedBadge(v) {
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
  return `<span class="saved ${cls}" title="${esc(T('savedHint'))}">(${money(v, { sign: true })})</span>`;
}
function entryRow(e) {
  if (e.noSpend) {
    return `<button class="erow" data-act="remove-nospend" data-id="${e.id}">
      <span class="eicon" style="--c:var(--good)">✓</span>
      <span class="emain"><span class="eitem">${T('noSpendRow')}</span></span><span class="eamt muted">0</span></button>`;
  }
  const t = typeById(e.typeId);
  const c = t ? colorVar(t.color) : 'var(--muted)';
  const sub = esc(typeName(t)) + (e.note ? ' · ' + esc(e.note) : '');
  return `<button class="erow" data-act="edit-entry" data-id="${e.id}">
    <span class="eicon" style="--c:${c}">${t ? t.emoji : '•'}</span>
    <span class="emain"><span class="eitem">${esc(e.item || typeName(t))}</span><span class="esub">${sub}</span></span>
    <span class="eamt">${num(e.amount)}</span></button>`;
}
function monthNav() {
  return `<div class="month-nav">
    <button class="icon-btn" data-act="month-prev" aria-label="Previous month">‹</button>
    <button class="month-label" data-act="month-today">${monthLabel(ui.ym.y, ui.ym.m)}</button>
    <button class="icon-btn" data-act="month-next" aria-label="Next month">›</button></div>`;
}

/* ---------- views ---------- */
function viewHome() {
  const { y, m } = currentYM();
  const today = todayStr();
  const list = monthEntries(y, m);
  const spent = sumAmt(list);
  const total = data.settings.monthlyTotal;
  const daysLeft = daysInMonth(y, m) - new Date().getDate() + 1;
  const stats = typesForMonth(y, m, list);
  let h = '';

  if (data.settings.example) {
    h += `<div class="banner"><p>${T('example.text')}</p><div class="banner-actions">
      <button class="btn small primary" data-act="go-settings">${T('example.edit')}</button>
      <button class="btn small ghost" data-act="dismiss-example">${T('example.dismiss')}</button></div></div>`;
  }

  h += `<section class="card hero">
    <div class="row-between muted"><span>${monthLabel(y, m)}</span><span>${T('daysLeft', { n: daysLeft })}</span></div>
    <div class="hero-num">${money(spent)}</div>
    <div class="muted">${T('ofBudget', { amt: money(total) })}</div>
    ${bar(spent, total, 'accent')}
    <div class="row-between"><span class="muted">${T('left')}</span><strong class="${total - spent < 0 ? 'neg' : ''}">${money(total - spent)}</strong></div>
  </section>`;

  // Today: whichever per-day type applies today (Daily Cost, or Saturday on Saturdays)
  const todayTypes = stats.filter((s) => s.t.rule === 'day' && s.isToday);
  const todayAll = liveEntries().filter((e) => e.date === today);
  const hasSpend = todayAll.some((e) => !e.noSpend);
  const markedNoSpend = todayAll.some((e) => e.noSpend);
  h += `<section class="card"><h2 class="sec">${T('today')} · ${dateLabel(today)}</h2>`;
  if (!todayTypes.length) h += `<p class="muted">${T('noDayBudget')}</p>`;
  todayTypes.forEach((s) => {
    h += `<div class="today-type">
      <div class="row-between"><span class="tname">${s.t.emoji} ${esc(typeName(s.t))} ${savedBadge(s.saved)}</span></div>
      <div class="today-num"><strong>${money(s.todaySpent)}</strong> <span class="muted">/ ${money(s.t.amount)}</span></div>
      ${bar(s.todaySpent, s.t.amount, s.t.color)}
      <div class="small">${s.todayLeft >= 0 ? T('leftToday', { amt: money(s.todayLeft) }) : `<span class="neg">⚠ ${T('overToday', { amt: money(-s.todayLeft) })}</span>`}</div>
      <div class="small muted">${T('typeDaysLeft', { n: s.daysLeft, name: esc(typeName(s.t)), amt: money(s.daysLeft * s.t.amount) })}</div>
    </div>`;
  });
  if (!hasSpend && !markedNoSpend) h += `<button class="btn ghost full" data-act="nospend">${T('noSpend')}</button>`;
  else if (markedNoSpend && !hasSpend) h += `<p class="good small">${T('noSpendDone')}</p>`;
  h += `</section>`;

  // Budget type cards
  h += `<h2 class="sec out">${T('types')}</h2><div class="tgrid">`;
  stats.filter((s) => !s.t.archived).forEach((s) => {
    h += `<button class="card tcard" data-act="type-history" data-id="${s.t.id}">
      <div class="tname">${s.t.emoji} ${esc(typeName(s.t))} ${savedBadge(s.saved)}</div>
      <div class="tnum"><strong>${num(s.spent)}</strong> <span class="muted">/ ${num(s.budget)}</span></div>
      ${bar(s.spent, s.budget, s.t.color)}
      <div class="small">${leftLine(s.left)}</div>
    </button>`;
  });
  h += `</div>`;

  h += `<section class="card"><h2 class="sec">${T('habit')}</h2>${calendar(y, m)}</section>`;

  const todays = todayAll.filter((e) => !e.noSpend).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  h += `<section class="card"><h2 class="sec">${T('todayEntries')}</h2>`;
  h += todays.length ? `<div class="elist">${todays.map(entryRow).join('')}</div>` : `<p class="muted">${T('empty.today')}</p>`;
  h += `</section>`;
  return h;
}

function calendar(y, m) {
  const n = daysInMonth(y, m);
  const first = new Date(y, m, 1).getDay();
  const today = todayStr();
  const logged = loggedSet();
  const k = monthKeyOf(y, m);
  const dayTypes = data.types.filter((t) => t.rule === 'day' && !t.archived);
  const spentBy = {};
  monthEntries(y, m).forEach((e) => { const key = e.date + '|' + e.typeId; spentBy[key] = (spentBy[key] || 0) + e.amount; });
  let cells = T('wd.mini').map((w) => `<span class="cal-wd">${w}</span>`).join('');
  for (let i = 0; i < first; i++) cells += '<span></span>';
  for (let d = 1; d <= n; d++) {
    const ds = `${k}-${pad(d)}`;
    const wd = new Date(y, m, d).getDay();
    const over = dayTypes.some((t) => (spentBy[ds + '|' + t.id] || 0) > (t.days.includes(wd) ? t.amount : 0));
    const cls = ['cal-day', logged.has(ds) ? 'on' : '', ds === today ? 'today' : '', ds > today ? 'future' : ''].join(' ');
    cells += `<span class="${cls}">${d}${over ? '<i class="cal-over"></i>' : ''}</span>`;
  }
  return `<div class="cal">${cells}</div>
    <div class="legend"><span><i class="lg on"></i>${T('legendLogged')}</span><span><i class="lg over"></i>${T('legendOver')}</span></div>`;
}

function viewHistory() {
  const modes = `<div class="seg">${[['day', T('hist.day')], ['month', T('hist.month')]].map(([v, label]) =>
    `<button data-act="hist-mode" data-v="${v}" class="${ui.histMode === v ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  return modes + (ui.histMode === 'day' ? viewHistoryDay() : viewHistoryMonth());
}

/** One day: pick a date, see that day's budget and everything entered for it. */
function viewHistoryDay() {
  const ds = ui.day;
  const today = todayStr();
  const d = parseYmd(ds);
  const items = liveEntries().filter((e) => e.date === ds).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const spent = sumAmt(items.filter((e) => !e.noSpend));

  let h = `<div class="month-nav">
    <button class="icon-btn" data-act="day-prev" aria-label="Previous day">‹</button>
    <button class="month-label day-label" data-act="day-pick">📅 ${dateLabel(ds)}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}</button>
    <button class="icon-btn" data-act="day-next" aria-label="Next day">›</button>
    <input type="date" id="dayInput" class="hidden-date" value="${ds}" tabindex="-1" aria-hidden="true">
  </div>`;
  if (ds !== today) h += `<div class="center"><button class="chip" data-act="day-today">${T('hist.today')}</button></div>`;

  // Per-day budgets that apply on this date (Daily Cost, or Saturday on Saturdays)
  const dayTypes = activeTypes().filter((t) => t.rule === 'day' && t.days.includes(d.getDay()));
  h += `<section class="card"><div class="row-between"><span class="muted">${T('hist.dayTotal')}</span><strong class="hero-day">${money(spent)}</strong></div>`;
  dayTypes.forEach((t) => {
    const s = sumAmt(items.filter((e) => e.typeId === t.id));
    h += `<div class="trow">
      <div class="row-between"><span class="tname">${t.emoji} ${esc(typeName(t))}</span><span class="tabnum"><strong>${num(s)}</strong> <span class="muted">/ ${num(t.amount)}</span></span></div>
      ${bar(s, t.amount, t.color)}
      <div class="small">${leftLine(t.amount - s)}</div></div>`;
  });
  h += `</section>`;

  h += `<section class="card">`;
  if (items.length) h += `<div class="elist">${items.map(entryRow).join('')}</div>`;
  else h += `<p class="muted center">${T('hist.emptyDay')}</p>`;
  h += `<button class="btn ghost full" data-act="add">+ ${T('hist.addForDay')}</button></section>`;
  return h;
}

function viewHistoryMonth() {
  const { y, m } = ui.ym;
  const k = monthKeyOf(y, m);
  const monthAll = liveEntries().filter((e) => e.date.startsWith(k));
  let list = monthAll;
  if (ui.filter !== 'all') list = list.filter((e) => e.typeId === ui.filter);
  const types = data.types
    .filter((t) => !t.archived || monthAll.some((e) => e.typeId === t.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const chips = [`<button class="chip${ui.filter === 'all' ? ' on' : ''}" data-act="filter" data-v="all">${T('all')}</button>`]
    .concat(types.map((t) => `<button class="chip${ui.filter === t.id ? ' on' : ''}" data-act="filter" data-v="${t.id}" style="--c:${colorVar(t.color)}">${t.emoji} ${esc(typeName(t))}</button>`))
    .join('');
  const total = sumAmt(list.filter((e) => !e.noSpend));

  let h = monthNav() + `<div class="chips scroll">${chips}</div>`;
  h += `<div class="row-between hist-total"><span class="muted">${T('spent')}</span><strong>${money(total)}</strong></div>`;
  if (!list.length) return h + `<p class="muted center pad">${T('empty.month')}</p>`;

  const groups = new Map();
  list.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))
    .forEach((e) => { if (!groups.has(e.date)) groups.set(e.date, []); groups.get(e.date).push(e); });
  groups.forEach((items, date) => {
    h += `<section class="card day-group">
      <button class="row-between day-head" data-act="open-day" data-v="${date}"><span>${dateLabel(date)} ›</span><span class="muted">${money(sumAmt(items.filter((e) => !e.noSpend)))}</span></button>
      <div class="elist">${items.map(entryRow).join('')}</div></section>`;
  });
  return h;
}

function elapsedDays(y, m) {
  const c = currentYM();
  if (y < c.y || (y === c.y && m < c.m)) return daysInMonth(y, m);
  if (y === c.y && m === c.m) return new Date().getDate();
  return 0;
}

function viewStats() {
  const { y, m } = ui.ym;
  const list = monthEntries(y, m);
  const spent = sumAmt(list);
  const total = data.settings.monthlyTotal;
  const elapsed = elapsedDays(y, m);
  const avg = elapsed ? spent / elapsed : 0;
  const stats = typesForMonth(y, m, list);

  let h = monthNav();
  h += `<div class="tiles">
    <div class="card tile"><span class="muted small">${T('spent')}</span><strong>${money(spent)}</strong></div>
    <div class="card tile"><span class="muted small">${T('budget')}</span><strong>${money(total)}</strong></div>
    <div class="card tile"><span class="muted small">${T('left')}</span><strong class="${total - spent < 0 ? 'neg' : ''}">${money(total - spent)}</strong></div>
    <div class="card tile"><span class="muted small">${T('avgDay')}</span><strong>${money(avg)}</strong></div>
  </div>`;

  h += `<section class="card"><h2 class="sec">${T('byType')}</h2>`;
  stats.forEach((s) => {
    const p = s.budget > 0 ? Math.round((s.spent / s.budget) * 100) : 0;
    h += `<div class="trow">
      <div class="row-between"><span class="tname">${s.t.emoji} ${esc(typeName(s.t))}</span><span class="tabnum"><strong>${num(s.spent)}</strong> <span class="muted">/ ${num(s.budget)}</span></span></div>
      ${bar(s.spent, s.budget, s.t.color)}
      <div class="row-between small"><span class="muted">${T('usedPct', { p })}</span>${leftLine(s.left)}</div>
    </div>`;
  });
  h += `</section>`;

  h += `<section class="card"><h2 class="sec">${T('daily')}</h2>${dailyChart(y, m, list)}</section>`;

  const byItem = new Map();
  list.forEach((e) => {
    const name = (e.item || typeName(typeById(e.typeId))).trim();
    const key = name.toLowerCase();
    const cur = byItem.get(key) || { name, amount: 0, count: 0, typeId: e.typeId };
    cur.amount += e.amount; cur.count++;
    byItem.set(key, cur);
  });
  const top = [...byItem.values()].sort((a, b) => b.amount - a.amount).slice(0, 5);
  if (top.length) {
    h += `<section class="card"><h2 class="sec">${T('topItems')}</h2><div class="elist">`;
    top.forEach((it) => {
      const t = typeById(it.typeId);
      h += `<div class="erow static"><span class="eicon" style="--c:${t ? colorVar(t.color) : 'var(--muted)'}">${t ? t.emoji : '•'}</span>
        <span class="emain"><span class="eitem">${esc(it.name)}</span><span class="esub">× ${it.count}</span></span>
        <span class="eamt">${num(it.amount)}</span></div>`;
    });
    h += `</div></section>`;
  }
  return h;
}

function dailyChart(y, m, list) {
  const n = daysInMonth(y, m);
  const tot = new Array(n).fill(0);
  list.forEach((e) => { tot[Number(e.date.slice(8)) - 1] += e.amount; });
  const max = Math.max(...tot);
  if (max <= 0) return `<p class="muted">${T('empty.month')}</p>`;
  const today = todayStr();
  const k = monthKeyOf(y, m);
  const cols = tot.map((v, i) => {
    const ds = `${k}-${pad(i + 1)}`;
    const tip = `${dateLabel(ds)} · ${money(v)}`;
    const hgt = v > 0 ? Math.max(2, (v / max) * 100) : 0;
    return `<button class="col${ds === today ? ' is-today' : ''}" data-act="col-tip" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><span style="height:${hgt.toFixed(1)}%"></span></button>`;
  }).join('');
  const ticks = [1, 8, 15, 22, 29].filter((d) => d <= n)
    .map((d) => `<span style="left:${(((d - 0.5) / n) * 100).toFixed(2)}%">${d}</span>`).join('');
  return `<div class="chart">
    <div class="row-between small"><span class="chart-tip" id="chartTip">${T('tapBar')}</span><span class="muted">${T('max', { amt: money(max) })}</span></div>
    <div class="cols">${cols}</div><div class="ticks">${ticks}</div></div>`;
}

function viewSettings() {
  const s = data.settings;
  const { y, m } = currentYM();
  const types = activeTypes();
  const allocated = types.reduce((a, t) => a + typeBudget(t, y, m), 0);
  const diff = s.monthlyTotal - allocated;
  const seg = (act, cur, opts) => `<div class="seg">${opts.map(([v, label]) =>
    `<button data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${label}</button>`).join('')}</div>`;

  return `
  <section class="card">
    <h2 class="sec">${T('lang')}</h2>
    ${seg('set-lang', s.lang, [['en', 'English'], ['my', 'မြန်မာ']])}
    <h2 class="sec">${T('theme')}</h2>
    ${seg('set-theme', s.theme, [['system', T('theme.system')], ['light', T('theme.light')], ['dark', T('theme.dark')]])}
    <h2 class="sec">${T('palette')}</h2>
    <div class="palettes">${PALETTES.map((p) => `<button class="pal${s.palette === p ? ' on' : ''}" data-act="set-palette" data-v="${p}" data-palette="${p}" aria-pressed="${s.palette === p}">
      <span class="pal-prev"><i></i><b>Ks</b></span><span class="pal-name">${T('pal.' + p)}</span></button>`).join('')}</div>
  </section>

  <section class="card">
    <h2 class="sec">${T('budget')}</h2>
    <label class="field"><span>${T('monthlyTotal')}</span>
      <div class="money-input"><input id="totalInput" inputmode="numeric" data-money value="${num(s.monthlyTotal)}"><span>${s.currency}</span></div></label>
    <div class="alloc">
      <div class="row-between"><span class="muted">${T('allocated')}</span><span class="tabnum">${money(allocated)}</span></div>
      <div class="row-between"><span class="muted">${diff >= 0 ? T('unallocated') : '⚠ ' + T('overAllocated')}</span><strong class="tabnum ${diff < 0 ? 'neg' : 'pos'}">${money(Math.abs(diff))}</strong></div>
    </div>
    <div class="elist">${types.map((t) => `<button class="erow" data-act="edit-type" data-id="${t.id}">
      <span class="eicon" style="--c:${colorVar(t.color)}">${t.emoji}</span>
      <span class="emain"><span class="eitem">${esc(typeName(t))}</span><span class="esub">${ruleSummary(t)}</span></span>
      <span class="eamt">${num(typeBudget(t, y, m))}</span></button>`).join('')}</div>
    <button class="btn ghost full" data-act="add-type">+ ${T('addType')}</button>
  </section>

  ${Sync.settingsCard()}

  <section class="card">
    <h2 class="sec">${T('data')}</h2>
    <p class="muted small">${T('storageNote')}</p>
    <div class="stack">
      <button class="btn ghost full" data-act="export-json">${T('exportJson')}</button>
      <button class="btn ghost full" data-act="import-json">${T('importJson')}</button>
      <button class="btn ghost full" data-act="export-csv">${T('exportCsv')}</button>
      <button class="btn danger full" data-act="reset">${T('reset')}</button>
    </div>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
  </section>

  <section class="card">
    <h2 class="sec">${T('install')}</h2>
    <p class="muted">${T('installSteps')}</p>
  </section>
  <p class="muted center small pad">Monthly Cost Tracker · ${T('version')} ${APP_VERSION}</p>`;
}

/* ---------- render ---------- */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  history: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  stats: '<path d="M3 21h18"/><path d="M6 17v-6M11 17V5M16 17v-9M21 17v-3"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};

function applyTheme() {
  const root = document.documentElement;
  const th = data.settings.theme;
  if (th === 'light' || th === 'dark') root.dataset.theme = th;
  else delete root.dataset.theme;
  root.dataset.palette = PALETTES.includes(data.settings.palette) ? data.settings.palette : 'blue';
  // Match the phone's status bar to the page color.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--page').trim() || '#f9f9f7';
}
// Follow the phone switching light/dark while the app is open.
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', applyTheme);
}

function render() {
  document.documentElement.lang = data.settings.lang === 'my' ? 'my' : 'en';
  $('#title').textContent = T('tab.' + ui.tab);
  Sync.updatePill();
  $('#streak').innerHTML = `<button class="streak" data-act="streak" aria-label="${esc(T('streakTip', { n: streak() }))}">🔥 ${streak()}</button>`;
  $('#tabs').innerHTML = ['home', 'history', 'stats', 'settings'].map((k) =>
    `<button data-act="tab" data-v="${k}" class="${ui.tab === k ? 'on' : ''}"${ui.tab === k ? ' aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg><span>${T('tab.' + k)}</span></button>`).join('');
  const views = { home: viewHome, history: viewHistory, stats: viewStats, settings: viewSettings };
  $('#view').innerHTML = views[ui.tab]();
  $('#view').querySelectorAll('input[data-money]').forEach(bindAmount);
  $('#fab').hidden = ui.tab === 'settings';
}

/* ---------- inputs ---------- */
function bindAmount(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '').slice(0, 12);
    input.value = digits ? Number(digits).toLocaleString('en-US') : '';
  });
}

/* ---------- sheet (bottom panel) ---------- */
function openSheet(html, onMount) {
  const wrap = $('#sheetWrap');
  $('#sheet').innerHTML = html;
  wrap.hidden = false;
  requestAnimationFrame(() => wrap.classList.add('open'));
  if (!ui.sheetOpen) { history.pushState({ sheet: true }, ''); ui.sheetOpen = true; }
  if (onMount) onMount($('#sheet'));
}
function closeSheet(fromPop) {
  if (!ui.sheetOpen) return;
  ui.sheetOpen = false;
  const wrap = $('#sheetWrap');
  wrap.classList.remove('open');
  setTimeout(() => { if (!ui.sheetOpen) { wrap.hidden = true; $('#sheet').innerHTML = ''; } }, 220);
  if (!fromPop) history.back();
}
window.addEventListener('popstate', () => { if (ui.sheetOpen) closeSheet(true); });

function sheetHead(title) {
  return `<div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="${esc(T('close'))}">✕</button></div>`;
}

function recentItems(typeId) {
  const seen = new Map();
  liveEntries().filter((e) => e.typeId === typeId && e.item)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .forEach((e) => { const k = e.item.trim().toLowerCase(); if (!seen.has(k)) seen.set(k, e); });
  return [...seen.values()].slice(0, 6);
}

function typeInfo(typeId, date, excludeId) {
  const t = typeById(typeId);
  if (!t) return '';
  const others = liveEntries().filter((e) => e.typeId === typeId && e.id !== excludeId && !e.noSpend);
  if (t.rule === 'day') {
    const allow = t.days.includes(parseYmd(date).getDay()) ? t.amount : 0;
    const spentDay = sumAmt(others.filter((e) => e.date === date));
    return T('info.day', { left: money(allow - spentDay), budget: money(allow) });
  }
  const mk = date.slice(0, 7);
  return T('info.month', { left: money(t.amount - sumAmt(others.filter((e) => e.date.startsWith(mk)))) });
}

function openEntrySheet(id, presetDate) {
  const src = id ? data.entries.find((e) => e.id === id) : null;
  const types = activeTypes();
  if (!types.length) { ui.tab = 'settings'; render(); return; }
  const startDate = src ? src.date : (presetDate || todayStr());
  const st = { typeId: src ? src.typeId : defaultTypeFor(startDate).id, date: startDate, touched: !!src };
  const chipTypes = types.slice();
  if (src && !types.some((t) => t.id === src.typeId) && typeById(src.typeId)) chipTypes.push(typeById(src.typeId));

  const html = sheetHead(src ? T('edit') : T('add')) + `
  <form id="entryForm" class="form" autocomplete="off">
    <div class="amount-field"><input id="fAmount" inputmode="numeric" placeholder="0" value="${src ? num(src.amount) : ''}" aria-label="${esc(T('amount'))}"><span>${esc(data.settings.currency)}</span></div>
    <div class="field"><span>${T('budgetType')}</span>
      <div class="chips">${chipTypes.map((t) => `<button type="button" class="chip big" data-type="${t.id}" style="--c:${colorVar(t.color)}">${t.emoji} ${esc(typeName(t))}</button>`).join('')}</div>
      <p class="hint" id="fInfo"></p></div>
    <label class="field"><span>${T('item')}</span><input id="fItem" value="${esc(src ? src.item : '')}" placeholder="${esc(T('itemPh'))}" maxlength="60"></label>
    <div class="chips small-chips" id="fRecent"></div>
    <div class="row2">
      <label class="field"><span>${T('date')}</span><input type="date" id="fDate" value="${st.date}"></label>
      <label class="field grow"><span>${T('note')}</span><input id="fNote" value="${esc(src ? src.note : '')}" placeholder="${esc(T('notePh'))}" maxlength="120"></label>
    </div>
    <div class="sheet-actions">
      ${src ? `<button type="button" class="btn danger" id="fDelete">${T('delete')}</button>` : ''}
      <button type="submit" class="btn primary grow">${T('save')}</button>
    </div>
  </form>`;

  openSheet(html, (root) => {
    const amt = $('#fAmount', root);
    const item = $('#fItem', root);
    bindAmount(amt);
    const refresh = () => {
      root.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === st.typeId));
      $('#fInfo', root).textContent = typeInfo(st.typeId, st.date, src && src.id);
      $('#fRecent', root).innerHTML = recentItems(st.typeId).map((e) =>
        `<button type="button" class="chip" data-item="${esc(e.item)}" data-amt="${e.amount}">${esc(e.item)} · ${num(e.amount)}</button>`).join('');
    };
    root.addEventListener('click', (ev) => {
      const tb = ev.target.closest('[data-type]');
      if (tb) { st.typeId = tb.dataset.type; st.touched = true; refresh(); return; }
      const ri = ev.target.closest('[data-item]');
      if (ri) { item.value = ri.dataset.item; amt.value = num(Number(ri.dataset.amt)); }
    });
    $('#fDate', root).addEventListener('change', (ev) => {
      st.date = ev.target.value || todayStr();
      if (!st.touched) st.typeId = defaultTypeFor(st.date).id;
      refresh();
    });
    if (src) {
      $('#fDelete', root).addEventListener('click', () => {
        if (!confirm(T('deleteConfirm'))) return;
        src.deleted = true; src.updatedAt = nowIso();
        save(); closeSheet(); render(); toast(T('deleted'));
      });
    }
    $('#entryForm', root).addEventListener('submit', (ev) => {
      ev.preventDefault();
      const amount = parseAmt(amt.value);
      if (amount <= 0) { toast(T('err.amount')); amt.focus(); return; }
      const t = nowIso();
      const rec = src || { id: uid(), createdAt: t, deleted: false };
      Object.assign(rec, { date: st.date, amount, typeId: st.typeId, item: item.value.trim(), note: $('#fNote', root).value.trim(), noSpend: false, updatedAt: t });
      if (!src) data.entries.push(rec);
      // A real expense on a day replaces any "no spending" mark for that day.
      data.entries.forEach((e) => { if (e.noSpend && !e.deleted && e.date === rec.date) { e.deleted = true; e.updatedAt = t; } });
      save(); closeSheet(); render(); toast(T('savedToast'));
    });
    refresh();
    if (!src) setTimeout(() => amt.focus(), 250);
  });
}

function openTypeSheet(id) {
  const src = id ? typeById(id) : null;
  const d = src ? JSON.parse(JSON.stringify(src)) : {
    id: uid(), key: null, name: '', emoji: '💰', color: nextColor(), rule: 'month', amount: 0,
    days: [0, 1, 2, 3, 4, 5, 6], archived: false, order: Math.max(0, ...data.types.map((t) => t.order || 0)) + 1,
  };
  const { y, m } = currentYM();
  const cur = esc(data.settings.currency);
  const colors = [1, 2, 3, 4, 5, 6, 7, 8];

  const html = sheetHead(src ? T('editType') : T('newType')) + `
  <form id="typeForm" class="form" autocomplete="off">
    <div class="row2">
      <label class="field emoji-field"><span>${T('emoji')}</span><input id="tEmoji" value="${esc(d.emoji)}" maxlength="8"></label>
      <label class="field grow"><span>${T('name')}</span><input id="tName" value="${esc(d.name)}" placeholder="${esc(d.key ? T('type.' + d.key) : '')}" maxlength="40"></label>
    </div>
    <div class="field"><span>${T('color')}</span>
      <div class="swatches">${colors.map((c) => `<button type="button" class="sw" data-c="${c}" style="background:var(--s${c})" aria-label="Color ${c}"></button>`).join('')}</div></div>
    <div class="field"><span>${T('rule')}</span>
      <div class="seg" id="tRule"><button type="button" data-r="day">${T('rule.day')}</button><button type="button" data-r="month">${T('rule.month')}</button></div></div>
    <label class="field"><span id="tAmtLabel"></span>
      <div class="money-input"><input id="tAmount" inputmode="numeric" value="${d.amount ? num(d.amount) : ''}" placeholder="0"><span>${cur}</span></div></label>
    <div class="field" id="tDaysWrap"><span>${T('days')}</span>
      <div class="days">${T('wd.short').map((w, i) => `<button type="button" data-d="${i}">${w}</button>`).join('')}</div></div>
    <p class="calc" id="tCalc"></p>
    <div class="sheet-actions">
      ${src ? `<button type="button" class="btn danger" id="tDelete">${T('delete')}</button>` : ''}
      <button type="submit" class="btn primary grow">${T('save')}</button>
    </div>
  </form>`;

  openSheet(html, (root) => {
    const amt = $('#tAmount', root);
    bindAmount(amt);
    const sync = () => {
      root.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', b.dataset.r === d.rule));
      root.querySelectorAll('[data-d]').forEach((b) => b.classList.toggle('on', d.days.includes(Number(b.dataset.d))));
      root.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', Number(b.dataset.c) === d.color));
      $('#tDaysWrap', root).hidden = d.rule !== 'day';
      $('#tAmtLabel', root).textContent = d.rule === 'day' ? T('amountDay') : T('amountMonth');
      const tmp = Object.assign({}, d, { amount: parseAmt(amt.value), archived: false });
      $('#tCalc', root).textContent = d.rule === 'day'
        ? T('calc', { amt: money(typeBudget(tmp, y, m)), n: activeDaysCount(tmp, y, m) })
        : T('calcMonth', { amt: money(tmp.amount) });
    };
    root.addEventListener('click', (ev) => {
      const r = ev.target.closest('[data-r]');
      if (r) { d.rule = r.dataset.r; if (d.rule === 'day' && !d.days.length) d.days = [0, 1, 2, 3, 4, 5, 6]; sync(); return; }
      const dd = ev.target.closest('[data-d]');
      if (dd) {
        const v = Number(dd.dataset.d);
        d.days = d.days.includes(v) ? d.days.filter((x) => x !== v) : d.days.concat(v).sort();
        sync(); return;
      }
      const sw = ev.target.closest('.sw');
      if (sw) { d.color = Number(sw.dataset.c); sync(); }
    });
    amt.addEventListener('input', sync);
    if (src) {
      $('#tDelete', root).addEventListener('click', () => {
        if (!confirm(T('deleteType'))) return;
        src.archived = true; src.updatedAt = nowIso();
        save(); closeSheet(); render(); toast(T('deleted'));
      });
    }
    $('#typeForm', root).addEventListener('submit', (ev) => {
      ev.preventDefault();
      d.name = $('#tName', root).value.trim();
      if (!d.key && !d.name) { toast(T('err.name')); return; }
      if (d.rule === 'day' && !d.days.length) { toast(T('err.days')); return; }
      d.emoji = $('#tEmoji', root).value.trim() || '💰';
      d.amount = parseAmt(amt.value);
      d.updatedAt = nowIso();
      const i = data.types.findIndex((t) => t.id === d.id);
      if (i >= 0) data.types[i] = d; else data.types.push(d);
      data.settings.example = false;
      save(); closeSheet(); render(); toast(T('savedToast'));
    });
    sync();
  });
}

/* ---------- backup ---------- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function mergeById(local, incoming, valid) {
  const map = new Map(local.map((r) => [r.id, r]));
  let n = 0;
  incoming.forEach((r) => {
    if (!r || typeof r.id !== 'string' || !valid(r)) return;
    const cur = map.get(r.id);
    if (!cur || String(r.updatedAt || '') > String(cur.updatedAt || '')) { map.set(r.id, r); n++; }
  });
  return { list: [...map.values()], n };
}
function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const inc = JSON.parse(reader.result);
      if (!inc || !Array.isArray(inc.entries) || !Array.isArray(inc.types)) throw new Error('bad');
      const types = mergeById(data.types, inc.types, (t) => (t.rule === 'day' || t.rule === 'month') && typeof t.amount === 'number');
      const entries = mergeById(data.entries, inc.entries, (e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.amount === 'number');
      types.list.forEach((t) => { if (!Array.isArray(t.days)) t.days = []; });
      data.types = types.list;
      data.entries = entries.list;
      if (inc.settings && String(inc.settings.updatedAt || '') > String(data.settings.updatedAt || '')) {
        data.settings = Object.assign(data.settings, inc.settings);
      }
      save(); applyTheme(); render();
      toast(T('imported', { n: types.n + entries.n }));
    } catch (e) {
      toast(T('importErr'));
    }
  };
  reader.readAsText(file);
}
function exportCsv() {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Item', 'Budget type', 'Amount', 'Note']];
  liveEntries().filter((e) => !e.noSpend).sort((a, b) => a.date.localeCompare(b.date))
    .forEach((e) => rows.push([e.date, e.item, typeName(typeById(e.typeId)), e.amount, e.note]));
  download(`monthly-cost-${todayStr()}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}

/* ---------- toast ---------- */
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- actions ---------- */
function shiftMonth(delta) {
  const d = new Date(ui.ym.y, ui.ym.m + delta, 1);
  ui.ym = { y: d.getFullYear(), m: d.getMonth() };
  render();
}
function setTip(el) {
  const tip = $('#chartTip');
  if (!tip) return;
  tip.textContent = el.dataset.tip;
  document.querySelectorAll('.col.sel').forEach((c) => c.classList.remove('sel'));
  el.classList.add('sel');
}

const actions = {
  tab: (el) => { ui.tab = el.dataset.v; if (ui.tab !== 'history') ui.filter = 'all'; render(); window.scrollTo(0, 0); },
  // In History's day view, new entries default to the day being viewed.
  add: () => openEntrySheet(null, ui.tab === 'history' && ui.histMode === 'day' ? ui.day : null),
  'hist-mode': (el) => { ui.histMode = el.dataset.v; render(); },
  'day-prev': () => { ui.day = addDays(ui.day, -1); render(); },
  'day-next': () => { ui.day = addDays(ui.day, 1); render(); },
  'day-today': () => { ui.day = todayStr(); render(); },
  'day-pick': () => {
    const inp = $('#dayInput');
    if (!inp) return;
    try { inp.showPicker(); } catch (e) { inp.focus(); inp.click(); }
  },
  'open-day': (el) => { ui.histMode = 'day'; ui.day = el.dataset.v; render(); window.scrollTo(0, 0); },
  'edit-entry': (el) => openEntrySheet(el.dataset.id),
  nospend: () => {
    const t = nowIso();
    data.entries.push({ id: uid(), date: todayStr(), amount: 0, typeId: null, item: '', note: '', noSpend: true, createdAt: t, updatedAt: t, deleted: false });
    save(); render(); toast(T('savedToast'));
  },
  'remove-nospend': (el) => {
    if (!confirm(T('removeNoSpend'))) return;
    const e = data.entries.find((x) => x.id === el.dataset.id);
    if (e) { e.deleted = true; e.updatedAt = nowIso(); save(); render(); }
  },
  'month-prev': () => shiftMonth(-1),
  'month-next': () => shiftMonth(1),
  'month-today': () => { ui.ym = currentYM(); render(); },
  filter: (el) => { ui.filter = el.dataset.v; render(); },
  'type-history': (el) => { ui.tab = 'history'; ui.histMode = 'month'; ui.filter = el.dataset.id; ui.ym = currentYM(); render(); window.scrollTo(0, 0); },
  'edit-type': (el) => openTypeSheet(el.dataset.id),
  'add-type': () => openTypeSheet(),
  'set-lang': (el) => { data.settings.lang = el.dataset.v; save({ fromSync: true }); render(); },
  'set-theme': (el) => { data.settings.theme = el.dataset.v; save({ fromSync: true }); applyTheme(); render(); },
  'set-palette': (el) => { data.settings.palette = el.dataset.v; save({ fromSync: true }); applyTheme(); render(); },
  'sync-connect': () => Sync.connect(),
  'sync-tap': () => Sync.tap(),
  'sync-disconnect': () => { if (confirm(T('sync.signOutConfirm'))) Sync.disconnect(); },
  'export-json': () => download(`monthly-cost-backup-${todayStr()}.json`,
    JSON.stringify(Object.assign({}, data, { sync: undefined }), null, 2), 'application/json'),
  'import-json': () => $('#importFile').click(),
  'export-csv': exportCsv,
  reset: () => {
    if (!confirm(T('resetConfirm'))) return;
    const lang = data.settings.lang;
    Sync.disconnect(true); // forget the Google link on this device too (the Sheet itself is not touched)
    data = defaultData();
    data.settings.lang = lang;
    save(); applyTheme(); render();
  },
  'close-sheet': () => closeSheet(),
  'dismiss-example': () => { data.settings.example = false; save(); render(); },
  'go-settings': () => { ui.tab = 'settings'; render(); window.scrollTo(0, 0); },
  'col-tip': (el) => setTip(el),
  streak: () => toast(T('streakTip', { n: streak() })),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
});
document.addEventListener('pointerover', (e) => {
  const c = e.target.closest && e.target.closest('.col');
  if (c && e.pointerType === 'mouse') setTip(c);
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'totalInput') {
    data.settings.monthlyTotal = parseAmt(el.value);
    data.settings.example = false;
    data.settings.totalUpdatedAt = nowIso();
    save(); render();
  } else if (el.id === 'dayInput') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) { ui.day = el.value; render(); }
  } else if (el.id === 'importFile') {
    importFile(el.files && el.files[0]);
    el.value = '';
  }
});
// When the installed app comes back to the foreground (e.g. the next day), refresh the numbers.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!ui.sheetOpen) render();
  Sync.schedule(300); // pick up changes made on another device
});

/* ---------- start ---------- */
applyTheme();
const params = new URLSearchParams(location.search);
if (['home', 'history', 'stats', 'settings'].includes(params.get('tab'))) ui.tab = params.get('tab');
render();
if (params.get('action') === 'add') openEntrySheet();
Sync.onStart();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // updateViaCache 'none': always fetch sw.js fresh, so new releases are noticed right away.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  // When a new version takes over, reload once to use it — but never while the user is typing in a form.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    const tryReload = () => { if (!ui.sheetOpen) location.reload(); else setTimeout(tryReload, 1000); };
    tryReload();
  });
  // Check for a new version whenever the app comes back to the screen.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  });
}

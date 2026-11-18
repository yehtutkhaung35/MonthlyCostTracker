'use strict';
/*
 * Phase 2: Google sign-in + sync to the user's OWN Google Sheet.
 *
 * - Sign-in uses Google Identity Services (token in the browser, no server).
 * - Scope is drive.file: the app can only see files it created itself.
 * - The phone keeps working offline; changes sync when signed in.
 * - Sync = read the Sheet, merge by id (newest updatedAt wins), write everything back.
 *   Deleted entries are kept as "tombstones" in a hidden Deleted tab so deletes reach other devices.
 *
 * Uses from app.js (loaded after this file): data, save, render, toast, T, nowIso, mergeById, typeName, typeById, ui.
 */
const Sync = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const TOKEN_KEY = 'mct.token';
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const MARK = { key: 'mctApp', value: 'v1' };
  const TITLE = 'Monthly Cost Tracker';

  const ENTRY_COLS = ['Date', 'Item', 'Budget type', 'Amount', 'Note', 'No spending', 'id', 'typeId', 'createdAt', 'updatedAt'];
  const TYPE_COLS = ['Name', 'Rule', 'Amount', 'Days', 'Icon', 'id', 'key', 'customName', 'color', 'archived', 'order', 'updatedAt'];
  const SETTING_COLS = ['key', 'value', 'updatedAt'];
  // One row per (month, budget type), plus a TOTAL row per month.
  const PLAN_COLS = ['Month', 'Budget type', 'Rule', 'Amount', 'Days', 'typeId', 'updatedAt'];
  const DEL_COLS = ['id', 'kind', 'updatedAt'];
  // Month × budget-type totals, for viewing on PC.
  const SUMMARY_FORMULA = '=QUERY({ARRAYFORMULA(LEFT(Entries!A2:A,7)),Entries!C2:C,Entries!D2:D},' +
    '"select Col1, sum(Col3) where Col1 <> \'\' and Col3 > 0 group by Col1 order by Col1 desc pivot Col2 label Col1 \'Month\'",0)';

  let status = 'off'; // off | idle | syncing | signin | error
  let busy = false;
  let again = false;
  let timer = 0;
  let gisPromise = null;

  /* ---------- config & state ---------- */
  const clientId = () => String((window.MCT_CONFIG && window.MCT_CONFIG.googleClientId) || '').trim();
  const configured = () => /\.apps\.googleusercontent\.com$/.test(clientId());
  const cfg = () => { if (!data.sync) data.sync = {}; return data.sync; };
  const connected = () => !!cfg().email;

  function getToken() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.exp > Date.now() + 60000) return t.token;
    } catch (e) { /* ignore */ }
    return null;
  }
  function setToken(token, expiresIn) {
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + (Number(expiresIn) || 3600) * 1000 })); } catch (e) { /* ignore */ }
  }
  function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }

  function setStatus(s) {
    status = s;
    updatePill();
    if (ui.tab === 'settings' && !ui.sheetOpen && !(document.activeElement && document.activeElement.id === 'totalInput')) render();
  }

  /* ---------- Google sign-in ---------- */
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisPromise) {
      gisPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in')); };
        document.head.appendChild(s);
      });
    }
    return gisPromise;
  }

  // Opens Google's popup, so it must run from a tap.
  async function requestToken(consent) {
    await loadGis();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: SCOPE,
        callback: (r) => {
          if (r && r.access_token && google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            setToken(r.access_token, r.expires_in);
            resolve(r.access_token);
          } else {
            reject(new Error((r && r.error) || 'Permission not granted'));
          }
        },
        error_callback: (err) => reject(new Error((err && err.type) || 'Popup closed')),
      });
      const opts = { prompt: consent ? 'consent' : '' };
      if (cfg().email) opts.login_hint = cfg().email;
      client.requestAccessToken(opts);
    });
  }

  /* ---------- REST helper ---------- */
  async function api(url, opts) {
    const token = getToken();
    if (!token) throw Object.assign(new Error('Sign-in needed'), { auth: true });
    const o = opts || {};
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, o.body ? { 'Content-Type': 'application/json' } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    if (res.status === 401) { clearToken(); throw Object.assign(new Error('Sign-in expired'), { auth: true }); }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(new Error(`Google API ${res.status}: ${txt.slice(0, 300)}`), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---------- the spreadsheet ---------- */
  function headerRow(cols) {
    return { values: cols.map((c) => ({ userEnteredValue: { stringValue: c }, userEnteredFormat: { textFormat: { bold: true } } })) };
  }
  function sheetSpec(title, index, cols, hidden) {
    const spec = { properties: { title, index, hidden: !!hidden, gridProperties: { frozenRowCount: cols ? 1 : 0 } } };
    if (cols) spec.data = [{ startRow: 0, startColumn: 0, rowData: [headerRow(cols)] }];
    return spec;
  }

  async function ensureSheet() {
    const c = cfg();
    if (c.sheetId) {
      try {
        const f = await api(`${DRIVE}/files/${c.sheetId}?fields=id,trashed`);
        if (!f.trashed) return ensureTabs(c.sheetId);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      c.sheetId = null;
    }
    // Look for the sheet this app made before (e.g. on another phone).
    const q = encodeURIComponent(`appProperties has { key='${MARK.key}' and value='${MARK.value}' } and trashed=false`);
    const found = await api(`${DRIVE}/files?q=${q}&fields=files(id)&orderBy=createdTime&pageSize=5&spaces=drive`);
    if (found.files && found.files.length) {
      c.sheetId = found.files[0].id;
      return ensureTabs(c.sheetId);
    }
    // First time: create it.
    const summary = {
      properties: { title: 'Summary', index: 3 },
      data: [{ startRow: 0, startColumn: 0, rowData: [{ values: [{ userEnteredValue: { formulaValue: SUMMARY_FORMULA } }] }] }],
    };
    const created = await api(SHEETS, {
      method: 'POST',
      body: {
        properties: { title: TITLE },
        sheets: [
          sheetSpec('Entries', 0, ENTRY_COLS),
          sheetSpec('Types', 1, TYPE_COLS),
          sheetSpec('Plans', 2, PLAN_COLS),
          summary,
          sheetSpec('Settings', 4, SETTING_COLS, true),
          sheetSpec('Deleted', 5, DEL_COLS, true),
        ],
      },
    });
    c.sheetId = created.spreadsheetId;
    tabsOk = c.sheetId;
    await api(`${DRIVE}/files/${c.sheetId}`, { method: 'PATCH', body: { appProperties: { [MARK.key]: MARK.value } } });
    return c.sheetId;
  }

  // Sheets made by an older version lack newer tabs (e.g. Plans): add them once.
  let tabsOk = null;
  async function ensureTabs(id) {
    if (tabsOk === id) return id;
    const info = await api(`${SHEETS}/${id}?fields=sheets.properties.title`);
    const have = new Set((info.sheets || []).map((s) => s.properties.title));
    const add = [];
    if (!have.has('Plans')) add.push({ addSheet: { properties: { title: 'Plans', index: 2, gridProperties: { frozenRowCount: 1 } } } });
    if (add.length) await api(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: { requests: add } });
    tabsOk = id;
    return id;
  }

  /* ---------- rows <-> records ---------- */
  function parseRows(rows) {
    if (!rows || !rows.length) return [];
    const head = rows[0].map(String);
    return rows.slice(1).map((r) => {
      const o = {};
      head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
  }
  const bool = (v) => v === true || String(v).toUpperCase() === 'TRUE';
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  function rowToEntry(o) {
    if (!o.id) return null;
    return {
      id: str(o.id), date: str(o.Date), item: str(o.Item), amount: Number(o.Amount) || 0, note: str(o.Note),
      noSpend: bool(o['No spending']), typeId: o.typeId ? str(o.typeId) : null,
      createdAt: str(o.createdAt), updatedAt: str(o.updatedAt), deleted: false,
    };
  }
  function entryToRow(e) {
    return [e.date, e.item || '', e.noSpend ? '' : typeName(typeById(e.typeId)), e.amount, e.note || '', !!e.noSpend,
      e.id, e.typeId || '', e.createdAt || '', e.updatedAt || ''];
  }
  function rowToType(o) {
    if (!o.id) return null;
    const days = str(o.Days).split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number).filter((n) => n >= 0 && n <= 6);
    return {
      id: str(o.id), key: o.key ? str(o.key) : null, name: str(o.customName), emoji: str(o.Icon) || '💰',
      color: Number(o.color) || 1, rule: str(o.Rule) === 'per day' ? 'day' : 'month', amount: Number(o.Amount) || 0,
      days, archived: bool(o.archived), order: Number(o.order) || 0, updatedAt: str(o.updatedAt),
    };
  }
  function typeToRow(t) {
    return [typeName(t), t.rule === 'day' ? 'per day' : 'per month', t.amount, (t.days || []).join(','), t.emoji,
      t.id, t.key || '', t.name || '', t.color, !!t.archived, t.order || 0, t.updatedAt || ''];
  }
  const parseDays = (v) => str(v).split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number).filter((n) => n >= 0 && n <= 6);
  function rowsToPlans(rows) {
    const plans = {};
    parseRows(rows).forEach((o) => {
      const k = str(o.Month);
      if (!/^\d{4}-\d{2}$/.test(k)) return;
      const p = plans[k] || (plans[k] = { total: 0, items: [], updatedAt: '' });
      if (str(o.updatedAt) > p.updatedAt) p.updatedAt = str(o.updatedAt);
      if (!o.typeId) p.total = Number(o.Amount) || 0;
      else p.items.push({ typeId: str(o.typeId), rule: str(o.Rule) === 'per day' ? 'day' : 'month', amount: Number(o.Amount) || 0, days: parseDays(o.Days) });
    });
    return plans;
  }
  function plansToRows() {
    const rows = [];
    Object.keys(data.plans).sort().reverse().forEach((k) => {
      const p = data.plans[k];
      const ts = str(p.updatedAt);
      rows.push([k, 'TOTAL', '', p.total, '', '', ts]);
      p.items.forEach((it) => rows.push([k, typeName(typeById(it.typeId)), it.rule === 'day' ? 'per day' : 'per month',
        it.amount, it.days.join(','), it.typeId, ts]));
    });
    return rows;
  }

  /* ---------- sync ---------- */
  async function syncNow() {
    if (!connected()) return;
    if (busy) { again = true; return; }
    if (!getToken()) { setStatus('signin'); return; }
    busy = true;
    setStatus('syncing');
    try {
      const id = await ensureSheet();
      const ranges = ['Entries!A:Z', 'Types!A:Z', 'Plans!A:Z', 'Deleted!A:Z'].map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
      const got = await api(`${SHEETS}/${id}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
      const [eRows, tRows, pRows, dRows] = got.valueRanges.map((v) => v.values || []);

      // 1) merge remote into local
      const remoteEntries = parseRows(eRows).map(rowToEntry).filter(Boolean);
      parseRows(dRows).forEach((d) => {
        if (d.id && d.kind === 'entry') {
          remoteEntries.push({ id: str(d.id), date: '1970-01-01', amount: 0, deleted: true, updatedAt: str(d.updatedAt) });
        }
      });
      const remoteTypes = parseRows(tRows).map(rowToType).filter(Boolean);
      const ent = mergeById(data.entries, remoteEntries, (e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.amount === 'number');
      const typ = mergeById(data.types, remoteTypes, (t) => t.rule === 'day' || t.rule === 'month');
      data.entries = ent.list;
      data.types = typ.list;
      const plansChanged = mergePlans(rowsToPlans(pRows));
      const changed = ent.n + typ.n + plansChanged;
      if (typ.n || plansChanged) data.settings.example = false;

      // 2) write the merged result back (newest first, easy to read on PC)
      const live = data.entries.filter((e) => !e.deleted)
        .sort((a, b) => (str(b.date) + str(b.createdAt)).localeCompare(str(a.date) + str(a.createdAt)));
      const eVals = [ENTRY_COLS].concat(live.map(entryToRow));
      const tVals = [TYPE_COLS].concat(data.types.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(typeToRow));
      const pVals = [PLAN_COLS].concat(plansToRows());
      const dVals = [DEL_COLS].concat(data.entries.filter((e) => e.deleted).map((e) => [e.id, 'entry', str(e.updatedAt)]));
      await api(`${SHEETS}/${id}/values:batchUpdate`, {
        method: 'POST',
        body: {
          valueInputOption: 'RAW',
          data: [
            { range: 'Entries!A1', values: eVals },
            { range: 'Types!A1', values: tVals },
            { range: 'Plans!A1', values: pVals },
            { range: 'Deleted!A1', values: dVals },
          ],
        },
      });
      // Clear leftover rows if the tables got shorter.
      const clear = [];
      if (eRows.length > eVals.length) clear.push(`Entries!A${eVals.length + 1}:Z${eRows.length}`);
      if (tRows.length > tVals.length) clear.push(`Types!A${tVals.length + 1}:Z${tRows.length}`);
      if (pRows.length > pVals.length) clear.push(`Plans!A${pVals.length + 1}:Z${pRows.length}`);
      if (dRows.length > dVals.length) clear.push(`Deleted!A${dVals.length + 1}:Z${dRows.length}`);
      if (clear.length) await api(`${SHEETS}/${id}/values:batchClear`, { method: 'POST', body: { ranges: clear } });

      const c = cfg();
      c.lastSyncAt = nowIso();
      c.dirty = false;
      save({ fromSync: true });
      busy = false;
      setStatus('idle');
      if (changed && !ui.sheetOpen) render();
    } catch (e) {
      busy = false;
      console.error('[sync]', e);
      if (e.auth) setStatus('signin');
      else { cfg().lastError = String(e.message || e).slice(0, 200); setStatus('error'); }
    }
    if (again) { again = false; schedule(300); }
  }

  function schedule(ms) {
    if (!connected()) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms == null ? 1500 : ms);
  }

  /* ---------- user actions ---------- */
  async function connect() {
    if (!configured()) { toast(T('sync.noConfig')); return; }
    try {
      await requestToken(true);
      const about = await api(`${DRIVE}/about?fields=user(emailAddress,displayName)`);
      const c = cfg();
      c.email = about.user.emailAddress;
      c.name = about.user.displayName || '';
      c.dirty = true;
      save({ fromSync: true });
      await syncNow();
      if (status === 'idle') toast(T('sync.done'));
    } catch (e) {
      console.error('[sync]', e);
      setStatus(connected() ? 'signin' : 'off');
      toast(T('sync.failed'));
    }
  }

  // Tap on "Sync now" or the cloud pill: refresh sign-in if needed, then sync.
  async function tap() {
    if (!connected()) { ui.tab = 'settings'; render(); return; }
    try {
      if (!getToken()) await requestToken(false);
      await syncNow();
      if (status === 'idle') toast(T('sync.done'));
    } catch (e) {
      console.error('[sync]', e);
      setStatus('signin');
      toast(T('sync.failed'));
    }
  }

  function disconnect(silent) {
    const token = getToken();
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* ignore */ }
    }
    clearToken();
    data.sync = {};
    if (!silent) { save({ fromSync: true }); setStatus('off'); }
    else status = 'off';
  }

  function onStart() {
    if (!connected()) { status = 'off'; updatePill(); return; }
    if (getToken()) syncNow();
    else setStatus('signin');
  }

  /* ---------- UI bits ---------- */
  function pillHtml() {
    if (!connected()) return '';
    const map = {
      idle: ['', '☁️ ✓', T('sync.ok')],
      syncing: ['', '<span class="spin">↻</span>', T('sync.syncing')],
      signin: ['warn', '☁️ ' + T('sync.tap'), T('sync.needSignin')],
      error: ['err', '☁️ ⚠', T('sync.error')],
      off: ['', '☁️', ''],
    };
    let [cls, label, title] = map[status] || map.off;
    if (status === 'idle' && cfg().dirty) { cls = 'warn'; label = '☁️ ↑'; title = T('sync.pending'); }
    return `<button class="sync-pill ${cls}" data-act="sync-tap" title="${esc(title)}" aria-label="${esc(title)}">${label}</button>`;
  }
  function updatePill() {
    const el = document.getElementById('syncPill');
    if (el) el.innerHTML = pillHtml();
  }

  const G_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

  function settingsCard() {
    let h = `<section class="card"><h2 class="sec">${T('sync')}</h2>`;
    if (!configured()) {
      h += `<p class="muted">${T('sync.noConfig')}</p>`;
    } else if (!connected()) {
      h += `<p class="muted">${T('sync.desc')}</p>
        <button class="btn google full" data-act="sync-connect">${G_LOGO}<span>${T('sync.signIn')}</span></button>`;
    } else {
      const c = cfg();
      const last = c.lastSyncAt ? new Date(c.lastSyncAt) : null;
      const lastTxt = last ? `${last.toLocaleDateString('en-CA')} ${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}` : T('sync.never');
      const stTxt = { idle: T('sync.ok'), syncing: T('sync.syncing'), signin: T('sync.needSignin'), error: T('sync.error'), off: '' }[status] || '';
      h += `<div class="sync-info">
          <div>${T('sync.as')} <strong>${esc(c.email)}</strong></div>
          <div class="muted small">${T('sync.last')}: ${lastTxt}${stTxt ? ' · ' + stTxt : ''}</div>
          ${status === 'error' && c.lastError ? `<div class="neg small">${esc(c.lastError)}</div>` : ''}
        </div>
        <div class="stack">
          <button class="btn primary full" data-act="sync-tap">${status === 'syncing' ? '<span class="spin">↻</span> ' : ''}${T('sync.now')}</button>
          ${c.sheetId ? `<a class="btn ghost full" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(c.sheetId)}/edit" target="_blank" rel="noopener">${T('sync.open')}</a>` : ''}
          <button class="btn ghost full" data-act="sync-disconnect">${T('sync.signOut')}</button>
        </div>
        <p class="muted small">${T('sync.note')}</p>`;
    }
    return h + '</section>';
  }

  return { configured, connected, schedule, syncNow, connect, tap, disconnect, onStart, updatePill, settingsCard, markDirty: () => { if (connected()) cfg().dirty = true; } };
})();

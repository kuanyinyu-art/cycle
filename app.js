'use strict';
/* 週期 — 個人生理期紀錄。所有資料只存在這支手機（瀏覽器的本機儲存空間）。 */

const STORE_KEY = 'cycle-app-v1';
const APP_VERSION = '1.1.0';

const DEFAULT_SYMPTOMS = ['頭痛', '頭暈', '腹脹', '腸胃不適', '長痘', '疲倦', '失眠', '腰痠', '胸部脹痛', '水腫', '嘴饞／食慾變化', '分泌物變化'];
const FLOW = [['light', '少'], ['medium', '中'], ['heavy', '多']];
const PAIN = [['none', '無'], ['mild', '輕'], ['moderate', '中'], ['severe', '重']];
const MOOD = [['happy', '開心'], ['calm', '平靜'], ['irritable', '煩躁'], ['low', '低落'], ['anxious', '焦慮']];
const MAX_PERIOD_DAYS = 14;

// 提醒通知小服務（放在 Cloudflare）
const PUSH_SERVER = 'https://cycle-reminder.kuanyinyu.workers.dev';
const VAPID_PUBLIC = 'BIuMVnnB8EJQ0ZIJ0wIlEELXNkIc35D_W1J5wq_bXQShlHXRGFHZg3OlZenGKhvPh9gdVuogrYaMhzg88rYspAE';

/* ---------- 日期小工具 ---------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const todayISO = () => iso(new Date());
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
function diffDays(a, b) { // b 減 a 的天數
  const [ya, ma, da] = a.split('-').map(Number), [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 864e5);
}
const md = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const longDate = s => { const d = parse(s); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEK[d.getDay()]}`; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 資料存取 ---------- */
function blank() {
  return {
    version: 1, periods: [], days: {},
    settings: { cycleLength: 28, periodLength: 5, customSymptoms: [], hiddenSymptoms: [], lastBackup: null, theme: 'dark' }
  };
}
function normalize(d) {
  const b = blank();
  if (!d || typeof d !== 'object') return b;
  const periods = Array.isArray(d.periods) ? d.periods
    .filter(p => p && isDate(p.start))
    .map(p => ({ id: p.id || uid(), start: p.start, end: isDate(p.end) && p.end >= p.start ? p.end : null })) : [];
  const days = {};
  if (d.days && typeof d.days === 'object') {
    for (const [k, v] of Object.entries(d.days)) if (isDate(k) && v && typeof v === 'object') days[k] = v;
  }
  const s = Object.assign(b.settings, d.settings || {});
  if (!Array.isArray(s.customSymptoms)) s.customSymptoms = [];
  if (!Array.isArray(s.hiddenSymptoms)) s.hiddenSymptoms = [];
  return { version: 1, periods, days, settings: s };
}
function load() {
  try { const raw = localStorage.getItem(STORE_KEY); return raw ? normalize(JSON.parse(raw)) : blank(); }
  catch (e) { return blank(); }
}
let state = load();
function writeStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); return true; }
  catch (e) { toast('儲存失敗，請先匯出備份'); return false; }
}
function save() {
  writeStore();
  schedulePushSync();
}
// 請手機不要自動清掉資料
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------- 計算：平均、預測 ---------- */
const sortedPeriods = () => [...state.periods].sort((a, b) => a.start < b.start ? -1 : 1);

function computeStats() {
  const ps = sortedPeriods();
  const cycles = [];
  for (let i = 1; i < ps.length; i++) {
    const len = diffDays(ps[i - 1].start, ps[i].start);
    if (len >= 15 && len <= 60) cycles.push(len);
  }
  const recent = cycles.slice(-6);
  const cycleLen = recent.length ? Math.round(avg(recent)) : state.settings.cycleLength;
  const closed = ps.filter(p => p.end).map(p => diffDays(p.start, p.end) + 1).filter(n => n >= 1 && n <= MAX_PERIOD_DAYS).slice(-6);
  const periodLen = closed.length ? Math.round(avg(closed)) : state.settings.periodLength;
  let range = null;
  if (recent.length >= 2) {
    const m = avg(recent);
    const sd = Math.sqrt(avg(recent.map(x => (x - m) ** 2)));
    range = Math.max(1, Math.min(7, Math.round(sd)));
  }
  return { ps, cycles, recent, cycleLen, periodLen, range };
}
function effectiveEnd(p, periodLen) {
  return p.end || addDays(p.start, periodLen - 1);
}
function nextPredicted(stats) {
  const last = stats.ps[stats.ps.length - 1];
  return last ? addDays(last.start, stats.cycleLen) : null;
}
// 每一天在月曆上的樣子
function buildDayMap(stats) {
  const map = new Map(), t = todayISO();
  for (const p of stats.ps) {
    const end = effectiveEnd(p, stats.periodLen);
    for (let d = p.start; d <= end; d = addDays(d, 1)) {
      map.set(d, { type: p.end || d <= t ? 'period' : 'tentative', id: p.id });
    }
  }
  let next = nextPredicted(stats);
  if (next) {
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < stats.periodLen; k++) {
        const d = addDays(next, k);
        if (!map.has(d)) map.set(d, { type: 'predicted' });
      }
      next = addDays(next, stats.cycleLen);
    }
  }
  return map;
}
function periodContaining(date, stats) {
  return stats.ps.find(p => date >= p.start && date <= effectiveEnd(p, stats.periodLen)) || null;
}

/* ---------- 畫面狀態 ---------- */
let view = 'calendar';
const now = new Date();
let shownYear = now.getFullYear(), shownMonth = now.getMonth();
let selected = null;

const $ = id => document.getElementById(id);

function applyTheme() {
  const t = state.settings.theme || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.getElementById('theme-color');
  if (m) m.setAttribute('content', dark ? '#18222F' : '#FAF5EB');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function render() {
  applyTheme();
  if (view === 'calendar') renderCalendar();
  if (view === 'history') renderHistory();
  if (view === 'settings') renderSettings();
}

/* ---------- 月曆頁 ---------- */
function renderStatus(stats) {
  const t = todayISO(), el = $('status');
  el.className = 'status';
  let html;
  if (!stats.ps.length) {
    html = `<div class="pre">歡迎</div><div class="big"><span class="word">開始記錄</span></div>
            <div class="sub">點月曆上的日期，記下生理期第一天</div>`;
  } else {
    const p = periodContaining(t, stats);
    if (p) {
      el.classList.add('in-period');
      const n = diffDays(p.start, t) + 1;
      html = `<div class="pre">生理期第</div><div class="big"><span class="num">${n}</span><span class="unit">天</span></div>
              <div class="sub">${p.end ? (p.end === t ? '今天是最後一天' : `到 ${md(p.end)} 結束`) : '結束那天記得點一下「生理期結束」'}</div>`;
    } else {
      const next = nextPredicted(stats), d = diffDays(t, next);
      const rng = stats.range ? `，前後約 ${stats.range} 天` : '';
      if (d > 0) {
        html = `<div class="pre">距離下次約</div><div class="big"><span class="num">${d}</span><span class="unit">天</span></div>
                <div class="sub">預計 ${md(next)} 開始${rng}</div>`;
      } else if (d === 0) {
        html = `<div class="pre">預計</div><div class="big"><span class="word">今天開始</span></div>
                <div class="sub">來了的話點一下今天記錄</div>`;
      } else {
        html = `<div class="pre">比預計晚了</div><div class="big"><span class="num">${-d}</span><span class="unit">天</span></div>
                <div class="sub">原本預計 ${md(next)}${rng}</div>`;
      }
    }
  }
  el.innerHTML = html;
}
function renderBackupBanner() {
  const el = $('backup-banner');
  const last = state.settings.lastBackup;
  const hasData = state.periods.length > 0;
  const since = last ? diffDays(last.slice(0, 10), todayISO()) : null;
  if (hasData && (since === null || since >= 30)) {
    el.innerHTML = `<div class="banner"><span>${since === null ? '還沒有備份過，備份一下比較安心' : `已經 ${since} 天沒備份囉`}</span>
      <button class="btn" data-act="backup">備份</button></div>`;
  } else el.innerHTML = '';
}
function renderCalendar(anim) {
  const stats = computeStats();
  renderStatus(stats);
  renderBackupBanner();
  const map = buildDayMap(stats), t = todayISO();
  $('month-title').textContent = `${shownYear} 年 ${shownMonth + 1} 月`;
  const first = new Date(shownYear, shownMonth, 1);
  const start = addDays(iso(first), -first.getDay());
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i), dt = parse(d);
    const other = dt.getMonth() !== shownMonth;
    if (i === 35 && other) break; // 只需要 5 列時不畫第 6 列
    const info = map.get(d);
    const cls = ['day'];
    if (other) cls.push('other');
    if (d === t) cls.push('today');
    if (d > t) cls.push('future');
    if (info) cls.push(info.type);
    if (d === selected) cls.push('selected');
    const log = state.days[d];
    const hasLog = log && (log.flow || log.pain || log.mood || (log.symptoms && log.symptoms.length) || log.note);
    html += `<button class="${cls.join(' ')}" data-date="${d}" aria-label="${longDate(d)}"><span class="n">${dt.getDate()}</span>${hasLog ? '<i class="dot"></i>' : ''}</button>`;
  }
  const grid = $('grid');
  grid.innerHTML = html;
  grid.classList.remove('slide-left', 'slide-right');
  if (anim) { void grid.offsetWidth; grid.classList.add(anim); }
  const isThisMonth = shownYear === now.getFullYear() && shownMonth === now.getMonth();
  $('today-btn').hidden = isThisMonth;
}
function shiftMonth(n) {
  shownMonth += n;
  while (shownMonth < 0) { shownMonth += 12; shownYear--; }
  while (shownMonth > 11) { shownMonth -= 12; shownYear++; }
  renderCalendar(n > 0 ? 'slide-left' : 'slide-right');
}
function goToday() {
  const d = new Date(); shownYear = d.getFullYear(); shownMonth = d.getMonth(); renderCalendar();
}

/* ---------- 某一天的卡片 ---------- */
function openDay(date) {
  selected = date;
  renderSheet();
  $('sheet').hidden = false; $('sheet-backdrop').hidden = false;
  $('sheet').scrollTop = 0;
  renderCalendar();
}
function closeSheet() {
  $('sheet').hidden = true; $('sheet-backdrop').hidden = true;
  selected = null;
  render();
}
function allSymptoms() {
  const s = state.settings;
  return [...DEFAULT_SYMPTOMS.filter(x => !s.hiddenSymptoms.includes(x)), ...s.customSymptoms];
}
function chipRow(name, options, value, rose) {
  return `<div class="chips">${options.map(([k, label]) =>
    `<button class="chip${rose ? ' rose' : ''}${value === k ? ' on' : ''}" data-field="${name}" data-val="${k}">${label}</button>`).join('')}</div>`;
}
function renderSheet() {
  const date = selected, t = todayISO(), stats = computeStats();
  const future = date > t;
  const p = periodContaining(date, stats);
  let meta = '', actions = '';

  if (p) {
    const n = diffDays(p.start, date) + 1;
    const tentative = !p.end && date > t;
    meta = tentative ? `可能是生理期第 ${n} 天（還沒按結束，先用平均天數估計）` : `生理期第 ${n} 天`;
    const btns = [];
    const showEnd = !future && p.end !== date && !(p.end && date === p.start);
    const endLabel = p.end ? '改成這天結束' : (date === p.start ? '這天就結束了' : '生理期在這天結束');
    if (showEnd) btns.push(`<button class="btn" data-act="set-end" data-id="${p.id}">${endLabel}</button>`);
    btns.push(`<button class="btn danger" data-act="delete-period" data-id="${p.id}">刪除這次紀錄</button>`);
    actions = `<div class="actions${btns.length === 2 ? ' two' : ''}">${btns.join('')}</div>`;
  } else if (future) {
    const map = buildDayMap(stats), info = map.get(date);
    meta = info && info.type === 'predicted' ? '預測可能是生理期' : '未來的日期';
    actions = `<p class="hint">未來的日期還不能記錄，到那天再點就可以了</p>`;
  } else {
    const prev = [...stats.ps].reverse().find(x => x.start < date && diffDays(x.start, date) < MAX_PERIOD_DAYS);
    const btns = [`<button class="btn rose" data-act="start">生理期開始</button>`];
    if (prev) btns.push(`<button class="btn ghost" data-act="extend" data-id="${prev.id}">生理期在這天結束</button>`);
    actions = `<div class="actions${btns.length === 2 ? ' two' : ''}">${btns.join('')}</div>`;
    if (prev) actions += `<p class="hint">「結束」會把 ${md(prev.start)} 開始的那次延長到這天</p>`;
  }

  let logHtml = '';
  if (!future) {
    const log = state.days[date] || {};
    const sym = log.symptoms || [];
    const symList = allSymptoms();
    const extra = sym.filter(x => !symList.includes(x)); // 已被隱藏但當天有勾的，仍顯示
    logHtml = `<div class="divider"></div>
      <div class="section-label">經血量</div>${chipRow('flow', FLOW, log.flow, true)}
      <div class="section-label">經痛</div>${chipRow('pain', PAIN, log.pain)}
      <div class="section-label">情緒</div>${chipRow('mood', MOOD, log.mood)}
      <div class="section-label">身體狀況</div>
      <div class="chips">${[...symList, ...extra].map(s =>
        `<button class="chip${sym.includes(s) ? ' on' : ''}" data-sym="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div class="section-label">備註</div>
      <textarea class="note" id="note" rows="2" placeholder="想記下的事…">${esc(log.note || '')}</textarea>`;
  }

  $('sheet-body').innerHTML = `<h2>${longDate(date)}</h2><div class="meta">${meta || (date === t ? '今天' : '&nbsp;')}</div>${actions}${logHtml}`;
}
function updateLog(date, fn) {
  const log = Object.assign({}, state.days[date] || {});
  fn(log);
  const empty = !log.flow && !log.pain && !log.mood && !(log.symptoms && log.symptoms.length) && !log.note;
  if (empty) delete state.days[date]; else state.days[date] = log;
  save();
}

/* ---------- 生理期的新增、結束、刪除 ---------- */
function startPeriod(date) {
  const stats = computeStats();
  // 如果幾天後已經有一次紀錄，就把那次的開始日往前移
  const soon = stats.ps.find(p => p.start > date && diffDays(date, p.start) <= MAX_PERIOD_DAYS);
  if (soon) {
    soon.start = date;
    if (soon.end && diffDays(soon.start, soon.end) + 1 > MAX_PERIOD_DAYS) soon.end = null;
  } else {
    // 之前還沒按結束的那次，自動用估計天數收尾
    for (const p of state.periods) {
      if (!p.end && p.start < date) {
        const e = effectiveEnd(p, stats.periodLen);
        p.end = e < date ? e : addDays(date, -1);
      }
    }
    state.periods.push({ id: uid(), start: date, end: null });
  }
  save();
  toast('已記錄開始');
}
function setEnd(id, date) {
  const p = state.periods.find(x => x.id === id);
  if (!p || date < p.start) return;
  p.end = date;
  save();
  toast('已記錄結束');
}
async function deletePeriod(id) {
  const p = state.periods.find(x => x.id === id);
  if (!p) return;
  const ok = await confirmDialog('刪除這次紀錄？', `${md(p.start)} 開始的這次生理期會被刪除。\n每天的身體狀況紀錄會保留。`, '刪除', true);
  if (!ok) return;
  state.periods = state.periods.filter(x => x.id !== id);
  save();
  toast('已刪除');
}

/* ---------- 紀錄頁 ---------- */
function renderHistory() {
  const stats = computeStats();
  const ps = stats.ps;
  $('stats').innerHTML = `
    <div class="card stat"><div class="v">${stats.recent.length ? stats.cycleLen : '—'}<small>天</small></div><div class="k">平均週期</div></div>
    <div class="card stat"><div class="v">${ps.some(p => p.end) ? stats.periodLen : '—'}<small>天</small></div><div class="k">平均經期</div></div>
    <div class="card stat"><div class="v">${ps.length}<small>次</small></div><div class="k">已記錄</div></div>`;
  if (!ps.length) {
    $('history').innerHTML = `<div class="empty"><div class="em">○</div>還沒有紀錄<br>到月曆點一下日期就可以開始</div>`;
    return;
  }
  let html = '', year = null, open = false;
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    const y = p.start.slice(0, 4);
    if (y !== year) {
      if (open) html += '</div>';
      html += `<div class="year-label">${y}</div><div class="card list">`;
      year = y; open = true;
    }
    const days = p.end ? diffDays(p.start, p.end) + 1 : null;
    const cyc = i < ps.length - 1 ? diffDays(p.start, ps[i + 1].start) : null;
    html += `<button class="row" data-goto="${p.start}"><span class="bar"></span>
      <span class="main"><div class="t">${md(p.start)} – ${p.end ? md(p.end) : '進行中'}</div>
      <div class="s">${days ? `經期 ${days} 天` : '還沒按結束'}</div></span>
      <span class="r">${cyc ? `週期 <b>${cyc}</b> 天` : '最近一次'}</span></button>`;
  }
  if (open) html += '</div>';
  $('history').innerHTML = html;
}

/* ---------- 設定頁 ---------- */
function renderSettings() {
  const s = state.settings;
  const lastB = s.lastBackup ? `上次備份：${s.lastBackup.slice(0, 10).replace(/-/g, '/')}` : '還沒有備份過';
  const syms = allSymptoms();
  $('settings').innerHTML = `
  <div class="group"><div class="group-title">週期</div><div class="card">
    <div class="item"><span class="label">預設週期天數<small>紀錄少於兩次時用來預測</small></span>
      <span class="stepper"><button data-step="cycleLength" data-d="-1">−</button><output>${s.cycleLength} 天</output><button data-step="cycleLength" data-d="1">＋</button></span></div>
    <div class="item"><span class="label">預設經期天數<small>還沒按結束時先用這個估計</small></span>
      <span class="stepper"><button data-step="periodLength" data-d="-1">−</button><output>${s.periodLength} 天</output><button data-step="periodLength" data-d="1">＋</button></span></div>
  </div></div>

  <div class="group"><div class="group-title">提醒通知</div><div class="card">
    ${reminderSettingsHtml()}
  </div></div>

  <div class="group"><div class="group-title">外觀</div><div class="card">
    <div class="item"><span class="label">顏色</span>
      <span class="seg">${[['dark', '深色'], ['light', '淺色'], ['auto', '跟手機']].map(([k, l]) =>
        `<button class="${(s.theme || 'dark') === k ? 'on' : ''}" data-theme-set="${k}">${l}</button>`).join('')}</span></div>
  </div></div>

  <div class="group"><div class="group-title">身體狀況項目</div><div class="card symptom-editor">
    <div class="chips">${syms.map(x => `<button class="chip" data-remove-sym="${esc(x)}">${esc(x)}<span class="x">✕</span></button>`).join('')}</div>
    <div class="add-row"><input id="new-sym" maxlength="12" placeholder="新增項目，例如：過敏"><button class="btn" data-act="add-sym">新增</button></div>
    ${s.hiddenSymptoms.length ? `<button class="link" data-act="restore-sym">恢復預設項目</button>` : ''}
  </div></div>

  <div class="group"><div class="group-title">備份（換手機時使用）</div><div class="card">
    <button class="item" data-act="backup"><span class="label">匯出備份<small>${lastB}</small></span><svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="item" data-act="import"><span class="label">匯入備份<small>會取代目前手機上的資料</small></span><svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
  </div></div>

  <div class="group"><div class="group-title">之後開放</div><div class="card">
    <div class="item muted"><span class="label">從小月曆搬移舊紀錄</span><span class="val">準備中</span></div>
  </div></div>

  <div class="group"><div class="card">
    <button class="item danger" data-act="clear"><span class="label">清除所有資料</span></button>
  </div></div>

  <p class="footnote">沒有廣告、沒有追蹤<br>所有紀錄只存在這支手機裡<br>版本 ${APP_VERSION}</p>`;
}

/* ---------- 提醒通知 ---------- */
const pushReady = () => !PUSH_SERVER.includes('__SUB__');
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
}
// 算出接下來要提醒的時間（通知文字不寫「生理期」等字眼）
function computeReminders() {
  const out = [], stats = computeStats(), nowMs = Date.now();
  const at = (dateStr, hour) => { const d = parse(dateStr); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  if (stats.ps.length) {
    const next = nextPredicted(stats);
    out.push({ at: at(addDays(next, -2), 9), title: '週期', body: `🌙 ${md(next)} 左右`, tag: 'soon' });
    out.push({ at: at(next, 9), title: '週期', body: '🌙 今天記得看一下', tag: 'day' });
    const p = state.settings.push || {};
    const base = state.settings.lastBackup ? state.settings.lastBackup.slice(0, 10) : (p.since || todayISO());
    out.push({ at: at(addDays(base, 30), 20), title: '週期', body: '☁️ 該備份囉', tag: 'backup' });
  }
  return out.filter(r => r.at > nowMs).sort((a, b) => a.at - b.at);
}
let pushTimer;
function schedulePushSync() {
  const p = state.settings.push;
  if (!p || !p.enabled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushSync(false), 800);
}
async function pushSync(force) {
  const p = state.settings.push;
  if (!p || !p.enabled || !pushReady() || !pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { p.enabled = false; writeStore(); if (view === 'settings') renderSettings(); return false; }
    const reminders = computeReminders();
    const sig = JSON.stringify([sub.endpoint, reminders.map(r => [r.at, r.body])]);
    if (!force && sig === p.lastSig) return true;
    const res = await fetch(PUSH_SERVER + '/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: p.secret, subscription: sub.toJSON(), reminders })
    });
    if (!res.ok) return false;
    p.lastSig = sig; p.lastSync = Date.now();
    writeStore();
    return true;
  } catch (e) { return false; }
}
async function enablePush() {
  if (!pushReady()) { toast('提醒服務還在準備中'); return; }
  if (isIOS() && !isStandalone()) {
    await confirmDialog('請從主畫面打開', '提醒通知只能在「加入主畫面」的 App 裡開啟。\n請關掉 Safari，從主畫面的「週期」圖示打開再試一次。', '知道了');
    return;
  }
  if (!pushSupported()) { toast('這支手機的系統版本太舊，沒辦法開啟通知'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    await confirmDialog('沒有允許通知', '可以到 iPhone「設定」→「通知」→「週期」把通知打開，再回來按一次「開啟提醒」。', '知道了');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC) });
    const old = state.settings.push || {};
    state.settings.push = { enabled: true, secret: old.secret || randomSecret(), since: old.since || todayISO() };
    writeStore();
    const ok = await pushSync(true);
    renderSettings();
    toast(ok ? '提醒已開啟' : '連不上提醒服務，請確認有網路再試一次');
  } catch (e) {
    toast('開啟失敗，請再試一次');
  }
}
async function disablePush() {
  const p = state.settings.push;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    if (p && p.secret) await fetch(PUSH_SERVER + '/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: p.secret }) });
  } catch (e) {}
  state.settings.push = Object.assign({}, p, { enabled: false, lastSig: null });
  writeStore(); renderSettings(); toast('提醒已關閉');
}
async function testPush() {
  const p = state.settings.push;
  if (!p || !p.enabled) return;
  await pushSync(true);
  try {
    const res = await fetch(PUSH_SERVER + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: p.secret }) });
    const data = await res.json().catch(() => ({}));
    toast(res.ok && data.ok ? '已送出，幾秒內會收到' : '送出失敗，請稍後再試');
  } catch (e) { toast('連不上提醒服務，請確認有網路'); }
}
function reminderSettingsHtml() {
  const p = state.settings.push;
  if (!pushReady()) return `<div class="item muted"><span class="label">提醒通知</span><span class="val">準備中</span></div>`;
  if (!p || !p.enabled) {
    return `<button class="item" data-act="push-on"><span class="label">開啟提醒<small>快來前 2 天、預計當天、該備份時各跳一則通知，文字不會出現「生理期」</small></span><svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>`;
  }
  const list = computeReminders().slice(0, 3).map(r => {
    const d = new Date(r.at);
    return `<div class="item"><span class="label">${d.getMonth() + 1}/${d.getDate()} ${d.getHours() < 12 ? '上午' : '晚上'} ${d.getHours() > 12 ? d.getHours() - 12 : d.getHours()}:00<small>${esc(r.body)}</small></span></div>`;
  }).join('');
  return `<div class="item"><span class="label">提醒已開啟</span><button class="btn ghost small" data-act="push-off">關閉</button></div>
    <button class="item" data-act="push-test"><span class="label">傳一則測試通知</span><svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    ${list || '<div class="item muted"><span class="label">記錄第一次生理期後，就會排好提醒</span></div>'}`;
}

/* ---------- 備份與還原 ---------- */
async function exportBackup() {
  const stamp = new Date().toISOString();
  const payload = JSON.stringify({ app: 'cycle', version: 1, exportedAt: stamp, data: state }, null, 1);
  const name = `cycle-backup-${todayISO()}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    state.settings.lastBackup = stamp;
    save(); render();
    toast('備份完成');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 自己按了取消
    toast('備份沒有完成，請再試一次');
  }
}
async function importBackup(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch (e) { toast('這個檔案讀不出來'); return; }
  const data = parsed && parsed.data ? parsed.data : parsed;
  if (!data || !Array.isArray(data.periods)) { toast('這不是週期的備份檔'); return; }
  const incoming = normalize(data);
  const ok = await confirmDialog('匯入備份？', `備份裡有 ${incoming.periods.length} 次生理期紀錄。\n目前手機上的資料會被取代。`, '匯入');
  if (!ok) return;
  state = incoming;
  save(); render();
  toast('匯入完成');
}

/* ---------- 確認視窗與提示 ---------- */
function confirmDialog(title, msg, okText = '確定', danger = false) {
  return new Promise(resolve => {
    $('dialog-title').textContent = title;
    $('dialog-msg').textContent = msg;
    const ok = $('dialog-ok'), cancel = $('dialog-cancel');
    ok.textContent = okText;
    ok.className = 'btn' + (danger ? ' rose' : '');
    $('dialog').hidden = false;
    const done = v => { $('dialog').hidden = true; ok.onclick = cancel.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------- 操作 ---------- */
function switchView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('button, [data-act]');
  if (!t) return;

  if (t.classList.contains('tab')) return switchView(t.dataset.view);
  if (t.dataset.date) return openDay(t.dataset.date);
  if (t.dataset.goto) {
    const d = parse(t.dataset.goto);
    shownYear = d.getFullYear(); shownMonth = d.getMonth();
    switchView('calendar');
    return openDay(t.dataset.goto);
  }
  if (t.id === 'prev-month') return shiftMonth(-1);
  if (t.id === 'next-month') return shiftMonth(1);
  if (t.id === 'today-btn' || t.id === 'month-title') return goToday();

  // 當天紀錄（單選）
  if (t.dataset.field && selected) {
    const f = t.dataset.field, v = t.dataset.val;
    updateLog(selected, log => { log[f] = log[f] === v ? undefined : v; if (!log[f]) delete log[f]; });
    renderSheet(); renderCalendar();
    return;
  }
  // 當天紀錄（複選）
  if (t.dataset.sym !== undefined && selected) {
    const s = t.dataset.sym;
    updateLog(selected, log => {
      const arr = new Set(log.symptoms || []);
      arr.has(s) ? arr.delete(s) : arr.add(s);
      log.symptoms = [...arr];
      if (!log.symptoms.length) delete log.symptoms;
    });
    t.classList.toggle('on');
    renderCalendar();
    return;
  }
  // 設定：天數加減
  if (t.dataset.step) {
    const k = t.dataset.step, d = Number(t.dataset.d);
    const lim = k === 'cycleLength' ? [15, 60] : [1, MAX_PERIOD_DAYS];
    state.settings[k] = Math.min(lim[1], Math.max(lim[0], state.settings[k] + d));
    save(); renderSettings();
    return;
  }
  // 設定：外觀
  if (t.dataset.themeSet) {
    state.settings.theme = t.dataset.themeSet;
    save(); render();
    return;
  }
  // 設定：移除症狀項目
  if (t.dataset.removeSym !== undefined) {
    const s = t.dataset.removeSym, st = state.settings;
    if (st.customSymptoms.includes(s)) st.customSymptoms = st.customSymptoms.filter(x => x !== s);
    else if (!st.hiddenSymptoms.includes(s)) st.hiddenSymptoms.push(s);
    save(); renderSettings();
    return;
  }

  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'start': startPeriod(selected); renderSheet(); renderCalendar(); break;
    case 'set-end':
    case 'extend': setEnd(id, selected); renderSheet(); renderCalendar(); break;
    case 'delete-period': await deletePeriod(id); renderSheet(); renderCalendar(); break;
    case 'backup': exportBackup(); break;
    case 'import': $('import-file').value = ''; $('import-file').click(); break;
    case 'add-sym': {
      const inp = $('new-sym'), v = inp.value.trim();
      const st = state.settings;
      if (!v) return;
      if (DEFAULT_SYMPTOMS.includes(v)) st.hiddenSymptoms = st.hiddenSymptoms.filter(x => x !== v);
      else if (!st.customSymptoms.includes(v)) st.customSymptoms.push(v);
      save(); renderSettings(); toast(`已新增「${v}」`);
      break;
    }
    case 'push-on': await enablePush(); break;
    case 'push-off': await disablePush(); break;
    case 'push-test': await testPush(); break;
    case 'restore-sym': state.settings.hiddenSymptoms = []; save(); renderSettings(); break;
    case 'clear': {
      const ok = await confirmDialog('清除所有資料？', '所有生理期與身體狀況紀錄都會刪除，而且無法復原。\n建議先匯出備份。', '全部清除', true);
      if (ok) { state = blank(); save(); render(); toast('已清除'); }
      break;
    }
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'new-sym') { e.preventDefault(); document.querySelector('[data-act="add-sym"]').click(); }
});

let noteTimer;
document.addEventListener('input', e => {
  if (e.target.id !== 'note' || !selected) return;
  const date = selected, v = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    updateLog(date, log => { if (v.trim()) log.note = v; else delete log.note; });
    renderCalendar();
  }, 400);
});
document.addEventListener('focusout', e => {
  if (e.target.id === 'note' && selected) {
    clearTimeout(noteTimer);
    const v = e.target.value;
    updateLog(selected, log => { if (v.trim()) log.note = v; else delete log.note; });
  }
});

const closeFromUser = () => {
  const n = $('note'); if (n) n.blur();
  closeSheet();
};
$('sheet-backdrop').addEventListener('click', closeFromUser);
$('sheet-close').addEventListener('click', closeFromUser);
$('import-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); });

// 月曆左右滑動換月份
(() => {
  const card = document.querySelector('.cal-card');
  let x0 = null, y0 = null;
  card.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  card.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    x0 = null;
  });
  // 往下滑關閉卡片
  const sheet = $('sheet');
  let sy = null;
  sheet.addEventListener('touchstart', e => { sy = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (sy !== null && e.changedTouches[0].clientY - sy > 90) closeSheet();
    sy = null;
  });
})();

// 過了午夜或從背景回來時更新「今天」
document.addEventListener('visibilitychange', () => { if (!document.hidden) { state = load(); render(); pushSync(false); } });

// 離線也能用
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
setTimeout(() => pushSync(false), 1500);

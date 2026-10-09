// Pendelpilot – Oberfläche. Reines JavaScript, kein Build-Schritt.
// Aufbau: Hilfen · Daten/API · Komponenten · Sheets · Screens · Aktionen · Start
import { icon } from './icons.js';

// ============================================================================
// Hilfen
// ============================================================================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WDS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DEFAULT_API = 'https://ntkooxdivapuznjufdwj.supabase.co/functions/v1/pendel';

const hm = (min) => {
  if (min == null || Number.isNaN(min)) return '–';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const parseHM = (s) => { if (!s) return null; const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const dur = (min) => {
  const m = Math.round(Math.abs(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const wdOf = (d) => { const [y, m, dd] = d.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7; };
const fmtDate = (d) => { const [, m, dd] = d.split('-').map(Number); return `${WD[wdOf(d)]}, ${dd}.${m}.`; };
const fmtShort = (d) => { const [, m, dd] = d.split('-').map(Number); return `${WDS[wdOf(d)]} ${dd}.${m}.`; };
const uid = () => Math.random().toString(36).slice(2, 10);
const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const minOfIso = (iso) => {
  if (!iso) return null;
  const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return g('hour') * 60 + g('minute');
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* privat */ } },
};
const LOGO = 'apple-touch-icon.png';

// ============================================================================
// Hell / Dunkel
// ============================================================================
const theme = () => store.get('theme') || 'auto';
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    $('meta[name="theme-color"]')?.setAttribute('content', bg || '#F4F5F7');
  });
}
applyTheme(theme());
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(theme()));

// ============================================================================
// Daten / API
// ============================================================================
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('token')) {
    store.set('api', h.get('api') || DEFAULT_API);
    store.set('token', h.get('token'));
    history.replaceState(null, '', location.pathname + location.search);
  }
})();
const conn = () => ({ api: store.get('api') || DEFAULT_API, token: store.get('token') });

async function api(path, { method = 'GET', body } = {}) {
  const { api: base, token } = conn();
  let r;
  try {
    r = await fetch(base.replace(/\/$/, '') + path, {
      method, headers: { 'Content-Type': 'application/json', 'x-app-token': token || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine ? 'Server gerade nicht erreichbar.' : 'Keine Internetverbindung.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { const e = new Error('Der Zugangsschlüssel stimmt nicht.'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j;
}

const S = {
  tab: store.get('tab') || 'today',
  sub: null, // Unterseite in „Mehr“
  ov: null, settings: null, stats: null,
  loading: true, error: null,
  weekDay: null, tVariant: 0, heatDir: 'out', heatSel: null,
  wizardShown: false,
};

async function load({ quiet = false } = {}) {
  if (!conn().token) return renderWelcome();
  if (!quiet && !S.ov) { S.loading = true; render(); }
  try {
    const [ov, settings] = await Promise.all([api('/overview'), api('/settings')]);
    S.ov = ov; S.settings = settings; S.error = null; S.loading = false;
    if (quiet) render.keepScroll = true;
    render();
    if (!S.wizardShown && setupSteps().filter((x) => !x.done).length >= 3) { S.wizardShown = true; openWizard(); }
  } catch (e) {
    S.loading = false;
    if (e.auth) { store.del('token'); return renderWelcome('Der Zugangsschlüssel stimmt nicht. Bitte neu einfügen.'); }
    if (quiet && S.ov) return toast(e.message, 'err');
    S.error = e.message;
    render();
  }
}

// Einstellungen speichern – nacheinander (Warteschlange), damit nichts verloren geht.
let chain = Promise.resolve();
function saveSettings(mut, msg = 'Gespeichert', { rerender = true, button = null } = {}) {
  if (button) { if (button.classList.contains('loading')) return Promise.resolve(false); button.classList.add('loading'); }
  const run = async () => {
    const s = structuredClone(S.settings);
    if (mut(s) === false) { button?.classList.remove('loading'); return false; }
    try {
      S.settings = await api('/settings', { method: 'PUT', body: s });
      S.ov = await api('/overview');
      if (rerender) rerenderKeepScroll();
      if (msg) toast(msg, 'ok');
      return true;
    } catch (e) {
      toast(`Nicht gespeichert – ${e.message}`, 'err');
      return false;
    } finally { button?.classList.remove('loading'); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ============================================================================
// Komponenten
// ============================================================================
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.className = kind;
  t.innerHTML = `${icon(kind === 'err' ? 'triangle-alert' : 'circle-check')}<span>${esc(msg)}</span>`;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}

const place = (key) => S.settings?.locations?.[key]?.label || { home: 'Zuhause', work: 'Arbeit', uni: 'Uni' }[key] || key;

function row({ title, desc = '', val = '', valCls = '', tile = '', tileCls = '', action = '', data = '', chev = !!action, cls = '' }) {
  const el = action ? 'button' : 'div';
  return `<${el} class="row ${cls}" ${action ? `type="button" data-a="${action}"` : ''} ${data}>
    ${tile ? `<span class="tile ${tileCls}">${icon(tile)}</span>` : ''}
    <span class="main"><span class="title">${title}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</span>
    ${val ? `<span class="val ${valCls}">${val}</span>` : ''}
    ${chev ? icon('chevron-right', 'chev') : ''}
  </${el}>`;
}
const group = (rows, { icons = false, title = '', foot = '' } = {}) =>
  `${title ? `<h3 class="overline gtitle">${title}</h3>` : ''}<div class="group ${icons ? 'icons' : ''}">${rows.join('')}</div>${foot ? `<p class="gfoot">${foot}</p>` : ''}`;
const field = (label, input, { hint = '', err = '' } = {}) =>
  `<label class="field"><span>${label}</span>${input}${err ? `<em class="err">${err}</em>` : ''}${hint ? `<em class="hint">${hint}</em>` : ''}</label>`;
const seg = (name, options, value) =>
  `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" data-a="seg" data-seg="${name}" data-v="${v}" aria-pressed="${String(v) === String(value)}">${l}</button>`).join('')}</div>`;
const chip = (text, cls = '', ic = '') => `<span class="chip ${cls}">${ic ? icon(ic) : ''}${text}</span>`;
const empty = ({ ic, title, text, action = '', label = '' }) =>
  `<div class="empty"><div class="ill">${icon(ic)}</div><h2>${title}</h2><p>${text}</p>${action ? `<button class="btn primary lg" data-a="${action}">${label}</button>` : ''}</div>`;
const ph = (title, sub = '', trailing = '') =>
  `<header class="ph"><h1>${sub ? `<span class="sub">${sub}</span>` : ''}${title}</h1>${trailing}</header>`;
const back = (label = 'Mehr') => `<button class="ph-back" data-a="back">${icon('chevron-left')}${label}</button>`;

function setDock(html) {
  const d = $('#dock');
  d.innerHTML = html || '';
  d.hidden = !html;
  document.body.classList.toggle('has-dock', !!html);
}

// ============================================================================
// Sheets (von unten), tastaturfest
// ============================================================================
let sheetState = null;
function openSheet({ title, body, footer = '', onMount }) {
  closeSheet(true);
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.dataset.a = 'close-sheet';
  const sh = document.createElement('section');
  sh.className = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', title);
  sh.innerHTML = `<div class="grab"></div><header><h2>${esc(title)}</h2><button class="btn ib" data-a="close-sheet" aria-label="Schließen">${icon('x')}</button></header>
    <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : '<footer hidden></footer>'}`;
  document.body.append(scrim, sh);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => { scrim.classList.add('open'); sh.classList.add('open'); });
  sheetState = { scrim, sh };
  onMount?.(sh);
  return sh;
}
function closeSheet(instant = false) {
  if (!sheetState) return;
  const { scrim, sh } = sheetState;
  sheetState = null;
  document.body.classList.remove('sheet-open');
  if (instant) { scrim.remove(); sh.remove(); return; }
  scrim.classList.remove('open'); sh.classList.remove('open');
  setTimeout(() => { scrim.remove(); sh.remove(); }, 340);
}
function updateSheetBody(html) { if (sheetState) $('.body', sheetState.sh).innerHTML = html; }
function updateSheetFooter(html) { const f = sheetState && $('footer', sheetState.sh); if (f) { f.innerHTML = html; f.hidden = !html; } }
// Tastatur: Sheet bleibt über der Tastatur, aktives Feld bleibt sichtbar
if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    document.documentElement.style.setProperty('--kb', `${-kb}px`);
  };
  vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); sync();
}
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input, select, textarea') && e.target.closest('.sheet')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

// ============================================================================
// Rahmen: Tabs + Router
// ============================================================================
const TABS = [['today', 'house', 'Heute'], ['tomorrow', 'calendar', 'Morgen'], ['week', 'calendar-days', 'Woche'], ['insights', 'chart-no-axes-column', 'Einblicke'], ['more', 'ellipsis', 'Mehr']];
function renderTabs() {
  const t = $('#tabbar');
  t.hidden = false;
  t.innerHTML = TABS.map(([k, ic, l]) => `<button type="button" data-a="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${icon(ic)}<span class="lbl">${l}</span></button>`).join('');
}

function render() {
  if (!conn().token) return renderWelcome();
  renderTabs();
  const app = $('#app');
  let html;
  if (S.loading && !S.ov) html = skeleton();
  else if (S.error && !S.ov) { setDock(''); html = `<div class="view">${ph('Pendelpilot')}${errorNote(S.error)}</div>`; }
  else {
    const views = { today: viewToday, tomorrow: viewTomorrow, week: viewWeek, insights: viewInsights, more: viewMore };
    html = (views[S.tab] || viewToday)();
  }
  const keep = render.keepScroll;
  const y = scrollY;
  app.innerHTML = html;
  if (keep) { $('.view', app)?.style.setProperty('animation', 'none'); window.scrollTo(0, y); } else window.scrollTo(0, 0);
  render.keepScroll = false;
  mountHooks();
}
function rerenderKeepScroll() { render.keepScroll = true; render(); }

const errorNote = (msg) => `<div class="note error">${icon('triangle-alert')}<div class="grow"><b>Das hat nicht geklappt</b><div class="t-2 callout">${esc(msg)}</div><button class="btn tinted" data-a="retry">${icon('rotate-cw')}Erneut versuchen</button></div></div>`;

function skeleton() {
  setDock('');
  return `<div class="view" aria-busy="true" aria-label="Lädt">
    <div class="skel" style="width:48%;height:18px;margin-top:12px"></div>
    <div class="skel" style="width:40%;height:16px;margin-top:36px"></div>
    <div class="skel" style="width:72%;height:72px;margin-top:12px;border-radius:16px"></div>
    <div class="skel" style="width:85%;height:16px;margin-top:16px"></div>
    <div class="skel" style="width:100%;height:6px;margin-top:20px"></div>
    ${[0, 1, 2, 3].map(() => `<div style="display:flex;gap:16px;margin-top:28px"><div class="skel" style="width:44px;height:16px"></div><div class="skel" style="flex:1;height:16px"></div></div>`).join('')}
  </div>`;
}

// ============================================================================
// Willkommen / Verbinden
// ============================================================================
function renderWelcome(err = '') {
  $('#tabbar').hidden = true; setDock('');
  $('#app').innerHTML = `<main class="welcome">
    <img class="logo" src="${LOGO}" alt="">
    <h1>Weniger Stau.<br>Mehr Tag.</h1>
    <p class="lead">Pendelpilot plant deine Fahrten rund um Arbeit, Uni und Termine – und sagt dir rechtzeitig, wann du am besten losfährst.</p>
    <ul class="pts">
      <li>${icon('clock')}<div><b>Die beste Abfahrtszeit</b><span>aus Verkehrsprognose, Live-Lage und deinen Erfahrungen</span></div></li>
      <li>${icon('bell')}<div><b>Rechtzeitig erinnert</b><span>nie mitten in der Vorlesung</span></div></li>
      <li>${icon('route')}<div><b>Alternativen im Vergleich</b><span>früher heim oder weniger Fahrt – du entscheidest</span></div></li>
    </ul>
    <div class="group">
      ${field('Zugangsschlüssel', `<input id="w-token" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="einfügen" ${err ? 'aria-invalid="true"' : ''}>`, { err, hint: 'Den Schlüssel hast du beim Einrichten bekommen.' })}
    </div>
    <details style="margin-top:12px"><summary class="caption t-3" style="min-height:44px;display:flex;align-items:center;cursor:pointer">Anderen Server verwenden</summary>
      <div class="group">${field('Server-Adresse', `<input id="w-api" value="${esc(conn().api)}" autocapitalize="off" autocorrect="off" spellcheck="false">`)}</div>
    </details>
    <button class="btn primary lg block" style="margin-top:24px" data-a="connect">Loslegen ${icon('arrow-right')}</button>
  </main>`;
}

// ============================================================================
// Einrichtung (geführt) – für neue Nutzer
// ============================================================================
function setupSteps() {
  const s = S.settings || {};
  const found = (k) => s.locations?.[k]?.lat != null;
  return [
    { key: 'traffic', done: !!s.traffic?.tomtomKey, title: 'Verkehrsdaten verbinden' },
    { key: 'places', done: found('home') && found(s.work?.location || 'work'), title: 'Zuhause & Arbeit eintragen' },
    { key: 'notify', done: !!s.notify?.ntfyTopic, title: 'Benachrichtigungen aktivieren' },
    { key: 'week', done: !!s.planReviewed || (s.study || []).length > 0, title: 'Arbeitszeiten prüfen' },
  ];
}
let wiz = 0;
function openWizard(startAt) {
  const steps = setupSteps();
  wiz = startAt ?? Math.max(0, steps.findIndex((x) => !x.done));
  openSheet({ title: 'Einrichtung', body: '', onMount: () => drawWizard() });
}
function drawWizard() {
  const steps = setupSteps();
  const st = steps[wiz];
  const bar = `<div class="steps" aria-label="Schritt ${wiz + 1} von ${steps.length}">${steps.map((x, i) => `<i class="${i <= wiz ? 'on' : ''}"></i>`).join('')}</div>
    <p class="overline">Schritt ${wiz + 1} von ${steps.length}</p><h3 class="headline" style="margin:4px 0 8px">${st.title}</h3>`;
  const s = S.settings;
  let body = '', primary = 'Weiter';
  if (st.key === 'traffic') {
    body = `<p class="lead">Für echte Verkehrsdaten braucht die App einen kostenlosen Schlüssel von TomTom. Ohne Kreditkarte, dauert etwa 3 Minuten.</p>
      <ol class="callout t-2" style="padding-left:20px;margin:0 0 16px;line-height:1.6">
        <li>Auf „Schlüssel holen“ tippen und registrieren</li><li>Bestätigungs-Mail öffnen</li><li>Unter „Keys“ den Schlüssel kopieren und hier einfügen</li></ol>
      <a class="btn tinted block" href="https://developer.tomtom.com/user/register" target="_blank" rel="noopener">${icon('external-link')}Schlüssel holen</a>
      <div class="group" style="margin-top:16px">${field('TomTom-Schlüssel', `<input id="z-key" value="${esc(s.traffic.tomtomKey)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="hier einfügen">`)}</div>`;
    primary = 'Speichern & weiter';
  } else if (st.key === 'places') {
    const pl = (k, label) => {
      const l = s.locations[k] || {};
      return `<div class="group" style="margin-top:12px">${field(label, `<div class="inline-field"><input data-geo-in="${k}" value="${esc(l.address)}" placeholder="Straße Nr., Ort" enterkeyhint="search"><button type="button" class="btn tinted" data-a="geo" data-k="${k}">Suchen</button></div>`,
        { hint: l.lat != null ? `<span style="color:var(--success)">✓ ${esc(l.address)}</span> · <a href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}" target="_blank" rel="noopener">in Karte prüfen ↗</a>` : '' })}</div>`;
    };
    body = `<p class="lead">Damit die App deine Strecke kennt. Die Uni kannst du auch später ergänzen.</p>
      ${!s.traffic.tomtomKey ? `<div class="note warn">${icon('info')}<div class="grow callout">Die Adresssuche braucht den TomTom-Schlüssel aus Schritt 1.</div></div>` : ''}
      ${pl('home', 'Zuhause')}${pl(s.work.location || 'work', 'Arbeit')}${s.locations.uni ? pl('uni', 'Uni (optional)') : ''}`;
  } else if (st.key === 'notify') {
    const topic = s.notify.ntfyTopic;
    body = `<p class="lead">Die App schickt dir Hinweise wie „In 15 Minuten losfahren“ über die kostenlose App <b>ntfy</b>.</p>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <a class="btn block" href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">${icon('smartphone')}iPhone</a>
        <a class="btn block" href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">${icon('smartphone')}Android</a></div>
      ${topic ? `<p class="callout t-2" style="margin-bottom:8px">In ntfy auf „+“ tippen und dieses Thema abonnieren:</p><div class="topic selectable">${esc(topic)}</div><div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="btn tinted block" data-a="copy-topic">${icon('copy')}Kopieren</button><button type="button" class="btn block" data-a="test-push">${icon('send')}Test senden</button></div>`
        : `<p class="callout t-2" style="margin-bottom:8px">Dann hier dein persönliches Thema erzeugen:</p><button type="button" class="btn tinted block" data-a="new-topic">${icon('sparkles')}Thema erzeugen</button>`}`;
  } else {
    const d = s.work.days;
    body = `<p class="lead">Wie viele Stunden arbeitest du an welchem Tag? Die Pause rechnet die App selbst dazu.</p>
      <div class="group">${WDS.map((w, i) => `<div class="row" style="cursor:default"><span class="main"><span class="title">${WD[i]}</span></span>
        <div class="stepper"><button type="button" class="btn ib" data-a="wiz-hours" data-d="${i}" data-step="-0.5" aria-label="${WD[i]} weniger">${icon('minus')}</button><output class="num" id="wh-${i}">${fmtHours(d[i]?.hours ?? 0)}</output><button type="button" class="btn ib" data-a="wiz-hours" data-d="${i}" data-step="0.5" aria-label="${WD[i]} mehr">${icon('plus')}</button></div></div>`).join('')}</div>
      <p class="gfoot">Zeitfenster und deinen Stundenplan trägst du unter „Woche“ ein.</p>`;
    primary = 'Fertig';
  }
  updateSheetBody(bar + body);
  updateSheetFooter(`<div class="wiz-foot"><button type="button" class="btn primary lg block" data-a="wiz-next">${primary}</button>
    <div class="sub">${wiz > 0 ? `<button type="button" class="btn plain" data-a="wiz-back">${icon('chevron-left')}Zurück</button>` : '<span></span>'}
    <button type="button" class="btn plain" data-a="wiz-skip">${wiz === 3 ? 'Später' : 'Überspringen'}</button></div></div>`);
  $('.body', sheetState.sh).scrollTop = 0;
}
const fmtHours = (h) => (Number(h) > 0 ? `${String(h).replace('.', ',')} h` : 'frei');

// ============================================================================
// Screen: Heute – Abfahrtstafel
// ============================================================================
function journey(sc, plan, nowMin) {
  const atPlace = (loc, from, to) => {
    const parts = [];
    if (sc.work && plan.day?.work?.location === loc && sc.work.start < to && sc.work.end > from) parts.push(`Arbeiten ${hm(sc.work.start)}–${hm(sc.work.end)}`);
    for (const e of sc.events) {
      if (e.location !== loc || e.start >= to || e.end <= from) continue;
      if (e.attend === 'skip') parts.push(`${esc(e.title)} auslassen`);
      else if (e.attend === 'late') parts.push(`${esc(e.title)} ab ${hm(e.attendStart)}`);
      else if (e.attend === 'early') parts.push(`${esc(e.title)} bis ${hm(e.attendEnd)}`);
      else parts.push(`${esc(e.title)} ${hm(e.start)}–${hm(e.end)}`);
    }
    return parts.join(' · ');
  };
  const items = [];
  sc.legs.forEach((l, i) => {
    if (i === 0) items.push({ cls: 'place', t: l.depart, title: place(l.from), desc: '' });
    items.push({ cls: `drive${i === 0 && nowMin != null ? ' next' : ''}`, t: l.depart, desc: `${icon('car-front')}${dur(l.minutes)} Fahrt` });
    const until = sc.legs[i + 1]?.depart ?? 1e9;
    const desc = l.to === 'home' ? (i === sc.legs.length - 1 ? 'Feierabend' : '') : atPlace(l.to, l.arrive, until);
    items.push({ cls: 'place', t: l.arrive, title: place(l.to), desc });
  });
  return `<ol class="line">${items.map((x) => `<li class="${x.cls}">
    <span class="tm">${x.cls.startsWith('drive') ? '' : hm(x.t)}</span><span class="rail"><span class="stop"></span></span>
    <span class="what">${x.title ? `<b>${esc(x.title)}</b>` : ''}${x.desc ? `<span>${x.desc}</span>` : ''}</span></li>`).join('')}</ol>`;
}

function spark(curve, leg, nowMin) {
  if (!curve?.points?.length || !leg) return '';
  const pts = curve.points.filter((p) => p[0] >= leg.depart - 180 && p[0] <= leg.depart + 180);
  if (pts.length < 3) return '';
  const W = 340, H = 92, T = 20, B = 18;
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const ys = pts.map((p) => p[1]);
  const lo = Math.min(...ys, leg.minutes) - 3, hi = Math.max(...ys, leg.minutes) + 3;
  const X = (m) => ((m - x0) / (x1 - x0)) * W;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
  const mx = X(leg.depart), my = Y(leg.minutes);
  const nowX = nowMin != null && nowMin > x0 && nowMin < x1 ? X(nowMin) : null;
  const ticks = [];
  for (let m = Math.ceil(x0 / 60) * 60; m <= x1; m += 120) if (X(m) > 26 && X(m) < W - 26) ticks.push(m);
  return `<div class="spark" data-pts='${JSON.stringify(pts)}' data-geo="${x0},${x1},${W}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Erwartete Fahrzeit je Abfahrtszeit, empfohlene Abfahrt ${hm(leg.depart)}">
      ${nowX != null ? `<rect x="0" y="${T}" width="${nowX}" height="${H - T - B}" fill="var(--fill)"/>` : ''}
      ${ticks.map((m) => `<text x="${X(m)}" y="${H - 2}" text-anchor="middle">${hm(m)}</text>`).join('')}
      <path d="${d}" fill="none" stroke="var(--text-3)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${mx}" x2="${mx}" y1="${T - 4}" y2="${H - B}" stroke="var(--accent-fill)" stroke-width="2" stroke-dasharray="3 3"/>
      <circle cx="${mx}" cy="${my}" r="6" fill="var(--accent-fill)" stroke="var(--bg)" stroke-width="3"/>
      <line class="xh" y1="${T}" y2="${H - B}" stroke="var(--text-2)" stroke-width="1" visibility="hidden"/>
    </svg><div class="tip"></div></div>`;
}

function whySentence(leg) {
  const worse = [...leg.around].filter((a) => a.minutes > leg.minutes + 2).sort((a, b) => b.minutes - a.minutes)[0];
  const better = [...leg.around].filter((a) => a.minutes < leg.minutes - 2).sort((a, b) => a.minutes - b.minutes)[0];
  let s = `Um <b>${hm(leg.depart)}</b> brauchst du voraussichtlich <b>${dur(leg.minutes)}</b>.`;
  if (worse) s += ` Um ${hm(worse.depart)} wären es ${dur(worse.minutes)}.`;
  else if (better) s += ' Früher oder später ginge es kaum schneller, ohne dich Freizeit zu kosten.';
  else s += ' Der Verkehr ist um diese Zeit gleichmäßig.';
  return s;
}

const SHORT = { 'Weniger Pendelzeit': 'Weniger Fahrt', 'Früher zu Hause': 'Früher heim', 'Später anfangen': 'Später starten', 'Früher anfangen, früher heim': 'Früher starten', 'Mehr von den Veranstaltungen': 'Mehr Uni', Alternative: 'Option' };

function deltaChips(d) {
  if (!d) return '';
  const out = [];
  if (d.commute) out.push(chip(`${d.commute > 0 ? '+' : '−'}${dur(d.commute)} Fahrt`, d.commute < 0 ? 'green' : 'orange'));
  if (d.arriveHome) out.push(chip(`${dur(d.arriveHome)} ${d.arriveHome < 0 ? 'früher' : 'später'} heim`, d.arriveHome < 0 ? 'green' : ''));
  if (d.optionalMissed) out.push(chip(d.optionalMissed > 0 ? `${dur(d.optionalMissed)} verpasst` : `${dur(d.optionalMissed)} mehr Uni`, d.optionalMissed > 0 ? 'orange' : 'green'));
  return out.join('') || chip('gleichwertig');
}

function viewToday() {
  const plan = S.ov.todayPlan;
  const best = plan.scenarios?.[0];
  const nowMin = S.ov.nowMin;
  const st = plan.state || {};
  const live = S.ov.provider === 'tomtom';
  const transit = st.departedAt != null && st.location;
  const where = transit ? `Unterwegs nach ${esc(place(st.location))}` : st.location && st.location !== 'home' ? `Bei ${esc(place(st.location))}` : 'Zuhause';
  const steps = setupSteps();
  const open = steps.filter((x) => !x.done).length;

  let h = `<div class="view">
    <div class="board-status">
      <span class="live-dot ${live ? '' : 'demo'}"></span>
      <span class="callout t-2" style="flex:1;min-width:0">${where} · ${live ? 'Live-Verkehr' : 'Demo-Verkehr'}</span>
      <button type="button" class="btn plain" data-a="status-sheet">Stimmt nicht?</button>
    </div>`;

  if (plan.warnings?.length) h += `<div class="notes" style="margin-top:16px">${plan.warnings.map((w) => `<div class="note warn">${icon('triangle-alert')}<div class="grow">${esc(w)}</div></div>`).join('')}</div>`;

  const next = best?.legs?.find((l) => l.depart >= nowMin - 5);
  let dock = '';
  if (!best) {
    h += empty({ ic: 'calendar-x', title: 'Heute ist kein Plan möglich', text: 'Arbeitszeit, Termine und Fahrzeiten passen nicht zusammen. Passe den Tag an.' });
    dock = `<button type="button" class="btn primary lg block" data-a="override-today">${icon('pencil')}Heute anpassen</button>`;
  } else if (next && !transit) {
    const inMin = Math.round(next.depart - nowMin);
    const soon = inMin <= 15;
    const prog = Math.max(4, Math.min(100, 100 - (inMin / 120) * 100));
    h += `<section class="board">
      <p class="eyebrow">${inMin <= 0 ? 'Jetzt losfahren' : 'Losfahren'} nach ${esc(place(next.to))}</p>
      <p class="time ${soon ? 'soon' : ''}">${hm(next.depart)}</p>
      <div class="facts"><span><b>${inMin > 0 ? `in ${dur(inMin)}` : 'jetzt'}</b></span><span>${dur(next.minutes)} Fahrt</span><span>an ${hm(next.arrive)}</span></div>
      <div class="countdown ${soon ? 'soon' : ''}" role="progressbar" aria-label="Zeit bis zur Abfahrt" aria-valuenow="${Math.round(prog)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${prog}%"></i></div>
    </section>`;
    dock = `<button type="button" class="btn ${soon ? 'urgent' : 'primary'} lg block" data-a="departed">${icon('car-front')}Ich fahre jetzt los</button>`;
  } else if (transit) {
    const arr = st.availableFrom;
    h += `<section class="board"><p class="eyebrow">Unterwegs nach ${esc(place(st.location))}</p>
      <p class="time">${hm(arr)}</p><div class="facts"><span><b>voraussichtlich an</b></span><span>losgefahren ${hm(st.departedAt)}</span></div></section>`;
    dock = `<button type="button" class="btn primary lg block" data-a="arrived" data-loc="${esc(st.location)}">${icon('map-pin')}Angekommen</button>`;
  } else {
    h += `<section class="board done"><p class="eyebrow">Heute</p><p class="time">Keine Fahrten mehr</p>
      <div class="facts"><span>Schönen Feierabend!</span></div></section>`;
    dock = `<button type="button" class="btn tinted lg block" data-a="tab" data-tab="tomorrow">${icon('calendar')}Morgen ansehen</button>`;
  }

  if (open) h += `<button type="button" class="setup-strip" data-a="wizard"><span class="ring" style="--p:${((4 - open) / 4) * 100}"><b>${4 - open}/4</b></span>
      <span class="main"><b>Einrichtung abschließen</b><span>Nächster Schritt: ${esc(steps.find((x) => !x.done).title)}</span></span>${icon('chevron-right', 'chev')}</button>`;

  if (best?.legs?.length) {
    h += `<section class="section"><div class="section-h"><h2>Dein Tag</h2><span class="caption t-3">${dur(best.totals.commute)} Fahrt</span></div>${journey(best, plan, nowMin)}</section>`;
    if (next && !transit) {
      const curve = plan.curves?.[`${next.from}>${next.to}`];
      h += `<section class="section why"><div class="section-h"><h2>Warum ${hm(next.depart)}?</h2></div><p>${whySentence(next)}</p>${spark(curve, next, nowMin)}</section>`;
    }
    const alts = plan.scenarios.slice(1);
    if (alts.length) {
      h += `<section class="section"><div class="section-h"><h2>Alternativen</h2><span class="caption t-3">${alts.length} weitere</span></div><div class="alts">${alts.map((a, i) => `
        <button type="button" class="alt" data-a="alt" data-i="${i + 1}" data-day="today">${chip(esc(SHORT[a.label] && a.label !== 'Alternative' ? SHORT[a.label] : `Variante ${i + 1}`), 'blue')}
          <div class="big num">${a.legs[0] ? hm(a.legs[0].depart) : '–'}</div>
          <div class="sm">${a.work ? `Feierabend ${hm(a.work.end)} · ` : ''}zu Hause ${hm(a.totals.arriveHome)}</div>
          <div class="delta">${deltaChips(a.diff)}</div></button>`).join('')}</div></section>`;
    }
  }
  h += `<section class="section"><button type="button" class="btn tinted block" data-a="override-today">${icon('pencil')}Heute ist anders …</button></section>`;
  h += `<p class="caption t-3" style="margin-top:24px">Berechnet ${hm(minOfIso(plan.computedAt))} · aktualisiert sich automatisch</p></div>`;
  setDock(dock);
  return h;
}

// ============================================================================
// Screen: Morgen – Tagesansicht mit Zeitachse
// ============================================================================
function agenda(sc, plan) {
  const blocks = [];
  sc.legs.forEach((l, i) => blocks.push({ cls: `drive${i === 0 ? ' first' : ''}`, s: l.depart, e: l.arrive, title: `${place(l.from)} → ${place(l.to)}`, sub: `${hm(l.depart)}–${hm(l.arrive)} · ${dur(l.minutes)}` }));
  if (sc.work) blocks.push({ cls: 'work', s: sc.work.start, e: sc.work.end, title: 'Arbeit', sub: `${hm(sc.work.start)}–${hm(sc.work.end)}${plan.day?.work?.pauseMin ? ` · inkl. ${plan.day.work.pauseMin} min Pause` : ''}` });
  for (const e of sc.events) {
    if (e.attend === 'skip') blocks.push({ cls: 'skip', s: e.start, e: e.end, title: e.title, sub: 'auslassen' });
    else blocks.push({ cls: 'event', s: e.attendStart ?? e.start, e: e.attendEnd ?? e.end, title: e.title, sub: `${hm(e.attendStart ?? e.start)}–${hm(e.attendEnd ?? e.end)}${e.attend === 'late' ? ' · später rein' : e.attend === 'early' ? ' · früher raus' : ''}` });
  }
  if (!blocks.length) return '';
  const from = Math.floor((Math.min(...blocks.map((b) => b.s)) - 20) / 60) * 60;
  const to = Math.ceil((Math.max(...blocks.map((b) => b.e)) + 20) / 60) * 60;
  const PX = 1.15;
  const Y = (m) => (m - from) * PX;
  let hrs = '';
  for (let m = from; m <= to; m += 60) hrs += `<div class="hour" style="top:${Y(m)}px"><span>${hm(m)}</span><i></i></div>`;
  // Nur Blöcke, die sich wirklich überschneiden, teilen sich die Breite
  blocks.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], cEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const b of cluster) { let li = lanes.findIndex((end) => end <= b.s); if (li < 0) { li = lanes.length; lanes.push(0); } lanes[li] = b.e; b.lane = li; }
    for (const b of cluster) b.n = lanes.length;
    cluster = [];
  };
  for (const b of blocks) { if (cluster.length && b.s >= cEnd) flush(); cluster.push(b); cEnd = Math.max(cEnd, b.e); }
  flush();
  return `<div class="agenda" style="height:${Y(to) + 8}px">${hrs}${blocks.map((b) => {
    const hgt = Math.max(24, (b.e - b.s) * PX - 3);
    const pos = b.n > 1 ? `left:calc(52px + (100% - 52px) * ${b.lane / b.n});right:auto;width:calc((100% - 52px) / ${b.n} - 4px);` : '';
    return `<div class="blk ${b.cls}${hgt < 44 ? ' tiny' : ''}" style="top:${Y(b.s) + 1}px;height:${hgt}px;${pos}"><b>${esc(b.title)}</b><span>${esc(b.sub)}</span></div>`;
  }).join('')}</div>`;
}

function viewTomorrow() {
  const plan = S.ov.tomorrowPlan;
  const scs = plan.scenarios || [];
  const opts = scs.slice(0, 3);
  if (S.tVariant >= opts.length) S.tVariant = 0;
  const sc = opts[S.tVariant];
  const best = scs[0];
  let h = `<div class="view">${ph('Morgen', fmtDate(plan.date))}`;
  if (plan.warnings?.length) h += `<div class="notes" style="margin-bottom:16px">${plan.warnings.map((w) => `<div class="note warn">${icon('triangle-alert')}<div class="grow">${esc(w)}</div></div>`).join('')}</div>`;
  setDock(`<button type="button" class="btn primary lg block" data-a="override-tomorrow">${icon('pencil')}Morgen anpassen</button>`);
  if (!sc || !sc.legs.length) {
    h += empty({ ic: 'sun', title: 'Morgen keine Fahrten', text: 'Laut deinem Plan musst du morgen nirgendwo hin. Genieß den Tag!' });
    return `${h}</div>`;
  }
  if (opts.length > 1) {
    const seen = new Set(['Empfohlen']);
    h += seg('tvar', opts.map((o, i) => {
      let l = i === 0 ? 'Empfohlen' : SHORT[o.label] || o.label;
      if (i && (seen.has(l) || l === 'Option')) l = `${hm(o.legs[0]?.depart)} los`;
      seen.add(l);
      return [i, esc(l)];
    }), S.tVariant);
  }
  const delta = (a, b, invert = false) => {
    if (sc === best || a == null || b == null) return '<span class="d">&nbsp;</span>';
    const d = Math.round(a - b);
    if (!d) return '<span class="d t-3">gleich</span>';
    const good = invert ? d > 0 : d < 0;
    return `<span class="d ${good ? 'better' : 'worse'}">${d > 0 ? '+' : '−'}${dur(d)}</span>`;
  };
  h += `<div class="summary-row">
    <div><div class="k">Losfahren</div><div class="v">${hm(sc.legs[0].depart)}</div>${delta(sc.legs[0].depart, best.legs[0]?.depart, true)}</div>
    <div><div class="k">Im Auto</div><div class="v">${dur(sc.totals.commute)}</div>${delta(sc.totals.commute, best.totals.commute)}</div>
    <div><div class="k">Zu Hause</div><div class="v">${hm(sc.totals.arriveHome)}</div>${delta(sc.totals.arriveHome, best.totals.arriveHome)}</div>
  </div>`;
  h += agenda(sc, plan);
  h += `<p class="caption t-3" style="margin-top:16px">Prognose. Morgen früh wird mit der echten Verkehrslage nachjustiert – du bekommst Bescheid, wenn sich etwas ändert.</p></div>`;
  return h;
}

// ============================================================================
// Screen: Woche – Planer
// ============================================================================
const pauseFor = (hours) => { let p = 0; for (const r of S.settings.work.pauseRules || []) if (hours > r.overHours) p = Math.max(p, r.pauseMin); return p; };

function viewWeek() {
  setDock('');
  const s = S.settings;
  if (S.weekDay == null) S.weekDay = wdOf(S.ov.today);
  const d = S.weekDay;
  const day = s.work.days[d] || {};
  const hours = Number(day.hours) || 0;
  const studies = (s.study || []).filter((e) => Number(e.weekday) === d).sort((a, b) => a.start.localeCompare(b.start));
  const pause = pauseFor(hours);

  let h = `<div class="view">${ph('Woche', 'Dein Plan', `<button type="button" class="btn ib primary" data-a="add" aria-label="Vorlesung, Termin oder Ausnahme hinzufügen">${icon('plus')}</button>`)}
    <div class="days" role="group" aria-label="Wochentag wählen">${WDS.map((w, i) => {
      const dh = Number(s.work.days[i]?.hours) || 0;
      const n = (s.study || []).filter((e) => Number(e.weekday) === i).length;
      return `<button type="button" data-a="day" data-d="${i}" aria-pressed="${i === d}" aria-label="${WD[i]}"><b>${w}</b><span>${dh ? `${String(dh).replace('.', ',')}h` : 'frei'}</span><span class="dots">${'<i></i>'.repeat(Math.min(3, n))}</span></button>`;
    }).join('')}</div>
    <section class="daycard"><h2>${WD[d]}</h2>
      <p class="callout t-2" style="margin-top:4px">${hours ? `${fmtHours(hours)} Arbeit${pause ? ` + ${pause} min Pause` : ''} · zwischen ${esc(day.earliest || '06:30')} und ${esc(day.latest || '19:00')}` : 'Kein Arbeitstag'}${studies.length ? ` · ${studies.length} ${studies.length === 1 ? 'Vorlesung' : 'Vorlesungen'}` : ''}</p>
      ${windowBar(day, hours, pause, studies)}
    </section>
    <div style="margin-top:24px">${group([
      `<div class="row" style="cursor:default"><span class="main"><span class="title">Stunden</span><span class="desc">ohne Pause</span></span>
        <div class="stepper"><button type="button" class="btn ib" data-a="hours" data-step="-0.5" aria-label="weniger Stunden">${icon('minus')}</button><output class="num">${fmtHours(hours)}</output><button type="button" class="btn ib" data-a="hours" data-step="0.5" aria-label="mehr Stunden">${icon('plus')}</button></div></div>`,
      ...(hours ? [`<div class="fgrid">${field('Frühestens ab', `<input type="time" data-wf="earliest" value="${esc(day.earliest || '06:30')}">`)}${field('Spätestens fertig', `<input type="time" data-wf="latest" value="${esc(day.latest || '19:00')}">`)}</div>`] : []),
    ], { title: 'Arbeit', foot: hours ? 'In diesem Fenster sucht die App den besten Arbeitsbeginn.' : '' })}</div>
    <div style="margin-top:24px">${group(studies.length
      ? [...studies.map((e) => row({ title: esc(e.title), desc: `${esc(e.start)}–${esc(e.end)} · ${esc(place(e.location))}`, val: e.kind === 'optional' ? 'optional' : 'Pflicht', valCls: e.kind === 'optional' ? '' : 'todo', action: 'edit-study', data: `data-id="${esc(e.id)}"` })), addRow('Vorlesung hinzufügen', 'study')]
      : [addRow('Vorlesung hinzufügen', 'study')], { title: 'Vorlesungen' })}</div>`;

  const upcoming = (s.appointments || []).filter((a) => a.date >= S.ov.today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  h += `<div style="margin-top:24px">${group([...upcoming.slice(0, 12).map((a) => row({ title: esc(a.title), desc: `${fmtShort(a.date)} · ${esc(a.start)}–${esc(a.end)} · ${esc(place(a.location))}`, action: 'edit-appt', data: `data-id="${esc(a.id)}"` })), addRow('Termin hinzufügen', 'appt')], { title: 'Nächste Termine' })}</div>`;
  const ovs = Object.entries(s.overrides || {}).filter(([dt]) => dt >= S.ov.today).sort();
  if (ovs.length) h += `<div style="margin-top:24px">${group(ovs.map(([dt, o]) => row({ title: fmtDate(dt), desc: o.work ? `${fmtHours(o.work.hours)} · ${esc(o.work.earliest)}–${esc(o.work.latest)}` : 'frei', action: 'del-override', data: `data-date="${dt}"`, val: 'entfernen', chev: false })), { title: 'Ausnahmen' })}</div>`;
  h += `<div style="margin-top:24px">${group([
    row({ title: 'Pause', desc: (s.work.pauseRules || []).map((r) => `ab mehr als ${String(r.overHours).replace('.', ',')} h → ${r.pauseMin} min`).join(' · '), action: 'pause-sheet' }),
    row({ title: 'Arbeitsort', val: esc(place(s.work.location)), action: 'workloc-sheet' }),
  ], { title: 'Regeln' })}</div></div>`;
  return h;
}
const addRow = (label, kind) => `<button type="button" class="row" data-a="add" data-kind="${kind}"><span class="main"><span class="title" style="color:var(--primary);display:flex;align-items:center;gap:8px">${icon('plus')}${label}</span></span></button>`;

function windowBar(day, hours, pause, studies) {
  const A = 300, Z = 1320; // 05–22 Uhr
  const P = (m) => Math.max(0, Math.min(100, ((m - A) / (Z - A)) * 100));
  const e = parseHM(day.earliest || '06:30'), l = parseHM(day.latest || '19:00');
  const len = hours * 60 + pause;
  return `<div class="window" aria-hidden="true"><div class="track">
    ${hours ? `<div class="span" style="left:${P(e)}%;width:${P(l) - P(e)}%"></div><div class="work" style="left:${P(e)}%;width:${P(e + len) - P(e)}%;opacity:.3"></div>` : ''}
    ${studies.map((x) => `<div class="ev ${x.kind === 'optional' ? 'opt' : ''}" style="left:${P(parseHM(x.start))}%;width:${P(parseHM(x.end)) - P(parseHM(x.start))}%"></div>`).join('')}
  </div><div class="ticks"><span>5</span><span>9</span><span>13</span><span>17</span><span>22 Uhr</span></div></div>`;
}

// ============================================================================
// Screen: Einblicke
// ============================================================================
function viewInsights() {
  setDock('');
  const st = S.stats;
  let h = `<div class="view">${ph('Einblicke', 'Was die App gelernt hat')}`;
  if (!st) {
    loadStats();
    return `${h}<div class="skel" style="height:34px;width:80%"></div><div class="skel" style="height:34px;width:60%;margin-top:8px"></div><div class="skel" style="height:260px;margin-top:24px;border-radius:14px"></div></div>`;
  }
  if (st.error) return `${h}${errorNote(st.error)}</div>`;
  const wl = S.settings.work.location;
  const key = S.heatDir === 'out' ? `home>${wl}` : `${wl}>home`;
  const cells = st.heat?.[key] || {};
  const vals = Object.entries(cells);
  const totalCells = Object.values(st.heat || {}).reduce((n, c) => n + Object.keys(c).length, 0);
  if (st.samples < 8 || totalCells < 4) {
    const hasKey = !!S.settings.traffic.tomtomKey;
    h += empty({
      ic: 'sparkles', title: 'Ich lerne noch',
      text: hasKey ? `Ich messe regelmäßig deine Strecke. Bisher ${st.samples} Messungen an ${st.days} ${st.days === 1 ? 'Tag' : 'Tagen'}. Nach ein paar Tagen siehst du hier, wann du am schnellsten bist.` : 'Sobald Verkehrsdaten verbunden sind, messe ich deine Strecke regelmäßig und zeige dir hier deine besten und schlechtesten Zeiten.',
      action: hasKey ? '' : 'wizard', label: 'Verkehrsdaten verbinden',
    });
    if (hasKey) {
      const pct = Math.min(10, Math.round((st.days / 14) * 10));
      h += `<p class="overline">Bis die Muster aussagekräftig sind (≈ 2 Wochen)</p><div class="meter">${Array.from({ length: 10 }, (_, i) => `<i class="${i < pct ? 'on' : ''}"></i>`).join('')}</div>`;
    }
    return `${h}</div>`;
  }
  const dirSeg = `<div style="margin-top:24px">${seg('heat', [['out', `${esc(place('home'))} → ${esc(place(wl))}`], ['back', `${esc(place(wl))} → ${esc(place('home'))}`]], S.heatDir)}</div>`;
  if (!vals.length) return `${h}${dirSeg}${empty({ ic: 'route', title: 'Für diese Richtung noch keine Daten', text: 'Wechsle die Richtung oder schau in ein paar Tagen wieder vorbei.' })}</div>`;
  const worst = vals.reduce((a, b) => (b[1].median > a[1].median ? b : a));
  const bestC = vals.reduce((a, b) => (b[1].median < a[1].median ? b : a));
  const [ww, wm] = worst[0].split('|').map(Number);
  const [bw, bm] = bestC[0].split('|').map(Number);
  h += `<h2 class="insight-head">${WD[ww]}s um ${hm(wm)} brauchst du am längsten – <em>${Math.round(worst[1].median)} min</em>.</h2>
    <p class="callout t-2" style="margin-top:12px">Am schnellsten: ${WD[bw]}s um ${hm(bm)} mit ${Math.round(bestC[1].median)} min.</p>${dirSeg}`;
  const all = vals.map(([, v]) => v.median);
  const lo = Math.min(...all), hi = Math.max(...all);
  const lvl = (v) => Math.min(6, Math.floor(((v - lo) / Math.max(1, hi - lo)) * 6.999));
  let g = `<div class="heat" aria-label="Typische Fahrzeit je Wochentag und Uhrzeit"><span></span>${WDS.slice(0, 5).map((x) => `<span class="hh">${x}</span>`).join('')}`;
  for (let m = 300; m < 1260; m += 30) {
    g += `<span class="hl">${m % 60 === 0 ? hm(m).slice(0, 2) : ''}</span>`;
    for (let wd = 0; wd < 5; wd++) {
      const c = cells[`${wd}|${m}`];
      g += c ? `<button type="button" class="c${S.heatSel === `${wd}|${m}` ? ' sel' : ''}" style="background:var(--heat-${lvl(c.median)})" data-a="heat-cell" data-k="${wd}|${m}" aria-label="${WD[wd]} ${hm(m)}: ${c.median} min"></button>` : '<span class="c" style="cursor:default"></span>';
    }
  }
  g += '</div>';
  const sel = S.heatSel && cells[S.heatSel];
  const [sw, sm] = (S.heatSel || '0|0').split('|').map(Number);
  h += g + `<div class="heat-legend">${Math.round(lo)} min ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--heat-${i})"></i>`).join('')} ${Math.round(hi)} min</div>
    <p class="heat-read">${sel ? `<b>${WD[sw]} ${hm(sm)}</b>: im Schnitt ${sel.median} min (${sel.n} Messungen)` : 'Tippe auf ein Feld für Details.'}</p>`;
  const acc = st.accuracy || {};
  h += `<section class="section"><div class="section-h"><h2>Treffsicherheit</h2></div><div class="stats2">
    <div><div class="v num">${acc.app ? `±${String(acc.app.mae).replace('.', ',')}<small>min</small>` : '–'}</div><div class="k">Abweichung der Vortags-Prognose dieser App</div></div>
    <div><div class="v num">${acc.service ? `±${String(acc.service.mae).replace('.', ',')}<small>min</small>` : '–'}</div><div class="k">Abweichung der reinen TomTom-Prognose</div></div>
  </div><p class="caption t-3" style="margin-top:16px">${st.samples} Messungen an ${st.days} Tagen · ${st.trips} selbst gemeldete Fahrten</p></section></div>`;
  return h;
}
async function loadStats() {
  if (loadStats.busy) return;
  loadStats.busy = true;
  try { S.stats = await api('/stats'); } catch (e) { S.stats = { error: e.message }; }
  loadStats.busy = false;
  if (S.tab === 'insights') rerenderKeepScroll();
}

// ============================================================================
// Screen: Mehr (Einstellungen)
// ============================================================================
function viewMore() {
  const s = S.settings;
  if (S.sub && SUBS[S.sub]) return SUBS[S.sub]();
  setDock('');
  const open = setupSteps().filter((x) => !x.done).length;
  const nLoc = Object.values(s.locations).filter((l) => l.lat != null).length;
  return `<div class="view">${ph('Mehr')}
    <div class="profile"><img class="logo" src="${LOGO}" alt=""><div style="min-width:0"><b>Pendelpilot</b><span>${S.ov.provider === 'tomtom' ? 'Live-Verkehr aktiv' : 'Demo-Verkehr'} · Benachrichtigungen ${s.notify.ntfyTopic ? 'an' : 'aus'}</span></div></div>
    ${open ? group([row({ title: 'Einrichtung abschließen', desc: `${4 - open} von 4 erledigt`, tile: 'sparkles', action: 'wizard' })], { icons: true }) + '<div style="height:24px"></div>' : ''}
    ${group([
      row({ title: 'Verkehrsdaten', tile: 'navigation', val: s.traffic.tomtomKey ? 'Verbunden' : 'Fehlt', valCls: s.traffic.tomtomKey ? 'ok' : 'todo', action: 'sub', data: 'data-sub="traffic"' }),
      row({ title: 'Orte', tile: 'map-pin', tileCls: 'red', val: `${nLoc} ${nLoc === 1 ? 'Ort' : 'Orte'}`, action: 'sub', data: 'data-sub="places"' }),
      row({ title: 'Benachrichtigungen', tile: 'bell', tileCls: 'orange', val: s.notify.ntfyTopic ? 'An' : 'Aus', valCls: s.notify.ntfyTopic ? 'ok' : 'todo', action: 'sub', data: 'data-sub="notify"' }),
    ], { icons: true })}
    <div style="height:24px"></div>
    ${group([
      row({ title: 'Was ist dir wichtig?', tile: 'sliders-horizontal', tileCls: 'indigo', action: 'sub', data: 'data-sub="prio"' }),
      row({ title: 'Feintuning', tile: 'clock', tileCls: 'gray', action: 'sub', data: 'data-sub="tuning"' }),
    ], { icons: true })}
    <div style="height:24px"></div>
    ${group([
      row({ title: 'Darstellung', tile: 'sun-moon', tileCls: 'gray', val: { auto: 'Automatisch', light: 'Hell', dark: 'Dunkel' }[theme()], action: 'sub', data: 'data-sub="look"' }),
      row({ title: 'Sicherung', tile: 'download', tileCls: 'green', action: 'sub', data: 'data-sub="backup"' }),
      row({ title: 'Verbindung', tile: 'link', tileCls: 'gray', action: 'sub', data: 'data-sub="conn"' }),
    ], { icons: true })}
    <p class="caption t-3" style="margin-top:24px">Pendelpilot · Verkehrsdaten © TomTom · Icons Lucide</p>
  </div>`;
}

const level = (v, max) => { const r = v / max; return r < 0.15 ? 'unwichtig' : r < 0.4 ? 'etwas' : r < 0.65 ? 'mittel' : r < 0.85 ? 'wichtig' : 'sehr wichtig'; };
const SUBS = {
  traffic() {
    const t = S.settings.traffic;
    setDock(`<button type="button" class="btn primary lg block" data-a="save-traffic">Speichern</button>`);
    return `<div class="view">${back()}${ph('Verkehrsdaten')}
      <p class="callout t-2" style="margin:-8px 0 20px">Mit einem kostenlosen TomTom-Schlüssel nutzt die App echte Prognosen und die Live-Lage. Kostenlos bis 2.500 Abfragen am Tag – die App braucht etwa 300–700.</p>
      ${group([field('TomTom-Schlüssel', `<input id="f-key" value="${esc(t.tomtomKey)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="hier einfügen">`)])}
      <a class="btn tinted block" style="margin-top:12px" href="https://developer.tomtom.com/user/register" target="_blank" rel="noopener">${icon('external-link')}Kostenlosen Schlüssel holen</a>
      <div style="height:24px"></div>
      ${group([
        field('Quelle', `<select id="f-prov"><option value="tomtom" ${t.provider !== 'demo' ? 'selected' : ''}>TomTom (empfohlen)</option><option value="demo" ${t.provider === 'demo' ? 'selected' : ''}>Demo-Modell</option></select>`),
        field('Höchstens Abfragen pro Tag', `<input id="f-limit" type="number" inputmode="numeric" value="${t.apiDailyLimit}">`, { hint: `Heute verbraucht: ${S.ov.usage}` }),
      ], { title: 'Erweitert' })}</div>`;
  },
  places() {
    const s = S.settings;
    setDock(`<button type="button" class="btn primary lg block" data-a="place-edit" data-k="">${icon('plus')}Ort hinzufügen</button>`);
    return `<div class="view">${back()}${ph('Orte')}
      ${!s.traffic.tomtomKey ? `<div class="note warn" style="margin-bottom:16px">${icon('info')}<div class="grow callout">Für die Adresssuche zuerst die Verkehrsdaten verbinden.</div></div>` : ''}
      ${group(Object.entries(s.locations).map(([k, l]) => row({ title: esc(l.label), desc: l.address ? esc(l.address) : 'Adresse fehlt', val: l.lat != null ? 'gefunden' : 'fehlt', valCls: l.lat != null ? 'ok' : 'todo', action: 'place-edit', data: `data-k="${esc(k)}"` })))}
      <p class="gfoot">Tippe auf einen Ort, um die Adresse zu ändern oder in Google Maps zu prüfen.</p></div>`;
  },
  notify() {
    const n = S.settings.notify;
    setDock(n.ntfyTopic ? `<button type="button" class="btn primary lg block" data-a="test-push">${icon('send')}Test senden</button>` : `<button type="button" class="btn primary lg block" data-a="new-topic">${icon('sparkles')}Benachrichtigungen einrichten</button>`);
    const hist = S.ov.notifications || [];
    return `<div class="view">${back()}${ph('Benachrichtigungen')}
      ${n.ntfyTopic ? group([`<div class="field"><span>Dein Thema in der App ntfy</span><div class="topic selectable">${esc(n.ntfyTopic)}</div></div>`, row({ title: 'Thema kopieren', tile: 'copy', action: 'copy-topic', chev: false }), row({ title: 'Neues Thema erzeugen', desc: 'Danach in ntfy neu abonnieren', tile: 'rotate-cw', tileCls: 'gray', action: 'new-topic', chev: false })], { icons: true, title: 'Verbindung' })
        : `<p class="callout t-2" style="margin:-8px 0 16px">Installiere die kostenlose App <b>ntfy</b>, tippe dann unten auf „einrichten“ und abonniere das angezeigte Thema.</p>
          <div style="display:flex;gap:8px"><a class="btn block" href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">${icon('smartphone')}iPhone</a><a class="btn block" href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">${icon('smartphone')}Android</a></div>`}
      <div style="height:24px"></div>
      ${group([`<div class="fgrid">
        ${field('Vorabend-Prognose', `<input type="time" data-nf="eveningTime" value="${esc(n.eveningTime)}">`)}
        ${field('Losfahr-Hinweis', `<select data-nf="leadMin">${[5, 10, 15, 20, 30].map((v) => `<option value="${v}" ${Number(n.leadMin) === v ? 'selected' : ''}>${v} min vorher</option>`).join('')}</select>`)}
        ${field('Ruhe ab', `<input type="time" data-nf="quietStart" value="${esc(n.quietStart)}">`)}
        ${field('Ruhe bis', `<input type="time" data-nf="quietEnd" value="${esc(n.quietEnd)}">`)}</div>`,
        field('Melden, wenn sich die beste Zeit verschiebt um', `<select data-nf="changeThresholdMin">${[3, 5, 10, 15].map((v) => `<option value="${v}" ${Number(n.changeThresholdMin) === v ? 'selected' : ''}>mindestens ${v} min</option>`).join('')}</select>`)], { title: 'Wann' })}
      ${hist.length ? `<div style="height:24px"></div>${group(hist.slice(0, 8).map((x) => row({ title: esc(x.title), desc: esc(x.message), val: hm(minOfIso(x.ts)) })), { title: 'Zuletzt gesendet' })}` : ''}
    </div>`;
  },
  prio() {
    const P = S.settings.priorities;
    setDock('');
    const sl = (k, title, txt, max, left, right) => `<div class="prio"><div class="top"><b>${title}</b><output id="o-${k}">${level(P[k], max)}</output></div><p>${txt}</p>
      <input type="range" min="0" max="${max}" step="0.05" value="${P[k]}" data-prio="${k}" data-max="${max}" style="--fillp:${(P[k] / max) * 100}%" aria-label="${title}">
      <div class="ends"><span>${left}</span><span>${right}</span></div></div>`;
    return `<div class="view">${back()}${ph('Was ist dir wichtig?')}
      <p class="callout t-2" style="margin:-8px 0 20px">Pflichttermine und deine Arbeitszeit hält die App immer ein. Hier legst du fest, wie sie den Rest abwägt.</p>
      ${group([
        sl('commute', 'Wenig im Auto sitzen', 'Wie sehr dich jede Minute Fahrt stört.', 2, 'egal', 'sehr wichtig'),
        sl('away', 'Früh wieder zu Hause sein', 'Freizeit zu Hause statt Warten unterwegs.', 1.5, 'egal', 'sehr wichtig'),
        sl('optionalMissed', 'Optionale Vorlesungen besuchen', 'Ob die App vorschlagen darf, sie für weniger Stau auszulassen.', 3, 'darf ausfallen', 'möglichst hin'),
      ])}<p class="gfoot">Änderungen gelten sofort.</p></div>`;
  },
  tuning() {
    const PL = S.settings.planning;
    setDock('');
    return `<div class="view">${back()}${ph('Feintuning')}
      ${group([`<div class="fgrid">
        ${field('Puffer vor Terminen', `<select data-pf="bufferMin">${[0, 5, 10, 15, 20].map((v) => `<option value="${v}" ${Number(PL.bufferMin) === v ? 'selected' : ''}>${v} min</option>`).join('')}</select>`)}
        ${field('Nach Feierabend warten', `<select data-pf="maxWaitAfterMin">${[0, 30, 60, 90, 120, 180].map((v) => `<option value="${v}" ${Number(PL.maxWaitAfterMin) === v ? 'selected' : ''}>${v ? `bis ${dur(v)}` : 'nie'}</option>`).join('')}</select>`)}
        ${field('Fahrzeit ohne Verkehr', `<input type="number" inputmode="numeric" data-pf="baseTravelMin" value="${PL.baseTravelMin}">`, { hint: 'Minuten, nur bis echte Daten da sind' })}
        ${field('Zeitraster', `<select data-pf="stepMin">${[5, 10, 15].map((v) => `<option value="${v}" ${Number(PL.stepMin) === v ? 'selected' : ''}>${v} min</option>`).join('')}</select>`)}</div>`])}
      <p class="gfoot">Änderungen werden automatisch gespeichert.</p></div>`;
  },
  look() {
    setDock('');
    return `<div class="view">${back()}${ph('Darstellung')}${seg('theme', [['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], theme())}
      <p class="gfoot" style="margin-top:12px">„Automatisch“ folgt der Einstellung deines Handys.</p></div>`;
  },
  backup() {
    setDock(`<button type="button" class="btn primary lg block" data-a="export">${icon('download')}Sicherung speichern</button>`);
    return `<div class="view">${back()}${ph('Sicherung')}
      <p class="callout t-2" style="margin:-8px 0 20px">Speichert Arbeitszeiten, Stundenplan, Termine, Orte und Einstellungen als Datei. Damit kannst du alles wiederherstellen.</p>
      ${group([row({ title: 'Aus Datei wiederherstellen', tile: 'upload', tileCls: 'gray', action: 'import', chev: false })], { icons: true, foot: 'Ersetzt deine aktuellen Daten. Vorher wird nachgefragt.' })}
      <input type="file" id="f-file" accept="application/json,.json" hidden></div>`;
  },
  conn() {
    setDock('');
    return `<div class="view">${back()}${ph('Verbindung')}
      ${group([row({ title: 'Server', desc: esc(conn().api) })])}
      <div style="height:24px"></div>${group([row({ title: 'Von diesem Gerät abmelden', cls: 'danger', action: 'logout', chev: false })], { foot: 'Deine Daten bleiben auf dem Server erhalten.' })}</div>`;
  },
};

// ============================================================================
// Sheets: Hinzufügen / Bearbeiten / Tag anpassen / Status / Orte
// ============================================================================
const locOptions = (sel) => Object.keys(S.settings.locations).map((k) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(place(k))}</option>`).join('');
const KIND_HINT = { mandatory: 'Wird nie verpasst. Die App plant alles andere darum herum.', optional: 'Die App darf vorschlagen, sie auszulassen oder nur teilweise zu besuchen, wenn du dadurch viel Stau sparst.' };

function openAdd(kind = 'study', item = null) {
  const draw = (k) => {
    const e = item || {};
    const d = S.weekDay ?? 0;
    let body = item ? '' : `<div style="margin-bottom:16px">${seg('addkind', [['study', 'Vorlesung'], ['appt', 'Termin'], ['off', 'Ausnahme']], k)}</div>`;
    if (k === 'study') {
      body += `<div class="group">${field('Titel', `<input id="a-title" maxlength="80" value="${esc(e.title || '')}" placeholder="z. B. Statistik" enterkeyhint="done">`)}
        <div class="fgrid">${field('Wochentag', `<select id="a-wd">${WD.map((w, i) => `<option value="${i}" ${Number(e.weekday ?? d) === i ? 'selected' : ''}>${w}</option>`).join('')}</select>`)}
        ${field('Ort', `<select id="a-loc">${locOptions(e.location || 'uni')}</select>`)}
        ${field('Von', `<input type="time" id="a-start" value="${esc(e.start || '10:00')}">`)}
        ${field('Bis', `<input type="time" id="a-end" value="${esc(e.end || '11:30')}">`)}</div></div>
        <div style="margin-top:16px">${seg('akind', [['mandatory', 'Pflicht'], ['optional', 'Optional']], e.kind || 'mandatory')}</div>
        <p class="gfoot" id="a-kindhint">${KIND_HINT[e.kind || 'mandatory']}</p>`;
    } else if (k === 'appt') {
      body += `<div class="group">${field('Titel', `<input id="a-title" maxlength="80" value="${esc(e.title || '')}" placeholder="z. B. Arzt, Training" enterkeyhint="done">`)}
        <div class="fgrid">${field('Datum', `<input type="date" id="a-date" value="${esc(e.date || S.ov.tomorrow)}" min="${S.ov.today}">`)}
        ${field('Ort', `<select id="a-loc">${locOptions(e.location || 'home')}</select>`)}
        ${field('Von', `<input type="time" id="a-start" value="${esc(e.start || '18:00')}">`)}
        ${field('Bis', `<input type="time" id="a-end" value="${esc(e.end || '19:00')}">`)}</div></div>
        <div style="margin-top:16px">${seg('akind', [['mandatory', 'Fest'], ['optional', 'Optional']], e.kind || 'mandatory')}</div>
        <p class="gfoot" id="a-kindhint">${KIND_HINT[e.kind || 'mandatory']}</p>`;
    } else {
      body += overrideForm(S.ov.tomorrow, true);
    }
    updateSheetBody(body);
    updateSheetFooter(`<div style="display:flex;gap:8px">${item ? `<button type="button" class="btn danger lg" data-a="del-item" data-kind="${k}" data-id="${esc(e.id)}" aria-label="Löschen">${icon('trash-2')}</button>` : ''}
      <button type="button" class="btn primary lg" style="flex:1" data-a="save-item" data-kind="${k}" data-id="${esc(e.id || '')}">${item ? 'Speichern' : k === 'off' ? 'Übernehmen' : 'Hinzufügen'}</button></div>`);
  };
  openSheet({ title: item ? (kind === 'study' ? 'Vorlesung bearbeiten' : 'Termin bearbeiten') : 'Hinzufügen', body: '', onMount: () => draw(kind) });
  openAdd.draw = draw;
}

function overrideForm(date, withDate = false) {
  const ov = S.settings.overrides?.[date];
  const w = ov && 'work' in ov ? ov.work : S.settings.work.days[wdOf(date)];
  const hours = Number(w?.hours) || 0;
  return `<p class="lead">Für einen einzelnen Tag, der anders ist – z. B. kürzer arbeiten oder frei.</p>
    <div class="group">${withDate ? field('Datum', `<input type="date" id="o-date" value="${date}" min="${S.ov.today}">`) : ''}
    <div class="row" style="cursor:default"><span class="main"><span class="title">Stunden</span><span class="desc">„frei“ = nicht arbeiten</span></span>
      <div class="stepper"><button type="button" class="btn ib" data-a="o-hours" data-step="-0.5" aria-label="weniger">${icon('minus')}</button><output class="num" id="o-hours" data-v="${hours}">${fmtHours(hours)}</output><button type="button" class="btn ib" data-a="o-hours" data-step="0.5" aria-label="mehr">${icon('plus')}</button></div></div>
    <div class="fgrid">${field('Frühestens ab', `<input type="time" id="o-earliest" value="${esc(w?.earliest || '06:30')}">`)}${field('Spätestens fertig', `<input type="time" id="o-latest" value="${esc(w?.latest || '19:00')}">`)}</div></div>
    ${ov ? `<button type="button" class="btn plain" style="margin-top:12px" data-a="del-override" data-date="${date}">Ausnahme entfernen – normaler Plan gilt</button>` : ''}`;
}
function openOverride(date, label) {
  openSheet({ title: `${label} anpassen`, body: overrideForm(date), footer: `<button type="button" class="btn primary lg block" data-a="save-override" data-date="${date}">Übernehmen</button>` });
}

function openStatus() {
  const st = S.ov.todayPlan.state || {};
  const locs = Object.keys(S.settings.locations);
  openSheet({
    title: 'Wo bist du gerade?',
    body: `<p class="lead">Die App geht davon aus, dass du dich an die Empfehlung hältst. Wenn nicht, sag es ihr – dann plant sie ab hier neu.</p>
      ${group(locs.map((k) => row({ title: k === 'home' ? 'Ich bin zu Hause' : `Ich bin bei ${esc(place(k))}`, tile: k === 'home' ? 'house' : 'map-pin', tileCls: k === 'home' ? '' : 'red', action: 'arrived', data: `data-loc="${esc(k)}"`, val: st.location === k && st.departedAt == null ? 'aktuell' : '', valCls: 'ok', chev: false })), { icons: true, title: 'Angekommen' })}
      <div style="height:20px"></div>
      ${group([row({ title: 'Ich bin gerade losgefahren', tile: 'car-front', action: 'departed', chev: false }), row({ title: 'Status für heute zurücksetzen', tile: 'rotate-cw', tileCls: 'gray', action: 'reset-state', chev: false })], { icons: true })}`,
  });
}

function openAlt(i, dayKey) {
  const plan = dayKey === 'today' ? S.ov.todayPlan : S.ov.tomorrowPlan;
  const a = plan.scenarios[i];
  if (!a) return;
  openSheet({
    title: SHORT[a.label] || a.label,
    body: `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${deltaChips(a.diff)}</div>
      <p class="callout t-2">${esc(a.diffText || '')} – im Vergleich zur Empfehlung.</p>${journey(a, plan, null)}
      <p class="gfoot" style="margin:16px 0 0">So fahren? Fahr einfach zur angegebenen Zeit los und tippe „Ich fahre jetzt los“ – die App plant ab dann mit deiner echten Zeit weiter.</p>`,
  });
}

function openPlace(k) {
  const isNew = !k;
  const key = k || `ort_${uid()}`;
  const l = S.settings.locations[key] || { label: '', address: '', lat: null, lon: null };
  const draw = (hit) => {
    const cur = hit || l;
    updateSheetBody(`<div class="group">${field('Name', `<input id="p-label" value="${esc($('#p-label')?.value ?? l.label)}" maxlength="30" placeholder="z. B. Fitnessstudio">`)}
      ${field('Adresse', `<div class="inline-field"><input id="p-addr" value="${esc(cur.address)}" placeholder="Straße Nr., Ort" enterkeyhint="search"><button type="button" class="btn tinted" data-a="p-search">Suchen</button></div>`,
        { hint: cur.lat != null ? `<span style="color:var(--success)">✓ gefunden</span> · <a href="https://www.google.com/maps/search/?api=1&query=${cur.lat},${cur.lon}" target="_blank" rel="noopener">In Google Maps prüfen ↗</a>` : 'Mit „Suchen“ findet die App die genaue Position.' })}</div>
      ${!isNew && !['home', 'work'].includes(key) ? `<button type="button" class="btn plain" style="margin-top:12px;color:var(--danger)" data-a="p-delete" data-k="${key}">Ort löschen</button>` : ''}`);
    updateSheetFooter(`<button type="button" class="btn primary lg block" data-a="p-save" data-k="${key}">Speichern</button>`);
    openPlace.hit = hit || null;
  };
  openSheet({ title: isNew ? 'Neuer Ort' : place(key), body: '', onMount: () => draw(null) });
  openPlace.draw = draw;
}

// ============================================================================
// Aktionen (ein zentraler Klick-Handler)
// ============================================================================
const A = {
  tab(b) { const t = b.dataset.tab; if (t === S.tab && !S.sub) return window.scrollTo({ top: 0, behavior: 'smooth' }); S.tab = t; S.sub = null; store.set('tab', S.tab); closeSheet(true); render(); },
  retry() { S.error = null; S.loading = true; load(); },
  'close-sheet'() { closeSheet(); },
  back() { S.sub = null; render(); },
  sub(b) { S.sub = b.dataset.sub; render(); },
  wizard() { openWizard(); },
  'status-sheet'() { openStatus(); },
  'override-today'() { openOverride(S.ov.today, 'Heute'); },
  'override-tomorrow'() { openOverride(S.ov.tomorrow, 'Morgen'); },
  alt(b) { openAlt(Number(b.dataset.i), b.dataset.day); },
  add(b) { openAdd(b.dataset.kind || 'study'); },
  'edit-study'(b) { const e = S.settings.study.find((x) => x.id === b.dataset.id); if (e) openAdd('study', e); },
  'edit-appt'(b) { const e = S.settings.appointments.find((x) => x.id === b.dataset.id); if (e) openAdd('appt', e); },
  day(b) { S.weekDay = Number(b.dataset.d); rerenderKeepScroll(); },
  'heat-cell'(b) { S.heatSel = b.dataset.k; rerenderKeepScroll(); },
  'place-edit'(b) { openPlace(b.dataset.k); },
  'pause-sheet'() {
    const r = S.settings.work.pauseRules?.[0] || { overHours: 6, pauseMin: 30 };
    openSheet({
      title: 'Pause',
      body: `<p class="lead">Ab einer bestimmten Arbeitszeit kommt automatisch eine Pause dazu – z. B. 8 h Arbeit + 30 min = 8,5 h vor Ort.</p>
      <div class="group"><div class="fgrid">${field('Bei mehr als', `<select id="pr-over">${[4, 5, 6, 7, 8].map((v) => `<option value="${v}" ${Number(r.overHours) === v ? 'selected' : ''}>${v} Stunden</option>`).join('')}</select>`)}
      ${field('Pause', `<select id="pr-min">${[0, 15, 30, 45, 60].map((v) => `<option value="${v}" ${Number(r.pauseMin) === v ? 'selected' : ''}>${v} min</option>`).join('')}</select>`)}</div></div>`,
      footer: '<button type="button" class="btn primary lg block" data-a="save-pause">Übernehmen</button>',
    });
  },
  'save-pause'(b) {
    saveSettings((s) => { s.work.pauseRules = [{ overHours: Number($('#pr-over').value), pauseMin: Number($('#pr-min').value) }, ...(s.work.pauseRules || []).slice(1)]; }, 'Pause gespeichert', { button: b }).then((ok) => ok && closeSheet());
  },
  'workloc-sheet'() {
    openSheet({ title: 'Arbeitsort', body: `<p class="lead">Wo arbeitest du? Weitere Orte legst du unter Mehr → Orte an.</p>${group(Object.keys(S.settings.locations).map((k) => row({ title: esc(place(k)), desc: esc(S.settings.locations[k].address || ''), action: 'set-workloc', data: `data-k="${esc(k)}"`, val: S.settings.work.location === k ? 'gewählt' : '', valCls: 'ok', chev: false })))}` });
  },
  'set-workloc'(b) { saveSettings((s) => { s.work.location = b.dataset.k; }, 'Arbeitsort gespeichert').then((ok) => ok && closeSheet()); },

  seg(b) {
    const name = b.dataset.seg, v = b.dataset.v;
    $$(`[data-seg="${name}"]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (name === 'tvar') { S.tVariant = Number(v); rerenderKeepScroll(); }
    else if (name === 'heat') { S.heatDir = v; S.heatSel = null; rerenderKeepScroll(); }
    else if (name === 'theme') { if (v === 'auto') store.del('theme'); else store.set('theme', v); applyTheme(v); }
    else if (name === 'addkind') openAdd.draw(v);
    else if (name === 'akind') { const h = $('#a-kindhint'); if (h) h.textContent = KIND_HINT[v]; }
  },

  hours(b) {
    const d = S.weekDay;
    const cur = Number(S.settings.work.days[d]?.hours) || 0;
    const next = num(cur + Number(b.dataset.step), 0, 12, 0);
    if (next === cur) return;
    S.settings.work.days[d] = { earliest: '06:30', latest: '19:00', ...(S.settings.work.days[d] || {}), hours: next };
    rerenderKeepScroll();
    saveSettings((s) => { s.work.days[d] = { ...S.settings.work.days[d] }; s.planReviewed = true; }, '', { rerender: false });
  },
  'o-hours'(b) {
    const o = $('#o-hours');
    const v = num(Number(o.dataset.v) + Number(b.dataset.step), 0, 12, 0);
    o.dataset.v = v; o.textContent = fmtHours(v);
  },
  'save-override'(b) {
    const date = $('#o-date')?.value || b.dataset.date;
    const hours = Number($('#o-hours').dataset.v);
    const e = $('#o-earliest').value, l = $('#o-latest').value;
    if (!date) return toast('Bitte ein Datum wählen', 'err');
    if (hours > 0 && (!e || !l || l <= e)) return toast('„Spätestens“ muss nach „frühestens“ liegen', 'err');
    saveSettings((s) => { s.overrides ||= {}; s.overrides[date] = { ...(s.overrides[date] || {}), work: hours > 0 ? { hours, earliest: e, latest: l } : null }; }, hours ? 'Tag angepasst' : 'Als frei eingetragen', { button: b }).then((ok) => ok && closeSheet());
  },
  'del-override'(b) {
    const d = b.dataset.date;
    if (!confirm(`Ausnahme für ${fmtDate(d)} entfernen? Dann gilt wieder dein normaler Plan.`)) return;
    saveSettings((s) => { delete s.overrides[d]; }, 'Ausnahme entfernt').then(() => closeSheet());
  },

  'save-item'(b) {
    const k = b.dataset.kind;
    if (k === 'off') return A['save-override'](b);
    const t = $('#a-title');
    const title = t.value.trim();
    const start = $('#a-start').value, end = $('#a-end').value;
    t.removeAttribute('aria-invalid');
    if (!title) { t.setAttribute('aria-invalid', 'true'); t.focus(); return toast('Bitte einen Titel eingeben', 'err'); }
    if (!start || !end || end <= start) return toast('„Bis“ muss nach „von“ liegen', 'err');
    const kind = $('[data-seg="akind"][aria-pressed="true"]')?.dataset.v || 'mandatory';
    const id = b.dataset.id || uid();
    const item = { id, title, start, end, location: $('#a-loc').value, kind };
    if (k === 'study') item.weekday = Number($('#a-wd').value);
    else { item.date = $('#a-date').value; item.category = 'private'; if (!item.date) return toast('Bitte ein Datum wählen', 'err'); }
    const list = k === 'study' ? 'study' : 'appointments';
    const isEdit = !!b.dataset.id;
    saveSettings((s) => { s[list] = [...(s[list] || []).filter((x) => x.id !== id), item]; if (k === 'study') s.planReviewed = true; }, isEdit ? 'Gespeichert' : 'Hinzugefügt', { button: b })
      .then((ok) => { if (ok) { closeSheet(); if (k === 'study' && S.tab === 'week') { S.weekDay = item.weekday; rerenderKeepScroll(); } } });
  },
  'del-item'(b) {
    const list = b.dataset.kind === 'study' ? 'study' : 'appointments';
    const e = S.settings[list].find((x) => x.id === b.dataset.id);
    if (!confirm(`„${e?.title}“ löschen?`)) return;
    saveSettings((s) => { s[list] = s[list].filter((x) => x.id !== b.dataset.id); }, 'Gelöscht').then((ok) => ok && closeSheet());
  },

  departed(b) { return stateAction({ action: 'departed' }, 'Gute Fahrt!', b); },
  arrived(b) { return stateAction({ action: 'arrived', ...(b.dataset.loc ? { location: b.dataset.loc } : {}) }, 'Ankunft gespeichert', b); },
  'reset-state'(b) { if (confirm('Status für heute zurücksetzen?')) return stateAction({ action: 'reset' }, 'Zurückgesetzt', b); },

  'save-traffic'(b) {
    saveSettings((s) => Object.assign(s.traffic, { tomtomKey: $('#f-key').value.trim(), provider: $('#f-prov').value, apiDailyLimit: num($('#f-limit').value, 50, 2500, 2000) }), 'Verkehrsdaten gespeichert', { button: b });
  },
  geo(b) { return geocodeInto(b.dataset.k, $(`[data-geo-in="${b.dataset.k}"]`).value, b, true); },
  async 'p-search'(b) {
    const q = $('#p-addr').value.trim();
    if (!q) return toast('Bitte eine Adresse eingeben', 'err');
    if (!S.settings.traffic.tomtomKey) return toast('Zuerst Verkehrsdaten verbinden', 'err');
    b.classList.add('loading');
    try { const hit = await api(`/geocode?q=${encodeURIComponent(q)}`); if (!hit) toast('Adresse nicht gefunden', 'err'); else openPlace.draw(hit); } catch (e) { toast(e.message, 'err'); }
    b.classList.remove('loading');
  },
  'p-save'(b) {
    const k = b.dataset.k;
    const lab = $('#p-label');
    const label = lab.value.trim();
    if (!label) { lab.setAttribute('aria-invalid', 'true'); lab.focus(); return toast('Bitte einen Namen eingeben', 'err'); }
    const hit = openPlace.hit;
    const addr = $('#p-addr').value.trim();
    saveSettings((s) => {
      const old = s.locations[k] || {};
      s.locations[k] = { ...old, label, ...(hit ? { address: hit.address, lat: hit.lat, lon: hit.lon } : addr !== (old.address || '') ? { address: addr, lat: null, lon: null } : {}) };
    }, 'Ort gespeichert', { button: b }).then((ok) => ok && closeSheet());
  },
  'p-delete'(b) {
    const k = b.dataset.k;
    const used = (S.settings.study || []).some((e) => e.location === k) || (S.settings.appointments || []).some((e) => e.location === k);
    if (!confirm(`„${place(k)}“ löschen?${used ? '\n\nAchtung: Vorlesungen oder Termine nutzen diesen Ort noch.' : ''}`)) return;
    saveSettings((s) => { delete s.locations[k]; }, 'Ort gelöscht').then((ok) => ok && closeSheet());
  },
  async 'new-topic'(b) {
    if (S.settings.notify.ntfyTopic && !confirm('Neues Thema erzeugen? Danach musst du es in ntfy neu abonnieren.')) return;
    const topic = `pendel-${uid()}${uid()}`;
    await saveSettings((s) => { s.notify.ntfyTopic = topic; }, 'Thema erzeugt – jetzt in ntfy abonnieren', { button: b });
    if (sheetState && $('.steps', sheetState.sh)) drawWizard();
  },
  async 'copy-topic'() {
    try { await navigator.clipboard.writeText(S.settings.notify.ntfyTopic); toast('Kopiert – jetzt in ntfy einfügen'); } catch { toast('Bitte lange drücken und kopieren', 'err'); }
  },
  async 'test-push'(b) {
    b.classList.add('loading');
    try { await api('/test-notification', { method: 'POST' }); toast('Gesendet – kam die Nachricht an?'); } catch (e) { toast(e.message, 'err'); }
    b.classList.remove('loading');
  },
  export() {
    const blob = new Blob([JSON.stringify({ app: 'pendelpilot', version: 1, savedAt: new Date().toISOString(), settings: S.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pendelpilot-sicherung-${S.ov.today}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Sicherung gespeichert');
  },
  import() { $('#f-file').click(); },
  logout() {
    if (!confirm('Von diesem Gerät abmelden? Deine Daten bleiben erhalten, du brauchst danach den Zugangsschlüssel erneut.')) return;
    store.del('token'); S.ov = null; S.settings = null; S.wizardShown = false; renderWelcome();
  },
  async connect(b) {
    const inp = $('#w-token');
    const token = inp.value.trim();
    const apiUrl = $('#w-api')?.value.trim() || DEFAULT_API;
    if (token.length < 20) { inp.setAttribute('aria-invalid', 'true'); inp.focus(); return toast('Bitte den Zugangsschlüssel einfügen', 'err'); }
    if (!/^https?:\/\//.test(apiUrl)) return toast('Bitte die Server-Adresse prüfen', 'err');
    store.set('api', apiUrl); store.set('token', token);
    b.classList.add('loading');
    await load();
  },
  // Einrichtung
  'wiz-back'() { wiz = Math.max(0, wiz - 1); drawWizard(); },
  'wiz-skip'() { wizNext(false); },
  async 'wiz-next'(b) {
    const st = setupSteps()[wiz];
    if (st.key === 'traffic') {
      const key = $('#z-key').value.trim();
      if (!key) { $('#z-key').setAttribute('aria-invalid', 'true'); return toast('Schlüssel einfügen – oder „Überspringen“', 'err'); }
      if (key !== S.settings.traffic.tomtomKey && !(await saveSettings((s) => { s.traffic.tomtomKey = key; s.traffic.provider = 'tomtom'; }, 'Verkehrsdaten verbunden', { button: b, rerender: false }))) return;
    } else if (st.key === 'places') {
      for (const inp of $$('[data-geo-in]')) {
        const k = inp.dataset.geoIn, l = S.settings.locations[k] || {};
        if (inp.value.trim() && (inp.value.trim() !== (l.address || '') || l.lat == null) && S.settings.traffic.tomtomKey) await geocodeInto(k, inp.value, null, false);
      }
    } else if (st.key === 'week' && !S.settings.planReviewed) {
      await saveSettings((s) => { s.planReviewed = true; }, '', { rerender: false });
    }
    wizNext(true);
  },
  'wiz-hours'(b) {
    const d = Number(b.dataset.d);
    const cur = Number(S.settings.work.days[d]?.hours) || 0;
    const v = num(cur + Number(b.dataset.step), 0, 12, 0);
    S.settings.work.days[d] = { earliest: '06:30', latest: '19:00', ...(S.settings.work.days[d] || {}), hours: v };
    $(`#wh-${d}`).textContent = fmtHours(v);
    saveSettings((s) => { s.work.days[d] = { ...S.settings.work.days[d] }; s.planReviewed = true; }, '', { rerender: false });
  },
};
function wizNext(fromNext) {
  if (wiz >= 3) {
    closeSheet(); rerenderKeepScroll();
    const open = setupSteps().filter((x) => !x.done).length;
    if (fromNext) toast(open ? 'Fast fertig – den Rest kannst du jederzeit nachholen' : 'Alles eingerichtet!');
    return;
  }
  wiz += 1; drawWizard();
}
async function geocodeInto(k, q, b, redraw) {
  q = (q || '').trim();
  if (!q) return toast('Bitte eine Adresse eingeben', 'err');
  if (!S.settings.traffic.tomtomKey) return toast('Zuerst Verkehrsdaten verbinden (Schritt 1)', 'err');
  b?.classList.add('loading');
  try {
    const hit = await api(`/geocode?q=${encodeURIComponent(q)}`);
    if (!hit) toast(`„${q}“ nicht gefunden`, 'err');
    else await saveSettings((s) => { s.locations[k] = { ...(s.locations[k] || { label: k }), address: hit.address, lat: hit.lat, lon: hit.lon }; }, `Gefunden: ${hit.address}`, { rerender: false });
  } catch (e) { toast(e.message, 'err'); }
  b?.classList.remove('loading');
  if (redraw && sheetState && $('.steps', sheetState.sh)) drawWizard();
}
async function stateAction(body, msg, b) {
  if (b?.classList.contains('loading')) return;
  b?.classList.add('loading');
  try {
    await chain;
    await api('/state', { method: 'POST', body });
    S.ov = await api('/overview');
    closeSheet();
    render();
    toast(msg);
  } catch (e) { toast(e.message, 'err'); b?.classList.remove('loading'); }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const fn = A[b.dataset.a];
  if (fn) { e.preventDefault(); fn(b, e); }
});
// Felder, die sich selbst speichern
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.wf) {
    const d = S.weekDay, f = t.dataset.wf;
    const day = { ...(S.settings.work.days[d] || {}), [f]: t.value };
    if (!day.earliest || !day.latest || day.latest <= day.earliest) { toast('„Spätestens“ muss nach „frühestens“ liegen', 'err'); t.value = S.settings.work.days[d]?.[f] || ''; return; }
    S.settings.work.days[d] = day;
    saveSettings((s) => { s.work.days[d] = day; s.planReviewed = true; }, 'Gespeichert', { rerender: false }).then(() => rerenderKeepScroll());
  } else if (t.dataset.nf) {
    const f = t.dataset.nf, v = t.type === 'time' ? t.value : Number(t.value);
    if (t.type === 'time' && !v) return;
    saveSettings((s) => { s.notify[f] = v; }, 'Gespeichert', { rerender: false });
  } else if (t.dataset.pf) {
    const f = t.dataset.pf;
    const v = f === 'baseTravelMin' ? num(t.value, 5, 240, 35) : Number(t.value);
    saveSettings((s) => { s.planning[f] = v; }, 'Gespeichert', { rerender: false });
  } else if (t.dataset.prio) {
    saveSettings((s) => { s.priorities[t.dataset.prio] = Number(t.value); }, 'Gespeichert', { rerender: false });
  } else if (t.id === 'f-file') {
    importBackup(t);
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.prio) {
    const max = Number(t.dataset.max);
    t.style.setProperty('--fillp', `${(t.value / max) * 100}%`);
    $(`#o-${t.dataset.prio}`).textContent = level(Number(t.value), max);
  }
  if (t.getAttribute('aria-invalid') === 'true' && t.value.trim()) t.removeAttribute('aria-invalid');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetState) closeSheet();
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t.matches('[data-geo-in]')) { e.preventDefault(); $(`[data-a="geo"][data-k="${t.dataset.geoIn}"]`)?.click(); }
  else if (t.id === 'p-addr') { e.preventDefault(); $('[data-a="p-search"]')?.click(); }
  else if (t.id === 'w-token') { e.preventDefault(); $('[data-a="connect"]')?.click(); }
  else if (t.id === 'a-title') { e.preventDefault(); t.blur(); }
});

async function importBackup(input) {
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { return toast('Die Datei ist keine gültige Sicherung', 'err'); }
  const imp = data?.settings ?? data;
  if (!imp || typeof imp !== 'object' || Array.isArray(imp) || !(imp.locations || imp.work || imp.study)) return toast('Das ist keine Pendelpilot-Sicherung', 'err');
  if (!confirm('Sicherung wiederherstellen? Deine aktuellen Daten werden ersetzt.')) return;
  saveSettings((s) => {
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
    const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && x.id && x.start && x.end) : []);
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, {
      locations: obj(imp.locations), work: obj(imp.work), priorities: obj(imp.priorities), planning: obj(imp.planning),
      notify: obj(imp.notify), traffic: obj(imp.traffic), overrides: obj(imp.overrides) || {},
      study: list(imp.study), appointments: list(imp.appointments).filter((x) => x.date),
      appUrl: typeof imp.appUrl === 'string' ? imp.appUrl : undefined, planReviewed: true,
    });
    Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
  }, 'Sicherung wiederhergestellt');
}

// Diagramm: Antippen/Ziehen zeigt den Wert
function mountHooks() {
  $$('.spark').forEach((c) => {
    const pts = JSON.parse(c.dataset.pts);
    const [x0, x1, W] = c.dataset.geo.split(',').map(Number);
    const svg = $('svg', c), tip = $('.tip', c), xh = $('.xh', c);
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const m = x0 + ((ev.clientX - r.left) / r.width) * (x1 - x0);
      const p = pts.reduce((b, q) => (Math.abs(q[0] - m) < Math.abs(b[0] - m) ? q : b), pts[0]);
      const x = ((p[0] - x0) / (x1 - x0)) * W;
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
      tip.style.left = `${Math.max(14, Math.min(86, (x / W) * 100))}%`;
      tip.textContent = `${hm(p[0])} → ${Math.round(p[1])} min`;
      tip.classList.add('on');
    };
    const hide = () => { tip.classList.remove('on'); xh.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') show(e); });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerup', () => setTimeout(hide, 1800));
  });
}

// ============================================================================
// Start: Zoom-/Markierschutz, Offline, Updates, Laden
// ============================================================================
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, .selectable')) e.preventDefault(); });
const showOffline = () => {
  const o = $('#offline');
  o.hidden = navigator.onLine;
  o.innerHTML = `${icon('wifi-off')}Offline – Anzeige ist evtl. nicht aktuell`;
};
addEventListener('online', () => { showOffline(); load({ quiet: true }); });
addEventListener('offline', showOffline);
showOffline();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) location.reload(); });
}
// Beim Zurückkehren und jede Minute frische Daten (ohne Springen der Ansicht)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && conn().token && S.ov && !sheetState) load({ quiet: true }); });
setInterval(() => { if (document.visibilityState === 'visible' && S.ov && !sheetState && ['today', 'tomorrow'].includes(S.tab)) load({ quiet: true }); }, 60000);

load();

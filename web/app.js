// Pendelplaner – Oberfläche. Keine Build-Tools nötig: reines JavaScript.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WDS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function hm(min) {
  if (min == null) return '–';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function dur(min) {
  const m = Math.round(Math.abs(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
function fmtDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7;
  return `${WD[wd]}, ${dd}.${m}.`;
}
const uid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* privat */ } },
};

// ---- Verbindung ---------------------------------------------------------------
// Einrichtungslink: …/#api=<url>&token=<token>
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('api') && h.get('token')) {
    store.set('api', h.get('api'));
    store.set('token', h.get('token'));
    history.replaceState(null, '', location.pathname + location.search);
  }
})();
// Öffentliche Adresse des eigenen Backends (kein Geheimnis); der Schlüssel bleibt geheim.
const DEFAULT_API = 'https://ntkooxdivapuznjufdwj.supabase.co/functions/v1/pendel';
const conn = () => ({ api: store.get('api') || (store.get('token') ? DEFAULT_API : null), token: store.get('token') });

async function api(path, { method = 'GET', body } = {}) {
  const { api: base, token } = conn();
  let r;
  try {
    r = await fetch(base.replace(/\/$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-app-token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(navigator.onLine ? 'Server nicht erreichbar. Bitte gleich nochmal versuchen.' : 'Keine Internetverbindung.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Der Zugangsschlüssel stimmt nicht.');
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---- Kein Zoom, kein ungewolltes Markieren, Offline-Hinweis -------------------
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea, [contenteditable], .selectable')) e.preventDefault(); });
const showOffline = () => { $('#offline').hidden = navigator.onLine; };
addEventListener('online', () => { showOffline(); load(); });
addEventListener('offline', showOffline);
showOffline();

// ---- Hell / Dunkel ---------------------------------------------------------------
const theme = () => store.get('theme') || 'auto';
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#0a0f1a');
}
applyTheme(theme());

// ---- Zustand & Navigation ----------------------------------------------------
const S = { tab: store.get('tab') || 'today', ov: null, settings: null, stats: null };

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  store.set('tab', S.tab);
  render();
  if (S.tab === 'stats') loadStats();
});
$('#refresh').addEventListener('click', () => load(true));

async function load(force) {
  if (!conn().api) return renderConnect();
  try {
    const [ov, settings] = await Promise.all([api('/overview'), api('/settings')]);
    S.ov = ov;
    S.settings = settings;
    render();
    if (force) toast('Aktualisiert');
  } catch (e) {
    $('#main').innerHTML = `<div class="card warn"><h2>Keine Verbindung</h2><p>${esc(e.message)}</p>
      <button class="btn" id="reconnect">Verbindung neu einrichten</button></div>`;
    $('#reconnect').onclick = () => { store.del('api'); store.del('token'); renderConnect(); };
  }
}

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  if (!S.ov) return;
  const main = $('#main');
  if (S.tab === 'today') main.innerHTML = dayView(S.ov.todayPlan, true);
  else if (S.tab === 'tomorrow') main.innerHTML = dayView(S.ov.tomorrowPlan, false);
  else if (S.tab === 'plan') main.innerHTML = planView();
  else if (S.tab === 'stats') main.innerHTML = statsView();
  else main.innerHTML = settingsView();
  wire(main);
}

// ---- Verbindungs-Bildschirm ----------------------------------------------------
function renderConnect() {
  $('#main').innerHTML = `<div class="card"><h2>Willkommen 👋</h2>
    <p>Nur noch den Zugangsschlüssel einfügen und auf „Verbinden“ tippen.</p>
    <label class="field">Server-Adresse (schon ausgefüllt)<input id="c-api" value="${DEFAULT_API}"></label>
    <label class="field">Zugangsschlüssel<input id="c-token" autocomplete="off"></label>
    <button class="btn primary" id="c-save">Verbinden</button></div>`;
  $('#c-save').onclick = () => {
    const api = $('#c-api').value.trim(), token = $('#c-token').value.trim();
    if (!/^https:\/\//.test(api)) return toast('Bitte die Server-Adresse prüfen');
    if (token.length < 20) return toast('Bitte den Zugangsschlüssel einfügen');
    store.set('api', api);
    store.set('token', token);
    load();
  };
}

// ---- Heute / Morgen -------------------------------------------------------------
function place(key) {
  return S.settings?.locations?.[key]?.label || { home: 'Zuhause', work: 'Arbeit', uni: 'Uni' }[key] || key;
}

function setupSteps() {
  const s = S.settings;
  const found = (k) => s.locations?.[k]?.lat != null;
  return [
    { done: !!s.traffic?.tomtomKey, text: 'TomTom-Schlüssel eintragen (echte Verkehrsdaten)', go: 'settings', anchor: 'sec-traffic' },
    { done: found('home') && found(s.work.location), text: 'Adressen von Zuhause und Arbeit eintragen', go: 'settings', anchor: 'sec-places' },
    { done: !!s.notify?.ntfyTopic, text: 'Benachrichtigungen einrichten (ntfy)', go: 'settings', anchor: 'sec-notify' },
    { done: !!s.planReviewed || (s.study || []).length > 0, text: 'Arbeitszeiten und Stundenplan prüfen', go: 'plan', anchor: 'sec-work' },
  ];
}

function setupCard() {
  const steps = setupSteps();
  if (steps.every((x) => x.done)) return '';
  const n = steps.filter((x) => x.done).length;
  return `<div class="card setup"><h2>Einrichtung (${n}/${steps.length})</h2>
    <p class="small muted">Tippe auf einen Punkt, um ihn zu erledigen.</p>
    <ul>${steps.map((x) => `<li class="${x.done ? 'done' : ''}"><span class="dot">${x.done ? '✓' : ''}</span>
      <span class="txt">${x.text}</span>${x.done ? '' : `<button class="btn" data-goto="${x.go}" data-anchor="${x.anchor}">Los</button>`}</li>`).join('')}</ul></div>`;
}

function dayView(plan, isToday) {
  const best = plan.scenarios?.[0];
  const nowMin = S.ov.nowMin;
  const meta = `<p class="meta">${fmtDate(plan.date)} · berechnet ${hm(minOfIso(plan.computedAt))} · ${S.ov.provider === 'tomtom' ? 'Live-Verkehr: TomTom' : 'Demo-Verkehr (TomTom noch nicht verbunden)'}</p>`;
  let html = '';

  if (plan.warnings?.length) html += `<div class="card warn">${plan.warnings.map((w) => `<p>⚠️ ${esc(w)}</p>`).join('')}</div>`;

  if (!best) {
    html += `<div class="card"><h2>Kein Plan möglich</h2><p class="muted">Bitte Arbeitszeiten und Termine prüfen.</p></div>`;
    return html + meta + (isToday ? setupCard() : '') + overrideCard(plan);
  }

  // Wichtigste Aussage oben
  const next = best.legs.find((l) => !isToday || l.depart >= nowMin - 5);
  if (next) {
    const inMin = isToday ? Math.round(next.depart - nowMin) : null;
    html += `<div class="card hero">
      <div class="label">${isToday ? 'Nächste Fahrt' : 'Morgen voraussichtlich'} · ${esc(place(next.from))} → ${esc(place(next.to))}</div>
      <div class="big">${hm(next.depart)}<small>losfahren</small></div>
      <div class="sub">≈ ${dur(next.minutes)} Fahrt · an ${hm(next.arrive)}${inMin != null && inMin >= 0 ? ` · in ${dur(inMin)}` : ''}</div>
      <div class="kpi">
        <div><span>Pendelzeit</span><b>${dur(best.totals.commute)}</b></div>
        <div><span>Feierabend</span><b>${best.work ? hm(best.work.end) : '–'}</b></div>
        <div><span>Zu Hause</span><b>${hm(best.totals.arriveHome)}</b></div>
      </div>
      ${isToday ? '' : '<p class="note">Prognose – morgen wird mit der echten Verkehrslage nachjustiert.</p>'}
    </div>`;
  } else {
    html += `<div class="card hero calm"><div class="label">${isToday ? 'Heute' : 'Morgen'}</div><div class="big">Keine Fahrten ${isToday ? 'mehr' : ''}</div>
      <div class="sub">${isToday && plan.state?.location === 'home' ? 'Du bist zu Hause. Schönen Feierabend!' : 'Genieß den Tag.'}</div></div>`;
  }
  html += meta + (isToday ? setupCard() : '');

  if (isToday) html += stateCard(plan, best);

  html += `<div class="card"><h2>Tagesablauf</h2>${timeline(best)}
    <h3>Warum diese Zeiten?</h3><ul class="reasons">${(best.reasons || []).map((r) => `<li>${esc(r.trim())}</li>`).join('')}</ul></div>`;

  const alts = plan.scenarios.slice(1);
  if (alts.length) {
    html += `<div class="card"><h2>Alternativen</h2><p class="small muted">Im Vergleich zur Empfehlung:</p>
      ${alts.map((s) => `<details class="alt"><summary>
        <span class="tag">${esc(s.label)}</span> <b>${s.legs[0] ? hm(s.legs[0].depart) : '–'} los</b>
        <div class="small">${esc(s.summary)}</div><div class="diff">${esc(s.diffText || '')}</div></summary>
        ${timeline(s)}</details>`).join('')}</div>`;
  }

  html += chartsCard(plan, best, isToday);
  html += overrideCard(plan);
  if (isToday && S.ov.notifications?.length) {
    html += `<div class="card"><h2>Letzte Benachrichtigungen</h2>${S.ov.notifications.slice(0, 6).map((n) =>
      `<div class="list-item"><div class="grow"><b class="small">${esc(n.title)}</b><div class="small muted">${esc(n.message)}</div></div><span class="small muted">${hm(minOfIso(n.ts))}</span></div>`).join('')}</div>`;
  }
  return html;
}

function minOfIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return g('hour') * 60 + g('minute');
}

function timeline(s) {
  if (!s.steps?.length) return '<p class="muted">Keine Fahrten nötig.</p>';
  return `<ul class="timeline">${s.steps.map((st) => `<li><span class="t">${hm(st.t)}</span><span class="${st.type === 'skip' ? 'skip' : ''}">${st.type === 'drive' ? '🚗 ' : st.type === 'work' ? '💼 ' : st.type === 'skip' ? '' : '📚 '}${esc(st.text)}</span></li>`).join('')}</ul>`;
}

function stateCard(plan, best) {
  const st = plan.state || {};
  let txt = 'Ich gehe davon aus, dass du dich an die Empfehlung hältst. Falls nicht, kurz antippen:';
  if (st.departedAt != null && st.location) txt = `Unterwegs nach ${esc(place(st.location))} seit ${hm(st.departedAt)}${st.assumed ? ' (angenommen)' : ''}.`;
  else if (st.location) txt = `Du bist ${st.location === 'home' ? 'zu Hause' : `bei ${esc(place(st.location))}`} seit ${hm(st.availableFrom)}${st.assumed ? ' (angenommen)' : ''}.`;
  if (st.workStart != null) txt += ` Arbeitsbeginn: ${hm(st.workStart)}${st.workStartEstimated ? ' (geschätzt)' : ''}.`;
  return `<div class="card"><h2>Wo stehst du gerade?</h2><div class="status">${txt}</div>
    <div class="row">
      <button class="btn" data-act="departed">🚗 Losgefahren</button>
      <button class="btn" data-act="arrived">📍 Angekommen</button>
      <button class="btn link" data-act="reset">zurücksetzen</button>
    </div>
    <p class="small muted">Tipp: „Angekommen“ verbessert auch die Prognosen, weil die echte Fahrzeit gespeichert wird.</p></div>`;
}

function overrideCard(plan) {
  const ov = S.settings?.overrides?.[plan.date];
  const w = plan.day?.work;
  return `<div class="card"><h2>Dieser Tag ist anders?</h2>
    <div class="grid2">
      <label class="field">Arbeitsstunden (0 = frei)<input type="number" step="0.5" min="0" max="12" id="ov-hours" value="${w ? w.hours : 0}"></label>
      <label class="field">Pause (automatisch)<input disabled value="${w ? `${w.pauseMin} min` : '–'}"></label>
      <label class="field">frühestens<input type="time" id="ov-earliest" value="${w ? hm(w.earliest) : '06:30'}"></label>
      <label class="field">spätestens fertig<input type="time" id="ov-latest" value="${w ? hm(w.latest) : '19:00'}"></label>
    </div>
    <div class="row"><button class="btn primary" data-override="${plan.date}">Für diesen Tag übernehmen</button>
    ${ov ? `<button class="btn link" data-override-clear="${plan.date}">Ausnahme entfernen</button>` : ''}</div></div>`;
}

// ---- Diagramm: Fahrzeit über den Tag --------------------------------------------
function chartsCard(plan, best, isToday) {
  const legs = best.legs;
  const keys = [...new Set(legs.length ? legs.map((l) => `${l.from}>${l.to}`) : Object.keys(plan.curves || {}))].filter((k) => plan.curves?.[k]);
  if (!keys.length) return '';
  const src = plan.curves[keys[0]].sources || {};
  return `<div class="card"><h2>Erwartete Fahrzeit über den Tag</h2>
    <p class="small muted">Linie = erwartete Fahrzeit je Abfahrtszeit. Markierung = empfohlene Abfahrt.</p>
    ${keys.map((k) => {
      const [a, b] = k.split('>');
      const leg = legs.find((l) => l.from === a && l.to === b);
      return `<h3>${esc(place(a))} → ${esc(place(b))}</h3>${lineChart(plan.curves[k].points, leg, isToday ? S.ov.nowMin : null)}`;
    }).join('')}
    <p class="small muted">Datenbasis: ${src.forecast ? `${src.forecast} Prognosepunkte` : 'noch keine Prognosen'} · ${src.learned ? `${src.learned} Zeitfenster aus eigenen Messungen` : 'noch keine eigenen Messungen'}${src.bias && src.bias !== 1 ? ` · Prognosen erfahrungsgemäß ×${src.bias.toFixed(2)}` : ''}${src.liveRatio && Math.abs(src.liveRatio - 1) > 0.02 ? ` · aktuell ${src.liveRatio > 1 ? 'mehr' : 'weniger'} Verkehr als erwartet (×${src.liveRatio.toFixed(2)})` : ''}</p>
  </div>`;
}

function lineChart(points, leg, nowMin) {
  const W = 360, H = 160, L = 28, R = 6, T = 18, B = 20;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = Math.ceil((Math.max(...ys) + 5) / 10) * 10;
  const yMin = Math.max(0, Math.floor((Math.min(...ys) - 5) / 10) * 10);
  const X = (m) => L + ((m - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  let grid = '';
  for (let v = yMin; v <= yMax; v += 10) grid += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let m = Math.ceil(x0 / 180) * 180; m <= x1; m += 180) grid += `<text x="${X(m)}" y="${H - 4}" text-anchor="middle">${hm(m)}</text>`;
  let mark = '';
  if (leg) {
    mark = `<line x1="${X(leg.depart)}" x2="${X(leg.depart)}" y1="${T}" y2="${H - B}" stroke="var(--mark)" stroke-width="2" stroke-dasharray="4 3"/>
      <circle cx="${X(leg.depart)}" cy="${Y(leg.minutes)}" r="5" fill="var(--mark)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${X(leg.depart) > W / 2 ? X(leg.depart) - 6 : X(leg.depart) + 6}" y="${T - 6}" text-anchor="${X(leg.depart) > W / 2 ? 'end' : 'start'}" style="fill:var(--text);font-size:12px;font-weight:600">${hm(leg.depart)} · ${Math.round(leg.minutes)} min</text>`;
  }
  const now = nowMin != null && nowMin > x0 && nowMin < x1
    ? `<rect x="${L}" y="${T}" width="${X(nowMin) - L}" height="${H - T - B}" fill="var(--surface-2)" opacity=".7"/><text x="${X(nowMin) - 4}" y="${H - B - 4}" text-anchor="end">jetzt</text>` : '';
  const data = esc(JSON.stringify(points));
  return `<div class="chart" data-points="${data}" data-geo="${[x0, x1, yMin, yMax, W, H, L, R, T, B].join(',')}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fahrzeit in Minuten je Abfahrtszeit">
      <g class="axis">${now}${grid}</g>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
      ${mark}
      <line class="xh" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>
      <circle class="xd" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
    </svg><div class="tip"></div></div>`;
}

function wireCharts(root) {
  root.querySelectorAll('.chart').forEach((c) => {
    const pts = JSON.parse(c.dataset.points);
    const [x0, x1, yMin, yMax, W, H, L, R, T, B] = c.dataset.geo.split(',').map(Number);
    const svg = c.querySelector('svg'), tip = c.querySelector('.tip'), xh = c.querySelector('.xh'), xd = c.querySelector('.xd');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const m = x0 + ((px - L) / (W - L - R)) * (x1 - x0);
      const p = pts.reduce((b, q) => (Math.abs(q[0] - m) < Math.abs(b[0] - m) ? q : b), pts[0]);
      const X = L + ((p[0] - x0) / (x1 - x0)) * (W - L - R);
      const Y = T + (1 - (p[1] - yMin) / (yMax - yMin)) * (H - T - B);
      xh.setAttribute('x1', X); xh.setAttribute('x2', X); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', X); xd.setAttribute('cy', Y); xd.setAttribute('visibility', 'visible');
      tip.style.display = 'block';
      tip.style.left = `${(X / W) * 100}%`;
      tip.style.top = `${(Y / H) * r.height}px`;
      tip.textContent = `Abfahrt ${hm(p[0])}: ≈ ${Math.round(p[1])} min`;
    };
    const leave = () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', leave);
  });
}

// ---- Plan (Arbeit, Studium, Termine) ---------------------------------------------
function locOptions(sel) {
  return Object.keys(S.settings.locations).map((k) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(place(k))}</option>`).join('');
}

function planView() {
  const s = S.settings;
  const days = s.work.days;
  const rule = s.work.pauseRules || [];
  return `
  <div class="card" id="sec-work" data-section="work"><h2>Arbeitszeiten <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <p class="small muted">Stunden = reine Arbeitszeit. Die Pause wird automatisch ergänzt (z. B. 8 h → 8,5 h vor Ort). „frühestens/spätestens“ ist dein erlaubtes Zeitfenster – die App sucht darin den besten Beginn.</p>
    <div class="week">
      <div class="wrow whead"><span></span><span>Std.</span><span>ab</span><span>bis</span></div>
    ${WDS.map((d, i) => `<div class="wrow"><span class="day">${d}</span>
      <input type="number" inputmode="decimal" step="0.5" min="0" max="12" data-work="${i}" data-f="hours" value="${days[i]?.hours ?? 0}" aria-label="${WD[i]} Stunden">
      <input type="time" data-work="${i}" data-f="earliest" value="${days[i]?.earliest || '06:30'}" aria-label="${WD[i]} frühestens">
      <input type="time" data-work="${i}" data-f="latest" value="${days[i]?.latest || '19:00'}" aria-label="${WD[i]} spätestens"></div>`).join('')}
    </div>
    <div class="grid2">
      <label class="field">Pause ab mehr als … Stunden<input type="number" step="0.5" id="pr-over" value="${rule[0]?.overHours ?? 6}"></label>
      <label class="field">… Minuten Pause<input type="number" id="pr-min" value="${rule[0]?.pauseMin ?? 30}"></label>
    </div>
    <label class="field">Arbeitsort<select id="work-loc">${locOptions(s.work.location)}</select></label>
    <p class="small muted">Änderungen werden automatisch gespeichert.</p>
  </div>

  <div class="card"><h2>Stundenplan (wöchentlich)</h2>
    ${(s.study || []).map((e) => `<div class="list-item"><div class="grow"><b>${esc(e.title)}</b> <span class="tag">${e.kind === 'optional' ? 'optional' : 'Pflicht'}</span>
      <div class="small muted">${WD[e.weekday]} ${esc(e.start)}–${esc(e.end)} · ${esc(place(e.location))}${e.from || e.until ? ` · ${esc(e.from || '…')} bis ${esc(e.until || '…')}` : ''}</div></div>
      <button class="btn danger" data-del-study="${esc(e.id)}">✕</button></div>`).join('') || '<p class="muted small">Noch keine Veranstaltungen.</p>'}
    <h3>Neue Veranstaltung</h3>
    <label class="field">Titel<input id="st-title" maxlength="80" placeholder="z. B. Statistik"></label>
    <div class="grid2">
      <label class="field">Wochentag<select id="st-wd">${WD.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></label>
      <label class="field">Art<select id="st-kind"><option value="mandatory">Pflicht – nie verpassen</option><option value="optional">optional – darf weichen</option></select></label>
      <label class="field">von<input type="time" id="st-start" value="10:00"></label>
      <label class="field">bis<input type="time" id="st-end" value="11:30"></label>
      <label class="field">Ort<select id="st-loc">${locOptions('uni')}</select></label>
      <label class="field">gilt bis (optional)<input type="date" id="st-until"></label>
    </div>
    <button class="btn primary" data-add="study">Hinzufügen</button>
  </div>

  <div class="card"><h2>Termine</h2>
    ${(s.appointments || []).slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((e) => `<div class="list-item"><div class="grow"><b>${esc(e.title)}</b> <span class="tag">${e.kind === 'optional' ? 'optional' : 'fest'}</span>
      <div class="small muted">${fmtDate(e.date)} ${esc(e.start)}–${esc(e.end)} · ${esc(place(e.location))}</div></div>
      <button class="btn danger" data-del-appt="${esc(e.id)}">✕</button></div>`).join('') || '<p class="muted small">Keine Termine eingetragen.</p>'}
    <h3>Neuer Termin</h3>
    <label class="field">Titel<input id="ap-title" maxlength="80" placeholder="z. B. Arzt, Training, Klausur"></label>
    <div class="grid2">
      <label class="field">Datum<input type="date" id="ap-date" value="${S.ov.tomorrow}"></label>
      <label class="field">Art<select id="ap-kind"><option value="mandatory">fest</option><option value="optional">optional</option></select></label>
      <label class="field">von<input type="time" id="ap-start" value="18:00"></label>
      <label class="field">bis<input type="time" id="ap-end" value="19:00"></label>
      <label class="field">Ort<select id="ap-loc">${locOptions('home')}</select></label>
      <label class="field">Kategorie<select id="ap-cat"><option value="private">privat</option><option value="study">Studium</option><option value="other">sonstiges</option></select></label>
    </div>
    <button class="btn primary" data-add="appt">Hinzufügen</button>
  </div>

  <div class="card"><h2>Ausnahmen</h2>
    ${Object.entries(s.overrides || {}).sort().map(([d, o]) => `<div class="list-item"><div class="grow">${fmtDate(d)}: ${o.work ? `${o.work.hours} h Arbeit (${esc(o.work.earliest)}–${esc(o.work.latest)})` : 'frei'}</div>
      <button class="btn danger" data-override-clear="${d}">✕</button></div>`).join('') || '<p class="muted small">Keine. Abweichende Tage kannst du direkt unter „Heute“ bzw. „Morgen“ eintragen.</p>'}
  </div>`;
}

// ---- Lernen / Statistik ---------------------------------------------------------
async function loadStats() {
  try { S.stats = await api('/stats'); if (S.tab === 'stats') render(); } catch (e) { toast(e.message); }
}

function statsView() {
  const st = S.stats;
  if (!st) return '<p class="muted center">Lade Statistik …</p>';
  const acc = st.accuracy || {};
  let html = `<div class="card"><h2>Was die App bisher gelernt hat</h2>
    <div class="kpi"><div><span>Messungen</span><b>${st.samples}</b></div><div><span>Tage</span><b>${st.days}</b></div><div><span>Fahrten</span><b>${st.trips}</b></div></div>
    <h3>Wie genau waren die Prognosen?</h3>
    <p class="small">Durchschnittliche Abweichung von der tatsächlichen Fahrzeit:</p>
    <ul class="reasons">
      <li>Prognose des Verkehrsdienstes (≥ 3 h vorher): <b>${acc.service ? `±${acc.service.mae} min` : 'noch zu wenig Daten'}</b>${acc.service ? ` (${acc.service.n} Vergleiche)` : ''}</li>
      <li>Vortages-Prognose dieser App: <b>${acc.app ? `±${acc.app.mae} min` : 'noch zu wenig Daten'}</b>${acc.app ? ` (${acc.app.n} Vergleiche)` : ''}</li>
    </ul>
    ${st.samples < 50 ? '<p class="small muted">Die App misst automatisch alle 15 Minuten die Fahrzeit. Nach 2–3 Wochen werden die Muster aussagekräftig.</p>' : ''}
  </div>`;
  const wl = S.settings.work.location;
  for (const [k, title] of [[`home>${wl}`, `${place('home')} → ${place(wl)}`], [`${wl}>home`, `${place(wl)} → ${place('home')}`]]) {
    html += heatmap(st.heat?.[k] || {}, title);
  }
  return html;
}

function heatmap(cells, title) {
  const vals = Object.values(cells).map((c) => c.median);
  if (!vals.length) return `<div class="card"><h2>${esc(title)}</h2><p class="muted small">Noch keine Messungen.</p></div>`;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const steps = ['--seq-0', '--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
  const col = (v) => `var(${steps[Math.min(6, Math.floor(((v - lo) / Math.max(1, hi - lo)) * 6.999))]})`;
  const slots = [];
  for (let m = 300; m < 1260; m += 30) slots.push(m);
  let g = `<div class="heat" style="grid-template-columns: 28px repeat(5, 1fr)"><span></span>${WDS.slice(0, 5).map((d) => `<span class="lbl" style="justify-content:center">${d}</span>`).join('')}`;
  for (const m of slots) {
    g += `<span class="lbl">${m % 60 === 0 ? hm(m).slice(0, 2) : ''}</span>`;
    for (let wd = 0; wd < 5; wd++) {
      const c = cells[`${wd}|${m}`];
      g += c ? `<span class="cell" style="background:${col(c.median)}" title="${WDS[wd]} ${hm(m)}: ${c.median} min (${c.n} Messungen)"></span>` : '<span class="cell" style="background:var(--surface-2)"></span>';
    }
  }
  g += '</div>';
  return `<div class="card"><h2>${esc(title)}</h2><p class="small muted">Typische Fahrzeit je Wochentag und Abfahrtszeit (Median). Dunkler = länger. Antippen für Werte.</p>${g}
    <div class="legend-seq">${Math.round(lo)} min ${steps.map((s) => `<i style="background:var(${s})"></i>`).join('')} ${Math.round(hi)} min</div></div>`;
}

// ---- Einstellungen --------------------------------------------------------------
function settingsView() {
  const s = S.settings;
  const P = s.priorities, N = s.notify, PL = s.planning, TR = s.traffic;
  return `
  <div class="card"><h2>Darstellung</h2>
    <div class="segmented" role="radiogroup" aria-label="Darstellung">
      ${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => `<button role="radio" aria-checked="${theme() === v}" class="${theme() === v ? 'on' : ''}" data-theme-set="${v}">${l}</button>`).join('')}
    </div>
  </div>
  <div class="card" id="sec-traffic" data-section="traffic"><h2>Verkehrsdaten <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <p class="small">Kostenlosen Schlüssel holen: <a href="https://developer.tomtom.com/user/register" target="_blank" rel="noopener">developer.tomtom.com</a> → registrieren → „Keys“ → Schlüssel kopieren und hier einfügen. Kostenlos bis 2.500 Abfragen/Tag (die App braucht ca. 300–700).</p>
    <label class="field">TomTom-Schlüssel<input id="t-key" value="${esc(TR.tomtomKey)}" autocomplete="off" autocapitalize="off" autocorrect="off" placeholder="hier einfügen"></label>
    <label class="field">Quelle<select id="t-prov"><option value="tomtom" ${TR.provider !== 'demo' ? 'selected' : ''}>TomTom (empfohlen)</option><option value="demo" ${TR.provider === 'demo' ? 'selected' : ''}>Demo-Modell</option></select></label>
    <label class="field">Max. Abfragen pro Tag<input type="number" id="t-limit" value="${TR.apiDailyLimit}"></label>
    <p class="small muted">Heute verbraucht: ${S.ov.usage} Abfragen.</p>
  </div>

  <div class="card" id="sec-places" data-section="locations"><h2>Orte <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <p class="small muted">Adresse eingeben und „Suchen“ tippen. (Braucht zuerst den TomTom-Schlüssel oben.)</p>
    ${Object.entries(s.locations).map(([k, l]) => `<div class="list-item" style="display:block">
      <div class="row"><input class="grow" data-loc="${esc(k)}" data-f="label" value="${esc(l.label)}" aria-label="Name des Orts">
      ${['home', 'work'].includes(k) ? '' : `<button class="btn danger" data-del-loc="${esc(k)}">✕</button>`}</div>
      <div class="row" style="margin-top:6px"><input class="grow" data-loc="${esc(k)}" data-f="address" value="${esc(l.address)}" placeholder="Straße, Ort" enterkeyhint="search">
      <button class="btn" data-geo="${esc(k)}">Suchen</button></div>
      <div class="small" style="margin-top:8px"><span style="color:${l.lat != null ? 'var(--good)' : 'var(--warn)'}">${l.lat != null ? '✓ gefunden' : 'noch nicht gefunden'}</span>${l.lat != null ? `<a class="map-link" href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}" target="_blank" rel="noopener">In Google Maps prüfen ↗</a>` : ''}</div></div>`).join('')}
    <div class="row" style="margin-top:8px"><button class="btn" data-add-loc>+ weiteren Ort</button></div>
  </div>

  <div class="card" data-section="priorities"><h2>Was ist dir wichtig? <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <p class="small muted">Pflichttermine und deine Arbeitszeit werden immer eingehalten. Die Regler bestimmen, wie die App den Rest abwägt.</p>
    ${slider('commute', 'Möglichst wenig im Auto sitzen', P.commute, 0, 2, 'Wie schlimm ist 1 Minute Fahrt?')}
    ${slider('away', 'Viel Freizeit zu Hause', P.away, 0, 1.5, 'Wie schlimm ist 1 Minute länger unterwegs (statt zu Hause)?')}
    ${slider('optionalMissed', 'Optionale Veranstaltungen besuchen', P.optionalMissed, 0, 3, 'Wie schlimm ist 1 verpasste Minute einer optionalen Veranstaltung?')}
  </div>

  <div class="card" id="sec-notify" data-section="notify"><h2>Benachrichtigungen <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <p class="small">1. App <b>ntfy</b> installieren (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a> · <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>)<br>
    2. Dort „+“ tippen und dieses Thema abonnieren:</p>
    <div class="row"><input class="grow" id="n-topic" value="${esc(N.ntfyTopic)}" placeholder="erst „Neu erzeugen“ tippen" autocapitalize="off" autocorrect="off"><button class="btn" id="n-gen">Neu erzeugen</button></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="n-copy">Kopieren</button><button class="btn" id="n-test">Test senden</button></div>
    <div class="grid2">
      <label class="field">Abend-Prognose um<input type="time" id="n-evening" value="${esc(N.eveningTime)}"></label>
      <label class="field">Losfahr-Hinweis (min vorher)<input type="number" id="n-lead" value="${N.leadMin}"></label>
      <label class="field">Melden ab Änderung von (min)<input type="number" id="n-thr" value="${N.changeThresholdMin}"></label>
      <label class="field">&nbsp;</label>
      <label class="field">Ruhe ab<input type="time" id="n-qs" value="${esc(N.quietStart)}"></label>
      <label class="field">Ruhe bis<input type="time" id="n-qe" value="${esc(N.quietEnd)}"></label>
    </div>
  </div>

  <div class="card" data-section="planning"><h2>Feintuning <span class="saved-hint" hidden>✓ gespeichert</span></h2>
    <div class="grid2">
      <label class="field">Puffer vor Terminen (min)<input type="number" id="p-buffer" value="${PL.bufferMin}"></label>
      <label class="field">Max. warten nach Feierabend (min)<input type="number" id="p-wait" value="${PL.maxWaitAfterMin}"></label>
      <label class="field">Fahrzeit ohne Verkehr (min)<input type="number" id="p-base" value="${PL.baseTravelMin}"></label>
      <label class="field">Raster (min)<input type="number" id="p-step" value="${PL.stepMin}"></label>
    </div>
    <label class="field">Link zu dieser App (für Klick auf Benachrichtigung)<input id="p-url" value="${esc(s.appUrl || location.origin + location.pathname)}"></label>
  </div>

  <div class="card"><h2>Sicherung</h2>
    <p class="small muted">Alle Einstellungen, Arbeitszeiten, Stundenplan und Termine als Datei sichern – oder aus einer Sicherung wiederherstellen.</p>
    <div class="row"><button class="btn" id="b-export">Sicherung speichern</button><button class="btn" id="b-import">Wiederherstellen</button></div>
    <input type="file" id="b-file" accept="application/json,.json" hidden>
  </div>

  <div class="card"><h2>Verbindung</h2><p class="small muted">${esc(conn().api)}</p>
    <button class="btn danger" id="logout">Von diesem Gerät abmelden</button></div>`;
}

function slider(key, title, val, min, max, help) {
  return `<label class="field"><b style="color:var(--text);font-size:15px">${title}</b> <span class="small" id="pv-${key}">${Number(val).toFixed(2)}</span>
    <input type="range" min="${min}" max="${max}" step="0.05" value="${val}" data-prio="${key}">
    <span class="small muted">${help}</span></label>`;
}

// ---- Aktionen --------------------------------------------------------------------
// Speichert Einstellungen in der Datenbank. Alle Speichervorgänge laufen nacheinander
// (Warteschlange), damit schnelle Änderungen nie verloren gehen. rerender=false beim
// Auto-Speichern, damit der Fokus im nächsten Eingabefeld bleibt. button = gegen Doppeltippen.
let chain = Promise.resolve();
function saveSettings(mut, msg = 'Gespeichert', { rerender = true, section = null, button = null } = {}) {
  if (button) { if (button.disabled) return Promise.resolve(false); button.disabled = true; }
  const run = async () => {
    const s = structuredClone(S.settings);
    if (mut(s) === false) { if (button) button.disabled = false; return false; }
    try {
      S.settings = await api('/settings', { method: 'PUT', body: s });
      S.ov = await api('/overview');
      if (rerender) render();
      else {
        const hint = section && document.querySelector(`[data-section="${section}"] .saved-hint`);
        if (hint) { hint.hidden = false; clearTimeout(hint.t); hint.t = setTimeout(() => { hint.hidden = true; }, 1800); }
      }
      if (msg) toast(msg);
      return true;
    } catch (e) {
      toast(`Nicht gespeichert: ${e.message}`);
      return false;
    } finally {
      if (button && !rerender) button.disabled = false;
      if (button && rerender && button.isConnected) button.disabled = false;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

function wire(root) {
  wireCharts(root);
  const val = (id) => root.querySelector(`#${id}`)?.value;

  root.querySelectorAll('[data-theme-set]').forEach((b) => b.onclick = () => {
    store.set('theme', b.dataset.themeSet);
    applyTheme(b.dataset.themeSet);
    root.querySelectorAll('[data-theme-set]').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
  });

  root.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => {
    S.tab = b.dataset.goto;
    store.set('tab', S.tab);
    render();
    if (b.dataset.goto === 'plan' && !S.settings.planReviewed) saveSettings((s) => { s.planReviewed = true; }, '', { rerender: false });
    const el = document.getElementById(b.dataset.anchor);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  root.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
    if (b.dataset.act === 'reset' && !confirm('Status für heute zurücksetzen?')) return;
    if (b.disabled) return;
    b.disabled = true;
    await chain;
    try {
      await api('/state', { method: 'POST', body: { action: b.dataset.act } });
      S.ov = await api('/overview');
      render();
      toast({ departed: 'Gute Fahrt!', arrived: 'Ankunft gespeichert', reset: 'Zurückgesetzt' }[b.dataset.act]);
    } catch (e) { toast(e.message); b.disabled = false; }
  });

  root.querySelectorAll('[data-override]').forEach((b) => b.onclick = () => {
    if (b.disabled) return;
    const d = b.dataset.override;
    const hours = num(val('ov-hours'), 0, 14, 0);
    if (hours > 0 && (!val('ov-earliest') || !val('ov-latest') || val('ov-latest') <= val('ov-earliest'))) return toast('„spätestens“ muss nach „frühestens“ liegen');
    saveSettings((s) => {
      s.overrides ||= {};
      s.overrides[d] = { ...(s.overrides[d] || {}), work: hours > 0 ? { hours, earliest: val('ov-earliest'), latest: val('ov-latest') } : null };
    }, 'Ausnahme gespeichert', { button: b });
  });
  root.querySelectorAll('[data-override-clear]').forEach((b) => b.onclick = () => {
    if (!confirm(`Ausnahme für ${fmtDate(b.dataset.overrideClear)} entfernen? Dann gilt wieder die normale Arbeitszeit.`)) return;
    saveSettings((s) => { delete s.overrides[b.dataset.overrideClear]; }, 'Entfernt');
  });

  const savers = {
    work: (s) => {
      for (const i of root.querySelectorAll('[data-work]')) {
        const d = i.dataset.work;
        s.work.days[d] ||= {};
        s.work.days[d][i.dataset.f] = i.dataset.f === 'hours' ? num(i.value, 0, 14, 0) : i.value;
      }
      for (const [d, w] of Object.entries(s.work.days)) {
        if (w.hours > 0 && (!w.earliest || !w.latest || w.latest <= w.earliest)) { toast(`${WD[d]}: „spätestens“ muss nach „frühestens“ liegen`); return false; }
      }
      s.work.pauseRules = [{ overHours: num(val('pr-over'), 0, 14, 6), pauseMin: num(val('pr-min'), 0, 120, 30) }, ...(s.work.pauseRules || []).slice(1)];
      s.work.location = val('work-loc');
      s.planReviewed = true;
    },
    locations: (s) => {
      for (const i of root.querySelectorAll('[data-loc][data-f="label"]')) {
        if (!i.value.trim()) { toast('Ein Ort braucht einen Namen'); return false; }
        if (s.locations[i.dataset.loc]) s.locations[i.dataset.loc].label = i.value.trim();
      }
    },
    priorities: (s) => root.querySelectorAll('[data-prio]').forEach((i) => { s.priorities[i.dataset.prio] = Number(i.value); }),
    notify: (s) => Object.assign(s.notify, {
      ntfyTopic: val('n-topic').trim(), eveningTime: val('n-evening') || '20:00', leadMin: num(val('n-lead'), 0, 120, 15),
      changeThresholdMin: num(val('n-thr'), 1, 60, 5), quietStart: val('n-qs'), quietEnd: val('n-qe'),
    }),
    traffic: (s) => Object.assign(s.traffic, { tomtomKey: val('t-key').trim(), provider: val('t-prov'), apiDailyLimit: num(val('t-limit'), 50, 2500, 2000) }),
    planning: (s) => {
      Object.assign(s.planning, { bufferMin: num(val('p-buffer'), 0, 60, 5), maxWaitAfterMin: num(val('p-wait'), 0, 300, 120), baseTravelMin: num(val('p-base'), 5, 240, 35), stepMin: num(val('p-step'), 5, 30, 5) });
      s.appUrl = val('p-url');
    },
  };
  root.querySelectorAll('[data-section]').forEach((sec) => {
    const save = savers[sec.dataset.section];
    if (!save) return;
    sec.addEventListener('change', (e) => {
      if (e.target.matches('[data-f="address"], input[type="file"]')) return;
      const isKey = e.target.id === 't-key';
      saveSettings(save, isKey ? 'TomTom-Schlüssel gespeichert ✓' : '', { rerender: isKey, section: sec.dataset.section });
    });
  });

  root.querySelectorAll('[data-prio]').forEach((i) => i.oninput = () => { root.querySelector(`#pv-${i.dataset.prio}`).textContent = Number(i.value).toFixed(2); });

  const geocode = async (k) => {
    const q = root.querySelector(`[data-loc="${k}"][data-f="address"]`).value.trim();
    if (!q) return toast('Bitte erst eine Adresse eingeben');
    if (!S.settings.traffic.tomtomKey) return toast('Erst oben den TomTom-Schlüssel eintragen');
    try {
      const hit = await api(`/geocode?q=${encodeURIComponent(q)}`);
      if (!hit) return toast('Adresse nicht gefunden');
      saveSettings((s) => { readLocs(root, s); Object.assign(s.locations[k], { address: hit.address, lat: hit.lat, lon: hit.lon }); }, `Gefunden: ${hit.address}`);
    } catch (e) { toast(e.message); }
  };
  root.querySelectorAll('[data-geo]').forEach((b) => b.onclick = () => geocode(b.dataset.geo));
  root.querySelectorAll('[data-f="address"]').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); geocode(i.dataset.loc); } }));
  root.querySelector('[data-add-loc]')?.addEventListener('click', () => saveSettings((s) => { readLocs(root, s); s.locations[`ort_${uid()}`] = { label: 'Neuer Ort', address: '', lat: null, lon: null }; }, 'Ort hinzugefügt'));
  root.querySelectorAll('[data-del-loc]').forEach((b) => b.onclick = () => {
    const k = b.dataset.delLoc;
    const used = (S.settings.study || []).some((e) => e.location === k) || (S.settings.appointments || []).some((e) => e.location === k);
    if (!confirm(`Ort „${place(k)}“ wirklich löschen?${used ? '\n\nAchtung: Veranstaltungen/Termine nutzen diesen Ort noch.' : ''}`)) return;
    saveSettings((s) => { delete s.locations[k]; }, 'Ort entfernt');
  });

  const checkTimes = (a, b) => {
    if (!a || !b) { toast('Bitte „von“ und „bis“ ausfüllen'); return false; }
    if (b <= a) { toast('„bis“ muss nach „von“ liegen'); return false; }
    return true;
  };
  root.querySelector('[data-add="study"]')?.addEventListener('click', (ev) => {
    if (!val('st-title').trim()) return toast('Bitte einen Titel eingeben');
    if (!checkTimes(val('st-start'), val('st-end'))) return;
    saveSettings((s) => { s.study = [...(s.study || []), { id: uid(), title: val('st-title').trim(), weekday: Number(val('st-wd')), start: val('st-start'), end: val('st-end'), location: val('st-loc'), kind: val('st-kind'), until: val('st-until') || null }]; }, 'Veranstaltung hinzugefügt', { button: ev.currentTarget });
  });
  root.querySelector('[data-add="appt"]')?.addEventListener('click', (ev) => {
    if (!val('ap-title').trim()) return toast('Bitte einen Titel eingeben');
    if (!val('ap-date')) return toast('Bitte ein Datum wählen');
    if (!checkTimes(val('ap-start'), val('ap-end'))) return;
    saveSettings((s) => { s.appointments = [...(s.appointments || []), { id: uid(), title: val('ap-title').trim(), date: val('ap-date'), start: val('ap-start'), end: val('ap-end'), location: val('ap-loc'), kind: val('ap-kind'), category: val('ap-cat') }]; }, 'Termin hinzugefügt', { button: ev.currentTarget });
  });
  root.querySelectorAll('[data-del-study]').forEach((b) => b.onclick = () => {
    const e = S.settings.study.find((x) => x.id === b.dataset.delStudy);
    if (!confirm(`„${e?.title}“ aus dem Stundenplan löschen?`)) return;
    saveSettings((s) => { s.study = s.study.filter((x) => x.id !== b.dataset.delStudy); }, 'Gelöscht');
  });
  root.querySelectorAll('[data-del-appt]').forEach((b) => b.onclick = () => {
    const e = S.settings.appointments.find((x) => x.id === b.dataset.delAppt);
    if (!confirm(`Termin „${e?.title}“ löschen?`)) return;
    saveSettings((s) => { s.appointments = s.appointments.filter((x) => x.id !== b.dataset.delAppt); }, 'Gelöscht');
  });

  root.querySelector('#n-gen')?.addEventListener('click', () => {
    if (S.settings.notify.ntfyTopic && !confirm('Neues Thema erzeugen? Danach musst du es in ntfy neu abonnieren.')) return;
    const topic = `pendel-${uid()}${uid()}`;
    root.querySelector('#n-topic').value = topic;
    saveSettings((s) => { s.notify.ntfyTopic = topic; }, 'Thema erzeugt – jetzt „Kopieren“ tippen', { rerender: false, section: 'notify' });
  });
  root.querySelector('#n-copy')?.addEventListener('click', async () => {
    const t = val('n-topic').trim();
    if (!t) return toast('Erst „Neu erzeugen“ tippen');
    try { await navigator.clipboard.writeText(t); toast('Kopiert – jetzt in ntfy einfügen'); } catch { root.querySelector('#n-topic').select(); toast('Bitte lange drücken und kopieren'); }
  });
  root.querySelector('#n-test')?.addEventListener('click', async () => {
    try {
      const topic = val('n-topic').trim();
      if (!topic) return toast('Erst „Neu erzeugen“ tippen');
      if (topic !== S.settings.notify.ntfyTopic) await saveSettings((s) => { s.notify.ntfyTopic = topic; }, '', { rerender: false });
      await api('/test-notification', { method: 'POST' });
      toast('Test gesendet – kam er an?');
    } catch (e) { toast(e.message); }
  });
  root.querySelector('#logout')?.addEventListener('click', () => {
    if (!confirm('Von diesem Gerät abmelden? Deine Daten bleiben erhalten, du brauchst danach aber den Zugangsschlüssel erneut.')) return;
    store.del('api'); store.del('token'); renderConnect();
  });

  // Sicherung
  root.querySelector('#b-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'pendelpilot', version: 1, savedAt: new Date().toISOString(), settings: S.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pendelpilot-sicherung-${S.ov.today}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  root.querySelector('#b-import')?.addEventListener('click', () => root.querySelector('#b-file').click());
  root.querySelector('#b-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('Die Datei ist keine gültige Sicherung'); }
    const imp = data?.settings ?? data;
    if (!imp || typeof imp !== 'object' || Array.isArray(imp) || !(imp.locations || imp.work || imp.study)) return toast('Die Datei ist keine Pendelpilot-Sicherung');
    if (!confirm('Sicherung wiederherstellen? Deine aktuellen Einstellungen, Stundenplan und Termine werden ersetzt.')) return;
    saveSettings((s) => {
      // Nur bekannte Bereiche übernehmen; kaputte Listen verwerfen. Der Server ergänzt fehlende Felder.
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
  });
}

function readLocs(root, s) {
  root.querySelectorAll('[data-loc]').forEach((i) => {
    const l = s.locations[i.dataset.loc];
    if (!l) return;
    if (i.dataset.f === 'address' && i.value !== l.address) { l.lat = null; l.lon = null; }
    l[i.dataset.f] = i.value;
  });
}

// Updates: beim Öffnen/Zurückkehren nach neuer Version schauen und dann automatisch neu laden.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}
load();
setInterval(() => { if (document.visibilityState === 'visible' && ['today', 'tomorrow'].includes(S.tab)) load(); }, 120000);

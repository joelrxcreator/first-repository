import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../supabase/functions/pendel/server.js';
import { memoryStore } from '../supabase/functions/pendel/store_memory.js';
import { demoTravel } from '../supabase/functions/pendel/core/demo.js';
import { zonedToUtc, localParts } from '../supabase/functions/pendel/core/time.js';

const LOC = {
  home: { label: 'Zuhause', lat: 50.80, lon: 7.20 },
  work: { label: 'Arbeit', lat: 50.94, lon: 6.96 },
  uni: { label: 'Uni', lat: 50.73, lon: 7.10 },
};

// Simuliertes TomTom + ntfy
function fakeFetch(log) {
  return async (url, init) => {
    if (String(url).startsWith('https://ntfy.sh')) {
      log.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({}) };
    }
    const u = new URL(url);
    log.calls = (log.calls || 0) + 1;
    const [a, b] = u.pathname.split('/')[4].split(':');
    const name = (p) => Object.entries(LOC).find(([, l]) => `${l.lat},${l.lon}` === p)[0];
    const dep = u.searchParams.get('departAt');
    const t = dep === 'now' ? log.now : new Date(dep);
    const lp = localParts(t);
    // "Echte" Lage: heute 20 % mehr Stau als die Prognose
    const factor = dep === 'now' ? 1.2 : 1;
    const min = demoTravel(name(a), name(b), lp.dateStr, lp.minutes, 35) * factor;
    return { ok: true, json: async () => ({ routes: [{ summary: { travelTimeInSeconds: min * 60 } }] }) };
  };
}

test('Ein Tag im Leben: Vorabend-Prognose, Update, Losfahr-Hinweis, Lernen', async () => {
  const log = [];
  const store = memoryStore({
    settings: { locations: LOC, traffic: { provider: 'tomtom', tomtomKey: 'x' }, notify: { ntfyTopic: 'test-topic' } },
  });
  const app = createApp({ store, fetchImpl: fakeFetch(log), log: () => {}, throttleMs: 0 });

  // Sonntagabend 20:05 → Prognose für Montag
  for (let m = 12 * 60; m <= 20 * 60 + 5; m += 5) {
    log.now = zonedToUtc('2026-10-11', m);
    await app.tick(log.now);
  }
  const evening = log.find((n) => n.title.startsWith('Morgen'));
  assert.ok(evening, 'Vorabend-Nachricht kommt');
  assert.match(evening.title, /\d\d:\d\d losfahren/);
  const usageSunday = await store.getUsage('2026-10-11');
  assert.ok(usageSunday > 10 && usageSunday < 400, `API-Aufrufe Sonntag: ${usageSunday}`);

  // Montag 04:30 → 16:30 im 5-Minuten-Takt
  for (let m = 270; m <= 16.5 * 60; m += 5) {
    log.now = zonedToUtc('2026-10-12', m);
    await app.tick(log.now);
  }
  const titles = log.map((n) => n.title);
  assert.ok(titles.some((t) => /losfahren|Jetzt losfahren/.test(t) && !t.startsWith('Morgen')), titles.join('\n'));
  // nie zwei identische Nachrichten
  assert.equal(new Set(log.map((n) => n.title + n.message)).size, log.length);
  // keine Nachrichten in der Ruhezeit
  const st = await store.getState('2026-10-12');
  assert.equal(st.location, 'work', 'Ankunft auf der Arbeit wurde angenommen');
  assert.ok(st.workStart >= 390);
  const usageMonday = await store.getUsage('2026-10-12');
  assert.ok(usageMonday < 800, `API-Aufrufe Montag: ${usageMonday}`);

  const ov = await app.overview(log.now);
  assert.ok(ov.todayPlan.scenarios[0].legs[0].to === 'home');
  const stats = await app.stats(log.now);
  assert.ok(stats.samples > 20);
  console.log(titles.join('\n'));
  console.log('API-Aufrufe:', usageSunday, usageMonday);
});

test('Manuelle Rückmeldung „losgefahren/angekommen“ speichert echte Fahrt', async () => {
  const store = memoryStore({ settings: { locations: LOC } });
  const app = createApp({ store, log: () => {} });
  const t1 = zonedToUtc('2026-10-12', 400);
  await app.setState({ action: 'departed' }, t1);
  const st = await app.setState({ action: 'arrived', location: 'work' }, zonedToUtc('2026-10-12', 441));
  assert.equal(st.workStart, 441);
  assert.equal(store.db.obs[0].minutes, 41);
  assert.equal(store.db.obs[0].source, 'trip');
  const ov = await app.overview(zonedToUtc('2026-10-12', 600));
  const legs = ov.todayPlan.scenarios[0].legs;
  assert.equal(legs.length, 1);
  assert.ok(legs[0].depart >= 441 + 510);
});

test('Ohne ntfy-Thema wird nichts als verschickt markiert', async () => {
  const store = memoryStore({ settings: { locations: LOC } });
  const app = createApp({ store, log: () => {} });
  await app.tick(zonedToUtc('2026-10-11', 20 * 60 + 5));
  assert.equal(store.db.sent.length, 0);
  await store.saveSettings({ ...(await store.getSettings()), locations: LOC, notify: { ntfyTopic: 't' } });
  const sent = [];
  const app2 = createApp({ store, log: () => {}, fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; } });
  await app2.tick(zonedToUtc('2026-10-11', 20 * 60 + 10));
  assert.ok(sent.some((n) => n.title.startsWith('Morgen')), 'Vorabend-Nachricht kommt nach Einrichtung');
});

import crypto from 'node:crypto';
import { b64u } from '../supabase/functions/pendel/webpush.js';

// Gegenstück zur Verschlüsselung (wie im Browser), um echte Zustellung zu prüfen
function decryptPush(body, ua, auth) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const shared = ua.computeSecret(asPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString());
}

test('Direkte Push-Nachricht aufs Handy: verschlüsselt, signiert, abgelaufene Abos werden entfernt', async () => {
  const store = memoryStore({ settings: { locations: LOC } });
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const got = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('gone')) return { ok: false, status: 410 };
    got.push({ url, headers: init.headers, msg: decryptPush(init.body, ua, auth) });
    return { ok: true, status: 201 };
  };
  const app = createApp({ store, fetchImpl, log: () => {}, throttleMs: 0 });
  const { publicKey } = await app.pushKey();
  assert.equal(b64u.decode(publicKey).length, 65);
  await app.pushSubscribe({ subscription: { endpoint: 'https://web.push.apple.com/ok', keys: { p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) } } });
  await app.pushSubscribe({ subscription: { endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: b64u.encode(ua.getPublicKey()), auth: b64u.encode(auth) } } });
  const r = await app.testNotification();
  assert.equal(r.ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].msg.title, 'Pendelpilot: Test');
  assert.match(got[0].headers.Authorization, /^vapid t=.+, k=/);
  assert.equal((await store.listPushSubs()).length, 1, 'abgelaufenes Abo entfernt');
});

test('ntfy 429: klare Meldung, nicht als verschickt markiert, im Protokoll sichtbar', async () => {
  const store = memoryStore({ settings: { locations: LOC, notify: { ntfyTopic: 't' } } });
  const fetchImpl = async () => ({ ok: false, status: 429 });
  const app = createApp({ store, fetchImpl, log: () => {}, throttleMs: 0 });
  await assert.rejects(app.testNotification(), /Kontingent erschöpft/);
  await app.tick(zonedToUtc('2026-10-11', 20 * 60 + 5));
  assert.equal(store.db.sent.length, 0);
  assert.ok(store.db.fetchLog.some((x) => x.kind === 'notify-ntfy' && /429/.test(x.note)));
  // mit eigenem Zugang wird der Schlüssel mitgeschickt
  let authHeader = null;
  await store.saveSettings({ ...(await store.getSettings()), notify: { ntfyTopic: 't', ntfyToken: 'tk_abc' } });
  const app2 = createApp({ store, fetchImpl: async (u, i) => { authHeader = i.headers.Authorization; return { ok: true, status: 200 }; }, log: () => {} });
  await app2.testNotification();
  assert.equal(authHeader, 'Bearer tk_abc');
});

test('Abruf-Häufigkeit ist einstellbar und wird protokolliert; Tempo-Bremse wirkt', async () => {
  const log = [];
  const mk = (traffic, throttleMs = 0) => {
    const store = memoryStore({ settings: { locations: LOC, traffic: { provider: 'tomtom', tomtomKey: 'x', ...traffic } } });
    return { store, app: createApp({ store, fetchImpl: fakeFetch(log), log: () => {}, throttleMs }) };
  };
  // Montag 10:00–12:00, keine Fahrt in Sicht → nur Lern-Messungen
  const run = async (app, step = 5) => { for (let m = 600; m < 720; m += step) { log.now = zonedToUtc('2026-10-12', m); await app.tick(log.now); } };
  const a = mk({ liveIdleMin: 30, forecastTodayMin: 0, tomorrowRuns: 0 });
  await run(a.app);
  const liveA = a.store.db.obs.filter((o) => o.source === 'live').length;
  const b = mk({ liveIdleMin: 0, forecastTodayMin: 0, tomorrowRuns: 0 });
  await run(b.app);
  const liveB = b.store.db.obs.filter((o) => o.source === 'live').length;
  assert.ok(liveA >= 4 && liveA <= 10, `alle 30 min: ${liveA}`);
  assert.ok(liveB <= liveA / 2, `Lernen aus: ${liveB}`);
  assert.ok(a.store.db.fetchLog.some((x) => x.kind === 'live' && x.calls > 0));
  const act = await a.app.activity(log.now);
  assert.equal(act.days.length, 7);
  assert.ok(act.log.length > 0);
  // Tageslimit wird eingehalten und vermerkt
  const c = mk({ apiDailyLimit: 3, liveIdleMin: 5, forecastTodayMin: 60, tomorrowRuns: 2 });
  await run(c.app);
  assert.ok((await c.store.getUsage('2026-10-12')) <= 3);
  assert.ok(c.store.db.fetchLog.some((x) => x.kind === 'limit'));
  // Bremse: mehrere Abrufe in einem Takt liegen ≥ 200 ms auseinander
  const times = [];
  const d = memoryStore({ settings: { locations: LOC, traffic: { provider: 'tomtom', tomtomKey: 'x', tomorrowRuns: 1 } } });
  const appD = createApp({ store: d, log: () => {}, throttleMs: 200, fetchImpl: async (url, init) => { times.push(Date.now()); return fakeFetch(log)(url, init); } });
  log.now = zonedToUtc('2026-10-11', 19 * 60 + 30);
  await appD.tick(log.now);
  assert.ok(times.length >= 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 190, `Abstand ${times[i] - times[i - 1]} ms`);
});

test('Sofort aktualisieren: holt Prognosen für den Tag, höchstens alle 3 Minuten', async () => {
  const log = [];
  const store = memoryStore({ settings: { locations: LOC, traffic: { tomtomKey: 'k' } } });
  const app = createApp({ store, fetchImpl: fakeFetch(log), log: () => {}, throttleMs: 0 });
  const now = zonedToUtc('2026-10-12', 600);
  log.now = now;
  const r1 = await app.refreshNow('2026-10-13', now);
  assert.ok(r1.fetched > 0 && r1.fetched <= 60, `fetched ${r1.fetched}`);
  assert.ok(r1.plan.scenarios.length);
  const r2 = await app.refreshNow('2026-10-13', new Date(now.getTime() + 60000));
  assert.equal(r2.skipped, 'recent');
  assert.equal(r2.fetched, 0);
  const act = await app.activity(now);
  assert.ok(act.log.some((x) => x.kind === 'refresh'));
  await assert.rejects(app.refreshNow('2020-01-01', now));
});

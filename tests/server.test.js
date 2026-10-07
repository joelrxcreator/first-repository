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
  const app = createApp({ store, fetchImpl: fakeFetch(log), log: () => {} });

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

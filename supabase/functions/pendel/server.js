// Anwendungslogik des Backends, unabhängig von Supabase (Speicher wird injiziert).
import { withDefaults, buildDay, dayLocations } from './core/schedule.js';
import { planDay } from './core/planner.js';
import { buildTravelModel, median } from './core/traffic.js';
import { explainPlan } from './core/explain.js';
import { decideNotifications } from './core/notify.js';
import { localParts, addDays, zonedToUtc, minutesOn, parseHM, weekdayOf } from './core/time.js';
import { tomtomProvider, tomtomGeocode, sendNtfy } from './providers.js';
import { generateVapidKeys, sendWebPush } from './webpush.js';

const DAY = 86400000;

const DEFAULT_SUBJECT = 'https://joelrxcreator.github.io/first-repository/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApp({ store, fetchImpl = fetch, log = console.log, appUrl = '', throttleMs = 260 }) {
  async function settings() {
    return withDefaults(await store.getSettings());
  }

  function hasCoords(s, loc) {
    const l = s.locations[loc];
    return l && l.lat != null && l.lon != null;
  }

  function liveProvider(s) {
    if (s.traffic.provider !== 'tomtom' || !s.traffic.tomtomKey) return null;
    return tomtomProvider(s.traffic.tomtomKey, s.locations, fetchImpl);
  }

  async function computeDay(s, date, now) {
    const day = buildDay(s, date);
    const locs = dayLocations(day);
    const observations = await store.getObservations({
      since: new Date(now.getTime() - 72 * DAY).toISOString(),
      locations: locs,
      forecastFrom: zonedToUtc(date, 0).toISOString(),
      forecastTo: zonedToUtc(date, 1440).toISOString(),
    });
    const travel = buildTravelModel({ observations, date, now, settings: s });
    const lp = localParts(now);
    const isToday = lp.dateStr === date;
    const state = isToday ? await store.getState(date) : null;
    const plan = planDay(day, travel, s, isToday ? { nowMin: lp.minutes, state: state || {} } : {});
    explainPlan(plan, s);
    plan.weekday = day.weekday;
    plan.day = day;
    plan.state = state;
    plan.computedAt = now.toISOString();
    plan.curves = {};
    const pairs = new Set();
    for (const sc of plan.scenarios.slice(0, 3)) for (const l of sc.legs) pairs.add(`${l.from}>${l.to}`);
    if (day.work) { pairs.add(`home>${day.work.location}`); pairs.add(`${day.work.location}>home`); }
    for (const p of pairs) {
      const [a, b] = p.split('>');
      plan.curves[p] = travel.curve(a, b);
    }
    return plan;
  }

  // ---- Verkehrsdaten holen ---------------------------------------------------
  async function refreshTraffic(s, now, todayPlan, tomorrowPlan) {
    const prov = liveProvider(s);
    if (!prov) return 0;
    const lp = localParts(now);
    const usageDay = lp.dateStr;
    let used = await store.getUsage(usageDay);
    const limit = s.traffic.apiDailyLimit || 2000;
    let calls = 0;
    const rows = [];
    const T = s.traffic;
    const budget = () => used + calls < limit;
    const stats = {}; // je Art: Abrufe, Fehler, letzter Fehler
    let lastCall = 0, budgetHit = false;
    const call = async (kind, from, to, depart) => {
      if (!budget()) { budgetHit = true; return null; }
      const wait = lastCall + throttleMs - Date.now(); // TomTom erlaubt nur wenige Abfragen pro Sekunde
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      calls++;
      const st = (stats[kind] ||= { calls: 0, failed: 0, error: '' });
      st.calls++;
      try { return await prov.route(from, to, depart); } catch (e) {
        st.failed++; st.error = e.message.slice(0, 160);
        log(`Verkehrsabfrage fehlgeschlagen: ${e.message}`);
        return null;
      }
    };

    // a) Live-Messungen (Lernen + Korrektur der Prognose)
    const nowMin = lp.minutes;
    const activeFrom = parseHM(T.activeFrom) ?? 300, activeTo = parseHM(T.activeTo) ?? 1320;
    const weekend = weekdayOf(lp.dateStr) >= 5;
    if (nowMin >= activeFrom && nowMin <= activeTo) {
      const pairs = new Map();
      const upcoming = todayPlan?.scenarios?.[0]?.legs || [];
      for (const l of upcoming) pairs.set(`${l.from}>${l.to}`, l.depart >= nowMin - 15 && l.depart <= nowMin + 180);
      const wl = todayPlan?.day?.work?.location || s.work.location;
      if (T.liveIdleMin > 0 && (!weekend || T.learnWeekends)) for (const p of [`home>${wl}`, `${wl}>home`]) if (!pairs.has(p)) pairs.set(p, false);
      const dayahead = await store.getPlan(lp.dateStr, 'dayahead');
      for (const [p, hot] of pairs) {
        const [a, b] = p.split('>');
        if (!hasCoords(s, a) || !hasCoords(s, b)) continue;
        const every = hot ? Math.max(5, T.liveHotMin || 5) : T.liveIdleMin;
        if (!every) continue;
        const last = await store.lastFetched(a, b, 'live');
        if (last && now - new Date(last) < every * 60000 - 60000) continue;
        const m = await call('live', a, b, 'now');
        if (m == null) continue;
        const ref = await store.findForecast(a, b, now.toISOString(), new Date(now.getTime() - 3 * 3600000).toISOString());
        const curve = dayahead?.curves?.[p]?.points;
        const refModel = curve ? nearest(curve, nowMin) : null;
        rows.push({ origin: a, dest: b, depart_at: now.toISOString(), fetched_at: now.toISOString(), minutes: round1(m), source: 'live', ref_forecast: ref, ref_model: refModel });
      }
    }

    // b) Prognosen des Dienstes rund um die interessanten Abfahrtszeiten
    const evening = parseHM(s.notify.eveningTime) ?? 1200;
    const jobs = [];
    const windows = (plan) => {
      const w = new Map();
      for (const sc of plan?.scenarios?.slice(0, 3) || []) for (const l of sc.legs) {
        const k = `${l.from}>${l.to}`;
        if (!w.has(k)) w.set(k, new Set());
        for (let m = Math.round((l.depart - 120) / 15) * 15; m <= l.depart + 120; m += 15) w.get(k).add(m);
      }
      return w;
    };
    // heute: stündlich, nur die nächsten 5 Stunden
    if (todayPlan && T.forecastTodayMin > 0) jobs.push({ kind: 'forecast-today', date: lp.dateStr, plan: todayPlan, every: T.forecastTodayMin, from: nowMin + 5, to: nowMin + 300 });
    // morgen: mittags und/oder vor der Abendnachricht
    if (tomorrowPlan && T.tomorrowRuns > 0) {
      const lastT = await store.lastForecastFetch(addDays(lp.dateStr, 1));
      const lastMin = lastT ? minutesOn(lp.dateStr, new Date(lastT)) : -Infinity;
      const midday = T.tomorrowRuns >= 2 && nowMin >= 720 && lastMin < 0;
      const eveningRun = nowMin >= evening - 60 && lastMin < evening - 60;
      if (midday || eveningRun) jobs.push({ kind: 'forecast-tomorrow', date: addDays(lp.dateStr, 1), plan: tomorrowPlan, every: 0, from: 0, to: 1440 });
    }
    for (const job of jobs) {
      for (const [p, mins] of windows(job.plan)) {
        const [a, b] = p.split('>');
        if (!hasCoords(s, a) || !hasCoords(s, b)) continue;
        if (job.every) {
          const last = await store.lastForecastFetch(job.date, a, b);
          if (last && now - new Date(last) < job.every * 60000 - 60000) continue;
        }
        for (const m of [...mins].sort((x, y) => x - y)) {
          if (m < job.from || m > job.to || m < 270 || m > 1410) continue;
          const dep = zonedToUtc(job.date, m);
          if (dep.getTime() < now.getTime() + 2 * 60000) continue;
          const v = await call(job.kind, a, b, dep);
          if (v == null) continue;
          rows.push({ origin: a, dest: b, depart_at: dep.toISOString(), fetched_at: now.toISOString(), minutes: round1(v), source: 'forecast' });
        }
      }
    }
    if (rows.length) await store.addObservations(rows);
    if (calls) await store.addUsage(usageDay, calls);
    for (const [kind, st] of Object.entries(stats)) {
      await store.addFetchLog({ ts: now.toISOString(), kind, calls: st.calls, failed: st.failed, note: st.error || null });
    }
    if (budgetHit && !(await store.getFetchLog(now.toISOString().slice(0, 10))).some((x) => x.kind === 'limit')) {
      await store.addFetchLog({ ts: now.toISOString(), kind: 'limit', calls: 0, failed: 0, note: `Tageslimit von ${limit} Abfragen erreicht` });
    }
    return rows.length;
  }

  // ---- Annahme: Empfehlung wurde befolgt (korrigierbar in der App) ------------
  // Ist die empfohlene Abfahrt des letzten Plans erreicht, gilt man als unterwegs.
  function applyDeparture(st, plan, at) {
    const sc = plan?.scenarios?.[0];
    const leg = sc?.legs?.[0];
    if (!leg) return null;
    const minutes = leg.minutes; // Fahrzeit laut Plan
    const next = { ...st, departedAt: at, departFrom: leg.from, location: leg.to, availableFrom: at + minutes };
    const workLoc = plan.day?.work?.location;
    if (leg.to === workLoc && st.workStart == null && sc.work) {
      next.workStart = Math.max(at + minutes, sc.work.start);
      next.workStartEstimated = true;
    }
    if (leg.to === 'home' && st.workStart != null) next.workDone = true;
    return next;
  }

  async function autoAdvance(now, prevToday) {
    const lp = localParts(now);
    const leg = prevToday?.scenarios?.[0]?.legs?.[0];
    if (!leg || prevToday.day?.date !== lp.dateStr) return false;
    if (leg.depart > lp.minutes) return false;
    const st = (await store.getState(lp.dateStr)) || {};
    if (st.departedAt != null && st.departedAt >= leg.depart) return false;
    const next = applyDeparture(st, prevToday, leg.depart);
    if (!next) return false;
    await store.saveState(lp.dateStr, { ...next, assumed: true });
    return true;
  }

  // ---- Benachrichtigungen zustellen: direkt aufs Handy (Web Push) und/oder ntfy ----
  async function vapidKeys() {
    let v = await store.getVapid();
    if (!v) { v = await generateVapidKeys(); await store.saveVapid(v); }
    return v;
  }

  async function deliver(s, msg, now) {
    const results = [];
    const subs = await store.listPushSubs();
    if (subs.length) {
      const vapid = await vapidKeys();
      for (const sub of subs) {
        try {
          const r = await sendWebPush(sub, { title: msg.title, body: msg.message, url: appUrl || DEFAULT_SUBJECT, tag: msg.key?.split(':').slice(0, 2).join(':') },
            vapid, { subject: appUrl || DEFAULT_SUBJECT, urgency: msg.priority >= 4 ? 'high' : 'normal', fetchImpl });
          if (r.gone) await store.deletePushSub(sub.endpoint);
          results.push({ channel: 'push', ok: r.ok, error: r.ok ? null : r.gone ? 'Abo abgelaufen – auf dem Handy neu erlauben' : `Push-Dienst ${r.status}` });
        } catch (e) { results.push({ channel: 'push', ok: false, error: e.message }); }
      }
    }
    if (s.notify.ntfyTopic) {
      try {
        await sendNtfy(s.notify.ntfyTopic, { ...msg, click: appUrl || undefined }, fetchImpl, s.notify.ntfyToken);
        results.push({ channel: 'ntfy', ok: true });
      } catch (e) { results.push({ channel: 'ntfy', ok: false, error: e.message }); }
    }
    for (const r of results.filter((x) => !x.ok)) {
      await store.addFetchLog({ ts: now.toISOString(), kind: `notify-${r.channel}`, calls: 1, failed: 1, note: `${msg.title}: ${r.error}`.slice(0, 200) });
    }
    return results;
  }

  async function tick(now = new Date()) {
    const s = await settings();
    const lp = localParts(now);
    const today = lp.dateStr, tomorrow = addDays(today, 1);
    const prevToday = await store.getPlan(today, 'live');
    const advanced = await autoAdvance(now, prevToday);

    let todayPlan = await computeDay(s, today, now);
    let tomorrowPlan = await computeDay(s, tomorrow, now);
    const fetched = await refreshTraffic(s, now, todayPlan, tomorrowPlan);
    if (fetched) {
      todayPlan = await computeDay(s, today, now);
      tomorrowPlan = await computeDay(s, tomorrow, now);
    }
    await store.savePlan(today, 'live', todayPlan);
    await store.savePlan(tomorrow, 'dayahead', tomorrowPlan);

    const sent = await store.getSent(today);
    const decisions = decideNotifications({ nowMin: lp.minutes, today, tomorrow, todayPlan, tomorrowPlan, settings: s, sent });
    const delivered = [];
    // Nur als verschickt markieren, wenn mindestens ein Weg geklappt hat – sonst nächster Versuch beim nächsten Takt.
    const hasChannel = s.notify.ntfyTopic || (await store.listPushSubs()).length;
    for (const d of hasChannel ? decisions : []) {
      const res = await deliver(s, d, now);
      if (res.some((r) => r.ok)) {
        await store.addSent({ key: d.key, date: d.payload?.date || today, title: d.title, message: d.message, payload: d.payload, ts: now.toISOString() });
        delivered.push(d.title);
      } else log(`Benachrichtigung fehlgeschlagen: ${res.map((r) => r.error).join('; ')}`);
    }
    return { ok: true, today, fetched, advanced, notifications: delivered };
  }

  // ---- Endpunkte für die App -------------------------------------------------
  async function overview(now = new Date()) {
    const s = await settings();
    const lp = localParts(now);
    const today = lp.dateStr, tomorrow = addDays(today, 1);
    const [todayPlan, tomorrowPlan] = [await computeDay(s, today, now), await computeDay(s, tomorrow, now)];
    const sent = await store.getSent(addDays(today, -1));
    return {
      now: now.toISOString(), nowMin: lp.minutes, today, tomorrow,
      todayPlan, tomorrowPlan,
      notifications: sent.slice(-15).reverse(),
      usage: await store.getUsage(today),
      provider: liveProvider(s) ? 'tomtom' : 'demo',
      pushDevices: (await store.listPushSubs()).length,
    };
  }

  async function planFor(date, now = new Date()) {
    return computeDay(await settings(), date, now);
  }

  async function setState(body, now = new Date()) {
    const lp = localParts(now);
    const date = lp.dateStr;
    const at = body.at != null ? parseHM(body.at) : Math.round(lp.minutes);
    const st = (await store.getState(date)) || {};
    if (body.action === 'reset') { await store.saveState(date, null); return {}; }
    const plan = await computeDay(await settings(), date, now);
    if (body.action === 'departed') {
      const next = applyDeparture(st, plan, at) || { ...st, departedAt: at, departFrom: st.location || 'home' };
      Object.keys(st).forEach((k) => delete st[k]);
      Object.assign(st, next, { assumed: false });
    } else if (body.action === 'arrived') {
      const to = body.location || (st.departedAt != null ? st.location : plan.scenarios?.[0]?.legs?.[0]?.to) || 'work';
      const from = st.departFrom || 'home';
      if (st.departedAt != null && at > st.departedAt && from !== to) {
        await store.addObservations([{
          origin: from, dest: to, depart_at: zonedToUtc(date, st.departedAt).toISOString(), fetched_at: now.toISOString(),
          minutes: at - st.departedAt, source: 'trip',
        }]);
      }
      const workLoc = plan.day?.work?.location;
      Object.assign(st, { location: to, availableFrom: at, departedAt: null, assumed: false });
      if (to === workLoc && (st.workStart == null || st.workStartEstimated)) { st.workStart = at; st.workStartEstimated = false; }
      if (to === 'home' && st.workStart != null) st.workDone = true;
    } else if (body.action === 'workStart') {
      st.workStart = at; st.location = st.location || 'work'; st.assumed = false;
    }
    await store.saveState(date, st);
    return st;
  }

  async function stats(now = new Date()) {
    const s = await settings();
    const rows = await store.getObservations({ since: new Date(now.getTime() - 120 * DAY).toISOString(), locations: Object.keys(s.locations), actualOnly: true });
    const wl = s.work.location;
    const heat = {};
    for (const p of [`home>${wl}`, `${wl}>home`]) {
      const grid = {};
      for (const o of rows) {
        if (`${o.origin}>${o.dest}` !== p) continue;
        const l = localParts(new Date(o.depart_at));
        const k = `${l.weekday}|${Math.floor(l.minutes / 30) * 30}`;
        (grid[k] ||= []).push(Number(o.minutes));
      }
      heat[p] = Object.fromEntries(Object.entries(grid).map(([k, v]) => [k, { median: round1(median(v)), n: v.length }]));
    }
    const err = (field) => {
      const e = rows.filter((o) => o[field] > 0).map((o) => Math.abs(o.minutes - o[field]));
      return e.length ? { mae: round1(e.reduce((a, b) => a + b, 0) / e.length), n: e.length } : null;
    };
    const days = new Set(rows.map((o) => localParts(new Date(o.depart_at)).dateStr));
    return {
      samples: rows.length, days: days.size, heat,
      accuracy: { service: err('ref_forecast'), app: err('ref_model') },
      trips: rows.filter((o) => o.source === 'trip').length,
    };
  }

  async function geocode(q) {
    const s = await settings();
    if (!s.traffic.tomtomKey) throw new Error('Für die Adresssuche wird ein TomTom-Schlüssel benötigt.');
    return tomtomGeocode(s.traffic.tomtomKey, q, fetchImpl);
  }

  async function testNotification(now = new Date()) {
    const s = await settings();
    const res = await deliver(s, { key: 'test', title: 'Pendelpilot: Test', message: 'Benachrichtigungen funktionieren 👍', priority: 3 }, now);
    if (!res.length) throw new Error('Noch kein Weg eingerichtet – erlaube Mitteilungen auf dem Handy oder trage ein ntfy-Thema ein.');
    if (!res.some((r) => r.ok)) throw new Error(res.map((r) => r.error).join(' · '));
    return { ok: true, results: res };
  }

  async function pushKey() { return { publicKey: (await vapidKeys()).publicKey }; }
  async function pushSubscribe(body, now = new Date()) {
    const sub = body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Ungültiges Abo');
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Ungültiger Push-Endpunkt');
    await store.addPushSub({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(body.label || '').slice(0, 60), created: now.toISOString() });
    return { ok: true, devices: (await store.listPushSubs()).length };
  }
  async function pushUnsubscribe(body) {
    if (body?.endpoint) await store.deletePushSub(body.endpoint);
    return { ok: true, devices: (await store.listPushSubs()).length };
  }

  async function activity(now = new Date()) {
    const lp = localParts(now);
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = addDays(lp.dateStr, -i); days.push({ day: d, calls: await store.getUsage(d) }); }
    return { log: await store.getFetchLog(new Date(now.getTime() - 3 * DAY).toISOString()), days, limit: (await settings()).traffic.apiDailyLimit };
  }

  async function saveSettings(body) {
    const s = withDefaults(body);
    await store.saveSettings(s);
    return s;
  }

  return { tick, overview, planFor, setState, stats, geocode, testNotification, settings, saveSettings, pushKey, pushSubscribe, pushUnsubscribe, activity };
}

const round1 = (v) => Math.round(v * 10) / 10;
function nearest(points, m) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p[0] - m) < Math.abs(best[0] - m)) best = p;
  return best && Math.abs(best[0] - m) <= 15 ? best[1] : null;
}

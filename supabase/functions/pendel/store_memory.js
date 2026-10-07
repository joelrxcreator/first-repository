// Speicher im Arbeitsspeicher – für Tests und lokales Ausprobieren.
import { zonedToUtc, addDays } from './core/time.js';

export function memoryStore(initial = {}) {
  const db = { settings: initial.settings || null, obs: [], plans: new Map(), state: new Map(), sent: [], usage: new Map() };
  return {
    db,
    async getSettings() { return db.settings; },
    async saveSettings(s) { db.settings = s; },
    async getObservations({ since, locations, forecastFrom, forecastTo, actualOnly }) {
      const locs = new Set(locations);
      return db.obs.filter((o) => locs.has(o.origin) && locs.has(o.dest) && (
        ((o.source === 'live' || o.source === 'trip') && o.depart_at >= since)
        || (!actualOnly && o.source === 'forecast' && o.depart_at >= forecastFrom && o.depart_at < forecastTo)));
    },
    async addObservations(rows) { db.obs.push(...rows); },
    async lastFetched(a, b, source) {
      return db.obs.filter((o) => o.origin === a && o.dest === b && o.source === source).map((o) => o.fetched_at).sort().pop() || null;
    },
    async lastForecastFetch(date, a, b) {
      const from = zonedToUtc(date, 0).toISOString(), to = zonedToUtc(addDays(date, 1), 0).toISOString();
      return db.obs.filter((o) => o.source === 'forecast' && o.depart_at >= from && o.depart_at < to && (!a || (o.origin === a && o.dest === b)))
        .map((o) => o.fetched_at).sort().pop() || null;
    },
    async findForecast(a, b, departIso, fetchedBefore) {
      const t = new Date(departIso).getTime();
      const c = db.obs.filter((o) => o.source === 'forecast' && o.origin === a && o.dest === b && o.fetched_at <= fetchedBefore
        && Math.abs(new Date(o.depart_at).getTime() - t) <= 7.5 * 60000).sort((x, y) => (x.fetched_at < y.fetched_at ? 1 : -1));
      return c[0]?.minutes ?? null;
    },
    async getPlan(date, kind) { return db.plans.get(`${date}|${kind}`) || null; },
    async savePlan(date, kind, data) { db.plans.set(`${date}|${kind}`, JSON.parse(JSON.stringify(data))); },
    async getState(date) { return db.state.get(date) || null; },
    async saveState(date, st) { if (st) db.state.set(date, st); else db.state.delete(date); },
    async getSent(sinceDate) { return db.sent.filter((s) => s.date >= sinceDate); },
    async addSent(rec) { db.sent.push(rec); },
    async getUsage(day) { return db.usage.get(day) || 0; },
    async addUsage(day, n) { db.usage.set(day, (db.usage.get(day) || 0) + n); },
  };
}

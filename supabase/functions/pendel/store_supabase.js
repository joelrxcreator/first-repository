// Speicher in der Supabase-Datenbank (Tabellen siehe supabase/migrations).
import { zonedToUtc, addDays } from './core/time.js';

export function supabaseStore(sb) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    async getSettings() {
      return must(await sb.from('settings').select('data').eq('id', 1).maybeSingle())?.data || null;
    },
    async saveSettings(s) {
      must(await sb.from('settings').upsert({ id: 1, data: s, updated_at: new Date().toISOString() }));
    },
    async getObservations({ since, locations, forecastFrom, forecastTo, actualOnly }) {
      const out = [];
      const page = async (build) => {
        for (let from = 0; ; from += 1000) {
          const rows = must(await build().range(from, from + 999));
          out.push(...rows);
          if (rows.length < 1000) break;
        }
      };
      const cols = 'origin,dest,depart_at,fetched_at,minutes,source,ref_forecast,ref_model';
      await page(() => sb.from('observations').select(cols).in('source', ['live', 'trip'])
        .in('origin', locations).in('dest', locations).gte('depart_at', since).order('id'));
      if (!actualOnly) {
        await page(() => sb.from('observations').select(cols).eq('source', 'forecast')
          .in('origin', locations).in('dest', locations).gte('depart_at', forecastFrom).lt('depart_at', forecastTo).order('id'));
      }
      return out;
    },
    async addObservations(rows) {
      must(await sb.from('observations').insert(rows));
    },
    async lastFetched(a, b, source) {
      const r = must(await sb.from('observations').select('fetched_at').eq('origin', a).eq('dest', b).eq('source', source)
        .order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.fetched_at || null;
    },
    async lastForecastFetch(date, a, b) {
      let q = sb.from('observations').select('fetched_at').eq('source', 'forecast')
        .gte('depart_at', zonedToUtc(date, 0).toISOString()).lt('depart_at', zonedToUtc(addDays(date, 1), 0).toISOString());
      if (a) q = q.eq('origin', a).eq('dest', b);
      const r = must(await q.order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.fetched_at || null;
    },
    async findForecast(a, b, departIso, fetchedBefore) {
      const t = new Date(departIso).getTime();
      const r = must(await sb.from('observations').select('minutes').eq('source', 'forecast').eq('origin', a).eq('dest', b)
        .lte('fetched_at', fetchedBefore)
        .gte('depart_at', new Date(t - 7.5 * 60000).toISOString()).lte('depart_at', new Date(t + 7.5 * 60000).toISOString())
        .order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.minutes ?? null;
    },
    async getPlan(date, kind) {
      return must(await sb.from('plans').select('data').eq('date', date).eq('kind', kind).maybeSingle())?.data || null;
    },
    async savePlan(date, kind, data) {
      must(await sb.from('plans').upsert({ date, kind, data, updated_at: new Date().toISOString() }));
    },
    async getState(date) {
      return must(await sb.from('day_state').select('data').eq('date', date).maybeSingle())?.data || null;
    },
    async saveState(date, st) {
      if (!st) must(await sb.from('day_state').delete().eq('date', date));
      else must(await sb.from('day_state').upsert({ date, data: st, updated_at: new Date().toISOString() }));
    },
    async getSent(sinceDate) {
      return must(await sb.from('notifications').select('key,date,title,message,payload,ts').gte('date', sinceDate).order('ts'));
    },
    async addSent(rec) {
      must(await sb.from('notifications').insert(rec));
    },
    async getUsage(day) {
      return must(await sb.from('api_usage').select('calls').eq('day', day).maybeSingle())?.calls || 0;
    },
    async addUsage(day, n) {
      must(await sb.rpc('add_api_usage', { p_day: day, p_calls: n }));
    },
  };
}

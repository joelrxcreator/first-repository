// Speicher in der Supabase-Datenbank – immer auf genau ein Konto (userId) beschränkt.
import { zonedToUtc, addDays } from './core/time.js';

export const LEGACY_USER = '00000000-0000-0000-0000-000000000001';

export function supabaseStore(sb, userId) {
  if (!userId) throw new Error('Kein Konto');
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const U = (q) => q.eq('user_id', userId);
  return {
    userId,
    async getSettings() {
      return must(await U(sb.from('user_settings').select('data')).maybeSingle())?.data || null;
    },
    async saveSettings(s) {
      must(await sb.from('user_settings').upsert({ user_id: userId, data: s, updated_at: new Date().toISOString() }));
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
      await page(() => U(sb.from('observations').select(cols)).in('source', ['live', 'trip'])
        .in('origin', locations).in('dest', locations).gte('depart_at', since).order('id'));
      if (!actualOnly) {
        await page(() => U(sb.from('observations').select(cols)).eq('source', 'forecast')
          .in('origin', locations).in('dest', locations).gte('depart_at', forecastFrom).lt('depart_at', forecastTo).order('id'));
      }
      return out;
    },
    async addObservations(rows) {
      must(await sb.from('observations').insert(rows.map((r) => ({ ...r, user_id: userId }))));
    },
    async lastFetched(a, b, source) {
      const r = must(await U(sb.from('observations').select('fetched_at')).eq('origin', a).eq('dest', b).eq('source', source)
        .order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.fetched_at || null;
    },
    async lastForecastFetch(date, a, b) {
      let q = U(sb.from('observations').select('fetched_at')).eq('source', 'forecast')
        .gte('depart_at', zonedToUtc(date, 0).toISOString()).lt('depart_at', zonedToUtc(addDays(date, 1), 0).toISOString());
      if (a) q = q.eq('origin', a).eq('dest', b);
      const r = must(await q.order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.fetched_at || null;
    },
    async findForecast(a, b, departIso, fetchedBefore) {
      const t = new Date(departIso).getTime();
      const r = must(await U(sb.from('observations').select('minutes')).eq('source', 'forecast').eq('origin', a).eq('dest', b)
        .lte('fetched_at', fetchedBefore)
        .gte('depart_at', new Date(t - 7.5 * 60000).toISOString()).lte('depart_at', new Date(t + 7.5 * 60000).toISOString())
        .order('fetched_at', { ascending: false }).limit(1));
      return r[0]?.minutes ?? null;
    },
    async getPlan(date, kind) {
      return must(await U(sb.from('user_plans').select('data')).eq('date', date).eq('kind', kind).maybeSingle())?.data || null;
    },
    async savePlan(date, kind, data) {
      must(await sb.from('user_plans').upsert({ user_id: userId, date, kind, data, updated_at: new Date().toISOString() }));
    },
    async getState(date) {
      return must(await U(sb.from('user_day_state').select('data')).eq('date', date).maybeSingle())?.data || null;
    },
    async saveState(date, st) {
      if (!st) must(await U(sb.from('user_day_state').delete()).eq('date', date));
      else must(await sb.from('user_day_state').upsert({ user_id: userId, date, data: st, updated_at: new Date().toISOString() }));
    },
    async getSent(sinceDate) {
      return must(await U(sb.from('notifications').select('key,date,title,message,payload,ts')).gte('date', sinceDate).order('ts'));
    },
    async addSent(rec) {
      must(await sb.from('notifications').insert({ ...rec, user_id: userId }));
    },
    async getUsage(day) {
      return must(await U(sb.from('user_api_usage').select('calls')).eq('day', day).maybeSingle())?.calls || 0;
    },
    async addUsage(day, n) {
      must(await sb.rpc('add_user_api_usage', { p_user: userId, p_day: day, p_calls: n }));
    },
    // VAPID-Schlüssel gelten für den ganzen Server
    async getVapid() {
      const r = must(await sb.from('app_secret').select('vapid_public,vapid_private').eq('id', 1).maybeSingle());
      return r?.vapid_public ? { publicKey: r.vapid_public, privateJwk: r.vapid_private } : null;
    },
    async saveVapid(v) {
      must(await sb.from('app_secret').update({ vapid_public: v.publicKey, vapid_private: v.privateJwk }).eq('id', 1));
    },
    async listPushSubs() {
      return must(await U(sb.from('push_subscriptions').select('endpoint,keys,label')));
    },
    async addPushSub(sub) {
      must(await sb.from('push_subscriptions').upsert({ endpoint: sub.endpoint, keys: sub.keys, label: sub.label, created_at: sub.created, user_id: userId }));
    },
    async deletePushSub(endpoint) {
      must(await U(sb.from('push_subscriptions').delete()).eq('endpoint', endpoint));
    },
    async addFetchLog(row) {
      must(await sb.from('fetch_log').insert({ ...row, user_id: userId }));
    },
    async getFetchLog(sinceIso) {
      return must(await U(sb.from('fetch_log').select('ts,kind,calls,failed,note')).gte('ts', sinceIso).order('ts', { ascending: false }).limit(200));
    },
  };
}

/** Alle Daten von LEGACY (vor Einführung der Konten) einem Konto übergeben. */
export async function claimLegacy(sb, userId) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  // Bereits angelegte (leere) Daten des neuen Kontos werden durch die alten ersetzt
  for (const t of ['user_settings', 'user_plans', 'user_day_state', 'user_api_usage']) must(await sb.from(t).delete().eq('user_id', userId));
  for (const t of ['user_settings', 'user_plans', 'user_day_state', 'user_api_usage', 'observations', 'notifications', 'push_subscriptions', 'fetch_log']) {
    must(await sb.from(t).update({ user_id: userId }).eq('user_id', LEGACY_USER));
  }
  must(await sb.from('app_secret').update({ claimed_by: userId }).eq('id', 1));
}

/** Konto samt aller Daten löschen. */
export async function deleteAccountData(sb, userId) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  for (const t of ['user_settings', 'user_plans', 'user_day_state', 'user_api_usage', 'observations', 'notifications', 'push_subscriptions', 'fetch_log']) {
    must(await sb.from(t).delete().eq('user_id', userId));
  }
}

/** Alle Konten, die Einstellungen haben (für den automatischen Takt). */
export async function listUserIds(sb) {
  const { data, error } = await sb.from('user_settings').select('user_id');
  if (error) throw new Error(error.message);
  return data.map((r) => r.user_id);
}

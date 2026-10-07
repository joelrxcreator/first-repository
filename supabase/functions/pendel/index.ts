// Supabase Edge Function "pendel": API für die App + automatischer Takt (/tick).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createApp } from './server.js';
import { supabaseStore } from './store_supabase.js';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const store = supabaseStore(sb);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-app-token, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

// Zugangsschlüssel liegt in der Datenbank (Tabelle app_secret), damit kein manuelles Setzen von Secrets nötig ist.
let tokenCache: string | null = null;
async function appToken(): Promise<string | null> {
  if (tokenCache) return tokenCache;
  const { data } = await sb.from('app_secret').select('token').eq('id', 1).maybeSingle();
  tokenCache = data?.token ?? null;
  return tokenCache;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/pendel/, '') || '/';
  const token = req.headers.get('x-app-token') || url.searchParams.get('token');
  const expected = await appToken();
  if (!expected || token !== expected) return json({ error: 'Nicht berechtigt' }, 401);

  const app = createApp({ store, appUrl: (await store.getSettings())?.appUrl || '' });
  try {
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
    switch (`${req.method} ${path}`) {
      case 'POST /tick': return json(await app.tick());
      case 'GET /overview': return json(await app.overview());
      case 'GET /plan': return json(await app.planFor(url.searchParams.get('date')!));
      case 'GET /settings': return json(await app.settings());
      case 'PUT /settings': return json(await app.saveSettings(body));
      case 'POST /state': return json(await app.setState(body));
      case 'GET /stats': return json(await app.stats());
      case 'GET /geocode': return json(await app.geocode(url.searchParams.get('q') || ''));
      case 'POST /test-notification': return json(await app.testNotification());
      default: return json({ error: `Unbekannt: ${req.method} ${path}` }, 404);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

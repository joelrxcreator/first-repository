// Supabase Edge Function "pendel": API für die App + automatischer Takt (/tick).
// Anmeldung: Supabase-Konto (Authorization: Bearer <Sitzung>). Übergangsweise funktioniert
// noch der alte Zugangsschlüssel (x-app-token), bis die alten Daten einem Konto übergeben wurden.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createApp } from './server.js';
import { supabaseStore, LEGACY_USER, claimLegacy, deleteAccountData, listUserIds } from './store_supabase.js';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-app-token, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

// Zugangsschlüssel (für den Takt und die Zeit vor den Konten) liegt in der Tabelle app_secret.
async function secret(): Promise<{ token: string | null; claimedBy: string | null }> {
  const { data } = await sb.from('app_secret').select('token,claimed_by').eq('id', 1).maybeSingle();
  return { token: data?.token ?? null, claimedBy: data?.claimed_by ?? null };
}

async function userFromJwt(req: Request): Promise<{ id: string; email?: string } | null> {
  const h = req.headers.get('authorization') || '';
  const jwt = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!jwt || jwt.split('.').length !== 3) return null;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

async function appFor(userId: string) {
  const store = supabaseStore(sb, userId);
  return createApp({ store, appUrl: (await store.getSettings())?.appUrl || '' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/pendel/, '') || '/';
  const route = `${req.method} ${path}`;
  try {
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
    const token = req.headers.get('x-app-token') || url.searchParams.get('token');
    const sec = await secret();
    const tokenOk = !!sec.token && token === sec.token;

    // Automatischer Takt für alle Konten (pg_cron, alle 5 Minuten)
    if (route === 'POST /tick') {
      if (!tokenOk) return json({ error: 'Nicht berechtigt' }, 401);
      const out: Record<string, unknown> = {};
      for (const id of await listUserIds(sb)) {
        try { out[id] = await (await appFor(id)).tick(); } catch (e) { console.error(id, e); out[id] = { error: (e as Error).message }; }
      }
      return json({ ok: true, users: Object.keys(out).length, results: out });
    }

    const user = await userFromJwt(req);
    let userId: string | null = user?.id ?? null;
    if (!userId && tokenOk && !sec.claimedBy) userId = LEGACY_USER;
    if (!userId) return json({ error: tokenOk ? 'Bitte mit deinem Konto anmelden' : 'Nicht angemeldet' }, 401);

    switch (route) {
      case 'GET /me': {
        let legacy = false;
        if (user && !sec.claimedBy) {
          const { data } = await sb.from('user_settings').select('user_id').eq('user_id', LEGACY_USER).maybeSingle();
          legacy = !!data;
        }
        return json({ userId, email: user?.email ?? null, legacyMode: !user, legacyAvailable: legacy });
      }
      case 'POST /claim': {
        if (!user) return json({ error: 'Bitte zuerst anmelden' }, 401);
        if (sec.claimedBy) return json({ error: 'Die alten Daten wurden bereits übernommen.' }, 409);
        if (!sec.token || body.legacyToken !== sec.token) return json({ error: 'Der Zugangsschlüssel stimmt nicht.' }, 403);
        await claimLegacy(sb, user.id);
        return json({ ok: true });
      }
      case 'POST /account/delete': {
        if (!user) return json({ error: 'Bitte zuerst anmelden' }, 401);
        if (body.confirm !== 'LÖSCHEN') return json({ error: 'Zum Bestätigen LÖSCHEN eintippen.' }, 400);
        await deleteAccountData(sb, user.id);
        const { error } = await sb.auth.admin.deleteUser(user.id);
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }
    }

    const app = await appFor(userId);
    switch (route) {
      case 'GET /overview': return json(await app.overview());
      case 'GET /plan': return json(await app.planFor(url.searchParams.get('date')!));
      case 'POST /refresh': return json(await app.refreshNow(body.date));
      case 'GET /settings': return json(await app.settings());
      case 'PUT /settings': return json(await app.saveSettings(body));
      case 'POST /state': return json(await app.setState(body));
      case 'GET /stats': return json(await app.stats());
      case 'GET /geocode': return json(await app.geocode(url.searchParams.get('q') || ''));
      case 'POST /test-notification': return json(await app.testNotification());
      case 'GET /push/key': return json(await app.pushKey());
      case 'POST /push/subscribe': return json(await app.pushSubscribe(body));
      case 'POST /push/unsubscribe': return json(await app.pushUnsubscribe(body));
      case 'GET /activity': return json(await app.activity());
      default: return json({ error: `Unbekannt: ${route}` }, 404);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

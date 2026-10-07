-- Automatische Prüfung alle 5 Minuten + Aufräumen.
-- <PROJECT_REF> durch die Projekt-ID ersetzen (wird bei der Einrichtung automatisch gemacht).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('pendel-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/pendel/tick',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-app-token', (select token from public.app_secret where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- Alte Prognose-Abfragen und Pläne nach 45 Tagen löschen (echte Messungen bleiben).
select cron.schedule('pendel-cleanup', '17 3 * * *', $$
  delete from public.observations where source = 'forecast' and depart_at < now() - interval '45 days';
  delete from public.plans where date < current_date - 14;
  delete from public.notifications where date < current_date - 60;
$$);

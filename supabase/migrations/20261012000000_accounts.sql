-- Konten: Jede Zeile gehört einem Nutzer (auth.users). Bestehende Daten gehören vorerst
-- dem Platzhalter LEGACY und werden beim ersten Anmelden mit dem alten Zugangsschlüssel übernommen.
-- Es wird nichts gelöscht; die alten Tabellen settings/plans/day_state/api_usage bleiben als Sicherung.

create table if not exists user_settings (
  user_id uuid primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
insert into user_settings (user_id, data, updated_at)
  select '00000000-0000-0000-0000-000000000001', data, updated_at from settings where id = 1
  on conflict do nothing;

create table if not exists user_plans (
  user_id uuid not null,
  date date not null,
  kind text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date, kind)
);
insert into user_plans select '00000000-0000-0000-0000-000000000001', date, kind, data, updated_at from plans on conflict do nothing;

create table if not exists user_day_state (
  user_id uuid not null,
  date date not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);
insert into user_day_state select '00000000-0000-0000-0000-000000000001', date, data, updated_at from day_state on conflict do nothing;

create table if not exists user_api_usage (
  user_id uuid not null,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);
insert into user_api_usage select '00000000-0000-0000-0000-000000000001', day, calls from api_usage on conflict do nothing;

alter table observations add column if not exists user_id uuid not null default '00000000-0000-0000-0000-000000000001';
alter table notifications add column if not exists user_id uuid not null default '00000000-0000-0000-0000-000000000001';
alter table push_subscriptions add column if not exists user_id uuid not null default '00000000-0000-0000-0000-000000000001';
alter table fetch_log add column if not exists user_id uuid not null default '00000000-0000-0000-0000-000000000001';
create index if not exists observations_user_pair on observations (user_id, origin, dest, source, depart_at);
create index if not exists notifications_user_date on notifications (user_id, date);
create index if not exists fetch_log_user_ts on fetch_log (user_id, ts desc);

alter table app_secret add column if not exists claimed_by uuid;

create or replace function add_user_api_usage(p_user uuid, p_day date, p_calls int) returns void
language sql security definer set search_path = public as $$
  insert into user_api_usage (user_id, day, calls) values (p_user, p_day, p_calls)
  on conflict (user_id, day) do update set calls = user_api_usage.calls + excluded.calls;
$$;
revoke execute on function add_user_api_usage(uuid, date, int) from public, anon, authenticated;

alter table user_settings enable row level security;
alter table user_plans enable row level security;
alter table user_day_state enable row level security;
alter table user_api_usage enable row level security;

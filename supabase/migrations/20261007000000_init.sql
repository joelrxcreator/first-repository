-- Pendelplaner: Datenbank-Grundgerüst.
-- Alle Tabellen sind per RLS gesperrt; nur die Edge Function (service role) greift zu.

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists observations (
  id bigint generated always as identity primary key,
  origin text not null,
  dest text not null,
  depart_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  minutes real not null,
  source text not null check (source in ('live', 'forecast', 'trip')),
  ref_forecast real,
  ref_model real
);
create index if not exists observations_pair_src_depart on observations (origin, dest, source, depart_at);
create index if not exists observations_src_fetched on observations (source, fetched_at);

create table if not exists plans (
  date date not null,
  kind text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (date, kind)
);

create table if not exists day_state (
  date date primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id bigint generated always as identity primary key,
  key text not null,
  date date not null,
  title text,
  message text,
  payload jsonb,
  ts timestamptz not null default now()
);
create index if not exists notifications_date on notifications (date);

create table if not exists api_usage (
  day date primary key,
  calls int not null default 0
);

create table if not exists app_secret (
  id int primary key default 1 check (id = 1),
  token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into app_secret (id) values (1) on conflict do nothing;

create or replace function add_api_usage(p_day date, p_calls int) returns void
language sql security definer set search_path = public as $$
  insert into api_usage (day, calls) values (p_day, p_calls)
  on conflict (day) do update set calls = api_usage.calls + excluded.calls;
$$;
revoke execute on function add_api_usage(date, int) from public, anon, authenticated;

alter table settings enable row level security;
alter table observations enable row level security;
alter table plans enable row level security;
alter table day_state enable row level security;
alter table notifications enable row level security;
alter table api_usage enable row level security;
alter table app_secret enable row level security;

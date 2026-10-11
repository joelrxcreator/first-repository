-- Direkte Push-Nachrichten (Web Push) und Protokoll der Datenabrufe.
alter table app_secret add column if not exists vapid_public text;
alter table app_secret add column if not exists vapid_private jsonb;

create table if not exists push_subscriptions (
  endpoint text primary key,
  keys jsonb not null,
  label text,
  created_at timestamptz not null default now()
);

create table if not exists fetch_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  kind text not null,
  calls int not null default 0,
  failed int not null default 0,
  note text
);
create index if not exists fetch_log_ts on fetch_log (ts desc);

alter table push_subscriptions enable row level security;
alter table fetch_log enable row level security;

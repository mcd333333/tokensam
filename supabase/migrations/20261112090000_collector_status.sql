-- Last outcome of each scheduled collector route (one row per job, overwritten), so a failing collector can be
-- diagnosed from the database: the Worker's own logs are not reachable from tooling. Holds counts and the first
-- error message only (never response bodies or secrets).
begin;

create table if not exists public.collector_status (
  job text primary key,
  updated_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb
);

alter table public.collector_status enable row level security;
revoke all on table public.collector_status from anon, authenticated;
grant select, insert, update on table public.collector_status to service_role;

commit;

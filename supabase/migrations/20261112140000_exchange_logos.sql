-- CoinGecko exchange logos (centralised and decentralised), pulled from GET /exchanges (about four calls) and refreshed
-- rarely. Looked up by CoinGecko exchange id to put a logo on exchange and DEX boxes.
begin;

create table if not exists public.exchange_logos (
  id text primary key,
  name text not null,
  logo text not null check (logo like 'https://%'),
  fetched_at timestamptz not null default now()
);

alter table public.exchange_logos enable row level security;
revoke all on table public.exchange_logos from anon, authenticated;
grant select, insert, update, delete on table public.exchange_logos to service_role;

commit;

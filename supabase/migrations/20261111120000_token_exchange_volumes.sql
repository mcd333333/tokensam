-- Latest per-token exchange (centralised and decentralised) 24h volume snapshot (CoinGecko /coins/{id}/tickers).
-- One row per token, overwritten on each daily refresh: no history, so storage stays at roughly
-- 154 small rows and never needs retention. exchanges is an array of
-- {id, name, kind (cex|dex), volumeUsd, pairs} objects, top exchanges per kind by 24h USD volume.
--
-- coingecko_exchange_call_usage counts the tickers calls made per UTC month so the collector can
-- stop at a hard cap and never starve the main /coins/markets refresh of the Demo plan's
-- ~10,000 calls/month.
begin;

create table if not exists public.token_exchange_volumes (
  token_id text primary key references public.tokens(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  exchanges jsonb not null default '[]'::jsonb,
  total_volume_usd numeric
);

create table if not exists public.coingecko_exchange_call_usage (
  month text primary key,
  calls integer not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.bump_coingecko_exchange_call_usage(p_month text, p_calls integer)
returns integer
language sql
set search_path = public, pg_catalog
as $function$
  insert into public.coingecko_exchange_call_usage as u (month, calls, updated_at)
  values (p_month, p_calls, now())
  on conflict (month) do update set calls = u.calls + excluded.calls, updated_at = now()
  returning calls;
$function$;

alter table public.token_exchange_volumes enable row level security;
alter table public.coingecko_exchange_call_usage enable row level security;
revoke all on table public.token_exchange_volumes from anon, authenticated;
revoke all on table public.coingecko_exchange_call_usage from anon, authenticated;
grant select, insert, update, delete on table public.token_exchange_volumes to service_role;
grant select, insert, update on table public.coingecko_exchange_call_usage to service_role;
revoke execute on function public.bump_coingecko_exchange_call_usage(text, integer) from public, anon, authenticated;
grant execute on function public.bump_coingecko_exchange_call_usage(text, integer) to service_role;

commit;

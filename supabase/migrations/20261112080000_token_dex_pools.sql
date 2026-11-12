-- Latest on-chain DEX pools per token (DEX Screener /token-pairs/v1), replacing GeckoTerminal as the
-- source of the profile's DEX Markets list and the liquidity-concentration indicators. GeckoTerminal
-- answers HTTP 429 to nearly every request from Cloudflare's shared outbound addresses.
--
-- One row per token, overwritten on each refresh: no history, so storage stays at roughly 55 small rows and
-- never needs retention. pools is an array (at most 30, most liquid first) of
-- {pairAddress, dexId, liquidityUsd, volume24hUsd, priceUsd, priceChange24hPct, fdvUsd, marketCapUsd, createdAt}.
begin;

create table if not exists public.token_dex_pools (
  token_id text primary key references public.tokens(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  pools jsonb not null default '[]'::jsonb
);

alter table public.token_dex_pools enable row level security;
revoke all on table public.token_dex_pools from anon, authenticated;
grant select, insert, update, delete on table public.token_dex_pools to service_role;

commit;

-- DexPaprika becomes the only on-chain DEX data provider (replacing DEX Screener and GeckoTerminal).
-- Adds the provider row, the new DEX metric definitions (observations carry a foreign key to metric_definitions),
-- and a per-provider monthly API-call counter so the collector can respect the free key's credit allowance.
-- Applied to production 2026-11-12.
begin;

insert into public.data_providers (id, name, enabled) values ('dexpaprika', 'DexPaprika', true)
on conflict (id) do update set name = excluded.name, enabled = true;

-- The five metrics shared with the previous DEX provider now mean "across every pool of the exact token address".
update public.metric_definitions set description = 'Total USD liquidity across every DEX pool of the exact token address (DexPaprika token summary).' where id = 'liquidity_usd';
update public.metric_definitions set description = 'USD volume over 24 hours across every DEX pool of the exact token address (DexPaprika token summary).' where id = 'volume_24h_usd';
update public.metric_definitions set description = 'DEX transactions over 24 hours across every pool of the exact token address (DexPaprika token summary).' where id = 'transactions_24h_count';
update public.metric_definitions set description = 'DEX buys over 24 hours across every pool of the exact token address (DexPaprika token summary).' where id = 'buys_24h_count';
update public.metric_definitions set description = 'DEX sells over 24 hours across every pool of the exact token address (DexPaprika token summary).' where id = 'sells_24h_count';

insert into public.metric_definitions (id, name, domain, unit, description) values
  ('dex_pool_count', 'DEX pool count', 'market', 'count', 'Number of DEX pools trading the exact token address (DexPaprika token summary).'),
  ('dex_buy_volume_24h_usd', 'DEX buy volume (24h)', 'market', 'USD', 'USD value bought over 24 hours across every pool of the exact token address.'),
  ('dex_sell_volume_24h_usd', 'DEX sell volume (24h)', 'market', 'USD', 'USD value sold over 24 hours across every pool of the exact token address.'),
  ('dex_volume_1h_usd', 'DEX volume (1h)', 'market', 'USD', 'USD DEX volume over the last hour across every pool of the exact token address.'),
  ('dex_volume_6h_usd', 'DEX volume (6h)', 'market', 'USD', 'USD DEX volume over the last 6 hours across every pool of the exact token address.'),
  ('dex_transactions_1h_count', 'DEX transactions (1h)', 'market', 'count', 'DEX transactions over the last hour across every pool of the exact token address.'),
  ('dex_transactions_6h_count', 'DEX transactions (6h)', 'market', 'count', 'DEX transactions over the last 6 hours across every pool of the exact token address.'),
  ('dex_price_change_1h_pct', 'DEX price change (1h)', 'market', 'percent', 'On-chain price change over the last hour (DexPaprika token summary).'),
  ('dex_price_change_6h_pct', 'DEX price change (6h)', 'market', 'percent', 'On-chain price change over the last 6 hours (DexPaprika token summary).'),
  ('dex_price_high_24h_usd', 'DEX price high (24h)', 'market', 'USD', 'Highest on-chain price over 24 hours (DexPaprika token price stats).'),
  ('dex_price_low_24h_usd', 'DEX price low (24h)', 'market', 'USD', 'Lowest on-chain price over 24 hours (DexPaprika token price stats).'),
  ('dex_volume_7d_usd', 'DEX volume (7d, top pools)', 'market', 'USD', 'USD volume over 7 days summed across the most liquid pools (up to 100) of the exact token address.'),
  ('dex_volume_30d_usd', 'DEX volume (30d, top pools)', 'market', 'USD', 'USD volume over 30 days summed across the most liquid pools (up to 100) of the exact token address.')
on conflict (id) do nothing;

create table if not exists public.provider_call_usage (
  provider text not null,
  month text not null,
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider, month)
);

create or replace function public.bump_provider_call_usage(p_provider text, p_month text, p_calls integer)
returns integer
language sql
set search_path = public, pg_catalog
as $function$
  insert into public.provider_call_usage as u (provider, month, calls, updated_at)
  values (p_provider, p_month, p_calls, now())
  on conflict (provider, month) do update set calls = u.calls + excluded.calls, updated_at = now()
  returning calls;
$function$;

alter table public.provider_call_usage enable row level security;
revoke all on table public.provider_call_usage from anon, authenticated;
grant select, insert, update on table public.provider_call_usage to service_role;
revoke execute on function public.bump_provider_call_usage(text, text, integer) from public, anon, authenticated;
grant execute on function public.bump_provider_call_usage(text, text, integer) to service_role;

commit;

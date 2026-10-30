-- Restore the stored daily market-cap values behind "Market cap change · daily" and
-- "Volume / market cap change · daily" (token profile > Market snapshot).
--
-- Both cards compare consecutive completed UTC days and, for market cap, accept only daily
-- aggregate rows (daily_snapshot / daily_average) from token_metric_daily_aggregates
-- (dailyAverageSeries(..., aggregatesOnly = true) in src/lib/data/live-data.ts). That table had 0
-- rows, because market cap is now kept granular for 14 days instead of being aggregated, so both
-- cards were blank for every token.
--
-- Each row written here is a daily_snapshot: the day's first real observation (value, timestamp and
-- source observation id), so it duplicates an existing raw point exactly. History charts and the
-- technical indicators, which also read this table, therefore see no new or changed data (a daily
-- mean at midnight would have added a synthetic point and shifted indicator samples).
-- retention_expire_daily_aggregates_batch already expires market_cap_usd aggregates after 46 days.
--
-- Applied to production 2026-10-30: 13 days x 154 tokens = 2,002 rows backfilled (17-29 Oct).

create or replace function public.snapshot_daily_market_cap(p_day date default ((now() at time zone 'UTC')::date - 1))
returns integer
language sql
set search_path = public, pg_catalog
as $function$
  with first_points as (
    select distinct on (o.token_id, o.chain_id) o.token_id, o.chain_id, o.id, o.value, o.observed_at
    from public.token_metric_observations o
    where o.provider_id = 'coingecko' and o.metric_id = 'market_cap_usd'
      and o.status = 'available' and o.value is not null and o.value > 0
      and o.excluded_reason is null
      and o.observed_at >= (p_day::timestamp at time zone 'UTC')
      and o.observed_at <  ((p_day + 1)::timestamp at time zone 'UTC')
    order by o.token_id, o.chain_id, o.observed_at, o.id
  ), inserted as (
    insert into public.token_metric_daily_aggregates (
      token_id, chain_id, metric_id, provider_id, utc_day, value, status,
      source_observation_count, valid_value_count, first_source_observed_at, last_source_observed_at,
      source_observation_ids, aggregation_method, aggregated_at
    )
    select f.token_id, f.chain_id, 'market_cap_usd', 'coingecko', p_day, f.value, 'available',
           1, 1, f.observed_at, f.observed_at, array[f.id], 'daily_snapshot', now()
    from first_points f
    on conflict (token_id, metric_id, provider_id, utc_day) do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$function$;

select public.snapshot_daily_market_cap(d::date)
from generate_series(((now() at time zone 'UTC')::date - 13)::timestamp, ((now() at time zone 'UTC')::date - 1)::timestamp, interval '1 day') as d;

select cron.schedule('tokensam-daily-market-cap-snapshot', '10 0 * * *', $$select public.snapshot_daily_market_cap();$$);

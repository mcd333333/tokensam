-- Keep the last 3 days of individual DeFiLlama revenue and fees samples.
--
-- revenue_growth_pct and the two "price / market cap vs revenue change" metrics compare the latest
-- revenue_24h_usd reading with one ~24 h earlier (within +-6 h) and ignore daily aggregates. The live
-- pg_cron job tokensam-non-chart-collapse runs this function, which collapsed every completed UTC day to a
-- single sample near midnight for every metric not in its exemption list, and revenue_24h_usd / fees_24h_usd
-- were not on it. So the only baseline left was the ~02:00 sample, usable for roughly the first six hours of
-- each UTC day; the rest of the day all 154 tokens read "Insufficient ~24h-apart history".
-- (20261010134730_keep_recent_defillama_revenue_samples.sql added a 3-day protection, but to
-- retention_aggregate_daily_observations, which this job does not call.)
--
-- Phase 1 (unchanged otherwise): revenue/fees are now excluded from the per-day collapse.
-- Phase 2 (new): collapses them to one sample per UTC day only for days older than 3 days, with no cursor.
-- The cursor in phase 1 only moves forward, so excluding them there without phase 2 would keep them forever.

create or replace function public.retention_collapse_non_chart_daily_batch(batch_size integer default 1000)
returns integer
language plpgsql
as $function$
declare
  max_days_per_call constant int := 8;
  day_limit timestamptz := date_trunc('day', now() at time zone 'UTC');
  floor_day timestamptz := day_limit - interval '31 days';
  day_cursor timestamptz;
  days_checked int := 0;
  target_day timestamptz;
  has_excess boolean;
  deleted_count int := 0;
  aged_deleted_count int := 0;
begin
  select greatest(floor_day, (cursor_day::timestamptz))
  into day_cursor
  from public.retention_collapse_cursor_state
  where id = true;

  if day_cursor is null then
    day_cursor := floor_day;
  end if;

  while day_cursor < day_limit and days_checked < max_days_per_call loop
    select count(*) <> count(distinct (t.token_id, t.metric_id, t.provider_id))
    from public.token_metric_observations t
    where t.observed_at >= day_cursor
      and t.observed_at < day_cursor + interval '1 day'
      and not (
        (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
        or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
        or (t.provider_id = 'defillama' and t.metric_id in ('revenue_24h_usd', 'fees_24h_usd'))
        or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
      )
    into has_excess;

    if has_excess then
      target_day := day_cursor;
      exit;
    end if;

    day_cursor := day_cursor + interval '1 day';
    days_checked := days_checked + 1;
  end loop;

  update public.retention_collapse_cursor_state
  set cursor_day = day_cursor::date, updated_at = now()
  where id = true;

  if target_day is not null then
    with excess_groups as (
      select t.token_id, t.metric_id, t.provider_id
      from public.token_metric_observations t
      where t.observed_at >= target_day
        and t.observed_at < target_day + interval '1 day'
        and not (
          (t.provider_id = 'coingecko' and t.metric_id in ('price_usd', 'volume_24h_usd'))
          or (t.provider_id = 'defillama' and t.metric_id = 'tvl_usd')
          or (t.provider_id = 'defillama' and t.metric_id in ('revenue_24h_usd', 'fees_24h_usd'))
          or (t.provider_id = 'coingecko' and t.metric_id = 'market_cap_usd' and t.observed_at >= now() - interval '48 hours')
        )
      group by t.token_id, t.metric_id, t.provider_id
      having count(*) > 1
      limit greatest(batch_size, 0)
    ),
    canonical as (
      select g.token_id, g.metric_id, g.provider_id, c.id as canonical_id
      from excess_groups g
      cross join lateral (
        select t.id
        from public.token_metric_observations t
        where t.token_id = g.token_id
          and t.metric_id = g.metric_id
          and t.provider_id = g.provider_id
          and t.observed_at >= target_day
          and t.observed_at < target_day + interval '1 day'
        order by abs(extract(epoch from (t.observed_at - target_day))), t.id
        limit 1
      ) c
    ),
    doomed as (
      select t.id
      from public.token_metric_observations t
      join canonical c on c.token_id = t.token_id and c.metric_id = t.metric_id and c.provider_id = t.provider_id
      where t.observed_at >= target_day
        and t.observed_at < target_day + interval '1 day'
        and t.id <> c.canonical_id
    ),
    deleted as (
      delete from public.token_metric_observations t
      using doomed
      where t.id = doomed.id
      returning t.id
    )
    select count(*) into deleted_count from deleted;
  end if;

  -- Phase 2: DeFiLlama revenue/fees keep every sample for 3 days, then collapse to the one nearest each
  -- UTC midnight, same rule as phase 1. Bounded to the same 31-day floor; uses provider_metric_history_lookup_idx.
  with excess_days as (
    select t.token_id, t.metric_id, t.provider_id,
           (date_trunc('day', t.observed_at at time zone 'UTC') at time zone 'UTC') as day_start
    from public.token_metric_observations t
    where t.provider_id = 'defillama'
      and t.metric_id in ('revenue_24h_usd', 'fees_24h_usd')
      and t.observed_at >= floor_day
      and t.observed_at < day_limit - interval '3 days'
    group by 1, 2, 3, 4
    having count(*) > 1
    limit greatest(batch_size, 0)
  ),
  canonical as (
    select e.token_id, e.metric_id, e.provider_id, e.day_start, c.id as canonical_id
    from excess_days e
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id = e.token_id
        and t.metric_id = e.metric_id
        and t.provider_id = e.provider_id
        and t.observed_at >= e.day_start
        and t.observed_at < e.day_start + interval '1 day'
      order by abs(extract(epoch from (t.observed_at - e.day_start))), t.id
      limit 1
    ) c
  ),
  doomed as (
    select t.id
    from public.token_metric_observations t
    join canonical c on c.token_id = t.token_id and c.metric_id = t.metric_id and c.provider_id = t.provider_id
    where t.observed_at >= c.day_start
      and t.observed_at < c.day_start + interval '1 day'
      and t.id <> c.canonical_id
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id = doomed.id
    returning t.id
  )
  select count(*) into aged_deleted_count from deleted;

  return coalesce(deleted_count, 0) + coalesce(aged_deleted_count, 0);
end;
$function$;

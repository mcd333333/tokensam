-- Shrinks the granular chart retention windows to reduce the database's
-- live footprint: price_usd 28->21 days, volume_24h_usd and tvl_usd 21->14
-- days. Requested explicitly to cut steady-state size, trading chart
-- resolution for storage.
--
-- Note: the UI's chart period selector currently maxes out at 21D for all
-- three charts (price, volume, risk profile -- see HISTORICAL_PERIODS in
-- src/lib/data/historical-series.ts). Volume and TVL's granular window is
-- now shorter than that UI option (14d < 21d), which reproduces the same
-- resolution-cliff problem fixed by 20261020120000_volume_tvl_granular_window_21_days.sql
-- in reverse: selecting 21D on a Volume or TVL chart will show full hourly
-- granularity for the first 14 days, then drop to one point per day for the
-- remaining 7. This migration only changes retention; it deliberately does
-- not touch the UI, since the request here was specifically to reduce
-- storage, not to change the chart period options again.
create or replace function public.protect_30d_chart_observations()
 returns trigger
 language plpgsql
as $function$
begin
  if (
    (OLD.provider_id = 'coingecko' and OLD.metric_id = 'price_usd' and OLD.observed_at >= now() - interval '21 days')
    or (OLD.provider_id = 'coingecko' and OLD.metric_id = 'volume_24h_usd' and OLD.observed_at >= now() - interval '14 days')
    or (OLD.provider_id = 'defillama' and OLD.metric_id = 'tvl_usd' and OLD.observed_at >= now() - interval '14 days')
  ) then
    raise exception 'RETENTION_GUARD: cannot delete %/% observation inside its granular chart window', OLD.provider_id, OLD.metric_id;
  end if;
  return OLD;
end;
$function$;

create or replace function public.retention_collapse_daily_batch(batch_size integer default 1000)
 returns integer
 language sql
as $function$
  with eligible as (
    select t.id,t.token_id,t.metric_id,t.provider_id,t.observed_at,
           date_trunc('day', t.observed_at at time zone 'UTC') as utc_day
    from public.token_metric_observations t
    where t.observed_at >= now() - interval '90 days'
      and (
        (t.provider_id = 'coingecko' and t.metric_id = 'price_usd' and t.observed_at < now() - interval '21 days')
        or (
          not (t.provider_id = 'coingecko' and t.metric_id = 'price_usd')
          and t.observed_at < now() - interval '14 days'
        )
      )
  ),
  days as (
    select distinct token_id, metric_id, provider_id, utc_day
    from eligible
  ),
  canonical as (
    select d.token_id,d.metric_id,d.provider_id,d.utc_day,c.id as canonical_id
    from days d
    cross join lateral (
      select t.id
      from public.token_metric_observations t
      where t.token_id=d.token_id
        and t.metric_id=d.metric_id
        and t.provider_id=d.provider_id
        and t.observed_at >= (d.utc_day at time zone 'UTC')
        and t.observed_at < ((d.utc_day + interval '1 day') at time zone 'UTC')
      order by abs(extract(epoch from (t.observed_at-(d.utc_day at time zone 'UTC')))),t.id
      limit 1
    ) c
  ),
  doomed as (
    select e.id from eligible e
    join canonical c on c.token_id=e.token_id and c.metric_id=e.metric_id
      and c.provider_id=e.provider_id and c.utc_day=e.utc_day
    where e.id<>c.canonical_id
    order by e.observed_at,e.id
    limit greatest(batch_size,0)
  ),
  deleted as (
    delete from public.token_metric_observations t
    using doomed
    where t.id=doomed.id
    returning t.id
  )
  select coalesce(count(*)::int,0) from deleted;
$function$;

-- Brings the volume_24h_usd and tvl_usd granular-chart retention window up
-- from 14 to 21 days, matching the UI chart period selector's new max
-- option (21D, see the "Change chart period from 30D to 21D" commit).
--
-- Both metrics shared the same HistoricalPeriod chart control as price, but
-- price's granular window (28 days) already comfortably covered the UI's
-- 21D option while volume/TVL's (14 days) did not: selecting 21D on a
-- Volume or TVL chart showed full hourly granularity for the first 14 days,
-- then dropped to one point per day for the remaining 7, a visible
-- resolution cliff partway through the chart. This closes that gap.
--
-- Note: this only changes retention going forward. Observations already
-- collapsed to one point per UTC day under the previous 14-day window
-- cannot be restored to their original granularity.
create or replace function public.protect_30d_chart_observations()
 returns trigger
 language plpgsql
as $function$
begin
  if (
    (OLD.provider_id = 'coingecko' and OLD.metric_id = 'price_usd' and OLD.observed_at >= now() - interval '28 days')
    or (OLD.provider_id = 'coingecko' and OLD.metric_id = 'volume_24h_usd' and OLD.observed_at >= now() - interval '21 days')
    or (OLD.provider_id = 'defillama' and OLD.metric_id = 'tvl_usd' and OLD.observed_at >= now() - interval '21 days')
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
        (t.provider_id = 'coingecko' and t.metric_id = 'price_usd' and t.observed_at < now() - interval '28 days')
        or (
          not (t.provider_id = 'coingecko' and t.metric_id = 'price_usd')
          and t.observed_at < now() - interval '21 days'
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

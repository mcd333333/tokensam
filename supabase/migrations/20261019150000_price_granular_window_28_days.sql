-- Sets the CoinGecko price_usd granular-chart retention window to 28 days.
--
-- History: this function's price window was originally 37 days, then
-- shortened to 21 days as part of a database-size reduction pass (alongside
-- the 27-token retirement and the volume/TVL windows moving 30d -> 14d),
-- applied directly against the live database in an earlier session and
-- never captured in a migration file. This migration brings the schema
-- into version control at its current, intentional value: 28 days for
-- price, unchanged 14 days for volume_24h_usd and tvl_usd.
--
-- Note: shortening (37->21) or lengthening (21->28) this window only
-- changes retention going forward. Observations already collapsed to one
-- point per UTC day under a shorter window cannot be restored to their
-- original granularity.
create or replace function public.protect_30d_chart_observations()
 returns trigger
 language plpgsql
as $function$
begin
  if (
    (OLD.provider_id = 'coingecko' and OLD.metric_id = 'price_usd' and OLD.observed_at >= now() - interval '28 days')
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
        (t.provider_id = 'coingecko' and t.metric_id = 'price_usd' and t.observed_at < now() - interval '28 days')
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

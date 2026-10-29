-- get_coingecko_midnight_gaps: only the gaps that swallow a UTC midnight, for the CoinGecko gap repair.
--
-- The repair called get_coingecko_intraday_gaps, which returns ~6,600 rows (37 days x 154 tokens x
-- price+volume) because every retention-collapsed day (one point per day) is itself a 24h "gap".
-- PostgREST silently truncates a response at 1,000 rows, so the repair only ever saw the first ~24
-- tokens; once those were repaired it found nothing to do while 131 other tokens still lacked their
-- 2026-10-23 midnight sample. This wrapper keeps just the gaps with a midnight strictly inside them
-- (more than 30 minutes from both edges, matching the indicator pipeline's tolerance), 262 rows
-- (131 tokens x price+volume) on 2026-10-29. Applied to production 2026-10-29.

create or replace function public.get_coingecko_midnight_gaps(
  p_start_date date, p_end_date date, p_min_gap_hours numeric,
  p_metric_ids text[] default array['price_usd','market_cap_usd','volume_24h_usd']
)
returns table(token_id text, metric_id text, gap_start timestamptz, gap_end timestamptz)
language sql
set search_path = public, pg_catalog
as $function$
  select g.token_id, g.metric_id, g.gap_start, g.gap_end
  from public.get_coingecko_intraday_gaps(p_start_date, p_end_date, p_min_gap_hours, p_metric_ids) g
  where exists (
    select 1
    from generate_series(
      (date_trunc('day', g.gap_start at time zone 'UTC') + interval '1 day') at time zone 'UTC',
      g.gap_end, interval '1 day'
    ) as m(midnight)
    where m.midnight - g.gap_start > interval '30 minutes'
      and g.gap_end - m.midnight > interval '30 minutes'
  )
  order by g.token_id, g.metric_id, g.gap_start;
$function$;

revoke execute on function public.get_coingecko_midnight_gaps(date, date, numeric, text[]) from public, anon, authenticated;
grant execute on function public.get_coingecko_midnight_gaps(date, date, numeric, text[]) to service_role;

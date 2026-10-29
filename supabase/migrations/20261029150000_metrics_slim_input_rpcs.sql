-- Slim read RPCs for runMetricsCalculation (src/lib/metrics/run-calculation.ts).
--
-- The metrics run (~104/day) read latest_observations_bounded (every provider and metric, 1,950 rows /
-- 1.22 MB of JSON on 2026-10-29) and metrics_series_recent_points (1,085 rows / 0.55 MB). The engine
-- consumes only 11 (provider, metric) pairs as latest values (LATEST_INPUTS in run-calculation.ts) and
-- 13 of the 19 columns. Several never-read rows (DEX Screener, DeFiLlama Coins) carry ~400-char notes.
--
--   metrics_latest_inputs : 806 rows / 0.38 MB  (-68%), same rows as the old function for those pairs
--   metrics_series_inputs : 1,085 rows / 0.38 MB (-31%), same rows, fewer columns
--
-- Verified in production before switching: identical id sets (0 only-in-old, 0 only-in-new) for both.
-- The original functions are unchanged; the dashboard still reads them. Applied 2026-10-29.

create or replace function public.metrics_latest_inputs(
  p_token_ids text[], p_providers text[], p_metrics text[], p_since timestamptz
)
returns table(
  id bigint, token_id text, chain_id text, metric_id text, provider_id text, raw_record_id bigint,
  value numeric, status text, observed_at timestamptz, collected_at timestamptz,
  source_field text, note text, scope text
)
language sql
stable
set search_path = public, pg_catalog
as $function$
  select r.id, r.token_id, r.chain_id, r.metric_id, r.provider_id, r.raw_record_id,
         r.value, r.status, r.observed_at, r.collected_at, r.source_field, r.note, r.scope
  from (
    select o.*,
      row_number() over (
        partition by o.token_id, o.provider_id, o.metric_id
        order by o.observed_at desc, o.id desc
      ) as rn
    from public.token_metric_observations_resolved o
    join unnest(p_providers, p_metrics) as w(provider_id, metric_id)
      on o.provider_id = w.provider_id and o.metric_id = w.metric_id
    where o.token_id = any(p_token_ids)
      and o.excluded_reason is null
      and o.observed_at >= p_since
  ) r
  where r.rn = 1;
$function$;

create or replace function public.metrics_series_inputs(
  p_token_ids text[], p_providers text[], p_metrics text[], p_now timestamptz,
  p_horizon_hours integer default 24, p_tolerance_hours integer default 6, p_max_lookback_days integer default 30
)
returns table(
  id bigint, token_id text, chain_id text, metric_id text, provider_id text, raw_record_id bigint,
  value numeric, status text, observed_at timestamptz, collected_at timestamptz,
  source_field text, note text, scope text
)
language sql
stable
set search_path = public, pg_catalog
as $function$
  select s.id, s.token_id, s.chain_id, s.metric_id, s.provider_id, s.raw_record_id,
         s.value, s.status, s.observed_at, s.collected_at, s.source_field, s.note, s.scope
  from public.metrics_series_recent_points(
    p_token_ids, p_providers, p_metrics, p_now, p_horizon_hours, p_tolerance_hours, p_max_lookback_days
  ) s;
$function$;

revoke execute on function public.metrics_latest_inputs(text[], text[], text[], timestamptz) from public, anon, authenticated;
revoke execute on function public.metrics_series_inputs(text[], text[], text[], timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.metrics_latest_inputs(text[], text[], text[], timestamptz) to service_role;
grant execute on function public.metrics_series_inputs(text[], text[], text[], timestamptz, integer, integer, integer) to service_role;

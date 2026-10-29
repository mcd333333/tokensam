-- runMetricsCalculation (src/lib/metrics/run-calculation.ts) now skips rewriting calculated metric
-- rows whose input_fingerprint is unchanged and only advances their calculated_at by id.
--
-- ~2/3 of calculated_metric_observations rows (2,749 of 4,312 on 2026-10-29) are `unavailable`
-- metrics with no source observation at all (no DeFiLlama/DEX data for that token); they never
-- change between runs, yet every run (~104/day) re-uploaded all of them, ~4 MB of JSON per run.
-- calculated_at must still advance: the dashboard's newest-run read (readDashboardCalculated in
-- src/lib/data/live-data.ts) selects rows by calculated_at, so leaving unchanged rows behind would
-- drop them from the dashboard.
--
-- Applied to production 2026-10-29.

create or replace function public.touch_calculated_metric_observations(p_ids bigint[], p_calculated_at timestamptz)
returns integer
language sql
set search_path = public, pg_catalog
as $function$
  with touched as (
    update public.calculated_metric_observations
    set calculated_at = p_calculated_at
    where id = any(p_ids)
    returning 1
  )
  select count(*)::integer from touched;
$function$;

-- This writes to a table, so it must not be reachable by the public anon/authenticated API roles.
revoke execute on function public.touch_calculated_metric_observations(bigint[], timestamptz) from public, anon, authenticated;
grant execute on function public.touch_calculated_metric_observations(bigint[], timestamptz) to service_role;

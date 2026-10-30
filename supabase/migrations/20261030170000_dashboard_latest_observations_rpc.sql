-- Newest observation per (token, provider, metric) inside a recent window, for the dashboard and
-- token-profile "latest" read (readLatestObservations in src/lib/data/observation-reads.ts).
--
-- That read used to page through EVERY observation in the last 6 hours for 50 tokens at a time
-- (~9,850 rows, 10 offset-paged requests) and then keep ~570 of them. Each later page re-walks all the
-- earlier ones, so a loaded database pushed the deep pages past the 8 s API statement_timeout, which
-- blanked the dashboard (seen 2026-10-30 16:25 UTC, 3 of 4 batches) and made every render parse ~40k rows.
--
-- This probes token_metric_latest_lookup_idx once per (token, provider, metric) instead.
-- Measured on production, 50 tokens: 556 ms and 571 rows, against 2.7 s for DISTINCT ON and an
-- offset-paged read that grows with every page.
--
-- It reads token_metric_observations_resolved, exactly like the paged read (observationRead), so the
-- compacted provenance columns (source_field, note, scope, provider_asset_id) come back resolved.
-- The caller passes the metrics it displays; other callers of readLatestObservations keep the paged read.

create or replace function public.dashboard_latest_observations(
  p_token_ids text[], p_providers text[], p_metrics text[], p_since timestamptz
)
returns table(
  id bigint, token_id text, chain_id text, metric_id text, provider_id text, raw_record_id bigint,
  value numeric, status text, observed_at timestamptz, collected_at timestamptz,
  source_field text, note text, scope text, provider_asset_id text, mapping_id bigint
)
language sql
stable
set search_path = public, pg_catalog
as $function$
  select o.id, o.token_id, o.chain_id, o.metric_id, o.provider_id, o.raw_record_id,
         o.value, o.status, o.observed_at, o.collected_at,
         o.source_field, o.note, o.scope, o.provider_asset_id, o.mapping_id
  from unnest(p_token_ids) as t(token_id)
  cross join unnest(p_providers) as p(provider_id)
  cross join unnest(p_metrics) as m(metric_id)
  cross join lateral (
    select r.*
    from public.token_metric_observations_resolved r
    where r.token_id = t.token_id
      and r.provider_id = p.provider_id
      and r.metric_id = m.metric_id
      and r.excluded_reason is null
      and r.observed_at >= p_since
    order by r.observed_at desc, r.collected_at desc, r.id desc
    limit 1
  ) o
  order by o.token_id, o.provider_id, o.metric_id;
$function$;

revoke execute on function public.dashboard_latest_observations(text[], text[], text[], timestamptz) from public, anon, authenticated;
grant execute on function public.dashboard_latest_observations(text[], text[], text[], timestamptz) to service_role;

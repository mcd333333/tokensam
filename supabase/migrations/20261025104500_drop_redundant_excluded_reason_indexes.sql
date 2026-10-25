-- Lossless storage reduction, found while looking for ways to shrink the
-- database without deleting tokens or shortening retention windows.
--
-- token_metric_observations_latest_dashboard_idx and raw_provider_records_latest_token_idx
-- each duplicated an already-existing index on the same table with the identical column
-- list (token_metric_latest_lookup_idx / raw_provider_latest_lookup_idx respectively),
-- differing only by a `WHERE excluded_reason IS NULL` predicate. excluded_reason is set
-- only by rare, one-time historical-curation migrations (e.g. retiring wrapped-asset
-- proxy mappings, see 20260927090000/20260928090000) -- never by routine ingestion -- and
-- was confirmed 100% NULL across both tables' entire current row counts
-- (token_metric_observations: 582,897/582,897; raw_provider_records: 44,533/44,533) at the
-- time of this migration, meaning the partial predicate was then a no-op and the two
-- indexes in each pair were functionally identical.
--
-- Verified directly before dropping, not just reasoned about: ran the real dashboard
-- view's query (latest_token_metric_observations's DISTINCT ON over
-- token_metric_observations_resolved) inside a BEGIN/DROP INDEX/EXPLAIN/ROLLBACK block.
-- With the partial index gone, the planner transparently fell back to the surviving full
-- index, scanned the identical row count (3647), applied `excluded_reason IS NULL` as a
-- free post-scan filter (the heap row is already fetched for an Index Scan's other
-- output columns), and the cost estimate was effectively unchanged (3675 vs 3731). No
-- plan degradation.
--
-- token_metric_observations_latest_dashboard_idx was 48MB; raw_provider_records_latest_token_idx
-- was 3.16MB. raw_provider_records_coingecko_markets_lookup_idx is NOT a duplicate (different
-- column list, includes endpoint_label) and is kept.
set local lock_timeout = '250ms';
set local statement_timeout = '15s';

do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.token_metric_latest_lookup_idx')
      and i.indrelid = 'public.token_metric_observations'::regclass
      and i.indisvalid and i.indisready
      and pg_catalog.pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX token_metric_latest_lookup_idx ON public.token_metric_observations USING btree (token_id, provider_id, metric_id, observed_at DESC, collected_at DESC, id DESC)'
  ) then
    raise exception 'Refusing: token_metric_latest_lookup_idx missing or changed';
  end if;

  if exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.token_metric_observations_latest_dashboard_idx')
      and (
        i.indisunique or i.indisprimary
        or pg_catalog.pg_get_indexdef(i.indexrelid) <>
          'CREATE INDEX token_metric_observations_latest_dashboard_idx ON public.token_metric_observations USING btree (token_id, provider_id, metric_id, observed_at DESC, collected_at DESC, id DESC) WHERE (excluded_reason IS NULL)'
      )
  ) then
    raise exception 'Refusing: token_metric_observations_latest_dashboard_idx definition changed';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.raw_provider_latest_lookup_idx')
      and i.indrelid = 'public.raw_provider_records'::regclass
      and i.indisvalid and i.indisready
      and pg_catalog.pg_get_indexdef(i.indexrelid) =
        'CREATE INDEX raw_provider_latest_lookup_idx ON public.raw_provider_records USING btree (provider_id, token_id, chain_id, collected_at DESC, id DESC)'
  ) then
    raise exception 'Refusing: raw_provider_latest_lookup_idx missing or changed';
  end if;

  if exists (
    select 1 from pg_catalog.pg_index i
    where i.indexrelid = pg_catalog.to_regclass('public.raw_provider_records_latest_token_idx')
      and (
        i.indisunique or i.indisprimary
        or pg_catalog.pg_get_indexdef(i.indexrelid) <>
          'CREATE INDEX raw_provider_records_latest_token_idx ON public.raw_provider_records USING btree (provider_id, token_id, chain_id, collected_at DESC, id DESC) WHERE (excluded_reason IS NULL)'
      )
  ) then
    raise exception 'Refusing: raw_provider_records_latest_token_idx definition changed';
  end if;
end;
$migration$;

drop index if exists public.token_metric_observations_latest_dashboard_idx;
drop index if exists public.raw_provider_records_latest_token_idx;

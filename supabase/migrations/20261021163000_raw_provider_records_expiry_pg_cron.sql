-- retention_expire_raw_provider_records_batch kept timing out on every
-- scheduled call through this app's retention route, which runs it via
-- client.rpc(...) over PostgREST -- whose `authenticated` role has an ~8s
-- statement_timeout (pg_roles.rolconfig). Each row it deletes fires the
-- token_metric_observations_raw_record_id_fkey trigger, and that trigger's
-- per-row cost was measured climbing from ~10-15ms to ~32.5ms to ~59ms over
-- a single afternoon on 2026-10-21 (confirmed via EXPLAIN (ANALYZE, BUFFERS)
-- on pure buffer-cache hits, no lock contention -- not an indexing problem,
-- the supporting index is 6.2MB and already in use). No fixed batch size
-- tuned to one measurement stays safe under an actively degrading per-row
-- cost: it deleted 0 rows on every scheduled run at batch sizes 1000, 300,
-- and then 100 in turn, letting raw_provider_records grow unchecked past
-- its intended 2-day window.
--
-- This is the same structural failure already fixed once this way for
-- retention_collapse_non_chart_daily_batch (20261008000000_non_chart_collapse_pg_cron.sql):
-- move it off PostgREST and run it directly via pg_cron as the postgres
-- role, whose statement_timeout is 5 minutes, not 8 seconds. Applied live
-- first (cron.schedule), this migration documents that job; the
-- corresponding call was also removed from RETENTION_FUNCTIONS in
-- src/lib/retention/run-retention.ts so the PostgREST-bound route no longer
-- duplicates or fights this work.
select cron.schedule(
  'tokensam-raw-provider-records-expiry',
  '*/2 * * * *',
  $$select public.retention_expire_raw_provider_records_batch(1000);$$
);

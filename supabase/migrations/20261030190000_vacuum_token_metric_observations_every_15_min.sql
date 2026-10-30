-- Run the manual VACUUM (ANALYZE) on token_metric_observations every 15 minutes instead of every 5.
--
-- Measured 2026-10-30 (pg_stat_statements, cumulative since 2026-10-02): this job was 29% of all database
-- time (4,707 runs, 8.6 s average, 97 s max) and ~221 GB of the ~335 GB read from disk. The table already has
-- aggressive autovacuum settings (scale_factor 0.01, threshold 1000) and held 836 dead rows of 742,664 (0.1%),
-- so autovacuum alone bounds dead space to about 1% of the table; the 5-minute manual run was mostly redundant.
-- The other vacuum jobs (raw_provider_records, calculated_metric_observations, provider_pairs) are unchanged:
-- their autovacuum thresholds are looser, so they still need the manual runs.
--
-- Offset to :07/:22/:37/:52 so it does not start together with the 5-minute collector ticks.
-- Applied live 2026-10-30. Revert with: select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'tokensam-retention-vacuum'), schedule := '*/5 * * * *');

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-vacuum'),
  schedule := '7-59/15 * * * *'
);

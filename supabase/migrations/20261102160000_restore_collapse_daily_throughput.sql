-- Restore retention throughput: collapse-daily every 2 minutes, batch 200 (2026-11-02).
--
-- 20261030200000 moved tokensam-retention-collapse-daily from every 2 minutes to every 10 minutes to cut its
-- load, but the job deletes at most `batch` (80) rows per run, so that cut its capacity from ~57,600 to
-- ~11,500 deletes a day. Rows older than the granular windows were no longer collapsed fast enough:
-- token_metric_observations grew from 742,664 to 847,953 rows in three days (60,382 collapsible rows were
-- waiting) and the daily peaks reached 497-498 MB of the 500 MB limit on Nov 1 and Nov 2.
-- The no-overlap advisory lock and the 90 s statement_timeout from that migration stay (they are what stop a slow
-- run from piling up); only the schedule is restored, and the batch is raised to 200 to work off the backlog.
-- If a run takes much longer than ~15 s (it was 4-13 s at batch 80), lower the batch back to 80.

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-collapse-daily'),
  schedule := '*/2 * * * *',
  command := $cmd$set statement_timeout = '90s'; select public.retention_pg_cron_step('retention_collapse_daily_batch', 200);$cmd$
);

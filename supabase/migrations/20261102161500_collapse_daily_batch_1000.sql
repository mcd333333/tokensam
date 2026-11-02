-- Raise the collapse-daily batch to 1000 (2026-11-02).
--
-- The job's cost is dominated by a fixed scan of every row older than the granular windows, not by the delete:
-- measured on production, one run deleting 1,000 rows took 9.7 s, against ~12 s per run at batch 200 and 4-13 s at
-- batch 80. Capacity is batch x runs, and the 80-row batch left almost no headroom (57,600/day against a need of
-- roughly 40,000-55,000/day); when its schedule was slowed on 2026-10-30 retention fell behind by 60,000 rows.
-- 1,000 per 2 minutes is ~720,000 deletes/day, so the schedule or a slow run can no longer starve retention.
-- The no-overlap advisory lock and 90 s statement_timeout stay. If runs ever exceed ~30 s, lower the batch.

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-collapse-daily'),
  command := $cmd$set statement_timeout = '90s'; select public.retention_pg_cron_step('retention_collapse_daily_batch', 1000);$cmd$
);

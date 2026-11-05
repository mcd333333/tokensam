-- Revert the two unproven IO-easing changes from 20261105100000 (applied live 2026-11-05).
--
-- Those changes assumed the 2026-11-04 stall came from our own disk IO. The Supabase disk graphs showed our IOPS and
-- throughput flat and tiny (~0.5% of limits) before and during the stall, with the spike only afterwards as recovery,
-- so the stall looks platform-side (Nano is shared, burst-then-baseline). Without that justification:
--   * observation-metadata-compaction goes back to every 30 s: once a minute (6,000 rows/h) is below the ~6,800 rows/h
--     inserted, so the backlog could never shrink, and compaction is one of the ways the database gets smaller.
--   * tokensam-retention-vacuum goes back to every 15 min, the last setting backed by a measurement (20261030190000).
-- The diagnostic tmp-relation-size-probe stays removed.

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'observation-metadata-compaction'), schedule := '30 seconds');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'tokensam-retention-vacuum'), schedule := '7-59/15 * * * *');

-- Let observation-metadata compaction keep pace with new rows (2026-10-30).
--
-- compact_observation_metadata_batch caps its batch at 100 rows per call (least(greatest(p_batch_size,0),100)).
-- The job ran once a minute, so it scanned at most 6,000 rows/hour while the collectors insert ~6,800/hour:
-- the scan cursor trailed the newest row by 22,692 ids (6,080 uncompacted rows with full-size notes in the
-- newest 20k), partly from the 09:36-11:57 stall and partly from this structural deficit.
-- Every 30 seconds gives ~12,000 rows/hour of capacity, which clears the backlog in a few hours.
-- Also capped at 60 s (runs reached 216 s during the stall) so it cannot hold a worker for minutes.
-- pg_cron 1.6.4 supports interval schedules. Revert: schedule := '* * * * *'.

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'observation-metadata-compaction'),
  schedule := '30 seconds',
  command := $cmd$set statement_timeout = '60s'; select public.compact_observation_metadata_batch(100);$cmd$
);

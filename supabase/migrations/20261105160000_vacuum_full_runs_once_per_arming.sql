-- Make the VACUUM FULL job run once per arming (applied live 2026-11-05).
--
-- manage_retention_full_vacuum() (every 10 min, at :00/:10/...) switches tokensam-retention-vacuum-full on when the
-- database is >= 450 MB and reclaimable space >= 15 MB, and switches it off at its next check once a run completed.
-- The job itself was scheduled every 5 minutes (2-59/5), so it always ran twice per arming: e.g. 02:02 and 02:07 on
-- 2026-11-05, 15:52 and 15:57 on 2026-11-02. The second run took the same ~40 s exclusive lock and rewrote ~400 MB again
-- for almost no reclaim, after the 15 MB condition had already stopped being true.
-- Every 10 minutes, offset to :02/:12/..., fires once between manager checks: armed at :10 -> runs :12 -> disarmed at
-- :20 before :22. The trigger conditions are unchanged. The manager's alter_job calls pass a NULL schedule, so it keeps this one.

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'tokensam-retention-vacuum-full'), schedule := '2-59/10 * * * *');

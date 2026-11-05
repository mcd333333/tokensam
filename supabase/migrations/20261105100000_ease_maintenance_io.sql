-- Ease background maintenance IO after the 2026-11-04 22:52 UTC stall (applied live 2026-11-05).
--
-- Evidence (Supabase Postgres logs + dashboard): for ~3 h every scheduled job failed to start, trivial statements took
-- 10-13 s, a 33 MB checkpoint took 365 s, and CPU showed ~85% IOwait with the Disk IO balance at 0%. API traffic and
-- checkpoint write volume were normal beforehand, so the Nano instance's disk IO budget ran out; vacuum was ~80% of
-- all disk reads. These changes cut IO we control:
--   * tokensam-retention-vacuum: every 15 min -> every 30 min (autovacuum, tuned to 1% on this table, covers the rest).
--   * observation-metadata-compaction: every 30 s -> every minute (its writes add WAL and IO; it stays enabled).
--   * the diagnostic tmp-relation-size-probe job, table and function are removed.
-- Revert vacuum: select cron.alter_job(job_id := (select jobid from cron.job where jobname='tokensam-retention-vacuum'), schedule := '7-59/15 * * * *');

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'tokensam-retention-vacuum'), schedule := '7,37 * * * *');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'observation-metadata-compaction'), schedule := '* * * * *');
select cron.unschedule('tmp-relation-size-probe') where exists (select 1 from cron.job where jobname = 'tmp-relation-size-probe');
drop table if exists public.tmp_relation_size_probe;
drop function if exists public.tmp_relation_size_probe_run();

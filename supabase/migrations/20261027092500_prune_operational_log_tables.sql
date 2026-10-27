-- Operational log tables (data_refresh_runs/steps, retention_runs, geckoterminal_sync_runs,
-- cron.job_run_details) accumulated unbounded since this database was created (2026-10-14):
-- ~17 MB total found on 2026-10-27, growing ~1.3 MB/day combined, with no retention policy.
-- None of these are product data -- no dashboard, chart, or metric reads rows older than a few
-- days from them -- so a rolling 3-day window is purely execution-history cleanup, mirroring the
-- existing tokensam-db-size-snapshot-prune pattern (30-day window on db_size_snapshots).
--
-- Applied live to production 2026-10-27 (one-off manual cleanup first via the Supabase SQL
-- Editor, since this crosses the DELETE/VACUUM-on-destructive-statement confirmation gap that
-- times out via the Supabase MCP tools), taking the database from 469 MB to 459 MB. This
-- migration adds the function and daily cron job so the cleanup is now permanent.

create or replace function public.prune_operational_logs(retention_interval interval default '3 days')
returns jsonb
language plpgsql
security definer
set search_path = public, cron
as $function$
declare
  deleted_steps integer;
  deleted_runs integer;
  deleted_retention integer;
  deleted_geckoterminal integer;
  deleted_cron integer;
  cutoff timestamptz := now() - retention_interval;
begin
  with doomed as (
    select s.id from public.data_refresh_steps s
    join public.data_refresh_runs r on r.id = s.run_id
    where r.started_at < cutoff
  ),
  deleted as (delete from public.data_refresh_steps s using doomed where s.id = doomed.id returning s.id)
  select count(*) into deleted_steps from deleted;

  with deleted as (
    delete from public.data_refresh_runs where started_at < cutoff returning id
  )
  select count(*) into deleted_runs from deleted;

  with deleted as (
    delete from public.retention_runs where started_at < cutoff returning id
  )
  select count(*) into deleted_retention from deleted;

  with deleted as (
    delete from public.geckoterminal_sync_runs where started_at < cutoff returning id
  )
  select count(*) into deleted_geckoterminal from deleted;

  with deleted as (
    delete from cron.job_run_details where start_time < cutoff returning jobid
  )
  select count(*) into deleted_cron from deleted;

  return jsonb_build_object(
    'data_refresh_steps', deleted_steps,
    'data_refresh_runs', deleted_runs,
    'retention_runs', deleted_retention,
    'geckoterminal_sync_runs', deleted_geckoterminal,
    'cron_job_run_details', deleted_cron
  );
end;
$function$;

select cron.schedule(
  'tokensam-operational-logs-prune',
  '25 3 * * *',
  $$select public.prune_operational_logs();$$
);

-- Verify:
--   select public.prune_operational_logs(); -- run manually to confirm it works
--   select jobid, schedule, jobname, active from cron.job where jobname = 'tokensam-operational-logs-prune';

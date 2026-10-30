-- Stop the retention pg_cron jobs from piling up (incident 2026-10-30 09:36-11:57 UTC).
--
-- tokensam-retention-collapse-daily normally takes ~5 s per run, every 2 minutes. At 09:36 one run took 349 s
-- and hit the 300 s statement_timeout; the job does not wait for its previous run, so copies overlapped (avg
-- 134 s, max 425 s per run in the 10:00 hour). With max_worker_processes = 6, the overlapping copies plus the
-- every-minute compaction job used every worker: all other cron jobs failed with "job startup timeout", and
-- the collectors' API calls timed out (Supabase read/lease timeouts), leaving a ~2 h hole in the 1D charts.
--
-- 1) retention_pg_cron_step now returns immediately if the same step is already running (transaction-level
--    advisory lock), so a slow run can no longer be joined by more copies of itself.
-- 2) The three retention jobs run with statement_timeout = 90 s (normal runs are 4-13 s, rarely ~45 s), so a
--    runaway batch frees its worker in 90 s instead of 300 s. A cancelled batch is rolled back and retried.
-- 3) tokensam-retention-collapse-daily runs every 10 minutes instead of every 2: the batch is 80 rows and its
--    query scans every row older than 14 days before applying that limit, which is costly to run 720 times a day.
-- Applied live 2026-10-30.

create or replace function public.retention_pg_cron_step(step_fn text, batch integer)
returns integer
language plpgsql
set search_path to 'public', 'pg_catalog'
as $function$
declare
  deleted integer;
  started timestamptz := clock_timestamp();
begin
  if step_fn not in (
    'retention_collapse_daily_batch',
    'retention_expire_observations_batch',
    'retention_expire_daily_aggregates_batch'
  ) then
    raise exception 'retention_pg_cron_step: unsupported step %', step_fn;
  end if;

  -- A previous run of this same step is still going: do nothing rather than pile up behind it.
  if not pg_try_advisory_xact_lock(hashtext('retention_pg_cron_step'), hashtext(step_fn)) then
    return 0;
  end if;

  execute format('select public.%I($1)', step_fn) into deleted using batch;
  deleted := coalesce(deleted, 0);

  -- Only record passes that actually removed rows, so retention_runs keeps its
  -- "what was deleted, when" history without a row for every idle tick.
  if deleted > 0 then
    insert into public.retention_runs (trigger, status, started_at, finished_at, lease_expires_at, lock_token, summary)
    values (
      'scheduled', 'succeeded', started, clock_timestamp(), clock_timestamp(), 'pg_cron:' || step_fn,
      jsonb_build_object('source', 'pg_cron', 'deleted', jsonb_build_object(step_fn, deleted), 'totalDeleted', deleted)
    );
  end if;
  return deleted;
end;
$function$;

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-collapse-daily'),
  schedule := '4-59/10 * * * *',
  command := $cmd$set statement_timeout = '90s'; select public.retention_pg_cron_step('retention_collapse_daily_batch', 80);$cmd$
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-expire-observations'),
  command := $cmd$set statement_timeout = '90s'; select public.retention_pg_cron_step('retention_expire_observations_batch', 1000);$cmd$
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'tokensam-retention-expire-daily-aggregates'),
  command := $cmd$set statement_timeout = '90s'; select public.retention_pg_cron_step('retention_expire_daily_aggregates_batch', 1000);$cmd$
);

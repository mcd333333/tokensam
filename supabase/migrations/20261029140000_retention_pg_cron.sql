-- Move the retention batches from the /api/cron/retention Vercel route into pg_cron.
--
-- The route ran every 5 minutes from the Cloudflare Worker: ~171 invocations/day, ~15 s of
-- function wall time each, almost all of it idle (nearly every pass deleted 0 rows). Each
-- invocation billed Vercel Fluid memory and active CPU against the Hobby allowance. The three
-- batch functions are plain SQL, and the same move already proved out for the non-chart collapse
-- and raw_provider_records expiry (20261008000000, 20261021163000): pg_cron runs as `postgres`
-- (5 min statement_timeout, not PostgREST's 8 s) and costs no function time.
--
-- Applied to production 2026-10-29. Each job runs one batch per tick, in its own transaction;
-- the daily rollover backlog (~7 batches of 80 groups) drains within ~15 minutes.
--
-- /api/cron/retention stays in the codebase for manual `?force=1` runs; the Cloudflare Worker no
-- longer calls it (cloudflare/refresh-scheduler/src/index.ts).

create or replace function public.retention_pg_cron_step(step_fn text, batch integer)
returns integer
language plpgsql
set search_path = public, pg_catalog
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

select cron.schedule('tokensam-retention-collapse-daily', '*/2 * * * *',
  $$select public.retention_pg_cron_step('retention_collapse_daily_batch', 80);$$);
select cron.schedule('tokensam-retention-expire-observations', '*/5 * * * *',
  $$select public.retention_pg_cron_step('retention_expire_observations_batch', 1000);$$);
select cron.schedule('tokensam-retention-expire-daily-aggregates', '1-59/5 * * * *',
  $$select public.retention_pg_cron_step('retention_expire_daily_aggregates_batch', 1000);$$);
-- manage_retention_full_vacuum() arms/disarms the tokensam-retention-vacuum-full job and used to
-- be called at the end of each route pass.
select cron.schedule('tokensam-retention-vacuum-manager', '*/10 * * * *',
  $$select public.manage_retention_full_vacuum();$$);

-- Verify:
--   select jobname, schedule, active from cron.job where jobname like 'tokensam-retention-%';
--   select * from public.retention_runs where lock_token like 'pg_cron:%' order by id desc limit 5;

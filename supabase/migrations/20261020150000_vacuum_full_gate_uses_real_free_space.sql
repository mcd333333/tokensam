-- manage_retention_full_vacuum() never fired automatically after 2026-10-17,
-- despite the database repeatedly crossing its own 450MB threshold (481MB,
-- 515MB observed directly). Root cause: its bloat gate was a dead-tuple-ratio
-- estimate (n_dead_tup / (n_live_tup + n_dead_tup) * relpages), and
-- token_metric_observations carries deliberately aggressive autovacuum
-- settings (autovacuum_vacuum_scale_factor = 0.01, threshold = 1000) that
-- sweep dead tuples almost immediately -- so that ratio reads near-zero at
-- essentially every check, even when the heap is genuinely fragmented.
-- Confirmed directly: a manual VACUUM FULL reclaimed ~106MB while this
-- estimate read ~1MB at the time.
--
-- Replaces it with pgstattuple_approx(relid).approx_free_space summed across
-- public-schema tables: a real, sampled measurement of reclaimable page-level
-- free space, not a snapshot of currently-unvacuumed dead tuples. Also fixes
-- the table-selection step for the VACUUM FULL command itself, which had the
-- same blind spot (picked tables via n_dead_tup > 0, so it could select zero
-- tables even with real free space present) -- now selects any public table
-- with more than 1MB of its own approx_free_space.
--
-- Raises the floor from 15MB to 25MB alongside this, since the new metric
-- reads meaningfully higher than the old one at any given moment (6.9MB vs
-- ~1MB observed on the same database state) and the floor should track that.
CREATE OR REPLACE FUNCTION public.manage_retention_full_vacuum()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  db_bytes bigint := pg_database_size(current_database());
  threshold_bytes bigint := 450 * 1024 * 1024;
  bloat_floor_bytes bigint := 25 * 1024 * 1024;
  max_attempts constant integer := 6;
  state_row public.retention_vacuum_state%rowtype;
  full_job_id bigint;
  latest_run timestamptz;
  latest_status text;
  latest_message text;
  job_active boolean;
  job_command text;
  vacuum_command text;
  tables_to_vacuum text;
  action text := 'none';
  failure_type text := null;
  is_new_run boolean;
  bloat_bytes bigint;
  should_run boolean;
begin
  select * into state_row
  from public.retention_vacuum_state
  where id = true
  for update;

  select jobid, active, command
  into full_job_id, job_active, job_command
  from cron.job
  where jobname = 'tokensam-retention-vacuum-full'
  limit 1;

  if full_job_id is null then
    raise exception 'tokensam-retention-vacuum-full job is missing';
  end if;

  select start_time, status, return_message
  into latest_run, latest_status, latest_message
  from cron.job_run_details
  where jobid = full_job_id
  order by start_time desc
  limit 1;

  is_new_run := latest_run is not null
    and (state_row.last_processed_run_at is null or latest_run > state_row.last_processed_run_at);

  -- True reclaimable free space via pgstattuple_approx, not a dead-tuple-ratio
  -- estimate: aggressive autovacuum tuning on these tables sweeps dead tuples
  -- almost immediately, so n_dead_tup reads near-zero even when the heap is
  -- genuinely fragmented across pages (confirmed: a VACUUM FULL reclaimed
  -- ~106MB while this ratio-based estimate read ~1MB at the time).
  select coalesce(sum(pgsa.approx_free_space), 0)::bigint
  into bloat_bytes
  from pg_stat_user_tables s
  cross join lateral pgstattuple_approx(s.relid) as pgsa
  where s.schemaname = 'public';

  should_run := db_bytes >= threshold_bytes and bloat_bytes >= bloat_floor_bytes;

  if state_row.exhausted then
    action := 'waiting_for_manual_reset_exhausted';

  elsif is_new_run and latest_status = 'succeeded' then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    update public.retention_vacuum_state
    set armed = (bloat_bytes < bloat_floor_bytes),
        attempt_count = 0,
        last_failure_type = null,
        last_failure_message = null,
        last_processed_run_at = latest_run,
        updated_at = now()
    where id = true;
    action := case when bloat_bytes < bloat_floor_bytes
      then 'completed_rearmed_below_threshold'
      else 'completed_waiting_for_bloat_to_fall_below_threshold' end;

  elsif is_new_run and latest_status = 'failed' then
    failure_type := case
      when latest_message ilike '%statement timeout%' then 'statement_timeout'
      when latest_message ilike '%lock timeout%' or latest_message ilike '%could not obtain lock%' or latest_message ilike '%could not acquire lock%' then 'lock_contention'
      when latest_message ilike '%deadlock detected%' then 'deadlock'
      when latest_message ilike '%no space left%' or latest_message ilike '%could not extend file%' or latest_message ilike '%disk full%' then 'disk_full'
      when latest_message ilike '%transaction block%' or latest_message ilike '%executed from a function%' then 'command_misconfig'
      else 'unknown'
    end;

    if failure_type = 'disk_full' or state_row.attempt_count + 1 >= max_attempts then
      if job_active then
        perform cron.alter_job(full_job_id, null, null, null, null, false);
      end if;
      update public.retention_vacuum_state
      set armed = false,
          exhausted = true,
          attempt_count = state_row.attempt_count + 1,
          last_failure_type = failure_type,
          last_failure_message = latest_message,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'stopped_after_failure_manual_review_required:' || failure_type;
    else
      update public.retention_vacuum_state
      set attempt_count = state_row.attempt_count + 1,
          last_failure_type = failure_type,
          last_failure_message = latest_message,
          last_processed_run_at = latest_run,
          updated_at = now()
      where id = true;
      action := 'retrying_after_failure:' || failure_type;
    end if;

  elsif not should_run then
    if job_active then
      perform cron.alter_job(full_job_id, null, null, null, null, false);
    end if;
    update public.retention_vacuum_state
    set armed = case when bloat_bytes < bloat_floor_bytes then true else armed end,
        attempt_count = case when bloat_bytes < bloat_floor_bytes then 0 else attempt_count end,
        last_failure_type = case when bloat_bytes < bloat_floor_bytes then null else last_failure_type end,
        last_failure_message = case when bloat_bytes < bloat_floor_bytes then null else last_failure_message end,
        updated_at = now()
    where id = true;
    action := case
      when db_bytes < threshold_bytes then 'waiting_for_database_size_and_bloat_thresholds'
      when bloat_bytes < bloat_floor_bytes then 'armed_waiting_for_bloat_threshold_crossing'
      else 'waiting_for_thresholds'
    end;

  elsif not state_row.armed then
    action := 'waiting_for_bloat_to_fall_below_threshold_before_rearming';

  elsif not job_active then
    -- Tables worth including in the VACUUM FULL: meaningful free space
    -- (>1MB), not n_dead_tup > 0, for the same reason as the gate above.
    select string_agg(format('%I.%I', s.schemaname, s.relname), ', ' order by s.schemaname, s.relname)
    into tables_to_vacuum
    from pg_stat_user_tables s
    cross join lateral pgstattuple_approx(s.relid) as pgsa
    where s.schemaname = 'public'
      and pgsa.approx_free_space > 1024 * 1024;

    if tables_to_vacuum is null then
      action := 'threshold_met_but_no_public_tables_with_reclaimable_space_found';
    else
      vacuum_command := 'VACUUM (FULL, ANALYZE) ' || tables_to_vacuum || ';';
      perform cron.alter_job(full_job_id, null, vacuum_command, null, null, true);
      update public.retention_vacuum_state
      set last_triggered_at = now(),
          last_triggered_bytes = db_bytes,
          updated_at = now()
      where id = true;
      action := 'activated_for_public_tables';
    end if;

  else
    action := 'vacuum_job_active_waiting_for_result';
  end if;

  return jsonb_build_object(
    'db_bytes', db_bytes,
    'db_size', pg_size_pretty(db_bytes),
    'database_threshold', pg_size_pretty(threshold_bytes),
    'bloat_bytes', bloat_bytes,
    'bloat_estimate', pg_size_pretty(bloat_bytes),
    'bloat_threshold', pg_size_pretty(bloat_floor_bytes),
    'bloat_scope', 'public application tables (pgstattuple_approx free space)',
    'should_run', should_run,
    'tables_to_vacuum', tables_to_vacuum,
    'job_id', full_job_id,
    'job_active', (select active from cron.job where jobid = full_job_id),
    'armed', (select armed from public.retention_vacuum_state where id = true),
    'exhausted', (select exhausted from public.retention_vacuum_state where id = true),
    'attempt_count', (select attempt_count from public.retention_vacuum_state where id = true),
    'last_failure_type', (select last_failure_type from public.retention_vacuum_state where id = true),
    'latest_run', latest_run,
    'latest_status', latest_status,
    'action', action
  );
end;
$function$;

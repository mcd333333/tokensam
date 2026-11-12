-- DexPaprika is now the only on-chain DEX data provider. Remove the DEX Screener and GeckoTerminal history,
-- mappings and provider rows, and refresh the calculated-metric definitions whose inputs changed.

delete from public.token_metric_daily_aggregates where provider_id in ('dexscreener', 'geckoterminal');
delete from public.token_metric_observations where provider_id in ('dexscreener', 'geckoterminal');
delete from public.provider_pairs where provider_id in ('dexscreener', 'geckoterminal');
delete from public.provider_token_mappings where provider_id in ('dexscreener', 'geckoterminal');
delete from public.raw_provider_records where provider_id in ('dexscreener', 'geckoterminal');
delete from public.data_refresh_steps where step = 'dexscreener';

-- The log-pruning function referenced geckoterminal_sync_runs, so replace it before the table goes.
create or replace function public.prune_operational_logs(retention_interval interval default '3 days'::interval)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'cron'
as $function$
declare
  deleted_steps integer;
  deleted_runs integer;
  deleted_retention integer;
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
    delete from cron.job_run_details where start_time < cutoff returning jobid
  )
  select count(*) into deleted_cron from deleted;

  return jsonb_build_object(
    'data_refresh_steps', deleted_steps,
    'data_refresh_runs', deleted_runs,
    'retention_runs', deleted_retention,
    'cron_job_run_details', deleted_cron
  );
end;
$function$;

drop table if exists public.geckoterminal_sync_runs;

delete from public.data_providers where id in ('dexscreener', 'geckoterminal');

update public.calculated_metric_definitions
set name = 'FDV / associated protocol TVL', formula = 'CoinGecko-reported fully_diluted_valuation / DeFiLlama protocol tvl_usd', source_scopes = 'token/protocol'
where id = 'fdv_to_tvl';
update public.calculated_metric_definitions
set name = 'FDV / associated protocol 24h revenue', formula = 'CoinGecko-reported fully_diluted_valuation / DeFiLlama revenue_24h_usd', source_scopes = 'token/protocol'
where id = 'fdv_to_revenue_24h';

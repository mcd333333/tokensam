-- retention_expire_raw_provider_records_batch had been failing silently on
-- every scheduled run ("canceling statement due to statement timeout"):
-- token_metric_observations.raw_record_id and provider_pairs.raw_record_id
-- both reference raw_provider_records(id) with no supporting index on the
-- referencing side, so each deleted parent row forced a sequential scan of
-- token_metric_observations (400K+ rows) to verify no orphaned references.
-- raw_provider_records grew unchecked from ~21k to ~115k rows over two days
-- as a result. Applied directly against the live database on 2026-10-19,
-- confirmed to bring the batch function from timing out to completing
-- instantly; this migration file brings that schema change into version
-- control.
create index if not exists idx_token_metric_observations_raw_record_id
  on public.token_metric_observations (raw_record_id);

create index if not exists idx_provider_pairs_raw_record_id
  on public.provider_pairs (raw_record_id);

-- token_dex_pools now holds two independently refreshed parts per token: the pool list (pools_at, slow) and the
-- token-level stats refresh time (stats_at, faster). fetched_at is kept (nullable) for readers of the old shape.
-- Applied to production 2026-11-12.
begin;
alter table public.token_dex_pools
  add column if not exists pools_at timestamptz,
  add column if not exists stats_at timestamptz;
update public.token_dex_pools set pools_at = fetched_at where pools_at is null;
alter table public.token_dex_pools alter column fetched_at drop not null;
commit;

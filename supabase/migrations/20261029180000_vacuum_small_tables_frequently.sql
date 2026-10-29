-- raw_provider_records inserts and expires ~760 rows per 45 minutes, so its row count is flat, but only
-- autovacuum vacuumed it, and autovacuum waits for 20% dead rows (~9,000). Dead space therefore sat
-- unreusable (5,122 dead rows, last autovacuum 08:06 on 2026-10-29) while the table's heap, indexes and
-- TOAST grew ~2.4 MB/hour (measured by a 5-minute size probe, 17:05-17:50 UTC: +1.77 MB with 769 rows
-- inserted and 760 deleted). token_metric_observations already gets a plain VACUUM every 5 minutes
-- (tokensam-retention-vacuum). Plain VACUUM takes no exclusive lock, unlike VACUUM FULL.
--
-- Applied to production 2026-10-29. Undo: select cron.unschedule('tokensam-vacuum-small-tables');

select cron.schedule('tokensam-vacuum-small-tables', '3-59/5 * * * *',
  $$VACUUM (ANALYZE) public.raw_provider_records, public.calculated_metric_observations, public.provider_pairs;$$);

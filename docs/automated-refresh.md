# Automated data refresh

Phase 11B keeps Supabase current without running each collector by hand. A single server-side orchestrator runs the CoinGecko, Binance, DEX Screener, and DeFiLlama collectors, recalculates metrics, and records the outcome. The browser never calls a provider. It only reads Supabase through the server.

```
Cloudflare Cron (*/5 * * * *) ─► GET /api/cron/refresh  (Bearer CRON_SECRET)
pnpm refresh ─────────┐          │
                      ▼          ▼
               runDataRefresh (src/lib/refresh/orchestrator.ts)
                 1. take the single-run lock (data_refresh_runs)
                 2. pick providers that are due
                 3. run due collectors concurrently, each with its own deadline
                      CoinGecko ─┐
                      DEX Screener ─┼─► raw_provider_records + token_metric_observations
                      DeFiLlama ─┘      (existing collectors and persistence, unchanged)
                 4. if any provider succeeded: runMetricsCalculation
                      └─► calculated_metric_observations
                 5. record each step + overall status, release the lock
                                   │
                                   ▼
                  Dashboard / Token Profile (server-rendered per request)
```

## Setup

1. Apply [`supabase/migrations/20260925090000_automated_refresh.sql`](../supabase/migrations/20260925090000_automated_refresh.sql) in the Supabase SQL Editor. It only adds objects:
   - `data_refresh_runs`: one row per run. A partial unique index allows only one `running` row, which acts as the lock.
   - `data_refresh_steps`: one row per provider or metrics step.
   - `latest_token_metric_observations` and `latest_raw_provider_records`: views that return the newest row per metric or per token, with supporting indexes.

   All four have RLS enabled and are accessible only to `service_role`.
2. Set the environment variables (server-side only, never `NEXT_PUBLIC_`):

   | Variable | Purpose |
   | --- | --- |
   | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Server-side Supabase access (existing) |
   | `COINGECKO_API_KEY`, `COINGECKO_API_PLAN` | CoinGecko collector (existing) |
   | `DEFILLAMA_WRITTEN_PERMISSION_REFERENCE` | DeFiLlama permission gate (existing). If unset, DeFiLlama is **skipped**, never bypassed |
   | `CRON_SECRET` | Protects `/api/cron/refresh`. Random, 16+ characters |

## Cadence

The cron fires hourly, and each run collects only the providers that are **due**. A provider is due when its last successful refresh is older than its interval. The check allows 10 minutes of tolerance for cron jitter. The same due check handles a missed cron delivery (the next run catches up) and a duplicated one (nothing is due, so the run is recorded as `skipped`).

| Provider | Interval | Shown stale after | Step budget | Basis |
| --- | --- | --- | --- | --- |
| CoinGecko | 1 hour | 3 hours | 90 s | One `/coins/markets` call per run (100 IDs, max 250 per call) ≈ 744 calls/month against the documented 10,000/month Demo allowance |
| Binance | 5 minutes | 20 minutes | 30 s | Live price and 24h change only. No API key; two requests per run at weight 40 each against a published 6,000 request-weight/minute per IP. Shown stale after 20 min because the read layer stops preferring Binance past that and falls back to CoinGecko |
| DEX Screener | 1 hour | 3 hours | 90 s | About 13 batched requests per run (63 mapped tokens, up to 30 addresses per chain request) against the documented 300 requests/minute |
| DeFiLlama | 6 hours | 24 hours | 150 s | No published numeric free-tier limit, so refreshed least often. Fees and revenue are 24-hour totals and TVL history is daily. 72 requests for 24 protocols took 109 s on 2026-09-25, so the budget rose from 120 s. Providers run in parallel, and 150 s plus 90 s for metrics stays below the route's 300 s limit |
| DeFiLlama (token prices) | 1 hour | 3 hours | 30 s | Four batched requests (25 keys each) for 100 tokens |
| Metrics | After any successful provider step | n/a | 90 s | Reads Supabase only; 2,800 rows for 100 tokens took 17 s |

Intervals and thresholds live in [`src/lib/refresh/config.ts`](../src/lib/refresh/config.ts). The existing per-request pacing, `Retry-After` handling and bounded retries inside each collector are unchanged.

## Scheduler

The existing `token-samurai-refresh-scheduler` Cloudflare Worker serves the app and owns its schedules in [`wrangler.jsonc`](../wrangler.jsonc). Its `*/5 * * * *` trigger calls `/api/cron/refresh` and the other market-data routes with `Authorization: Bearer <CRON_SECRET>`. The route compares the secret in constant time, returns `401` for unauthorized requests, and sets `maxDuration = 300`.

The same Worker checks RootData once per day at `0 4 * * *` (04:00 UTC). It calls `/api/cron/rootdata`, which refreshes only funding and investor summaries at least 14 days old. The handler branches on the cron expression because Cloudflare sends all configured schedules to the same `scheduled()` handler. See the [RootData integration guide](rootdata-integration.md) and [Cloudflare migration notes](cloudflare-migration.md).

## Manual refresh (development)

```bash
pnpm refresh
```

This runs only the providers that are due, through the same lock and status recording. To collect regardless of due state, or to choose providers:

```bash
pnpm refresh --force --providers=coingecko,dexscreener
```

To call the endpoint of a local `next start` server with `CRON_SECRET` set:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/refresh?force=1&providers=coingecko"
```

Each forced run uses provider quota, so avoid repeated forced runs.

The individual collector commands (`pnpm coingecko:sync`, etc.) and `pnpm metrics:calculate` still work unchanged. They don't take the lock or record refresh status.

## Failure and partial success

- **Isolation.** Providers run concurrently with separate deadlines. Collectors fetch and validate before writing, so a failed or timed-out provider writes nothing. Its previously stored observations remain the latest, and the UI keeps showing them with their original collection time. Nothing is deleted or replaced with zeros.
- **Timeouts.** Each step's deadline aborts in-flight requests and retry waits through the collector's `fetchImpl` and `sleep` hooks. A hard ceiling also guards work that can't be aborted.
- **Run status:**
  - `succeeded`: every attempted provider and metrics succeeded.
  - `partial`: at least one provider succeeded, but another failed or timed out, or metrics failed.
  - `failed`: no attempted provider succeeded.
  - `skipped`: nothing was due, or only permission-gated providers were due.
  - The endpoint returns `200` for succeeded, partial and skipped, `409` if another run holds the lock, and `500` for failed.
- **Locking.** A second concurrent run gets `busy` and does nothing. A run that crashes leaves its lock only until its 10-minute lease expires. The next run then marks it `failed` ("lease expired") and proceeds.
- **Error text.** Step errors store the collector's sanitized message, which contains no keys or URLs.

## Metrics recalculation

After at least one provider succeeds in a run, the existing `runMetricsCalculation` runs once over whatever is stored. A provider that failed contributes its last successful observations. Inputs that are unavailable remain `unavailable` or `null`, never zero. If every provider fails, metrics are skipped and the stored results stay as they are.

History is append-only and now grows every hour, so the metrics runner reads a bounded set:
- the latest observation for every metric (from the view);
- a 14-day window for the five series the engine compares over time (CoinGecko price and market cap; DeFiLlama TVL, fees and revenue);
- the newest DEX Screener raw payload per token.

The engine itself is unchanged. A growth metric whose two most recent points are both older than 14 days now reads as unavailable rather than using the old points. With hourly collection this only happens after a provider has been down for two weeks.

## Freshness in the UI

The Dashboard's data-status box and the Token Profile's data-notes panel show one compact line per provider, such as "CoinGecko: 12 min ago". A provider past its own stale threshold (table above) is marked "stale", and one with no collected data shows "not collected". The time shown is the newer of the last successful refresh step and the latest stored collection time, so manual collector runs count too. Per-metric provider and collection time remain on hover.

Before the migration is applied, the UI falls back to full-table reads and to collection times, so it keeps working.

## Storage growth

Each hourly CoinGecko + DEX Screener pass writes about 700 observation rows and about 84 raw records of 1–2 KB each. A DeFiLlama pass writes about 11 raw records of 5–7 KB. Expect roughly 15–20k observation rows a day. No pruning or retention policy is part of this phase. Monitor database size (the Supabase free tier is 500 MB) and plan a retention or downsampling policy before long-running production use.

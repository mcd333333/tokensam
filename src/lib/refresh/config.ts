export type ProviderStep = "coingecko" | "defillama" | "defillama_coins";
/** Datasets whose freshness is shown. DexPaprika is collected by its own cron route (/api/cron/dexpaprika), not as a refresh step. */
export type FreshnessProvider = ProviderStep | "dexpaprika";
export type RefreshStep = ProviderStep | "metrics";

export const PROVIDER_STEPS: ProviderStep[] = ["coingecko", "defillama", "defillama_coins"];
export const FRESHNESS_PROVIDERS: FreshnessProvider[] = ["coingecko", "dexpaprika", "defillama", "defillama_coins"];

const MINUTE = 60 * 1000;

/**
 * Per-provider refresh policy.
 *
 * - intervalMs: a provider is "due" once this long has passed since its last
 *   successful refresh. The external scheduler fires every few minutes; each run
 *   collects only the providers that are due, so a missed or duplicated delivery self-heals.
 * - staleAfterMs: when stored data stops being "current" in the UI. Roughly
 *   interval x 3 (one missed run plus slack), and a full day for DeFiLlama,
 *   whose fees/revenue are 24-hour totals and whose TVL history is daily.
 * - timeoutMs: provider-fetch budget inside one run. Collectors fetch before
 *   writing, so a timeout aborts before any Supabase change.
 *
 * Quota notes (see docs/*-integration.md): at this 15-min interval, CoinGecko runs up
 * to ~96 times/day (~2,880/month). Each run batches its ~238 tokens into requests of
 * MAX_IDS_PER_REQUEST each (see coingecko.ts — kept deliberately small to avoid a
 * CloudFront-level 403 unrelated to CoinGecko's own rate limiting), currently 3
 * calls/run, for ~8,640 calls/month against the documented 10,000/month Demo
 * allowance — reduce the interval or revisit the batch size if the token universe
 * grows enough to push this over quota. DexPaprika is not a refresh step: its own cron route walks the
 * on-chain tokens stalest-first (see run-dexpaprika-collection.ts). DeFiLlama publishes no numeric
 * free-tier limit, so it is refreshed least often.
 *
 * Providers run in parallel, then metrics (METRICS_TIMEOUT_MS). The longest
 * provider budget plus the metrics budget must stay below the cron route's
 * 300 s maxDuration: 150 s + 90 s = 240 s.
 */
export const REFRESH_POLICY: Record<FreshnessProvider, { label: string; intervalMs: number; staleAfterMs: number; timeoutMs: number }> = {
  coingecko: { label: "CoinGecko", intervalMs: 15 * MINUTE, staleAfterMs: 3 * 60 * MINUTE, timeoutMs: 140_000 },
  // Binance is no longer a refresh-pipeline provider step: its live price/24h change is
  // fetched directly at render time instead (see fetchLiveBinanceObservations in
  // live-data.ts), the same way the client-side flashing ticker already worked (see
  // src/app/api/live-prices/route.ts). It used to be collected on this cadence and
  // written to token_metric_observations purely so the dashboard's "latest row" read
  // could serve it -- ~13K rows/day, 100% falling into the non-chart retention bucket
  // (Binance has no protected chart-metric exception the way CoinGecko's price_usd/
  // volume_24h_usd do), making it the second-largest contributor to the database-size
  // pressure this project kept running into. A live fetch gets the same freshness with
  // zero Supabase storage.
  // Not run by the orchestrator (see FreshnessProvider): each token's stats refresh about every 90 minutes.
  dexpaprika: { label: "DexPaprika", intervalMs: 90 * MINUTE, staleAfterMs: 4 * 60 * MINUTE, timeoutMs: 40_000 },
  // Current TVL + fees + revenue: three small requests per protocol (72 for 24), paced 1.1 s apart.
  // Measured 2026-09-25 at 109 s for 24 protocols, so the budget is 150 s (pacing is unchanged).
  // Keep the 6-hour cadence because DeFiLlama does not publish a free-tier request limit or
  // guarantee hourly TVL freshness; production observations have also remained ~6–7 hours apart.
  // Dated TVL history (/protocol, up to ~69 MB per record) remains a separate explicit backfill.
  defillama: { label: "DeFiLlama", intervalMs: 6 * 60 * MINUTE, staleAfterMs: 24 * 60 * MINUTE, timeoutMs: 150_000 },
  // Token-level DeFiLlama prices: small batched requests (25 keys each; four for 100 tokens).
  defillama_coins: { label: "DeFiLlama (token prices)", intervalMs: 60 * MINUTE, staleAfterMs: 3 * 60 * MINUTE, timeoutMs: 30_000 },
};

/** Cron delivery can be late or early by minutes; treat a provider as due slightly early. */
export const DUE_TOLERANCE_MS = 2 * MINUTE;

/** Metrics read Supabase only; bound them so a slow database cannot hang the run. */
export const METRICS_TIMEOUT_MS = 90_000;

/**
 * A run holds the lock for at most this long before its lease is considered
 * expired and reclaimable. Set just above the route's maxDuration (300 s) —
 * not to the old 10-minute value — because ownership is now renewed by a
 * heartbeat (see renewLease in store.ts), not just asserted once at acquire
 * time: a genuinely live run keeps extending this deadline as it progresses,
 * while a run killed by the platform stops heartbeating and so becomes
 * reclaimable about 30 s after the kill, not 10 minutes later. That is what
 * keeps a dead invocation from causing more than about one extra Cloudflare
 * 5-minute tick's worth of 409s.
 */
export const RUN_LEASE_MS = 330_000;

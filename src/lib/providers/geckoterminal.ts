import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderPairMapping,
  ProviderSnapshot,
} from "./types.ts";
import { GECKO_TERMINAL_METRIC_NOTE, geckoTerminalTokenMappings } from "../../data/geckoterminal-token-mappings.ts";

const PROVIDER_ID = "geckoterminal";
// The standalone GeckoTerminal Public API (never CoinGecko's /onchain endpoints).
// Trailing slash matters: URL() treats a base's path as a directory only when it
// ends in "/", so a leading-slash-free relative path below keeps "/api/v2".
const BASE_URL = "https://api.geckoterminal.com/api/v2/";
const MAX_ATTEMPTS = 3;
// GeckoTerminal's public API documents no fixed number; treated conservatively as
// ~10 requests/minute. 6.5 s between requests keeps every collection run under
// that budget even after retries, and this endpoint has no multi-address batch
// form, so requests are one token at a time.
// Exported so the scheduling layer (never the provider itself) can require an
// even more conservative pacing; it is never allowed to go below this floor.
export const MIN_REQUEST_INTERVAL_MS = 6_500;
// Live testing (2026-09-26) showed 429 responses whose Retry-After was "0" even
// while genuinely throttled (a burst of 3 requests within ~1.5 s got a 429 after
// the first two succeeded); the header is not trustworthy for this API. A 429
// always waits at least this long, regardless of what Retry-After claims.
const RATE_LIMIT_COOLDOWN_FLOOR_MS = 20_000;
// EVM contract addresses are case-insensitive; other networks' addresses/coin
// types (Solana mints, Move coin types, ICP canisters, TON addresses) are
// compared exactly. Mirrors the DEX Screener identity policy.
const EVM_NETWORKS = new Set(["eth", "bsc", "arbitrum", "optimism", "base", "zksync"]);

export type GeckoTerminalPool = {
  id?: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string | null;
    base_token_price_usd?: string | number | null;
    quote_token_price_usd?: string | number | null;
    token_price_usd?: string | number | null;
    fdv_usd?: string | number | null;
    market_cap_usd?: string | number | null;
    reserve_in_usd?: string | number | null;
    price_change_percentage?: Record<string, string | number | null | undefined> | null;
    transactions?: Record<string, { buys?: number | null; sells?: number | null } | undefined>;
    volume_usd?: Record<string, string | number | null | undefined>;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

export class GeckoTerminalApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GeckoTerminalApiError";
    this.status = status;
  }
}

/**
 * Thrown by `getPools()` when a caller-supplied `deadlineAt` is reached mid-token —
 * before an HTTP attempt would have meaningful time left, or before a planned
 * retry/429-cooldown sleep would itself cross the deadline. Distinct from
 * `GeckoTerminalApiError` so the scheduled collector can classify this token as a
 * time-budget cutoff (`skipped_time_budget`) rather than an ordinary provider failure,
 * and so the rotation cursor does not advance past it (see `fetchGeckoTerminalSnapshotsTolerant`).
 */
export class GeckoTerminalTimeBudgetExceededError extends Error {
  constructor() {
    super("GeckoTerminal request budget exhausted before this token could be completed.");
    this.name = "GeckoTerminalTimeBudgetExceededError";
  }
}

export type GeckoTerminalAsset = ProviderAsset & {
  gtNetworkId: string;
  tokenAddress: string;
  identityNote: string;
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addressEquals(network: string, left: string | undefined | null, right: string | undefined | null): boolean {
  if (!left || !right) return false;
  return EVM_NETWORKS.has(network) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Relationship token ids are formatted "{network}_{address}"; strip the known network prefix. */
function relationshipAddress(network: string, relationshipId: string | undefined | null): string | null {
  if (!relationshipId) return null;
  const prefix = `${network}_`;
  return relationshipId.startsWith(prefix) ? relationshipId.slice(prefix.length) : relationshipId;
}

function poolVolume(pool: GeckoTerminalPool): number | null {
  return finiteNumber(pool.attributes?.volume_usd?.h24);
}

function poolLiquidity(pool: GeckoTerminalPool): number | null {
  return finiteNumber(pool.attributes?.reserve_in_usd);
}

function poolTransactions(pool: GeckoTerminalPool, field: "buys" | "sells"): number | null {
  return finiteNumber(pool.attributes?.transactions?.h24?.[field]);
}

function aggregate(pools: GeckoTerminalPool[], read: (pool: GeckoTerminalPool) => number | null): number | null {
  const values = pools.map(read).filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function comparePools(a: GeckoTerminalPool, b: GeckoTerminalPool): number {
  const aLiquidity = poolLiquidity(a) ?? -1;
  const bLiquidity = poolLiquidity(b) ?? -1;
  if (aLiquidity !== bLiquidity) return bLiquidity - aLiquidity;
  const aVolume = poolVolume(a) ?? -1;
  const bVolume = poolVolume(b) ?? -1;
  if (aVolume !== bVolume) return bVolume - aVolume;
  return (a.attributes?.address ?? "").localeCompare(b.attributes?.address ?? "");
}

function uniqueMatchedPools(asset: GeckoTerminalAsset, pools: GeckoTerminalPool[]): GeckoTerminalPool[] {
  const seen = new Set<string>();
  return pools.filter((pool) => {
    const address = pool.attributes?.address;
    if (!address) return false;
    const baseAddress = relationshipAddress(asset.gtNetworkId, pool.relationships?.base_token?.data?.id);
    const quoteAddress = relationshipAddress(asset.gtNetworkId, pool.relationships?.quote_token?.data?.id);
    const tokenMatches =
      addressEquals(asset.gtNetworkId, baseAddress, asset.tokenAddress) ||
      addressEquals(asset.gtNetworkId, quoteAddress, asset.tokenAddress);
    if (!tokenMatches || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

function isBasePool(asset: GeckoTerminalAsset, pool: GeckoTerminalPool): boolean {
  const baseAddress = relationshipAddress(asset.gtNetworkId, pool.relationships?.base_token?.data?.id);
  return addressEquals(asset.gtNetworkId, baseAddress, asset.tokenAddress);
}

function observation(
  asset: GeckoTerminalAsset,
  metricId: string,
  value: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  windowDays: number | null = null,
  note = GECKO_TERMINAL_METRIC_NOTE,
): NormalizedObservation {
  const normalized = finiteNumber(value);
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: normalized,
    status: normalized === null ? "unavailable" : "available",
    observedAt,
    collectedAt,
    windowDays,
    // DEX pool/market data for an exact token address, same scope as DEX Screener.
    scope: "market",
    sourceField,
    note: normalized === null ? `${note} Provider field was absent or non-numeric.` : note,
  };
}

function poolMapping(asset: GeckoTerminalAsset, pool: GeckoTerminalPool, collectedAt: string): ProviderPairMapping {
  const createdAt = pool.attributes?.pool_created_at ?? null;
  return {
    tokenId: asset.tokenId,
    providerChainId: asset.gtNetworkId,
    chainId: asset.chainId,
    tokenAddress: asset.tokenAddress,
    pairAddress: pool.attributes?.address ?? "",
    dexId: pool.relationships?.dex?.data?.id ?? null,
    pairUrl: null,
    baseTokenAddress: relationshipAddress(asset.gtNetworkId, pool.relationships?.base_token?.data?.id),
    quoteTokenAddress: relationshipAddress(asset.gtNetworkId, pool.relationships?.quote_token?.data?.id),
    pairCreatedAt: createdAt ? new Date(createdAt).toISOString() : null,
    lastSeenAt: collectedAt,
  };
}

/** Choose the exact token-base pool by liquidity, then volume, then stable address order. */
export function selectPrimaryPool(asset: GeckoTerminalAsset, pools: GeckoTerminalPool[]): GeckoTerminalPool | null {
  const matched = uniqueMatchedPools(asset, pools);
  const basePools = matched.filter((pool) => isBasePool(asset, pool));
  return [...(basePools.length > 0 ? basePools : matched)].sort(comparePools)[0] ?? null;
}

/**
 * What is stored in raw_provider_records.payload for each matched pool. The full pool (~1.9 KB
 * uncompressed, up to ~20 per token) made this the largest payload in that table: ~26 MB of the
 * database for a two-day buffer. The only reader of a stored GeckoTerminal payload is
 * readGeckoTerminalPools in src/lib/data/live-data.ts, which matches pools by `address` and reads
 * `reserve_in_usd`, `volume_usd.h24` and `token_price_usd`. Every metric and every provider_pairs row
 * is computed from the full response in memory before this is stored, so nothing else is needed.
 * `id`, `name` and `pool_created_at` stay as cheap identity/debug context.
 */
export function storedGeckoTerminalPool(pool: GeckoTerminalPool): Record<string, unknown> {
  const attributes = pool.attributes ?? {};
  return {
    id: pool.id ?? null,
    attributes: {
      address: attributes.address ?? null,
      name: attributes.name ?? null,
      pool_created_at: attributes.pool_created_at ?? null,
      reserve_in_usd: attributes.reserve_in_usd ?? null,
      token_price_usd: attributes.token_price_usd ?? null,
      volume_usd: { h24: attributes.volume_usd?.h24 ?? null },
    },
  };
}

export function normalizeGeckoTerminalToken(
  asset: GeckoTerminalAsset,
  providerPools: GeckoTerminalPool[],
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const matchedPools = uniqueMatchedPools(asset, providerPools);
  const basePools = matchedPools.filter((pool) => isBasePool(asset, pool));
  const primaryPool = selectPrimaryPool(asset, matchedPools);
  const primaryBasePool = primaryPool && isBasePool(asset, primaryPool) ? primaryPool : basePools[0] ?? null;
  const observedAt = collectedAt;
  const aggregateNote = matchedPools.length > 0
    ? `${GECKO_TERMINAL_METRIC_NOTE} Volume and transaction counts aggregate numeric values from ${matchedPools.length} exact-address pool(s); absent pool fields are excluded. Primary pool is selected by highest USD liquidity, then 24-hour volume, then pool address.`
    : GECKO_TERMINAL_METRIC_NOTE;
  const buyCount = aggregate(matchedPools, (pool) => poolTransactions(pool, "buys"));
  const sellCount = aggregate(matchedPools, (pool) => poolTransactions(pool, "sells"));
  const totalTxCount = buyCount === null || sellCount === null ? null : buyCount + sellCount;
  const observations = [
    observation(asset, "price_usd", primaryBasePool?.attributes?.token_price_usd, "primaryPool.attributes.token_price_usd", observedAt, collectedAt, null, primaryBasePool ? aggregateNote : `${aggregateNote} No exact-address base-token pool was available; pool price is not inverted.`),
    observation(asset, "volume_24h_usd", aggregate(matchedPools, poolVolume), "pools[].attributes.volume_usd.h24", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "liquidity_usd", primaryPool?.attributes?.reserve_in_usd, "primaryPool.attributes.reserve_in_usd", observedAt, collectedAt, null, aggregateNote),
    observation(asset, "price_change_24h_pct", primaryBasePool?.attributes?.price_change_percentage?.h24, "primaryPool.attributes.price_change_percentage.h24", observedAt, collectedAt, 1, primaryBasePool ? aggregateNote : `${aggregateNote} No exact-address base-token pool was available.`),
    observation(asset, "transactions_24h_count", totalTxCount, "sum(pools[].attributes.transactions.h24.buys+sells)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "buys_24h_count", buyCount, "sum(pools[].attributes.transactions.h24.buys)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "sells_24h_count", sellCount, "sum(pools[].attributes.transactions.h24.sells)", observedAt, collectedAt, 1, aggregateNote),
    observation(asset, "fdv_usd", primaryBasePool?.attributes?.fdv_usd, "primaryPool.attributes.fdv_usd", observedAt, collectedAt, null, aggregateNote),
    observation(asset, "market_cap_usd", primaryBasePool?.attributes?.market_cap_usd, "primaryPool.attributes.market_cap_usd", observedAt, collectedAt, null, aggregateNote),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: "GET /networks/{network}/tokens/{address}/pools",
    asset,
    observedAt,
    collectedAt,
    rawPayload: {
      requestedNetworkId: asset.gtNetworkId,
      requestedTokenAddress: asset.tokenAddress,
      identityNote: asset.identityNote,
      selection: "All exact network/address pool matches retained (page 1); primary base-token pool selected by USD liquidity descending, 24-hour volume descending, then pool address ascending.",
      providerPools: matchedPools.map(storedGeckoTerminalPool),
    },
    observations,
    providerPairs: matchedPools.map((pool) => poolMapping(asset, pool, collectedAt)),
  };
}

function retryAfterMs(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallback;
}

/**
 * `deadlineAt`/`now` are optional and only used by the scheduled collector (see
 * `fetchGeckoTerminalSnapshotsTolerant`); the manual, all-or-nothing sync path
 * (`GeckoTerminalMarketDataProvider.fetchSnapshots`) never passes them, so its
 * behavior — a fixed 20 s timeout per attempt, unconstrained retry/backoff sleeps —
 * is unchanged. When a deadline is supplied:
 *   - each attempt's own HTTP timeout is capped at `min(20_000, deadlineAt - now())`,
 *     never longer than the existing 20 s ceiling;
 *   - a token with no meaningful time left before even starting an attempt, or whose
 *     next planned retry/429-cooldown sleep would itself cross `deadlineAt`, throws
 *     `GeckoTerminalTimeBudgetExceededError` instead of attempting or sleeping — the
 *     caller classifies this as a time-budget cutoff, never an ordinary failure.
 */
async function getPools(
  network: string,
  address: string,
  options: { fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>; now?: () => Date; deadlineAt?: number },
): Promise<GeckoTerminalPool[]> {
  const now = options.now ?? (() => new Date());
  const url = new URL(`networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(address)}/pools`, BASE_URL);
  url.searchParams.set("page", "1");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = options.deadlineAt !== undefined ? options.deadlineAt - now().getTime() : null;
    if (remainingMs !== null && remainingMs <= 0) throw new GeckoTerminalTimeBudgetExceededError();
    const timeoutMs = remainingMs !== null ? Math.min(20_000, remainingMs) : 20_000;
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new GeckoTerminalApiError("GeckoTerminal request failed due to a network error.", null);
      const backoffMs = 500 * 2 ** (attempt - 1);
      if (options.deadlineAt !== undefined && now().getTime() + backoffMs >= options.deadlineAt) throw new GeckoTerminalTimeBudgetExceededError();
      await options.sleep(backoffMs);
      continue;
    }
    if (response.ok) {
      const payload: unknown = await response.json();
      const data = (payload as { data?: unknown })?.data;
      if (!Array.isArray(data)) throw new GeckoTerminalApiError("GeckoTerminal returned an unexpected pool response.", response.status);
      return data as GeckoTerminalPool[];
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new GeckoTerminalApiError(`GeckoTerminal returned HTTP ${response.status}.`, response.status);
    }
    const fallback = 500 * 2 ** (attempt - 1);
    const plannedSleepMs = response.status === 429
      ? Math.max(retryAfterMs(response.headers.get("retry-after"), fallback), RATE_LIMIT_COOLDOWN_FLOOR_MS)
      : fallback;
    if (options.deadlineAt !== undefined && now().getTime() + plannedSleepMs >= options.deadlineAt) throw new GeckoTerminalTimeBudgetExceededError();
    await options.sleep(plannedSleepMs);
  }
  throw new GeckoTerminalApiError("GeckoTerminal request exhausted its retry limit.", null);
}

export function configuredGeckoTerminalAssets(): GeckoTerminalAsset[] {
  return geckoTerminalTokenMappings.flatMap((mapping) =>
    mapping.gtNetworkId && mapping.tokenAddress
      ? [{
          tokenId: mapping.tokenId,
          chainId: mapping.canonicalChainId,
          externalAssetId: `${mapping.gtNetworkId}:${mapping.tokenAddress}`,
          gtNetworkId: mapping.gtNetworkId,
          tokenAddress: mapping.tokenAddress,
          identityNote: mapping.identityNote,
        }]
      : [],
  );
}

export class GeckoTerminalMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private readonly options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  };

  constructor(options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}) {
    this.options = options;
  }

  async fetchSnapshots(assets: ProviderAsset[] = configuredGeckoTerminalAssets()): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = this.options.now ?? (() => new Date());
    const configuredByToken = new Map(configuredGeckoTerminalAssets().map((asset) => [asset.tokenId, asset]));
    const requested = assets.map((asset) => {
      const configured = configuredByToken.get(asset.tokenId);
      if (!configured || configured.chainId !== asset.chainId || configured.externalAssetId !== asset.externalAssetId) {
        throw new Error(`No exact GeckoTerminal address mapping exists for canonical token ${asset.tokenId}.`);
      }
      return configured;
    });

    // No multi-address batch endpoint exists for pools-by-token, so every asset
    // is one request, paced to stay within the conservative ~10 requests/minute budget.
    const results = new Map<string, GeckoTerminalPool[]>();
    for (let index = 0; index < requested.length; index += 1) {
      if (index > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
      const asset = requested[index];
      const pools = await getPools(asset.gtNetworkId, asset.tokenAddress, { fetchImpl, sleep });
      results.set(asset.tokenId, pools);
    }

    return requested.map((asset) => normalizeGeckoTerminalToken(asset, results.get(asset.tokenId) ?? [], now().toISOString()));
  }
}

export function getUnmappedGeckoTerminalTokens() {
  return geckoTerminalTokenMappings
    .filter((mapping) => !mapping.gtNetworkId || !mapping.tokenAddress)
    .map(({ tokenId, unmappedReason }) => ({ tokenId, reason: unmappedReason ?? "No explicit address mapping." }));
}

function resolveConfiguredAssets(assets: ProviderAsset[]): GeckoTerminalAsset[] {
  const configuredByToken = new Map(configuredGeckoTerminalAssets().map((asset) => [asset.tokenId, asset]));
  return assets.map((asset) => {
    const configured = configuredByToken.get(asset.tokenId);
    if (!configured || configured.chainId !== asset.chainId || configured.externalAssetId !== asset.externalAssetId) {
      throw new Error(`No exact GeckoTerminal address mapping exists for canonical token ${asset.tokenId}.`);
    }
    return configured;
  });
}

/** Wraps a fetch implementation to count requests and detect 429s, without touching getPools' own retry logic. */
function observingFetch(base: typeof fetch, stats: { requests: number; rateLimited: boolean }): typeof fetch {
  return async (input, init) => {
    stats.requests += 1;
    const response = await base(input, init);
    if (response.status === 429) stats.rateLimited = true;
    return response;
  };
}

export type GeckoTerminalCollectionOutcome = {
  tokenId: string;
  status: "succeeded" | "failed" | "skipped_time_budget";
  error?: string;
  /** Total HTTP requests made for this token, including retries (0 when skipped). */
  attempts: number;
  rateLimited: boolean;
};

export type GeckoTerminalTolerantResult = {
  snapshots: ProviderSnapshot[];
  outcomes: GeckoTerminalCollectionOutcome[];
  /**
   * The token id the *next* run should start from, so successive scheduled
   * runs rotate through the universe instead of always restarting at index 0
   * (which would starve later tokens whenever a run doesn't fit everyone
   * inside its time budget). Advances past every token this run *attempted*
   * (succeeded or failed), never past a token skipped only for lack of time,
   * so a skipped tail is exactly where the next run resumes. `null` when the
   * asset list is empty.
   */
  nextTokenId: string | null;
};

/**
 * Like `GeckoTerminalMarketDataProvider.fetchSnapshots`, but tolerant of
 * per-token failure and of a wall-clock deadline: one token failing (or the
 * deadline passing) never discards snapshots already collected for other
 * tokens. Used only by the scheduled/recurring collection path — the manual
 * `pnpm geckoterminal:sync` script keeps using the strict, all-or-nothing
 * `fetchSnapshots` above, unchanged.
 *
 * Pacing and retry/backoff (including the 429 cooldown floor) are exactly the
 * same as `fetchSnapshots`; `minRequestIntervalMs` may only raise the pacing
 * above `MIN_REQUEST_INTERVAL_MS`, never lower it, so scheduling can be made
 * more conservative but never weaker.
 *
 * `startTokenId` rotates the processing order to begin at that token (wrapping
 * around the end of the list), instead of always starting at index 0. This is
 * what lets successive scheduled runs make fair progress across the whole
 * universe instead of only ever reaching the first tokens that fit inside one
 * run's time budget. An unknown or omitted `startTokenId` starts at index 0,
 * same as before this option existed.
 */
export async function fetchGeckoTerminalSnapshotsTolerant(
  assets: ProviderAsset[] = configuredGeckoTerminalAssets(),
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    /** Epoch ms after which no further tokens are attempted; already-collected snapshots are still returned. */
    deadlineAt?: number;
    minRequestIntervalMs?: number;
    /** Token id to start this run's rotation from; unknown/omitted means start at index 0. */
    startTokenId?: string | null;
    /**
     * Called roughly every `heartbeatIntervalMs` while tokens are still being
     * processed, so a long-running scheduled collection can renew its DB lock
     * lease (see geckoterminal-sync-lock.ts) instead of relying solely on the
     * lease set once at acquire time. If it resolves `false`, ownership of the
     * run has been reclaimed by another invocation (this one's lease expired):
     * every remaining token is then treated the same as a deadline cutoff —
     * skipped, not attempted, and left for the next run's rotation — so this
     * invocation stops starting new work the moment it learns it is no longer
     * the owner, rather than continuing to fetch/collect on a run it no longer
     * controls.
     */
    onHeartbeat?: () => Promise<boolean>;
    heartbeatIntervalMs?: number;
  } = {},
): Promise<GeckoTerminalTolerantResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const requestInterval = Math.max(MIN_REQUEST_INTERVAL_MS, options.minRequestIntervalMs ?? 0);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  const requested = resolveConfiguredAssets(assets);
  const startIndex = options.startTokenId
    ? Math.max(0, requested.findIndex((asset) => asset.tokenId === options.startTokenId))
    : 0;
  const rotated = startIndex > 0 ? [...requested.slice(startIndex), ...requested.slice(0, startIndex)] : requested;

  const snapshots: ProviderSnapshot[] = [];
  const outcomes: GeckoTerminalCollectionOutcome[] = [];
  // Only calls now() up front when a heartbeat is actually configured, so
  // callers with no onHeartbeat (every existing caller) see no behavior change
  // at all — including tests whose `now` is a stateful call counter.
  let lastHeartbeatAt = options.onHeartbeat ? now().getTime() : 0;
  let ownershipLost = false;
  for (let index = 0; index < rotated.length; index += 1) {
    const asset = rotated[index];
    if (ownershipLost || (options.deadlineAt !== undefined && now().getTime() >= options.deadlineAt)) {
      outcomes.push({ tokenId: asset.tokenId, status: "skipped_time_budget", attempts: 0, rateLimited: false });
      continue;
    }
    if (options.onHeartbeat && now().getTime() - lastHeartbeatAt >= heartbeatIntervalMs) {
      lastHeartbeatAt = now().getTime();
      if (!(await options.onHeartbeat())) {
        // Lost the lock lease mid-run: stop starting new token work immediately
        // (this iteration's token is skipped, same as every one after it), but
        // still return whatever was already collected and persisted.
        ownershipLost = true;
        outcomes.push({ tokenId: asset.tokenId, status: "skipped_time_budget", attempts: 0, rateLimited: false });
        continue;
      }
    }
    if (index > 0) await sleep(requestInterval);
    const stats = { requests: 0, rateLimited: false };
    try {
      const pools = await getPools(asset.gtNetworkId, asset.tokenAddress, {
        fetchImpl: observingFetch(fetchImpl, stats), sleep, now, deadlineAt: options.deadlineAt,
      });
      snapshots.push(normalizeGeckoTerminalToken(asset, pools, now().toISOString()));
      outcomes.push({ tokenId: asset.tokenId, status: "succeeded", attempts: stats.requests, rateLimited: stats.rateLimited });
    } catch (error) {
      // A deadline cutoff mid-token (an in-flight attempt or retry sleep that would have
      // crossed deadlineAt) is a time-budget cutoff, never an ordinary provider failure:
      // it must not advance the rotation cursor past this token (see nextTokenId below).
      if (error instanceof GeckoTerminalTimeBudgetExceededError) {
        outcomes.push({ tokenId: asset.tokenId, status: "skipped_time_budget", attempts: stats.requests, rateLimited: stats.rateLimited });
        continue;
      }
      outcomes.push({
        tokenId: asset.tokenId,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error.",
        attempts: stats.requests,
        rateLimited: stats.rateLimited,
      });
    }
  }
  // Advance past every token actually attempted this run (succeeded or failed),
  // never past one only skipped for lack of time — so a partial run resumes
  // exactly where it left off, and modulo wraps back to the start once a full
  // cycle of the universe completes.
  const attemptedCount = outcomes.filter((outcome) => outcome.status !== "skipped_time_budget").length;
  const nextTokenId = rotated.length > 0 ? rotated[attemptedCount % rotated.length].tokenId : null;
  return { snapshots, outcomes, nextTokenId };
}

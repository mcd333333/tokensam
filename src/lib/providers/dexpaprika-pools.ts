/**
 * On-chain DEX pools for one exact token address, from DexPaprika's pool search
 * (`GET /networks/{network}/pools/search?token_address=...`, up to 100 most-liquid pools per token, one request each).
 *
 * This replaced DEX Screener's `/token-pairs` and GeckoTerminal as the pool source: both answered HTTP 429 to most
 * requests from Cloudflare's shared outbound addresses. DexPaprika meters by API key, not just by address:
 * a free key allows 30 requests/minute and 100,000 credits per rolling 30 days; with no key it is 15 requests/minute
 * and the first page only (which is all this needs). The key goes in the `Authorization` header as the bare value, on
 * api.dexpaprika.com (paid plans use a different host). Set DEXPAPRIKA_API_KEY as a Worker secret; it is optional.
 */

const BASE_URL = "https://api.dexpaprika.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** Pools kept per token, most liquid first: the search's page-size maximum, so one request per token and it works keyless. */
export const MAX_POOLS_PER_TOKEN = 100;
/** Minimum spacing between requests (30/minute with a key; the keyless 15/minute is slower and still served by retries). */
export const DEX_POOL_REQUEST_INTERVAL_MS = 2_500;
/** Pause after a 429 before the collector moves on to the next token. */
export const DEX_POOL_RATE_LIMIT_COOLDOWN_MS = 8_000;

/** Our DEX chain ids that DexPaprika names differently. Chains DexPaprika does not index are skipped by the collector. */
const NETWORK_ALIASES: Record<string, string> = { hyperliquid: "hyperevm" };
const UNSUPPORTED_CHAINS = new Set(["icp"]);

export function dexPaprikaNetwork(chainId: string): string | null {
  if (UNSUPPORTED_CHAINS.has(chainId)) return null;
  return NETWORK_ALIASES[chainId] ?? chainId;
}

/**
 * The token address in the form DexPaprika indexes. Sui coin types are stored with the shortened package id
 * ("0x2::sui::SUI"), but DexPaprika only matches the full 64-hex form, so the package id is zero-padded.
 */
export function dexPaprikaAddress(network: string, tokenAddress: string): string {
  if (network !== "sui") return tokenAddress;
  const match = /^0x([0-9a-fA-F]{1,63})(::.+)$/.exec(tokenAddress);
  return match ? `0x${match[1].padStart(64, "0")}${match[2]}` : tokenAddress;
}

export type DexPool = {
  pairAddress: string;
  /** DexPaprika's dex id, which carries the version, e.g. "uniswap_v3". */
  dexId: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  /** DexPaprika's pool search carries no FDV or market cap, so these stay null and their cards are not shown. */
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** ISO time the pool was created, when reported. */
  createdAt: string | null;
};

export class DexPoolApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DexPoolApiError";
    this.status = status;
  }
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

type RawPool = {
  id?: string;
  dex_id?: string | null;
  liquidity_usd?: unknown;
  volume_usd_24h?: unknown;
  price_usd?: unknown;
  price_change_percentage_24h?: unknown;
  created_at?: string | null;
};

/** Pools in the search response, deduplicated by address, most liquid first, capped. The search is already filtered to the token. */
export function normalizeDexPools(payload: unknown): DexPool[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const pools: DexPool[] = [];
  for (const raw of results as RawPool[]) {
    if (!raw?.id || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const created = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
    pools.push({
      pairAddress: raw.id,
      dexId: typeof raw.dex_id === "string" && raw.dex_id ? raw.dex_id : null,
      liquidityUsd: finite(raw.liquidity_usd),
      volume24hUsd: finite(raw.volume_usd_24h),
      priceUsd: finite(raw.price_usd),
      priceChange24hPct: finite(raw.price_change_percentage_24h),
      fdvUsd: null,
      marketCapUsd: null,
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
    });
  }
  return pools
    .sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)
      || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)
      || a.pairAddress.localeCompare(b.pairAddress))
    .slice(0, MAX_POOLS_PER_TOKEN);
}

/**
 * One request with a single retry on 429/5xx. Throws DexPoolApiError; response bodies are never surfaced.
 * A 402 means the plan's credits are exhausted: retrying will not help, so it is not retried.
 */
export async function fetchDexPools(
  network: string,
  tokenAddress: string,
  options: { apiKey?: string | null; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DexPool[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const apiKey = options.apiKey ?? process.env.DEXPAPRIKA_API_KEY?.trim();
  const url = new URL(`${BASE_URL}/networks/${encodeURIComponent(network)}/pools/search`);
  url.searchParams.set("token_address", tokenAddress);
  url.searchParams.set("order_by", "liquidity_usd");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("limit", String(MAX_POOLS_PER_TOKEN));
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = apiKey;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      if (attempt === 2) throw new DexPoolApiError("DexPaprika pools request failed due to a network error.", null);
      await sleep(1_000);
      continue;
    }
    if (response.ok) return normalizeDexPools(await response.json());
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new DexPoolApiError(`DexPaprika pools returned HTTP ${response.status}.`, response.status);
    await sleep(response.status === 429 ? 3_000 : 1_000);
  }
  throw new DexPoolApiError("DexPaprika pools request exhausted its retry limit.", null);
}

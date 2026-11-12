import { addressEquals, type DexScreenerPair } from "./dexscreener.ts";

/**
 * On-chain DEX pools for one exact token address, from DEX Screener's `GET /token-pairs/v1/{chainId}/{address}`
 * (up to 30 pools per token, one request each). The batch `/tokens/v1` endpoint used by the main refresh returns
 * a single pair per token, so it cannot fill a pool list.
 *
 * This replaced GeckoTerminal as the pool source: GeckoTerminal throttles Cloudflare's shared outbound addresses
 * (HTTP 429 on about 85% of requests), while DEX Screener's 300 requests/minute limit is not shared that way.
 */

const BASE_URL = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "tokensam/1.0 (dex pools; +https://github.com/dm999999-ctrl/tokensam)";
/** Pools kept per token, most liquid first. */
export const MAX_POOLS_PER_TOKEN = 30;
/** Minimum spacing between requests (the limit is 300/minute). */
export const DEX_POOL_REQUEST_INTERVAL_MS = 300;

export type DexPool = {
  pairAddress: string;
  /** DEX Screener's dex id with its version label when it has one, e.g. "uniswap_v3". */
  dexId: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** ISO time the pool was created, when DEX Screener reports it. */
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

type RawPair = DexScreenerPair & { labels?: string[] | null };

/**
 * Exact-address pools only: the pair must be on the requested chain and have the token as its base or quote token.
 * Duplicate pair addresses are dropped; pools are ordered by liquidity, then volume, then address, and capped.
 */
export function normalizeDexPools(chainId: string, tokenAddress: string, pairs: unknown): DexPool[] {
  if (!Array.isArray(pairs)) return [];
  const seen = new Set<string>();
  const pools: DexPool[] = [];
  for (const pair of pairs as RawPair[]) {
    if (!pair?.pairAddress || pair.chainId !== chainId || seen.has(pair.pairAddress)) continue;
    const matches = addressEquals(chainId, pair.baseToken?.address, tokenAddress)
      || addressEquals(chainId, pair.quoteToken?.address, tokenAddress);
    if (!matches) continue;
    seen.add(pair.pairAddress);
    const created = finite(pair.pairCreatedAt);
    const label = Array.isArray(pair.labels) && typeof pair.labels[0] === "string" ? pair.labels[0].toLowerCase() : null;
    pools.push({
      pairAddress: pair.pairAddress,
      dexId: pair.dexId ? (label ? `${pair.dexId}_${label}` : pair.dexId) : null,
      liquidityUsd: finite(pair.liquidity?.usd),
      volume24hUsd: finite(pair.volume?.h24),
      priceUsd: finite(pair.priceUsd),
      priceChange24hPct: finite(pair.priceChange?.h24),
      fdvUsd: finite(pair.fdv),
      marketCapUsd: finite(pair.marketCap),
      createdAt: created !== null && created > 0 ? new Date(created).toISOString() : null,
    });
  }
  return pools
    .sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)
      || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)
      || a.pairAddress.localeCompare(b.pairAddress))
    .slice(0, MAX_POOLS_PER_TOKEN);
}

/** One request with a single retry on 429/5xx. Throws DexPoolApiError; the response body is never surfaced. */
export async function fetchDexPools(
  chainId: string,
  tokenAddress: string,
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DexPool[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${BASE_URL}/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === 2) throw new DexPoolApiError("DEX Screener pools request failed due to a network error.", null);
      await sleep(1_000);
      continue;
    }
    if (response.ok) return normalizeDexPools(chainId, tokenAddress, await response.json());
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new DexPoolApiError(`DEX Screener pools returned HTTP ${response.status}.`, response.status);
    await sleep(response.status === 429 ? 2_000 : 1_000);
  }
  throw new DexPoolApiError("DEX Screener pools request exhausted its retry limit.", null);
}

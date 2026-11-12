/**
 * On-chain DEX pools for one exact token address, from DexPaprika's pool search
 * (`GET /networks/{network}/pools/search?token_address=...`, up to 100 most-liquid pools per token, one request each).
 *
 * This replaced the earlier DEX pair source's `/token-pairs` and GeckoTerminal as the pool source: both answered HTTP 429 to most
 * requests from Cloudflare's shared outbound addresses. DexPaprika meters by API key, not just by address:
 * a free key allows 30 requests/minute and 100,000 credits per rolling 30 days; with no key it is 15 requests/minute
 * and the first page only (which is all this needs). The key goes in the `Authorization` header as the bare value, on
 * api.dexpaprika.com (paid plans use a different host). Set DEXPAPRIKA_API_KEY as a Worker secret; it is optional.
 */

const BASE_URL = "https://api.dexpaprika.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** Pools kept per token, most liquid first: the search's page-size maximum, so one request per token and it works keyless. */
import { isPlausibleDexValue } from "./dex-sanity.ts";
import { quoteLabel } from "../../data/dex-quote-tokens.ts";

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
  /** Display name of the DEX, e.g. "Uniswap V3". */
  dexName: string | null;
  /** The pool's other token: a well-known symbol ("WETH") or a shortened address. */
  quote?: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volume7dUsd: number | null;
  volume30dUsd: number | null;
  /** All transactions in the pool over 24 hours. */
  transactions24h: number | null;
  priceUsd: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  priceChange6hPct: number | null;
  priceChange24hPct: number | null;
  priceChange48hPct: number | null;
  /** The pool's swap fee as a fraction of the trade (DexPaprika reports it in percent; null when absent). */
  fee: number | null;
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
  dex_name?: string | null;
  liquidity_usd?: unknown;
  volume_usd_24h?: unknown;
  volume_usd_7d?: unknown;
  volume_usd_30d?: unknown;
  transactions_24h?: unknown;
  price_usd?: unknown;
  price_change_percentage_5m?: unknown;
  price_change_percentage_1h?: unknown;
  price_change_percentage_6h?: unknown;
  price_change_percentage_24h?: unknown;
  price_change_percentage_48h?: unknown;
  fee?: unknown;
  created_at?: string | null;
  tokens?: { id?: unknown }[] | null;
};

/** Pools in the search response, deduplicated by address, most liquid first, capped. The search is already filtered to the token. */
/** The pool's token that is not the requested one, labelled for display; null when it cannot be told. */
function quoteOf(raw: RawPool, context: { network?: string; tokenAddress?: string }): string | null {
  if (!context.network || !context.tokenAddress || !Array.isArray(raw.tokens)) return null;
  const self = context.tokenAddress.toLowerCase();
  const other = raw.tokens.map((token) => (typeof token?.id === "string" ? token.id : null)).find((id): id is string => id !== null && id.toLowerCase() !== self);
  return other ? quoteLabel(context.network, other) : null;
}

/** A per-pool figure when plausible, else null (see dex-sanity.ts). */
function sane(kind: "usd" | "count" | "price" | "change_pct", value: number | null): number | null {
  return value !== null && isPlausibleDexValue(kind, value) ? value : null;
}

export function normalizeDexPools(payload: unknown, context: { network?: string; tokenAddress?: string } = {}): DexPool[] {
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
      dexName: typeof raw.dex_name === "string" && raw.dex_name ? raw.dex_name : null,
      quote: quoteOf(raw, context),
      liquidityUsd: sane("usd", finite(raw.liquidity_usd)),
      volume24hUsd: sane("usd", finite(raw.volume_usd_24h)),
      volume7dUsd: sane("usd", finite(raw.volume_usd_7d)),
      volume30dUsd: sane("usd", finite(raw.volume_usd_30d)),
      transactions24h: sane("count", finite(raw.transactions_24h)),
      priceUsd: sane("price", finite(raw.price_usd)),
      priceChange5mPct: sane("change_pct", finite(raw.price_change_percentage_5m)),
      priceChange1hPct: sane("change_pct", finite(raw.price_change_percentage_1h)),
      priceChange6hPct: sane("change_pct", finite(raw.price_change_percentage_6h)),
      priceChange24hPct: sane("change_pct", finite(raw.price_change_percentage_24h)),
      priceChange48hPct: sane("change_pct", finite(raw.price_change_percentage_48h)),
      fee: finite(raw.fee),
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
    if (response.ok) return normalizeDexPools(await response.json(), { network, tokenAddress });
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new DexPoolApiError(`DexPaprika pools returned HTTP ${response.status} (key: ${apiKey ? "sent" : "none"}${rateHeaders(response)}).`, response.status);
    await sleep(response.status === 429 ? 3_000 : 1_000);
  }
  throw new DexPoolApiError("DexPaprika pools request exhausted its retry limit.", null);
}

/** Rate-limit headers only (never a response body), so a throttle can be told apart from an exhausted allowance. */
export function rateHeaders(response: Response): string {
  const parts = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset"]
    .map((name) => [name, response.headers.get(name)] as const)
    .filter(([, value]) => value !== null && /^[\w.:-]{1,40}$/.test(value as string))
    .map(([name, value]) => `${name}=${value}`);
  return parts.length ? `, ${parts.join(" ")}` : "";
}

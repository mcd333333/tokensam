import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderSnapshot,
} from "./types.ts";
import type { CollectorDiagnostics } from "../refresh/collector-diagnostics.ts";

const PROVIDER_ID = "coingecko";
const ENDPOINT_LABEL = "GET /coins/markets";
// A single request for this project's ~238 tokens (all fitting under the 250/request API
// limit) produces a multi-thousand-character URL that an AWS CloudFront WAF in front of
// CoinGecko's /coins/markets started rejecting outright with a CloudFront-branded 403 —
// confirmed by testing the identical URL from multiple networks/regions, where only the
// request's size/shape (not its origin) explained the failure. Splitting into smaller
// batches keeps each URL well under whatever length triggered that. This value balances
// that against the Demo plan's ~10,000 calls/month quota (see REFRESH_POLICY's quota notes
// in config.ts): at the current 15-min cadence and 238 tokens, 80 keeps this to 3
// calls/run (~8,640/month) — some margin, but revisit both this and quota headroom if the
// token universe grows meaningfully past ~250.
const MAX_IDS_PER_REQUEST = 80;
const MAX_ATTEMPTS = 3;
// A legacy official support article still documents 30 RPM, while the current
// pricing page lists 100 RPM. Stay below the lower published limit.
export const MIN_REQUEST_INTERVAL_MS = 2_100;

type CoinGeckoPlan = "demo" | "pro";

type CoinGeckoMarketItem = {
  id: string;
  last_updated?: string | null;
  current_price?: number | null;
  market_cap?: number | null;
  total_volume?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  circulating_supply?: number | null;
  total_supply?: number | null;
  max_supply?: number | null;
};

export class CoinGeckoApiError extends Error {
  readonly status: number | null;

  constructor(
    message: string,
    status: number | null,
  ) {
    super(message);
    this.name = "CoinGeckoApiError";
    this.status = status;
  }
}

export function getCoinGeckoConfig(
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; plan: CoinGeckoPlan; baseUrl: string; keyHeader: string } {
  const plan = (env.COINGECKO_API_PLAN?.trim().toLowerCase() || "demo") as CoinGeckoPlan;
  if (plan !== "demo" && plan !== "pro") {
    throw new Error("COINGECKO_API_PLAN must be either demo or pro.");
  }

  // Optional: route through the Cloudflare Worker's /coingecko-proxy instead of calling
  // CoinGecko directly. CoinGecko started rejecting requests from Vercel's shared AWS Lambda
  // IP range with 403 for this project (the key itself works fine from any other network —
  // confirmed directly against api.coingecko.com), so this gives CoinGecko calls a different
  // egress path through Cloudflare's network instead. The Worker holds the real CoinGecko key
  // as its own secret; this deployment only needs CRON_SECRET, which it already has, to
  // authenticate to the Worker's proxy route.
  const proxyUrl = env.COINGECKO_PROXY_URL?.trim().replace(/\/$/, "");
  // TEMPORARY diagnostic logging for the "still hitting CoinGecko directly" investigation.
  // Logs only whether the proxy env var was seen, never its value or any secret. Remove
  // once confirmed the deployed function actually resolves COINGECKO_PROXY_URL.
  console.log(`[diagnostic] getCoinGeckoConfig: COINGECKO_PROXY_URL is ${proxyUrl ? "set, using proxy" : "unset, calling CoinGecko directly"}`);
  if (proxyUrl) {
    const cronSecret = env.CRON_SECRET?.trim();
    if (!cronSecret) {
      throw new Error("COINGECKO_PROXY_URL is set but CRON_SECRET is missing; the proxy route requires it for auth.");
    }
    return { apiKey: `Bearer ${cronSecret}`, plan, baseUrl: `${proxyUrl}/coingecko-proxy`, keyHeader: "authorization" };
  }

  const apiKey = env.COINGECKO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Set COINGECKO_API_KEY in the ignored root .env.local file.");
  }

  return {
    apiKey,
    plan,
    baseUrl:
      plan === "pro"
        ? "https://pro-api.coingecko.com/api/v3"
        : "https://api.coingecko.com/api/v3",
    keyHeader: plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key",
  };
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallbackMs;
}

async function fetchMarketBatch(
  ids: string[],
  options: {
    apiKey: string;
    baseUrl: string;
    keyHeader: string;
    fetchImpl: typeof fetch;
    sleep: (durationMs: number) => Promise<void>;
  },
  // Diagnostic-only: records attempt count/timing/status, never the request/response itself.
  diagnostics?: { batchIndex: number; recorder: CollectorDiagnostics },
): Promise<CoinGeckoMarketItem[]> {
  const url = new URL(`${options.baseUrl}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("price_change_percentage", "24h,7d");
  // CoinGecko now excludes rehypothecated/wrapped assets from /coins/markets by default.
  // WBTC is a deliberate canonical asset in this universe, so request this class explicitly.
  url.searchParams.set("include_rehypothecated", "true");
  url.searchParams.set("per_page", String(MAX_IDS_PER_REQUEST));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptStart = Date.now();
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { [options.keyHeader]: options.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      const willRetry = attempt !== MAX_ATTEMPTS;
      diagnostics?.recorder.recordHttpAttempt({
        batch: diagnostics.batchIndex, attempt, outcome: willRetry ? "retry" : "error",
        durationMs: Date.now() - attemptStart, httpStatus: null,
      });
      if (!willRetry) {
        throw new CoinGeckoApiError("CoinGecko request failed due to a network error.", null);
      }
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      const payload: unknown = await response.json();
      diagnostics?.recorder.recordHttpAttempt({
        batch: diagnostics.batchIndex, attempt, outcome: "ok",
        durationMs: Date.now() - attemptStart, httpStatus: response.status,
      });
      if (!Array.isArray(payload)) {
        throw new CoinGeckoApiError("CoinGecko returned an unexpected market response.", response.status);
      }
      return payload as CoinGeckoMarketItem[];
    }

    const retryable = response.status === 429 || response.status >= 500;
    const willRetry = retryable && attempt !== MAX_ATTEMPTS;
    diagnostics?.recorder.recordHttpAttempt({
      batch: diagnostics.batchIndex, attempt, outcome: willRetry ? "retry" : "error",
      durationMs: Date.now() - attemptStart, httpStatus: response.status,
    });
    if (!willRetry) {
      // Avoid including request URLs or response bodies in errors and logs.
      throw new CoinGeckoApiError(
        `CoinGecko returned HTTP ${response.status}. Check the API plan, key configuration, and usage limits.`,
        response.status,
      );
    }

    const fallbackMs = 500 * 2 ** (attempt - 1);
    await options.sleep(
      response.status === 429
        ? retryAfterMs(response.headers.get("retry-after"), fallbackMs)
        : fallbackMs,
    );
  }

  throw new CoinGeckoApiError("CoinGecko request exhausted its retry limit.", null);
}

function numericObservation(
  asset: ProviderAsset,
  metricId: string,
  rawValue: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  windowDays: number | null = null,
): NormalizedObservation {
  const available = typeof rawValue === "number" && Number.isFinite(rawValue);
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: available ? rawValue : null,
    status: available ? "available" : "unavailable",
    observedAt,
    collectedAt,
    windowDays,
    scope: "token",
    sourceField,
    note: available ? null : "CoinGecko did not return a numeric value for this field.",
  };
}

/**
 * What is stored in raw_provider_records.payload for a /coins/markets item. The full item is ~1 KB
 * compressed and, kept for two days, was ~31 MB of the 500 MB database. The only readers of a stored
 * CoinGecko payload are token logos (id, image) and reported FDV (id, fully_diluted_valuation,
 * current_price) in src/lib/data/live-data.ts; every metric is stored as its own observation.
 * symbol and last_updated stay as cheap identity/debug context.
 */
export const STORED_MARKET_PAYLOAD_FIELDS = ["id", "symbol", "image", "current_price", "fully_diluted_valuation", "last_updated"] as const;

export function storedMarketPayload(item: CoinGeckoMarketItem): Record<string, unknown> {
  const source = item as Record<string, unknown>;
  return Object.fromEntries(STORED_MARKET_PAYLOAD_FIELDS.map((field) => [field, source[field] ?? null]));
}

export function normalizeCoinGeckoMarketItem(
  asset: ProviderAsset,
  item: CoinGeckoMarketItem,
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const validProviderTime = item.last_updated && Number.isFinite(Date.parse(item.last_updated));
  const observedAt = validProviderTime ? new Date(item.last_updated as string).toISOString() : collectedAt;
  const observations = [
    numericObservation(asset, "price_usd", item.current_price, "current_price", observedAt, collectedAt),
    numericObservation(asset, "market_cap_usd", item.market_cap, "market_cap", observedAt, collectedAt),
    numericObservation(asset, "volume_24h_usd", item.total_volume, "total_volume", observedAt, collectedAt),
    numericObservation(
      asset,
      "price_change_24h_pct",
      item.price_change_percentage_24h,
      "price_change_percentage_24h",
      observedAt,
      collectedAt,
      1,
    ),
    numericObservation(
      asset,
      "price_change_7d_pct",
      item.price_change_percentage_7d_in_currency,
      "price_change_percentage_7d_in_currency",
      observedAt,
      collectedAt,
      7,
    ),
    numericObservation(asset, "circulating_supply", item.circulating_supply, "circulating_supply", observedAt, collectedAt),
    numericObservation(asset, "total_supply", item.total_supply, "total_supply", observedAt, collectedAt),
    numericObservation(asset, "maximum_supply", item.max_supply, "max_supply", observedAt, collectedAt),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: ENDPOINT_LABEL,
    asset,
    observedAt,
    collectedAt,
    rawPayload: storedMarketPayload(item),
    observations,
  };
}

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  private readonly options: {
    apiKey: string;
    baseUrl: string;
    keyHeader: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  };

  constructor(
    options: {
      apiKey: string;
      baseUrl: string;
      keyHeader: string;
      fetchImpl?: typeof fetch;
      sleep?: (durationMs: number) => Promise<void>;
      now?: () => Date;
    },
  ) {
    this.options = options;
  }

  /** `diagnostics`, if supplied, only records stage timing/HTTP-attempt metadata (see
   *  collector-diagnostics.ts) — it never changes the returned snapshots or this method's
   *  Promise<ProviderSnapshot[]> contract, so implementing MarketDataProvider still holds. */
  async fetchSnapshots(assets: ProviderAsset[], diagnostics?: CollectorDiagnostics): Promise<ProviderSnapshot[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    const now = this.options.now ?? (() => new Date());
    const uniqueAssets = [...new Map(assets.map((asset) => [asset.externalAssetId, asset])).values()];
    const batches = splitIntoBatches(uniqueAssets, MAX_IDS_PER_REQUEST);
    const snapshots: ProviderSnapshot[] = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      if (batchIndex > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
      const batch = batches[batchIndex];
      const records = await fetchMarketBatch(
        batch.map((asset) => asset.externalAssetId),
        { ...this.options, fetchImpl, sleep },
        diagnostics ? { batchIndex, recorder: diagnostics } : undefined,
      );
      const assetsByExternalId = new Map(batch.map((asset) => [asset.externalAssetId, asset]));
      const collectedAt = now().toISOString();
      diagnostics?.start("coingecko.parseTransform");
      for (const record of records) {
        const asset = assetsByExternalId.get(record.id);
        if (asset) snapshots.push(normalizeCoinGeckoMarketItem(asset, record, collectedAt));
      }
      diagnostics?.end("coingecko.parseTransform");
    }

    return snapshots;
  }
}

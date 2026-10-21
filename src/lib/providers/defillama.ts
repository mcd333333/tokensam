import type {
  MarketDataProvider,
  NormalizedObservation,
  ProviderAsset,
  ProviderSnapshot,
} from "./types.ts";
import { DEFILLAMA_PROTOCOL_METRIC_NOTE } from "../../data/defillama-protocol-mappings.ts";

const PROVIDER_ID = "defillama";
const BASE_URL = "https://api.llama.fi";
const HISTORY_DAYS = 90;
const MAX_ATTEMPTS = 3;
// The public docs only say "Standard" for the free API and publish no numeric
// limit. Keep a single request in flight and pace requests conservatively.
const MIN_REQUEST_INTERVAL_MS = 1_100;
/** Routine requests (/tvl, /summary/fees) return bytes to tens of kilobytes. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * /protocol/{slug} returns a protocol's entire history with per-token and
 * per-chain breakdowns: 0.3-69 MB for the mapped records (measured 2026-09-24),
 * and the 69 MB Curve DEX record took 7-34 s to download. Only the explicit
 * history mode requests it, with a budget sized for that payload.
 */
const HISTORY_REQUEST_TIMEOUT_MS = 90_000;
const FEE_SUMMARY_QUERY = "excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

/** A curated protocol mapping plus the DeFiLlama record ID it was verified against. */
export type DefiLlamaProtocolAsset = ProviderAsset & { recordId: string };

type TvlPoint = { date?: number; totalLiquidityUSD?: number | null };
type ProtocolPayload = {
  id?: string | number;
  name?: string;
  symbol?: string;
  tvl?: TvlPoint[];
  currentChainTvls?: Record<string, number | null>;
};
type FeeSummaryPayload = {
  id?: string | number;
  defillamaId?: string | number;
  slug?: string;
  name?: string;
  total24h?: number | null;
  total48hto24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  childProtocols?: unknown[];
};

/** One provider request, kept so a slow run can be attributed to a specific call. */
export type DefiLlamaRequestTelemetry = { path: string; attempts: number; durationMs: number };

export class DefiLlamaApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "DefiLlamaApiError";
    this.status = status;
  }
}

/** Requires a reference to written approval before any API request can occur. */
export function getDefiLlamaConfig(
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; writtenPermissionReference: string } {
  const writtenPermissionReference = env.DEFILLAMA_WRITTEN_PERMISSION_REFERENCE?.trim();
  if (!writtenPermissionReference) {
    throw new Error(
      "DeFiLlama sync is disabled. Obtain written permission for the intended data use, then set DEFILLAMA_WRITTEN_PERMISSION_REFERENCE in the ignored root .env.local file.",
    );
  }
  return { baseUrl: BASE_URL, writtenPermissionReference };
}

function retryAfterMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const dateMs = Date.parse(value) - Date.now();
  return Number.isFinite(dateMs) ? Math.min(Math.max(dateMs, 0), 30_000) : fallbackMs;
}

async function getJson<T>(
  path: string,
  options: {
    baseUrl: string;
    fetchImpl: typeof fetch;
    sleep: (durationMs: number) => Promise<void>;
    timeoutMs: number;
    /** A 404 means "no such record" for this path: return null instead of failing the run. */
    allowNotFound?: boolean;
  },
): Promise<{ body: T | null; attempts: number }> {
  const url = new URL(path, options.baseUrl);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    // The timeout covers headers and body: a stalled download cannot outlive it.
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      response = await options.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        throw new DefiLlamaApiError("DeFiLlama request failed due to a network error.", null);
      }
      await options.sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      try {
        return { body: (await response.json()) as T, attempts: attempt };
      } catch {
        // Not retried: a body that exceeded its budget once would multiply the run time.
        throw new DefiLlamaApiError(
          signal.aborted
            ? `DeFiLlama response body for ${url.pathname} was not received within ${Math.round(options.timeoutMs / 1000)} s.`
            : `DeFiLlama returned malformed JSON for ${url.pathname}.`,
          response.status,
        );
      }
    }
    if (response.status === 404 && options.allowNotFound) return { body: null, attempts: attempt };
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new DefiLlamaApiError(
        `DeFiLlama returned HTTP ${response.status}. Check availability and the service's current usage terms.`,
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
  throw new DefiLlamaApiError("DeFiLlama request exhausted its retry limit.", null);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function epochSecondsToIso(value: unknown, fallback: string): string {
  if (!isNumber(value) || value <= 0) return fallback;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function recordIdOf(payload: { id?: string | number; defillamaId?: string | number } | null | undefined): string | null {
  const value = payload?.defillamaId ?? payload?.id;
  return value === undefined || value === null ? null : String(value);
}

function observation(
  asset: ProviderAsset,
  metricId: string,
  rawValue: unknown,
  sourceField: string,
  observedAt: string,
  collectedAt: string,
  windowDays: number | null,
  unavailableNote: string,
  timingNote = "",
): NormalizedObservation {
  const available = isNumber(rawValue);
  const note = available ? DEFILLAMA_PROTOCOL_METRIC_NOTE : `${DEFILLAMA_PROTOCOL_METRIC_NOTE} ${unavailableNote}`;
  return {
    tokenId: asset.tokenId,
    chainId: asset.chainId,
    metricId,
    value: available ? rawValue : null,
    status: available ? "available" : "unavailable",
    observedAt,
    collectedAt,
    windowDays,
    // Protocol records: never token-level data.
    scope: "protocol",
    sourceField,
    note: timingNote ? `${note} ${timingNote}` : note,
  };
}

function retainedSummary(summary: FeeSummaryPayload | null) {
  if (!summary) return null;
  return {
    id: summary.id ?? null,
    defillamaId: summary.defillamaId ?? null,
    slug: summary.slug ?? null,
    name: summary.name ?? null,
    total24h: summary.total24h ?? null,
    total48hto24h: summary.total48hto24h ?? null,
    total7d: summary.total7d ?? null,
    total30d: summary.total30d ?? null,
    // A parent record's total aggregates these sub-protocols.
    childProtocols: Array.isArray(summary.childProtocols)
      ? summary.childProtocols
        .map((child) => (typeof child === "string" ? child : (child as { name?: unknown } | null)?.name))
        .filter((name): name is string => typeof name === "string")
      : [],
  };
}

/**
 * Routine protocol snapshot: current TVL plus 24-hour fees and revenue.
 * Every value must come from the verified DeFiLlama record. A summary that
 * resolves to any other record (for example a parent's child protocol) is
 * never substituted, and it also withholds TVL, because the slug no longer
 * resolves to the record the mapping was verified against.
 */
export function normalizeDefiLlamaCurrent(
  asset: DefiLlamaProtocolAsset,
  payload: { tvl: unknown; fees: FeeSummaryPayload | null; revenue: FeeSummaryPayload | null },
  collectedAt = new Date().toISOString(),
): ProviderSnapshot {
  const mismatch = [payload.fees, payload.revenue]
    .map(recordIdOf)
    .find((id) => id !== null && id !== asset.recordId);
  const mismatchNote = mismatch
    ? `DeFiLlama resolved slug "${asset.externalAssetId}" to record "${mismatch}", not the verified record "${asset.recordId}"; values from other records (such as a parent or child protocol) are not substituted.`
    : null;
  const exact = (summary: FeeSummaryPayload | null) => (recordIdOf(summary) === asset.recordId ? summary : null);
  const feeNote = (summary: FeeSummaryPayload | null, kind: "fees" | "revenue") =>
    mismatchNote
      ?? (summary
        ? `DeFiLlama did not return a numeric daily-${kind} total for this exact protocol record.`
        : `DeFiLlama has no daily-${kind} summary for this exact protocol record.`);

  const fees = exact(payload.fees);
  const revenue = exact(payload.revenue);
  const observations = [
    observation(
      asset,
      "tvl_usd",
      mismatchNote ? null : payload.tvl,
      "tvl (GET /tvl/{protocol})",
      collectedAt,
      collectedAt,
      null,
      mismatchNote ?? "DeFiLlama did not return a numeric current TVL for this exact protocol record.",
      "Current value; DeFiLlama returns no timestamp with it, so the observation time is the collection time.",
    ),
    observation(
      asset,
      "fees_24h_usd",
      fees?.total24h,
      "summary.total24h (dataType=dailyFees)",
      collectedAt,
      collectedAt,
      1,
      feeNote(payload.fees, "fees"),
    ),
    observation(
      asset,
      "revenue_24h_usd",
      revenue?.total24h,
      "summary.total24h (dataType=dailyRevenue)",
      collectedAt,
      collectedAt,
      1,
      feeNote(payload.revenue, "revenue"),
    ),
  ];

  return {
    providerId: PROVIDER_ID,
    endpointLabel: "GET /tvl/{protocol}; GET /summary/fees/{protocol}?dataType=dailyFees,dailyRevenue",
    asset,
    observedAt: collectedAt,
    collectedAt,
    rawPayload: {
      recordId: asset.recordId,
      tvl: payload.tvl ?? null,
      dailyFees: retainedSummary(payload.fees),
      dailyRevenue: retainedSummary(payload.revenue),
      retentionNote: "DeFiLlama current TVL and the identity and headline totals of the fees/revenue summaries are retained; charts and unrelated provider fields are omitted.",
    },
    observations,
  };
}

/**
 * History snapshot from /protocol/{slug}: dated TVL points within the 90-day
 * window only (fees and revenue come from the routine path). Returns null when
 * the record is not the verified one or has no usable points, so a history
 * run never writes an "unavailable" row that would mask the current value.
 */
export function dailyHistoryPoints(points: Array<{ date?: number | null; totalLiquidityUSD?: number | null }>): Array<{ date?: number | null; totalLiquidityUSD?: number | null }> {
  const byDay = new Map<string, { date?: number | null; totalLiquidityUSD?: number | null }>();
  for (const point of points) {
    if (!isNumber(point.date) || !isNumber(point.totalLiquidityUSD)) continue;
    const dayStart = new Date(point.date * 1000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const day = dayStart.toISOString().slice(0, 10);
    const previous = byDay.get(day);
    if (!previous || Math.abs(point.date * 1000 - dayStart.getTime()) < Math.abs((previous.date ?? 0) * 1000 - dayStart.getTime())) {
      byDay.set(day, point);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
}

function normalizeDefiLlamaHistory(
  asset: DefiLlamaProtocolAsset,
  protocol: ProtocolPayload,
  collectedAt = new Date().toISOString(),
  now = new Date(collectedAt),
): { snapshot: ProviderSnapshot | null; skipReason: string | null } {
  const recordId = recordIdOf(protocol);
  if (recordId !== asset.recordId) {
    return {
      snapshot: null,
      skipReason: `DeFiLlama resolved slug "${asset.externalAssetId}" to record "${recordId ?? "none"}", not the verified record "${asset.recordId}"; its history is not substituted.`,
    };
  }
  const series = Array.isArray(protocol.tvl) ? protocol.tvl : [];
  const cutoffSeconds = Math.floor(now.getTime() / 1000) - HISTORY_DAYS * 24 * 60 * 60;
  const tvlWithinWindow = series.filter(
    (point) => isNumber(point.date) && point.date >= cutoffSeconds && point.date <= now.getTime() / 1000,
  );
  const points = dailyHistoryPoints(tvlWithinWindow);
  const latest = points.at(-1);
  if (!latest) {
    return { snapshot: null, skipReason: "No numeric protocol TVL point was returned in the requested history window." };
  }

  return {
    skipReason: null,
    snapshot: {
      providerId: PROVIDER_ID,
      endpointLabel: "GET /protocol/{protocol}",
      asset,
      observedAt: epochSecondsToIso(latest.date, collectedAt),
      collectedAt,
      rawPayload: {
        recordId,
        protocol: {
          name: protocol.name ?? null,
          symbol: protocol.symbol ?? null,
          currentChainTvls: protocol.currentChainTvls ?? null,
          tvl: points,
        },
        retentionNote: `DeFiLlama protocol identity and one real TVL point per UTC day within the ${HISTORY_DAYS}-day normalization window are retained. Older TVL points and per-token/per-chain breakdowns are omitted to keep the raw snapshot bounded.`,
      },
      observations: points.map((point) =>
        observation(
          asset,
          "tvl_usd",
          point.totalLiquidityUSD,
          "tvl[].totalLiquidityUSD",
          epochSecondsToIso(point.date, collectedAt),
          collectedAt,
          null,
          "",
        ),
      ),
    },
  };
}

export class DefiLlamaFundamentalsProvider implements MarketDataProvider {
  readonly providerId = PROVIDER_ID;
  /** Every request made by this instance, in order. */
  readonly telemetry: DefiLlamaRequestTelemetry[] = [];
  /**
   * Assets whose request threw during the most recent fetchSnapshots call
   * (isolated per-asset so one unresolvable slug cannot abort collection for
   * every other curated protocol -- see the comment on fetchSnapshots).
   * fetchSnapshots must keep the MarketDataProvider interface's
   * Promise<ProviderSnapshot[]> return type, so failures are reported here
   * instead of in its return value.
   */
  lastFetchFailures: { tokenId: string; reason: string }[] = [];
  private readonly options: {
    baseUrl: string;
    writtenPermissionReference: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  };

  constructor(options: {
    baseUrl: string;
    writtenPermissionReference: string;
    fetchImpl?: typeof fetch;
    sleep?: (durationMs: number) => Promise<void>;
    now?: () => Date;
  }) {
    if (!options.writtenPermissionReference.trim()) {
      throw new Error("DeFiLlama written permission reference is required before collection.");
    }
    this.options = options;
  }

  private sleep(durationMs: number): Promise<void> {
    return (this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(durationMs);
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** Serialized, paced request that records its attempts and duration. */
  private async request<T>(path: string, timeoutMs: number, allowNotFound = false): Promise<T | null> {
    if (this.telemetry.length > 0) await this.sleep(MIN_REQUEST_INTERVAL_MS);
    const entry: DefiLlamaRequestTelemetry = { path, attempts: 0, durationMs: 0 };
    this.telemetry.push(entry);
    const startedAt = Date.now();
    try {
      const { body, attempts } = await getJson<T>(path, {
        baseUrl: this.options.baseUrl,
        fetchImpl: this.options.fetchImpl ?? fetch,
        sleep: (ms) => this.sleep(ms),
        timeoutMs,
        allowNotFound,
      });
      entry.attempts = attempts;
      return body;
    } finally {
      entry.durationMs = Date.now() - startedAt;
    }
  }

  /**
   * Routine collection: three small requests per protocol (current TVL, fees
   * summary, revenue summary), each resolved by the exact curated slug.
   *
   * Each asset is isolated in its own try/catch: a single protocol whose
   * slug DeFiLlama has renamed, removed, or otherwise made unresolvable
   * throws a DefiLlamaApiError (e.g. HTTP 400 "Protocol not found") that is
   * NOT retried (see getJson's retryable check) and, before this isolation
   * existed, propagated straight out of this loop -- aborting collection for
   * every OTHER curated protocol too. That is exactly what happened
   * 2026-10-14 through 2026-10-21 when DeFiLlama renamed the Aerodrome
   * parent record's slug: tvl_usd (and fees/revenue) stopped updating for
   * every DeFiLlama-tracked protocol, not just AERO, because one bad
   * mapping killed the whole run on every scheduled cycle. A failed asset
   * is now recorded (in lastFetchFailures, since this method must keep the
   * MarketDataProvider interface's Promise<ProviderSnapshot[]> return type)
   * and skipped; the run only fails outright if nothing came back at all
   * (see the "no protocol records" check in runDefiLlamaCollection).
   */
  async fetchSnapshots(assets: DefiLlamaProtocolAsset[]): Promise<ProviderSnapshot[]> {
    const snapshots: ProviderSnapshot[] = [];
    const failed: { tokenId: string; reason: string }[] = [];
    for (const asset of assets) {
      try {
        const slug = encodeURIComponent(asset.externalAssetId);
        const tvl = await this.request<unknown>(`/tvl/${slug}`, REQUEST_TIMEOUT_MS, true);
        const fees = await this.request<FeeSummaryPayload>(`/summary/fees/${slug}?${FEE_SUMMARY_QUERY}&dataType=dailyFees`, REQUEST_TIMEOUT_MS, true);
        const revenue = await this.request<FeeSummaryPayload>(`/summary/fees/${slug}?${FEE_SUMMARY_QUERY}&dataType=dailyRevenue`, REQUEST_TIMEOUT_MS, true);
        snapshots.push(normalizeDefiLlamaCurrent(asset, { tvl, fees, revenue }, this.now().toISOString()));
      } catch (error) {
        failed.push({ tokenId: asset.tokenId, reason: error instanceof Error ? error.message : "Unknown DeFiLlama request error." });
      }
    }
    this.lastFetchFailures = failed;
    return snapshots;
  }

  /** Explicit history collection (backfill): one /protocol request per protocol. */
  async fetchHistorySnapshots(
    assets: DefiLlamaProtocolAsset[],
  ): Promise<{
    snapshots: ProviderSnapshot[];
    skipped: { tokenId: string; reason: string }[];
    failed: { tokenId: string; reason: string }[];
  }> {
    const snapshots: ProviderSnapshot[] = [];
    const skipped: { tokenId: string; reason: string }[] = [];
    const failed: { tokenId: string; reason: string }[] = [];
    for (const asset of assets) {
      try {
        const protocol = await this.request<ProtocolPayload>(
          `/protocol/${encodeURIComponent(asset.externalAssetId)}`,
          HISTORY_REQUEST_TIMEOUT_MS,
          true,
        );
        const collectedAt = this.now().toISOString();
        const { snapshot, skipReason } = protocol
          ? normalizeDefiLlamaHistory(asset, protocol, collectedAt, this.now())
          : { snapshot: null, skipReason: `DeFiLlama has no protocol record for slug "${asset.externalAssetId}".` };
        if (snapshot) snapshots.push(snapshot);
        else skipped.push({ tokenId: asset.tokenId, reason: skipReason ?? "No usable history." });
      } catch (error) {
        failed.push({ tokenId: asset.tokenId, reason: error instanceof Error ? error.message : "Unknown DeFiLlama request error." });
      }
    }
    return { snapshots, skipped, failed };
  }
}

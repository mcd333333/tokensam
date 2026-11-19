import type { DashboardToken } from "../../types/token.ts";

/**
 * Client-side live prices.
 *
 * The dashboard is server-rendered with the stored price (see livePriceRow in
 * src/lib/data/live-data.ts), which is at most one refresh cycle old. This layer
 * only makes the two live-able numbers -- price and 24h change -- keep moving
 * between renders, by polling the app's /api/live-prices route, which reads
 * Coinbase's public market data. It writes nothing: no Supabase, no provider
 * calls from the browser, and no persistence of any kind. Stored history stays
 * the collector's job.
 *
 * Direct feeds (see coinbase-direct-feed.ts and binance-direct-feed.ts): the browser also opens
 * Coinbase's public WebSocket for the tokens Coinbase lists and Binance's for the rest, so those
 * prices cost no Worker request and no Durable Object time per viewer. Exchange APIs are geo-blocked in
 * some of this project's markets, so a direct connection is only ever an addition: it must deliver data
 * within seconds to count as healthy, and while either feed is not healthy the route keeps being polled at
 * LIVE_PRICE_POLL_MS exactly as before. The route also stays the source for the mobile app.
 *
 * The provider id "binance" below is the id of the live-exchange-price slot (see
 * DATASET_LABELS), kept from when only Binance filled it; each entry says whether Coinbase or
 * Binance quoted it.
 */

/**
 * `p` live price, `c` the exchange's reported 24-hour change, `c7` an optional
 * 7-day change computed server-side from `p` against a 7-day opening price. The
 * Coinbase route does not send `c7`, so rows keep their stored 7-day change.
 */
export type LivePriceEntry = {
  p: number;
  c: number;
  c7?: number;
  /** which exchange quoted it */
  s?: "coinbase" | "binance";
  /** When this entry was observed (epoch ms). Absent means the response's `asOf` applies. */
  at?: number;
};
export type LivePriceResponse = { asOf: string; prices: Record<string, LivePriceEntry> };

/**
 * Poll interval. The exchange updates a ticker about once a second, and the route
 * serves repeat polls from a 5 s memo, so polling faster than this buys nothing but requests --
 * and request count, not Binance's rate limit, is the budget that binds here
 * (one always-open tab at this interval is ~12,000 Worker requests/day).
 */
export const LIVE_PRICE_POLL_MS = 7_000;

/**
 * Poll interval while EVERY direct feed is healthy (Coinbase and Binance both streaming): about a quarter of
 * the requests of LIVE_PRICE_POLL_MS. It cannot be rarer, because the feeds do not cover everything at once.
 * Coinbase sends a snapshot of every product on connect, but Binance's miniTicker has none and sends a pair only
 * when it trades (in a 45 s test, 10 of the 36 Binance-only pairs had not yet), so until a quiet pair trades the
 * route's last-known price is what keeps its row live. It must stay at most half of LIVE_PRICE_MAX_AGE_MS so one
 * missed poll does not age those rows out. As soon as either feed is unhealthy the poll returns to
 * LIVE_PRICE_POLL_MS immediately.
 */
export const LIVE_PRICE_POLL_ALL_FEEDS_MS = 30_000;

/**
 * How often a healthy direct feed re-confirms its last prices. A feed only sends a price when it changes, so
 * a quiet token's entry would otherwise age past LIVE_PRICE_MAX_AGE_MS while the connection is perfectly fine.
 * While frames are arriving, silence on a symbol means its price has not changed, so its entry is re-stamped.
 * Must stay well under LIVE_PRICE_MAX_AGE_MS.
 */
export const DIRECT_FEED_RESTAMP_MS = 10_000;

/** Returns the entries with their observation time moved to `at` (a healthy feed confirming its last prices). */
export function restampEntries(entries: Record<string, LivePriceEntry>, at: number): Record<string, LivePriceEntry> {
  const out: Record<string, LivePriceEntry> = {};
  for (const [id, entry] of Object.entries(entries)) out[id] = { ...entry, at };
  return out;
}

/** The direct feed is on unless NEXT_PUBLIC_LIVE_PRICES_DIRECT is explicitly "0", "false" or "off" (kill switch). */
export function directFeedEnabled(value: string | undefined): boolean {
  return !["0", "false", "off"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Combines the polled response with the direct feed, per token: whichever entry was observed more
 * recently wins, so a feed that stalls hands the row back to the poll instead of freezing it. Every
 * merged entry carries its own `at`, and `asOf` becomes the newest of them.
 */
export function mergeLivePrices(
  polled: LivePriceResponse | null,
  direct: Record<string, LivePriceEntry> | null,
): LivePriceResponse | null {
  const hasDirect = !!direct && Object.keys(direct).length > 0;
  if (!hasDirect) return polled;
  const polledAt = polled ? Date.parse(polled.asOf) : Number.NaN;
  const prices: Record<string, LivePriceEntry> = {};
  if (polled) {
    for (const [id, entry] of Object.entries(polled.prices)) {
      prices[id] = Number.isFinite(entry.at) || !Number.isFinite(polledAt) ? entry : { ...entry, at: polledAt };
    }
  }
  for (const [id, entry] of Object.entries(direct)) {
    const current = prices[id];
    if (!current || (Number.isFinite(entry.at) && (entry.at as number) > (Number.isFinite(current.at) ? (current.at as number) : -Infinity))) {
      prices[id] = entry;
    }
  }
  let newest = Number.isFinite(polledAt) ? polledAt : -Infinity;
  for (const entry of Object.values(prices)) {
    if (Number.isFinite(entry.at) && (entry.at as number) > newest) newest = entry.at as number;
  }
  return { asOf: new Date(Number.isFinite(newest) ? newest : Date.now()).toISOString(), prices };
}

/**
 * A payload older than this is ignored rather than displayed.
 *
 * Guards the case where the edge keeps serving a cached response while upstream
 * has stopped updating: without it the dashboard would show a frozen price that
 * still looks live. Past this age the server-rendered value is kept instead,
 * which carries its own honest "as of" timestamp.
 */
export const LIVE_PRICE_MAX_AGE_MS = 60_000;

/**
 * Overlays live prices onto the server-rendered rows.
 *
 * Returns the original array unchanged when there is nothing to apply, so React
 * sees a stable reference and skips re-rendering on a poll that changed nothing.
 *
 * Provenance is updated with the value: a row showing a live price says so in
 * `metricSources`, rather than keeping the attribution of the stored observation
 * it replaced. A token with no live entry keeps its server-rendered value and
 * source untouched -- the two never mix within a row.
 */
export function applyLivePrices(
  tokens: DashboardToken[],
  response: LivePriceResponse | null,
  now: number = Date.now(),
): DashboardToken[] {
  if (!response) return tokens;
  const asOf = Date.parse(response.asOf);
  if (!Number.isFinite(asOf) || now - asOf > LIVE_PRICE_MAX_AGE_MS) return tokens;

  let changed = false;
  const next = tokens.map((token) => {
    // The route keys prices by canonical token id: the exchange mapping is resolved server-side.
    const live = response.prices[token.id];
    if (!live || !Number.isFinite(live.p) || !Number.isFinite(live.c)) return token;
    // An entry carries its own observation time when it came from the direct feed or a merge; it is
    // judged on that, so one stalled source cannot keep a stale price alive behind a fresh asOf.
    const observedAt = Number.isFinite(live.at) ? (live.at as number) : asOf;
    if (now - observedAt > LIVE_PRICE_MAX_AGE_MS) return token;
    const collectedAt = new Date(observedAt).toISOString();
    // c7 is supplementary: a missing or unusable one leaves the stored 7-day change alone.
    const live7d = Number.isFinite(live.c7) ? (live.c7 as number) : null;
    // Market cap and Vol / mcap derive from the price, so price being unchanged is enough
    // to know they are unchanged too.
    if (token.priceUsd === live.p && token.change24hPct === live.c
      && (live7d === null || token.change7dPct === live7d)) return token;
    changed = true;
    const source = {
      providerId: "binance" as const,
      collectedAt,
      note: live.s === "binance"
        ? "Binance spot last trade, USDT-quoted (a USD proxy, not USD), live in the browser. Single-venue price for the fungible asset, not a cross-venue average."
        : "Coinbase spot last trade, USD-quoted, live in the browser. Single-venue price for the fungible asset, not a cross-venue average.",
    };
    /**
     * Market cap is price x circulating supply, and supply does not move in seconds, so a
     * live price makes the stored market cap wrong until the next refresh. It is scaled by
     * the price move rather than recomputed as price x circulatingSupply: CoinGecko's own
     * market cap does not exactly equal that product (checked across 181 tokens -- 158
     * within 0.1%, worst 0.64%), so recomputing would visibly jump the figure the moment
     * polling started. Scaling is jump-free, because the ratio is 1 on the first poll, and
     * it applies only what actually changed.
     */
    const priceRatio = Number.isFinite(token.priceUsd) && (token.priceUsd as number) > 0
      ? live.p / (token.priceUsd as number)
      : null;
    const liveMarketCap = priceRatio !== null && Number.isFinite(token.marketCapUsd) && (token.marketCapUsd as number) > 0
      ? (token.marketCapUsd as number) * priceRatio
      : null;

    const sources = { ...token.metricSources, priceUsd: source, change24hPct: source };
    if (live7d !== null) {
      sources.change7dPct = {
        providerId: "binance" as const,
        collectedAt,
        note: "Exchange 7-day price change: the live last trade against the exchange's own 7-day rolling opening price. Single-venue, and derived from those two figures rather than reported as a single field.",
      };
    }
    if (liveMarketCap !== null) {
      sources.marketCapUsd = {
        providerId: "binance" as const,
        collectedAt,
        note: "Stored market cap scaled by the live exchange price move. Circulating supply is unchanged from the stored figure; only the price component is live.",
      };
    }

    /**
     * FDV is price x TOTAL supply. It is recomputed from the live price and the supply
     * implied by the stored record (see fdvSupply in types/token.ts) rather than scaled
     * by the price ratio, because that supply is exact: it comes from the same payload as
     * the FDV, so the two can never be mismatched. Omitted when no supply was derived,
     * leaving the stored FDV and its CoinGecko provenance alone.
     */
    const liveFdv = Number.isFinite(token.fdvSupply) && (token.fdvSupply as number) > 0
      ? live.p * (token.fdvSupply as number)
      : null;
    if (liveFdv !== null) {
      sources.fdvUsd = {
        providerId: "binance" as const,
        collectedAt,
        note: "Live exchange price multiplied by the total supply implied by the stored market-data record. Supply is unchanged from that record; only the price component is live.",
      };
    }

    // Vol / mcap is a server-calculated metric whose denominator just moved, so it must be
    // recomputed or the row would show a ratio that contradicts its own market-cap column.
    // The 24-hour volume is NOT touched: it is value actually traded over a window, which a
    // price tick does not retroactively change.
    const calculated = liveMarketCap !== null && Number.isFinite(token.volume24hUsd)
      ? { ...token.calculated, volume_to_market_cap: (token.volume24hUsd as number) / liveMarketCap }
      : token.calculated;

    return {
      ...token,
      priceUsd: live.p,
      change24hPct: live.c,
      ...(live7d !== null ? { change7dPct: live7d } : {}),
      ...(liveMarketCap !== null ? { marketCapUsd: liveMarketCap } : {}),
      ...(liveFdv !== null ? { fdvUsd: liveFdv } : {}),
      calculated,
      metricSources: sources,
    };
  });
  return changed ? next : tokens;
}

/**
 * Endpoint the browser polls. Unset (or blank) means the same-origin route
 * /api/live-prices, which is where live prices are served from: Binance rejects
 * Cloudflare Workers' egress with intermittent 403s, while Vercel's reaches it
 * reliably (see src/app/api/live-prices/route.ts). Same-origin also removes the
 * CORS surface and the cross-origin round trip.
 *
 * NEXT_PUBLIC_LIVE_PRICES_URL therefore only needs setting to point somewhere
 * else; pointing it at the Cloudflare Worker is what this default replaces.
 *
 * Takes the value rather than reading process.env itself. Next.js only inlines a
 * NEXT_PUBLIC_* variable into client code where it appears literally as
 * `process.env.NEXT_PUBLIC_...`; reading it through a dynamic property lookup
 * leaves it undefined in the browser, which would silently disable live polling
 * with no error anywhere. The caller therefore passes the literal, and this stays
 * a pure function the tests can drive.
 */
export const DEFAULT_LIVE_PRICES_PATH = "/api/live-prices";

export function livePricesUrl(value: string | undefined): string | null {
  const base = value?.trim().replace(/\/+$/, "");
  return base ? base : DEFAULT_LIVE_PRICES_PATH;
}

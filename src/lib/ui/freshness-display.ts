import { LIVE_PRICE_MAX_AGE_MS } from "./live-prices.ts";
import type { LiveSource } from "./live-source.ts";

/**
 * What the profile's Data freshness list shows.
 *
 * Two rules, both applied in the browser against the visitor's clock rather than at render time, because the page's
 * HTML can come from an edge cache and be minutes older than the visit:
 *
 * - A dataset last collected more than FRESHNESS_DISPLAY_MAX_AGE_MS ago is not listed.
 * - A "Live exchange price" row, driven by the live feed rather than by a collector, appears while that feed is delivering.
 *
 * Until the browser clock is read (`now` is null: server render and hydration) the server's rows are returned untouched, so
 * the markup matches on both sides and visitors without JavaScript still get the section.
 */
export const FRESHNESS_DISPLAY_MAX_AGE_MS = 15 * 60 * 1000;

export type FreshnessItem = {
  kind: "observation" | "calculation";
  label: string;
  ageLabel: string;
  state: "current" | "stale" | null;
  collectedAt: string;
  observedAt: string | null;
};

/** "just now" or "N min ago"; datasets older than the display limit are never labelled, so minutes are enough. */
export function ageLabel(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

/** The datasets to list: collected within the display limit, with ages recomputed from `now`. */
export function visibleFreshness<T extends FreshnessItem>(items: T[], now: number | null): T[] {
  if (now === null) return items;
  const shown: T[] = [];
  for (const item of items) {
    const collected = Date.parse(item.collectedAt);
    if (!Number.isFinite(collected)) continue;
    const age = now - collected;
    if (age > FRESHNESS_DISPLAY_MAX_AGE_MS) continue;
    shown.push({ ...item, ageLabel: ageLabel(age) });
  }
  return shown;
}

/** Which live feed quotes this token and when it was last confirmed (epoch ms), as the page's live overlay sees it. */
export type LivePriceStatus = { source: LiveSource | null; at: number | null };
export type LiveFreshnessRow = { label: string; text: string };

/**
 * The feed-based row. Shown only while the feed is delivering (its newest confirmation is within
 * LIVE_PRICE_MAX_AGE_MS); a token with no live exchange feed, a blocked feed or a stalled one simply has no row, and the
 * price in the header is then the server-rendered one. A feed only sends a price when it changes, so "Live" means the
 * connection is delivering and the price is current, not that a trade happened a moment ago.
 */
export function liveFreshnessRow(status: LivePriceStatus | null | undefined, now: number | null): LiveFreshnessRow | null {
  if (!status || !status.source || status.at === null || now === null) return null;
  if (now - status.at > LIVE_PRICE_MAX_AGE_MS) return null;
  return {
    label: "Live exchange price",
    text: status.source === "coinbase" ? "Live · Coinbase (USD)" : "Live · Binance (USDT)",
  };
}

import assert from "node:assert/strict";

import {
  FRESHNESS_DISPLAY_MAX_AGE_MS,
  ageLabel,
  liveFreshnessRow,
  visibleFreshness,
} from "../src/lib/ui/freshness-display.ts";
import { LIVE_PRICE_MAX_AGE_MS } from "../src/lib/ui/live-prices.ts";
import { liveSourceFor } from "../src/lib/ui/live-source.ts";
import { directFeedSize, directFeedSubscribeMessage } from "../src/lib/ui/coinbase-direct-feed.ts";
import { binanceDirectFeedSize, binanceStreamUrl } from "../src/lib/ui/binance-direct-feed.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { binanceSymbols } from "../src/data/binance-symbols.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = Date.parse("2026-11-19T07:00:00.000Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const item = (label, collectedAt, extra = {}) => ({ kind: "observation", label, ageLabel: "server label", state: "current", collectedAt, observedAt: null, ...extra });

test("the display limit is 15 minutes", () => {
  assert.equal(FRESHNESS_DISPLAY_MAX_AGE_MS, 15 * 60_000);
});

test("before the browser clock is read the server's rows are returned untouched", () => {
  const items = [item("Market data", minutesAgo(40))];
  assert.equal(visibleFreshness(items, null), items);
});

test("datasets collected more than 15 minutes ago are not listed; the rest are relabelled from the visitor's clock", () => {
  const items = [
    item("Market data", minutesAgo(10)),
    item("Reference token prices", minutesAgo(33)),
    item("DEX market data", minutesAgo(95)),
    item("Calculated metrics", minutesAgo(9), { kind: "calculation", state: null }),
    item("Just collected", minutesAgo(0.2)),
  ];
  const shown = visibleFreshness(items, NOW);
  assert.deepEqual(shown.map((row) => row.label), ["Market data", "Calculated metrics", "Just collected"]);
  assert.deepEqual(shown.map((row) => row.ageLabel), ["10 min ago", "9 min ago", "just now"], "ages come from `now`, not from the server's text");
  assert.equal(shown[1].state, null, "a row with no threshold keeps no state");
});

test("a cached page cannot keep a stale row alive: the age is judged when the page is viewed", () => {
  // Rendered when the data was 5 minutes old (so listed), viewed 12 minutes later: now 17 minutes old.
  const rows = [item("Market data", minutesAgo(5))];
  assert.equal(visibleFreshness(rows, NOW).length, 1);
  assert.equal(visibleFreshness(rows, NOW + 12 * 60_000).length, 0);
});

test("the boundary is inclusive at exactly 15 minutes, and unreadable timestamps are dropped rather than shown", () => {
  assert.equal(visibleFreshness([item("a", minutesAgo(15))], NOW).length, 1);
  assert.equal(visibleFreshness([item("a", minutesAgo(15.02))], NOW).length, 0);
  assert.equal(visibleFreshness([item("a", "not a date")], NOW).length, 0);
});

test("a timestamp slightly in the future (clock skew) reads as just now instead of a negative age", () => {
  assert.equal(ageLabel(-5_000), "just now");
  const rows = visibleFreshness([item("a", new Date(NOW + 30_000).toISOString())], NOW);
  assert.equal(rows[0].ageLabel, "just now");
});

test("the live row appears while the feed is delivering, names the exchange and its quote, and disappears otherwise", () => {
  const live = (source, ageMs) => liveFreshnessRow({ source, at: NOW - ageMs }, NOW);
  assert.deepEqual(live("coinbase", 3_000), { label: "Live exchange price", text: "Live · Coinbase (USD)" });
  assert.deepEqual(live("binance", 3_000), { label: "Live exchange price", text: "Live · Binance (USDT)" });
  assert.notEqual(live("coinbase", LIVE_PRICE_MAX_AGE_MS), null, "still live at the freshness limit");
  assert.equal(live("coinbase", LIVE_PRICE_MAX_AGE_MS + 1), null, "a stalled feed is not shown as live");
  assert.equal(liveFreshnessRow({ source: null, at: null }, NOW), null, "a token no exchange quotes has no live row");
  assert.equal(liveFreshnessRow({ source: "coinbase", at: null }, NOW), null, "not connected yet");
  assert.equal(liveFreshnessRow(undefined, NOW), null);
  assert.equal(liveFreshnessRow({ source: "coinbase", at: NOW }, null), null, "no row until the browser clock is read");
});

test("liveSourceFor mirrors the server: Coinbase where it lists the token, Binance for the rest, otherwise none", () => {
  const onCoinbase = Object.keys(coinbaseProducts)[0];
  const binanceOnly = Object.keys(binanceSymbols).find((id) => !coinbaseProducts[id]);
  assert.equal(liveSourceFor(onCoinbase), "coinbase");
  assert.equal(liveSourceFor(binanceOnly), "binance");
  assert.equal(liveSourceFor("ethereum-mnt"), null, "Mantle is on neither exchange");
  assert.equal(liveSourceFor("not-a-token"), null);
});

test("a profile page subscribes only to what its token needs", () => {
  const onCoinbase = Object.keys(coinbaseProducts)[0];
  const binanceOnly = Object.keys(binanceSymbols).find((id) => !coinbaseProducts[id]);
  // Coinbase-listed token: one product on Coinbase, nothing on Binance.
  assert.equal(directFeedSize([onCoinbase]), 1);
  assert.deepEqual(JSON.parse(directFeedSubscribeMessage([onCoinbase])).product_ids, [coinbaseProducts[onCoinbase]]);
  assert.equal(binanceDirectFeedSize([onCoinbase]), 0, "Coinbase wins, so Binance is not opened for it");
  // Binance-only token: nothing on Coinbase, one stream on Binance.
  assert.equal(directFeedSize([binanceOnly]), 0);
  assert.equal(binanceDirectFeedSize([binanceOnly]), 1);
  assert.ok(binanceStreamUrl([binanceOnly]).endsWith(`streams=${binanceSymbols[binanceOnly].toLowerCase()}@miniTicker`));
  // Neither exchange: no connection at all.
  assert.equal(directFeedSize(["ethereum-mnt"]), 0);
  assert.equal(binanceDirectFeedSize(["ethereum-mnt"]), 0);
  // No filter still means the whole universe (the dashboard).
  assert.ok(directFeedSize() > 100);
  assert.ok(binanceDirectFeedSize() > 20);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
if (failures > 0) process.exitCode = 1;

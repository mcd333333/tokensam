import assert from "node:assert/strict";

import { COINBASE_WS_URL, DIRECT_FEED_CHANNEL, directFeedSubscribeMessage, parseDirectFeedFrame } from "../src/lib/ui/coinbase-direct-feed.ts";
import { binanceDirectFeedSize, binanceStreamUrl, parseBinanceDirectFrame } from "../src/lib/ui/binance-direct-feed.ts";
import {
  DIRECT_FEED_RESTAMP_MS,
  LIVE_PRICE_MAX_AGE_MS,
  LIVE_PRICE_POLL_ALL_FEEDS_MS,
  LIVE_PRICE_POLL_MS,
  applyLivePrices,
  directFeedEnabled,
  mergeLivePrices,
  restampEntries,
} from "../src/lib/ui/live-prices.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { binanceSymbols } from "../src/data/binance-token-mappings.ts";
import { binanceSymbols as clientBinanceSymbols } from "../src/data/binance-symbols.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = Date.parse("2026-11-19T06:00:00.000Z");
const [A_ID, B_ID] = Object.keys(coinbaseProducts);
const A_PRODUCT = coinbaseProducts[A_ID];

function frame(tickers, channel = DIRECT_FEED_CHANNEL) {
  return JSON.stringify({ channel, events: [{ type: "update", tickers }] });
}
function token(id, overrides = {}) {
  return {
    id, name: id, symbol: "X", chain: "Ethereum", category: "DeFi",
    priceUsd: 100, change24hPct: 1, change7dPct: 7, marketCapUsd: 1000,
    volume24hUsd: 50, calculated: { volume_to_market_cap: 0.05 },
    fdvSupply: 20, fdvUsd: 2000, circulatingSupply: 10, maximumSupply: 20,
    tvlUsd: null, tvlChange30dPct: null, marketCapChange24hPct: null,
    volumeChange24hPct: null, volumeToMarketCapChange24hPct: null,
    fees24hUsd: null, revenue24hUsd: null, observedAt: new Date(NOW).toISOString(),
    metricSources: { priceUsd: { providerId: "coingecko", collectedAt: new Date(NOW).toISOString(), note: "stored" } },
    ...overrides,
  };
}

test("the direct feed talks to Coinbase's public WebSocket and subscribes to every mapped product", () => {
  assert.match(COINBASE_WS_URL, /^wss:\/\/advanced-trade-ws\.coinbase\.com/);
  const message = JSON.parse(directFeedSubscribeMessage());
  assert.equal(message.type, "subscribe");
  assert.equal(message.channel, DIRECT_FEED_CHANNEL);
  assert.deepEqual([...message.product_ids].sort(), [...new Set(Object.values(coinbaseProducts))].sort());
  assert.ok(!("jwt" in message) && !("signature" in message), "public channel: no credentials in the frame");
});

test("a ticker frame becomes entries for every token mapped to that product, stamped with the receive time", () => {
  const out = parseDirectFeedFrame(frame([{ product_id: A_PRODUCT, price: "123.45", price_percent_chg_24_h: "-2.5" }]), NOW);
  const expectedTokens = Object.entries(coinbaseProducts).filter(([, product]) => product === A_PRODUCT).map(([id]) => id).sort();
  assert.deepEqual(Object.keys(out).sort(), expectedTokens);
  assert.deepEqual(out[A_ID], { p: 123.45, c: -2.5, s: "coinbase", at: NOW });
});

test("unusable frames are ignored instead of throwing", () => {
  assert.deepEqual(parseDirectFeedFrame("not json", NOW), {});
  assert.deepEqual(parseDirectFeedFrame(JSON.stringify({ channel: "subscriptions", events: [] }), NOW), {});
  assert.deepEqual(parseDirectFeedFrame(frame([{ product_id: A_PRODUCT, price: "0", price_percent_chg_24_h: "1" }]), NOW), {}, "zero price");
  assert.deepEqual(parseDirectFeedFrame(frame([{ product_id: A_PRODUCT, price: "-3", price_percent_chg_24_h: "1" }]), NOW), {}, "negative price");
  assert.deepEqual(parseDirectFeedFrame(frame([{ product_id: A_PRODUCT, price: "5", price_percent_chg_24_h: "abc" }]), NOW), {}, "non-numeric change");
  assert.deepEqual(parseDirectFeedFrame(frame([{ product_id: "NOPE-USD", price: "5", price_percent_chg_24_h: "1" }]), NOW), {}, "unmapped product");
});

test("merging keeps whichever entry is newer per token and carries its own timestamp", () => {
  const polled = { asOf: new Date(NOW - 20_000).toISOString(), prices: { [A_ID]: { p: 1, c: 1, s: "coinbase" }, [B_ID]: { p: 2, c: 2, s: "binance" } } };
  const direct = { [A_ID]: { p: 9, c: 9, s: "coinbase", at: NOW - 1_000 } };
  const merged = mergeLivePrices(polled, direct);
  assert.equal(merged.prices[A_ID].p, 9, "the fresher direct entry wins");
  assert.equal(merged.prices[B_ID].p, 2, "a token only the poll knows keeps its polled entry");
  assert.equal(merged.prices[B_ID].at, NOW - 20_000, "polled entries are stamped with the poll's own time");
  assert.equal(merged.asOf, new Date(NOW - 1_000).toISOString(), "asOf is the newest entry");

  // The poll catches up after the feed stalls: the newer polled entry wins back the row.
  const newerPoll = { asOf: new Date(NOW).toISOString(), prices: { [A_ID]: { p: 5, c: 5, s: "coinbase" } } };
  assert.equal(mergeLivePrices(newerPoll, direct).prices[A_ID].p, 5);
});

test("merging with nothing direct returns the polled response untouched, and with nothing at all returns null", () => {
  const polled = { asOf: new Date(NOW).toISOString(), prices: { [A_ID]: { p: 1, c: 1 } } };
  assert.equal(mergeLivePrices(polled, null), polled);
  assert.equal(mergeLivePrices(polled, {}), polled);
  assert.equal(mergeLivePrices(null, null), null);
  const directOnly = mergeLivePrices(null, { [A_ID]: { p: 3, c: 3, s: "coinbase", at: NOW - 500 } });
  assert.equal(directOnly.prices[A_ID].p, 3);
  assert.equal(directOnly.asOf, new Date(NOW - 500).toISOString());
});

test("each entry is judged on its own age, so a stale one cannot ride on a fresh asOf", () => {
  const response = {
    asOf: new Date(NOW).toISOString(),
    prices: {
      [A_ID]: { p: 200, c: 5, s: "coinbase", at: NOW - 1_000 },
      [B_ID]: { p: 300, c: 6, s: "coinbase", at: NOW - LIVE_PRICE_MAX_AGE_MS - 1 },
    },
  };
  const [a, b] = applyLivePrices([token(A_ID), token(B_ID)], response, NOW);
  assert.equal(a.priceUsd, 200);
  assert.equal(a.metricSources.priceUsd.collectedAt, new Date(NOW - 1_000).toISOString(), "provenance carries the entry's own time");
  assert.equal(b.priceUsd, 100, "the stale entry is ignored and the stored value stands");
});

test("entries without a timestamp still follow the response's asOf, exactly as before", () => {
  const rows = applyLivePrices([token(A_ID)], { asOf: new Date(NOW - 3_000).toISOString(), prices: { [A_ID]: { p: 150, c: 2 } } }, NOW);
  assert.equal(rows[0].priceUsd, 150);
  const stale = applyLivePrices([token(A_ID)], { asOf: new Date(NOW - LIVE_PRICE_MAX_AGE_MS - 1).toISOString(), prices: { [A_ID]: { p: 150, c: 2 } } }, NOW);
  assert.equal(stale[0].priceUsd, 100);
});

test("the direct feed is on by default and only an explicit off switch disables it", () => {
  assert.equal(directFeedEnabled(undefined), true);
  assert.equal(directFeedEnabled(""), true);
  assert.equal(directFeedEnabled("1"), true);
  for (const off of ["0", "false", "OFF", " off "]) assert.equal(directFeedEnabled(off), false, off);
});

test("the poll slows while the feeds are healthy but never so far that last-known prices age out", () => {
  assert.ok(LIVE_PRICE_POLL_ALL_FEEDS_MS > LIVE_PRICE_POLL_MS, "all feeds healthy: fewer requests than the fallback poll");
  assert.ok(LIVE_PRICE_POLL_ALL_FEEDS_MS * 2 <= LIVE_PRICE_MAX_AGE_MS, "one missed poll must not age a not-yet-traded pair's price out");
  assert.ok(DIRECT_FEED_RESTAMP_MS * 3 <= LIVE_PRICE_MAX_AGE_MS, "a few missed re-confirmations must not age a quiet token out");
});

test("re-stamping moves every entry's observation time and changes nothing else", () => {
  const before = { [A_ID]: { p: 1, c: 2, s: "coinbase", at: NOW - 50_000 }, [B_ID]: { p: 3, c: 4, s: "binance", at: NOW - 40_000 } };
  const after = restampEntries(before, NOW);
  assert.deepEqual(after[A_ID], { p: 1, c: 2, s: "coinbase", at: NOW });
  assert.deepEqual(after[B_ID], { p: 3, c: 4, s: "binance", at: NOW });
  assert.equal(before[A_ID].at, NOW - 50_000, "the input is not mutated");
});

// A token Binance quotes but Coinbase does not: exactly what the Binance direct feed covers.
const BINANCE_ONLY_IDS = Object.keys(binanceSymbols).filter((id) => !coinbaseProducts[id]);
const BN_ID = BINANCE_ONLY_IDS[0];
const BN_SYMBOL = binanceSymbols[BN_ID];
const bnFrame = (symbol, last, open) => JSON.stringify({ stream: `${symbol.toLowerCase()}@miniTicker`, data: { s: symbol, c: String(last), o: String(open) } });

test("the browser's Binance symbol map is the same data as the server's", () => {
  assert.deepEqual(clientBinanceSymbols, binanceSymbols);
});

test("the Binance feed covers exactly the tokens Coinbase does not list, and only those", () => {
  assert.ok(BINANCE_ONLY_IDS.length > 0);
  assert.equal(binanceDirectFeedSize(), new Set(BINANCE_ONLY_IDS.map((id) => binanceSymbols[id].toUpperCase())).size);
  const url = binanceStreamUrl();
  assert.match(url, /^wss:\/\/data-stream\.binance\.vision\/stream\?streams=/);
  const streams = url.split("streams=")[1].split("/");
  assert.ok(streams.every((stream) => stream.endsWith("@miniTicker") && stream.split("@")[0] === stream.split("@")[0].toLowerCase()), "lower-case symbol, @miniTicker stream names");
  assert.ok(streams.includes(`${BN_SYMBOL.toLowerCase()}@miniTicker`));
  const coinbaseAlsoOnBinance = Object.keys(binanceSymbols).find((id) => coinbaseProducts[id]);
  assert.ok(coinbaseAlsoOnBinance, "fixture sanity: some token is on both exchanges");
  assert.ok(!streams.includes(`${binanceSymbols[coinbaseAlsoOnBinance].toLowerCase()}@miniTicker`), "Coinbase-listed tokens are not streamed from Binance");
});

test("a miniTicker frame becomes a USDT-quoted entry with the 24-hour change derived from the 24-hour open", () => {
  const out = parseBinanceDirectFrame(bnFrame(BN_SYMBOL, "110", "100"), NOW);
  assert.equal(out[BN_ID].p, 110);
  assert.ok(Math.abs(out[BN_ID].c - 10) < 1e-9, "(110/100 - 1) x 100");
  assert.equal(out[BN_ID].s, "binance");
  assert.equal(out[BN_ID].at, NOW);
});

test("Binance frames that are junk, unusable, or for Coinbase-listed tokens are ignored", () => {
  assert.deepEqual(parseBinanceDirectFrame("nope", NOW), {});
  assert.deepEqual(parseBinanceDirectFrame(JSON.stringify({ result: null, id: 1 }), NOW), {});
  assert.deepEqual(parseBinanceDirectFrame(bnFrame(BN_SYMBOL, "0", "100"), NOW), {}, "zero price");
  assert.deepEqual(parseBinanceDirectFrame(bnFrame(BN_SYMBOL, "5", "0"), NOW), {}, "zero open would make an infinite change");
  assert.deepEqual(parseBinanceDirectFrame(bnFrame(BN_SYMBOL, "x", "100"), NOW), {}, "non-numeric price");
  assert.deepEqual(parseBinanceDirectFrame(bnFrame("NOTASYMBOLUSDT", "5", "5"), NOW), {}, "unmapped symbol");
  const coinbaseListed = Object.keys(binanceSymbols).find((id) => coinbaseProducts[id]);
  assert.deepEqual(parseBinanceDirectFrame(bnFrame(binanceSymbols[coinbaseListed], "5", "5"), NOW), {}, "Coinbase wins where it lists the token");
});

test("a Binance entry is applied to the row and attributed to Binance's USDT quote", () => {
  const entry = parseBinanceDirectFrame(bnFrame(BN_SYMBOL, "200", "100"), NOW)[BN_ID];
  const [row] = applyLivePrices([token(BN_ID)], { asOf: new Date(NOW).toISOString(), prices: { [BN_ID]: entry } }, NOW);
  assert.equal(row.priceUsd, 200);
  assert.match(row.metricSources.priceUsd.note, /Binance spot last trade, USDT-quoted/);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
if (failures > 0) process.exitCode = 1;

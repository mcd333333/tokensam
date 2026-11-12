import assert from "node:assert/strict";

import { applyLivePrices, livePricesUrl, DEFAULT_LIVE_PRICES_PATH, LIVE_PRICE_MAX_AGE_MS } from "../src/lib/ui/live-prices.ts";
import { setStreamReaderForTests, readLivePrices, LIVE_MAX_AGE_MS } from "../src/lib/providers/live-price-source.ts";
import { binanceSymbols } from "../src/data/binance-token-mappings.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { GET as getLivePrices } from "../src/app/api/live-prices/route.ts";
import { resetCoinbaseMemo } from "../src/lib/providers/coinbase.ts";
import { canonicalTokens } from "../src/data/canonical-tokens.ts";
import { getLiveTokenProfile } from "../src/lib/data/live-data.ts";
import { createFakeSupabase } from "./support/fake-supabase.mjs";
import { BINANCE_SYMBOLS } from "../cloudflare/refresh-scheduler/src/binance-symbols.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const fresh = new Date(NOW - 3_000).toISOString();

function token(id, overrides = {}) {
  return {
    id, name: id, symbol: "X", chain: "Ethereum", category: "DeFi",
    priceUsd: 100, change24hPct: 1, change7dPct: 7, marketCapUsd: 1000,
    volume24hUsd: 50, calculated: { volume_to_market_cap: 0.05 },
    fdvSupply: 20, fdvUsd: 2000, circulatingSupply: 10, maximumSupply: 20,
    tvlUsd: null, tvlChange30dPct: null, marketCapChange24hPct: null,
    volumeChange24hPct: null, volumeToMarketCapChange24hPct: null,
    fees24hUsd: null, revenue24hUsd: null, observedAt: fresh,
    metricSources: {
      priceUsd: { providerId: "coingecko", collectedAt: fresh, note: "stored" },
      change7dPct: { providerId: "coingecko", collectedAt: fresh, note: "stored" },
    },
    ...overrides,
  };
}

// A token that really is mapped, so the symbol lookup is exercised against real data.
const MAPPED_ID = Object.keys(coinbaseProducts)[0];
const MAPPED_SYMBOL = coinbaseProducts[MAPPED_ID];

test("a live price replaces the stored one and is attributed to the live exchange price", () => {
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 123.45, c: -2.5 } },
  }, NOW);

  assert.equal(row.priceUsd, 123.45);
  assert.equal(row.change24hPct, -2.5);
  // Provenance must move with the value, never keep the replaced row's attribution.
  assert.equal(row.metricSources.priceUsd.providerId, "binance");
  assert.equal(row.metricSources.change24hPct.providerId, "binance");
  assert.match(row.metricSources.priceUsd.note, /Coinbase spot last trade, USD-quoted/);
  // Market cap is a function of price, so it scales with it: 1000 x (123.45/100).
  assert.equal(row.marketCapUsd, 1234.5);
  // Volume is NOT a function of price -- it is value actually traded over a window, which
  // a price tick does not retroactively change.
  assert.equal(row.volume24hUsd, 50);
  // No 7-day figure was supplied in this payload, so the stored one stands.
  assert.equal(row.change7dPct, 7);
});

test("a live 7-day change replaces the stored one and is attributed to the live exchange price", () => {
  // c7 is computed server-side from the live price against Binance's own 7-day open
  // (see src/app/api/live-prices/route.ts), so it ticks with every price move.
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 123.45, c: -2.5, c7: 8.75 } },
  }, NOW);

  assert.equal(row.change7dPct, 8.75);
  assert.equal(row.metricSources.change7dPct.providerId, "binance");
  assert.match(row.metricSources.change7dPct.note, /7-day rolling opening price/);
});

test("a missing or unusable 7-day change leaves the stored one untouched", () => {
  // The 7-day figure is supplementary: the live price must still apply without it.
  for (const entry of [{ p: 123.45, c: -2.5 }, { p: 123.45, c: -2.5, c7: Number.NaN }]) {
    const [row] = applyLivePrices([token(MAPPED_ID)], { asOf: fresh, prices: { [MAPPED_ID]: entry } }, NOW);
    assert.equal(row.change7dPct, 7, "the stored 7-day change survives");
    assert.equal(row.metricSources.change7dPct.providerId, "coingecko", "and keeps its own provenance");
    assert.equal(row.priceUsd, 123.45, "while the live price still applies");
    assert.equal(row.metricSources.priceUsd.providerId, "binance");
  }
});

test("a 7-day change that moved alone still produces a new array", () => {
  // Price and 24h unchanged, only c7 moved: the row must still update.
  const input = [token(MAPPED_ID, { priceUsd: 123.45, change24hPct: -2.5, change7dPct: 8.0 })];
  const moved = applyLivePrices(input, {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 123.45, c: -2.5, c7: 8.75 } },
  }, NOW);
  assert.notEqual(moved, input);
  assert.equal(moved[0].change7dPct, 8.75);
});

test("market cap scales with the price move, and Vol / mcap follows", () => {
  // Price doubles: market cap must double, and volume/mcap must halve, or the row would
  // contradict itself. Volume is untouched -- a price tick does not change what was traded.
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 200, c: 5 } },
  }, NOW);

  assert.equal(row.marketCapUsd, 2000, "1000 x (200/100)");
  assert.equal(row.volume24hUsd, 50, "24h volume is not a function of price");
  assert.equal(row.calculated.volume_to_market_cap, 0.025, "50 / 2000");
  assert.equal(row.metricSources.marketCapUsd.providerId, "binance");
  assert.match(row.metricSources.marketCapUsd.note, /Circulating supply is unchanged/);
});

test("market cap does not jump when polling starts", () => {
  // First poll typically returns the same price the row was rendered with; the ratio is
  // then 1 and the stored market cap must come through untouched.
  const [row] = applyLivePrices([token(MAPPED_ID, { change24hPct: 99 })], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 100, c: 1 } },
  }, NOW);
  assert.equal(row.marketCapUsd, 1000);
  assert.equal(row.calculated.volume_to_market_cap, 0.05);
});

test("an unusable price or market cap leaves both the cap and the ratio alone", () => {
  for (const overrides of [{ priceUsd: 0 }, { priceUsd: null }, { marketCapUsd: null }]) {
    const [row] = applyLivePrices([token(MAPPED_ID, overrides)], {
      asOf: fresh, prices: { [MAPPED_ID]: { p: 200, c: 5 } },
    }, NOW);
    assert.equal(row.marketCapUsd, overrides.marketCapUsd === null ? null : 1000, "no fabricated market cap");
    assert.equal(row.calculated.volume_to_market_cap, 0.05, "stored ratio survives");
    assert.equal(row.priceUsd, 200, "the live price still applies");
  }
});

test("FDV is recomputed from the live price and the implied total supply", () => {
  // fdvSupply (20) is fdv/price from the SAME stored record, i.e. the total supply
  // CoinGecko priced it on -- not circulating, and not maximum, which 68 of 182 tokens
  // do not even have. Price doubles, so FDV doubles.
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 200, c: 5 } },
  }, NOW);

  assert.equal(row.fdvUsd, 4000, "200 x 20");
  assert.equal(row.metricSources.fdvUsd.providerId, "binance");
  assert.match(row.metricSources.fdvUsd.note, /Supply is unchanged/);
});

test("FDV without a derivable supply keeps the stored figure", () => {
  for (const overrides of [{ fdvSupply: null }, { fdvSupply: 0 }, { fdvSupply: undefined }]) {
    const [row] = applyLivePrices([token(MAPPED_ID, overrides)], {
      asOf: fresh, prices: { [MAPPED_ID]: { p: 200, c: 5 } },
    }, NOW);
    assert.equal(row.fdvUsd, 2000, "no fabricated FDV");
    assert.equal(row.priceUsd, 200, "the live price still applies");
  }
});

test("a token with no live entry keeps its server-rendered value and source", () => {
  const [row] = applyLivePrices([token(MAPPED_ID)], { asOf: fresh, prices: {} }, NOW);
  assert.equal(row.priceUsd, 100);
  assert.equal(row.metricSources.priceUsd.providerId, "coingecko");
});

test("an unmapped token is never given another token's price", () => {
  const unmapped = "UNMAPPED"; // a token Coinbase does not list
  assert.equal(coinbaseProducts[unmapped], undefined);
  const [row] = applyLivePrices([token(unmapped)], {
    asOf: fresh, prices: { [MAPPED_ID]: { p: 999, c: 99 } },
  }, NOW);
  assert.equal(row.priceUsd, 100);
});

test("a stale or malformed payload is ignored in favour of the server-rendered value", () => {
  const input = [token(MAPPED_ID)];
  const stale = new Date(NOW - LIVE_PRICE_MAX_AGE_MS - 1_000).toISOString();
  const prices = { [MAPPED_ID]: { p: 123.45, c: -2.5 } };

  assert.equal(applyLivePrices(input, { asOf: stale, prices }, NOW), input, "stale payload ignored");
  assert.equal(applyLivePrices(input, { asOf: "not-a-date", prices }, NOW), input, "unparseable asOf ignored");
  assert.equal(applyLivePrices(input, null, NOW), input, "no payload ignored");
  assert.equal(
    applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_ID]: { p: Number.NaN, c: 1 } } }, NOW)[0].priceUsd,
    100,
    "non-finite price ignored rather than rendered",
  );
});

test("an unchanged poll returns the same array reference, so React re-renders nothing", () => {
  const input = [token(MAPPED_ID, { priceUsd: 123.45, change24hPct: -2.5 })];
  const same = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_ID]: { p: 123.45, c: -2.5 } } }, NOW);
  assert.equal(same, input, "identical values must not produce a new array");

  const moved = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_ID]: { p: 123.46, c: -2.5 } } }, NOW);
  assert.notEqual(moved, input, "a moved price must produce a new array");
});

test("polling defaults to the same-origin route, with the env var as an override", () => {
  // Live prices are served by the app's own /api/live-prices route. An unset env var must mean
  // that route, not "disabled".
  assert.equal(livePricesUrl(undefined), DEFAULT_LIVE_PRICES_PATH);
  assert.equal(livePricesUrl("   "), DEFAULT_LIVE_PRICES_PATH);
  assert.equal(livePricesUrl("https://elsewhere.example/prices/"), "https://elsewhere.example/prices");
});

test("the Worker's generated Binance symbol allowlist still matches the Binance mapping", () => {
  // The Worker cannot import from src/, so its list is generated (pnpm binance:symbols).
  // Adding a token without regenerating would leave it with no live price, silently.
  assert.deepEqual([...BINANCE_SYMBOLS].sort(), Object.values(binanceSymbols).sort());
});

const realFetch = globalThis.fetch;
function resetLive() { resetCoinbaseMemo(); setStreamReaderForTests(null); }
function coinbaseStub(handler) {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(new URL(String(url))); return handler(new URL(String(url)), calls.length); };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
const productsFor = (url, overrides = {}) => url.searchParams.getAll("product_ids").map((id) => ({
  product_id: id, price: "10.5", price_percentage_change_24h: "-1.25", status: "online",
  trading_disabled: false, is_disabled: false, ...(overrides[id] ?? {}),
}));

test("the live-prices route returns Coinbase last price and 24h change keyed by product, in batches", async () => {
  resetLive();
  setStreamReaderForTests(async () => null); // both streams down: the Coinbase REST fallback serves
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, { [MAPPED_SYMBOL]: { price: "123.45", price_percentage_change_24h: "-2.5" } }) }));
  try {
    const response = await getLivePrices();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.prices[MAPPED_ID], { p: 123.45, c: -2.5, s: "coinbase" });
    assert.equal(Object.keys(body.prices).length, Object.keys(coinbaseProducts).length);
    assert.ok(stub.calls.length >= 2, "117 products need more than one request");
    assert.ok(stub.calls.every((url) => url.hostname === "api.coinbase.com" && url.searchParams.getAll("product_ids").length <= 60));
  } finally { stub.restore(); }
});

test("the route drops disabled, offline and non-finite products rather than sending zeros, and memoises success", async () => {
  resetLive();
  setStreamReaderForTests(async () => null);
  const ids = Object.values(coinbaseProducts);
  const tokenIds = Object.keys(coinbaseProducts);
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, {
    [ids[1]]: { status: "offline" }, [ids[2]]: { trading_disabled: true }, [ids[3]]: { price: "abc" }, [ids[4]]: { price: "0" },
  }) }));
  try {
    const body = await (await getLivePrices()).json();
    for (const id of [tokenIds[1], tokenIds[2], tokenIds[3], tokenIds[4]]) assert.equal(body.prices[id], undefined, `${id} omitted`);
    assert.ok(body.prices[tokenIds[0]]);
    const before = stub.calls.length;
    await getLivePrices();
    assert.equal(stub.calls.length, before, "a repeat poll inside the window makes no upstream call");
  } finally { stub.restore(); }
});

test("an upstream failure is a 502 that is never cacheable", async () => {
  resetLive();
  setStreamReaderForTests(async () => null);
  const stub = coinbaseStub(async () => new Response("blocked", { status: 403 }));
  try {
    const response = await getLivePrices();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "No live prices are available." });
  } finally { stub.restore(); }
});

const profileTokenId = Object.keys(coinbaseProducts).find((id) => canonicalTokens.some((token) => token.id === id));
const profileFor = (tokenId, seed = {}) => {
  const token = canonicalTokens.find((candidate) => candidate.id === tokenId);
  const client = createFakeSupabase({ seed: {
    tokens: [{ id: token.id, name: token.name, symbol: token.symbol, chain_id: token.chainId, contract_address: token.contractAddress, is_native: token.isNative, category: token.category, description: token.identityNote }],
    chains: [{ id: token.chainId, name: token.chainName }],
    token_metric_observations: [
      { id: 1, token_id: token.id, chain_id: token.chainId, metric_id: "price_usd", provider_id: "coingecko", value: 1.23, status: "available", observed_at: "2026-11-12T00:00:00.000Z", collected_at: "2026-11-12T00:00:00.000Z", source_field: "current_price", note: null },
    ],
    ...seed,
  } }).client;
  return getLiveTokenProfile(tokenId, client);
};

test("a server-rendered profile shows the live Coinbase price, attributed to the live exchange slot", async () => {
  resetLive();
  const product = coinbaseProducts[profileTokenId];
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, { [product]: { price: "77.7", price_percentage_change_24h: "3.5" } }) }));
  try {
    const profile = await profileFor(profileTokenId);
    assert.equal(profile.token.priceUsd, 77.7, "the live price replaces the stored 1.23");
    assert.equal(profile.token.change24hPct, 3.5);
    assert.equal(profile.token.metricSources.priceUsd.providerId, "binance");
    assert.match(profile.token.metricSources.priceUsd.note, /Coinbase spot last trade, USD-quoted/);
  } finally { stub.restore(); }
});

test("a failing live fetch falls back to the stored CoinGecko price instead of failing the page", async () => {
  resetLive();
  const otherId = Object.keys(coinbaseProducts).filter((id) => canonicalTokens.some((token) => token.id === id))[1];
  const stub = coinbaseStub(async () => new Response("blocked", { status: 403 }));
  try {
    const profile = await profileFor(otherId);
    assert.equal(profile.token.priceUsd, 1.23);
    assert.equal(profile.token.metricSources.priceUsd.providerId, "coingecko");
  } finally { stub.restore(); }
});

test("a 429 is retried once, and the User-Agent identifies the app", async () => {
  resetLive();
  let attempts = 0;
  const seenAgents = [];
  const realFetchLocal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenAgents.push(init?.headers?.["user-agent"]);
    attempts += 1;
    return attempts === 1 ? new Response("slow down", { status: 429 }) : Response.json({ products: productsFor(new URL(String(url))) });
  };
  try {
    const response = await getLivePrices();
    assert.equal(response.status, 200);
    assert.ok(attempts >= 3, "the first batch was retried, and the second batch ran");
    assert.ok(seenAgents.every((agent) => /^tokensam\//.test(agent)));
  } finally { globalThis.fetch = realFetchLocal; }
});

test("when a refresh fails, recent prices are still served with their original asOf, and not after two minutes", async () => {
  resetLive();
  const realNow = Date.now;
  const t0 = realNow.call(Date);
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url) }));
  try {
    Date.now = () => t0;
    const first = await (await getLivePrices()).json();
    stub.restore();

    const failing = coinbaseStub(async () => new Response("down", { status: 500 }));
    Date.now = () => t0 + 30_000;
    const stale = await getLivePrices();
    assert.equal(stale.status, 200, "30 s old prices still served after a failed refresh");
    assert.equal((await stale.json()).asOf, first.asOf, "asOf stays the original fetch time, so the client ages it out honestly");

    Date.now = () => t0 + 130_000;
    assert.equal((await getLivePrices()).status, 502, "past two minutes nothing usable remains");
    failing.restore();
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
});

const NOW_MS = () => Date.now();
const firstBoth = Object.keys(coinbaseProducts).find((id) => binanceSymbols[id]);
const binanceOnly = canonicalTokens.find((token) => binanceSymbols[token.id] && !coinbaseProducts[token.id])?.id;

function streams({ coinbase = null, binance = null } = {}) {
  setStreamReaderForTests(async (source) => (source === "coinbase" ? coinbase : binance));
}

test("Coinbase is preferred where it lists the token, and Binance fills in the tokens Coinbase does not", async () => {
  resetLive();
  const at = NOW_MS();
  streams({
    coinbase: { [coinbaseProducts[firstBoth]]: { p: 10, c: 1, at } },
    binance: { [binanceSymbols[firstBoth]]: { p: 99, c: 9, at }, [binanceSymbols[binanceOnly]]: { p: 0.5, c: -3, at } },
  });
  const live = await readLivePrices();
  assert.deepEqual(live.get(firstBoth), { p: 10, c: 1, at, source: "coinbase" }, "Coinbase wins when both quote the token");
  assert.deepEqual(live.get(binanceOnly), { p: 0.5, c: -3, at, source: "binance" }, "a Binance-only token is served from Binance");
  const body = await (await getLivePrices()).json();
  assert.deepEqual(body.prices[binanceOnly], { p: 0.5, c: -3, s: "binance" });
});

test("a Coinbase price past the age limit falls through to Binance, and a too-old Binance price is dropped", async () => {
  resetLive();
  const at = NOW_MS();
  const old = at - LIVE_MAX_AGE_MS - 1_000;
  streams({
    coinbase: { [coinbaseProducts[firstBoth]]: { p: 10, c: 1, at: old } },
    binance: { [binanceSymbols[firstBoth]]: { p: 11, c: 2, at }, [binanceSymbols[binanceOnly]]: { p: 0.5, c: -3, at: old } },
  });
  const live = await readLivePrices();
  assert.equal(live.get(firstBoth).source, "binance");
  assert.equal(live.get(binanceOnly), undefined, "a halted or very quiet market is not served as live");
});

test("with the Coinbase stream down, Coinbase REST covers its tokens while Binance still fills in the rest", async () => {
  resetLive();
  const at = NOW_MS();
  streams({ coinbase: null, binance: { [binanceSymbols[binanceOnly]]: { p: 0.5, c: -3, at } } });
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, { [coinbaseProducts[firstBoth]]: { price: "42", price_percentage_change_24h: "4" } }) }));
  try {
    const live = await readLivePrices();
    assert.deepEqual([live.get(firstBoth).p, live.get(firstBoth).source], [42, "coinbase"]);
    assert.equal(live.get(binanceOnly).source, "binance");
  } finally { stub.restore(); }
});

test("a profile for a Binance-only token shows the Binance price with Binance's own note", async () => {
  resetLive();
  const at = NOW_MS();
  streams({ binance: { [binanceSymbols[binanceOnly]]: { p: 0.77, c: 5, at } } });
  const stub = coinbaseStub(async () => new Response("down", { status: 500 }));
  try {
    const profile = await profileFor(binanceOnly);
    assert.equal(profile.token.priceUsd, 0.77);
    assert.equal(profile.token.change24hPct, 5);
    assert.match(profile.token.metricSources.priceUsd.note, /Binance spot last trade, USDT-quoted/);
  } finally { stub.restore(); setStreamReaderForTests(null); }
});

test("the Durable Object feed parsers read Binance miniTicker and Coinbase ticker frames and reject junk", async () => {
  const { parseBinanceFrame, parseCoinbaseFrame } = await import("../cloudflare/price-stream.ts");
  const tick = parseBinanceFrame({ stream: "btcusdt@miniTicker", data: { s: "BTCUSDT", c: "110", o: "100" } });
  assert.equal(tick.key, "BTCUSDT");
  assert.equal(tick.p, 110);
  assert.ok(Math.abs(tick.c - 10) < 1e-9, "24h change is (last / open - 1) x 100");
  assert.equal(parseBinanceFrame({ data: { s: "X", c: "1", o: "0" } }), null, "a zero open would make the change infinite");
  assert.equal(parseBinanceFrame({ result: null, id: 1 }), null);
  const frame = { channel: "ticker", events: [{ tickers: [{ product_id: "BTC-USD", price: "100", price_percent_chg_24_h: "-2.5" }, { product_id: "BAD-USD", price: "x", price_percent_chg_24_h: "1" }] }] };
  assert.deepEqual(parseCoinbaseFrame(frame), [{ key: "BTC-USD", p: 100, c: -2.5 }]);
  assert.deepEqual(parseCoinbaseFrame({ channel: "subscriptions", events: [] }), []);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown"}`); }
}
console.log(`${cases.length - failures}/${cases.length} live-price checks passed.`);
if (failures > 0) process.exitCode = 1;

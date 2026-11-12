import assert from "node:assert/strict";

import { applyLivePrices, livePricesUrl, tokenIdForSymbol, DEFAULT_LIVE_PRICES_PATH, LIVE_PRICE_MAX_AGE_MS } from "../src/lib/ui/live-prices.ts";
import { binanceSymbols } from "../src/data/binance-token-mappings.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { GET as getLivePrices } from "../src/app/api/live-prices/route.ts";
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } },
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5, c7: 8.75 } },
  }, NOW);

  assert.equal(row.change7dPct, 8.75);
  assert.equal(row.metricSources.change7dPct.providerId, "binance");
  assert.match(row.metricSources.change7dPct.note, /7-day rolling opening price/);
});

test("a missing or unusable 7-day change leaves the stored one untouched", () => {
  // The 7-day figure is supplementary: the live price must still apply without it.
  for (const entry of [{ p: 123.45, c: -2.5 }, { p: 123.45, c: -2.5, c7: Number.NaN }]) {
    const [row] = applyLivePrices([token(MAPPED_ID)], { asOf: fresh, prices: { [MAPPED_SYMBOL]: entry } }, NOW);
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5, c7: 8.75 } },
  }, NOW);
  assert.notEqual(moved, input);
  assert.equal(moved[0].change7dPct, 8.75);
});

test("market cap scales with the price move, and Vol / mcap follows", () => {
  // Price doubles: market cap must double, and volume/mcap must halve, or the row would
  // contradict itself. Volume is untouched -- a price tick does not change what was traded.
  const [row] = applyLivePrices([token(MAPPED_ID)], {
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 200, c: 5 } },
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 100, c: 1 } },
  }, NOW);
  assert.equal(row.marketCapUsd, 1000);
  assert.equal(row.calculated.volume_to_market_cap, 0.05);
});

test("an unusable price or market cap leaves both the cap and the ratio alone", () => {
  for (const overrides of [{ priceUsd: 0 }, { priceUsd: null }, { marketCapUsd: null }]) {
    const [row] = applyLivePrices([token(MAPPED_ID, overrides)], {
      asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 200, c: 5 } },
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 200, c: 5 } },
  }, NOW);

  assert.equal(row.fdvUsd, 4000, "200 x 20");
  assert.equal(row.metricSources.fdvUsd.providerId, "binance");
  assert.match(row.metricSources.fdvUsd.note, /Supply is unchanged/);
});

test("FDV without a derivable supply keeps the stored figure", () => {
  for (const overrides of [{ fdvSupply: null }, { fdvSupply: 0 }, { fdvSupply: undefined }]) {
    const [row] = applyLivePrices([token(MAPPED_ID, overrides)], {
      asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 200, c: 5 } },
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
    asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 999, c: 99 } },
  }, NOW);
  assert.equal(row.priceUsd, 100);
});

test("a stale or malformed payload is ignored in favour of the server-rendered value", () => {
  const input = [token(MAPPED_ID)];
  const stale = new Date(NOW - LIVE_PRICE_MAX_AGE_MS - 1_000).toISOString();
  const prices = { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } };

  assert.equal(applyLivePrices(input, { asOf: stale, prices }, NOW), input, "stale payload ignored");
  assert.equal(applyLivePrices(input, { asOf: "not-a-date", prices }, NOW), input, "unparseable asOf ignored");
  assert.equal(applyLivePrices(input, null, NOW), input, "no payload ignored");
  assert.equal(
    applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: Number.NaN, c: 1 } } }, NOW)[0].priceUsd,
    100,
    "non-finite price ignored rather than rendered",
  );
});

test("an unchanged poll returns the same array reference, so React re-renders nothing", () => {
  const input = [token(MAPPED_ID, { priceUsd: 123.45, change24hPct: -2.5 })];
  const same = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.45, c: -2.5 } } }, NOW);
  assert.equal(same, input, "identical values must not produce a new array");

  const moved = applyLivePrices(input, { asOf: fresh, prices: { [MAPPED_SYMBOL]: { p: 123.46, c: -2.5 } } }, NOW);
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

test("every Coinbase product resolves back to exactly one canonical token", () => {
  const products = Object.values(coinbaseProducts);
  assert.equal(new Set(products).size, products.length, "no two tokens share a product");
  for (const [tokenId, product] of Object.entries(coinbaseProducts)) assert.equal(tokenIdForSymbol(product), tokenId);
});

const realFetch = globalThis.fetch;
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
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, { [MAPPED_SYMBOL]: { price: "123.45", price_percentage_change_24h: "-2.5" } }) }));
  try {
    const response = await getLivePrices();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.prices[MAPPED_SYMBOL], { p: 123.45, c: -2.5 });
    assert.equal(Object.keys(body.prices).length, Object.keys(coinbaseProducts).length);
    assert.ok(stub.calls.length >= 2, "117 products need more than one request");
    assert.ok(stub.calls.every((url) => url.hostname === "api.coinbase.com" && url.searchParams.getAll("product_ids").length <= 60));
  } finally { stub.restore(); }
});

test("the route drops disabled, offline and non-finite products rather than sending zeros, and memoises success", async () => {
  const ids = Object.values(coinbaseProducts);
  const stub = coinbaseStub(async (url) => Response.json({ products: productsFor(url, {
    [ids[1]]: { status: "offline" }, [ids[2]]: { trading_disabled: true }, [ids[3]]: { price: "abc" }, [ids[4]]: { price: "0" },
  }) }));
  try {
    // The memo from the previous test is still fresh, so expire it by waiting past the window.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const body = await (await getLivePrices()).json();
    for (const id of [ids[1], ids[2], ids[3], ids[4]]) assert.equal(body.prices[id], undefined, `${id} omitted`);
    assert.ok(body.prices[ids[0]]);
    const before = stub.calls.length;
    await getLivePrices();
    assert.equal(stub.calls.length, before, "a repeat poll inside the window makes no upstream call");
  } finally { stub.restore(); }
});

test("an upstream failure is a 502 that is never cacheable", async () => {
  const stub = coinbaseStub(async () => new Response("blocked", { status: 403 }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const response = await getLivePrices();
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Coinbase returned HTTP 403." });
  } finally { stub.restore(); }
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown"}`); }
}
console.log(`${cases.length - failures}/${cases.length} live-price checks passed.`);
if (failures > 0) process.exitCode = 1;

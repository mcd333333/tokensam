import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { liveSourceFor } from "../src/lib/ui/live-source.ts";
import { directFeedSize, directFeedSubscribeMessage } from "../src/lib/ui/coinbase-direct-feed.ts";
import { binanceDirectFeedSize, binanceStreamUrl } from "../src/lib/ui/binance-direct-feed.ts";
import { TECHNICAL_PROVENANCE } from "../src/lib/ui/data-language.ts";
import { coinbaseProducts } from "../src/data/coinbase-token-mappings.ts";
import { binanceSymbols } from "../src/data/binance-symbols.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

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

test("Data provenance no longer lists the reference token prices or the DeFiLlama coins API", () => {
  assert.ok(!TECHNICAL_PROVENANCE.some((item) => /reference token price/i.test(item.dataset)));
  assert.ok(!TECHNICAL_PROVENANCE.some((item) => /coins API/i.test(item.provider)));
  assert.deepEqual(TECHNICAL_PROVENANCE.map((item) => item.dataset), ["Market data", "Live exchange price", "Protocol data", "DEX market data"], "the other datasets are unchanged");
});

test("Sources & methodology has no Data freshness section, and the treatment parameters run in two columns", () => {
  const source = read("../src/components/SourcesMethodology.tsx");
  assert.doesNotMatch(source, /sources-freshness|Data freshness|freshness-list|referencePrice/, "the freshness section and the reference-price note are gone");
  assert.match(source, /<h3 id="sources-treatment">Data treatment<\/h3>/);
  assert.match(source, /<ul className="method-list method-list-columns">/, "the treatment list uses the two-column style");
  assert.match(source, /<h3 className="methodology-subhead">Limitations<\/h3>/, "limitations are kept");
  const items = source.slice(source.indexOf("method-list-columns"), source.indexOf("methodology-subhead")).match(/<li>/g) ?? [];
  assert.equal(items.length, 7, "all seven treatment parameters are still listed");
});

test("the intro text runs the full width, justified, and the treatment list is two columns that collapse on small screens", () => {
  const css = read("../src/app/globals.css");
  const lede = css.match(/\.methodology-lede \{([^}]*)\}/)?.[1] ?? "";
  assert.match(lede, /text-align:\s*justify/);
  assert.match(lede, /max-width:\s*none/, "no longer capped at 72ch");
  assert.match(css, /\.methodology-grid \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, "a single full-width column now that freshness is gone");
  assert.match(css, /\.method-list\.method-list-columns \{[^}]*columns:\s*2/);
  assert.match(css, /\.method-list-columns li \{[^}]*break-inside:\s*avoid/, "an item is never split across the two columns");
  // The narrow-screen override sits indented inside a media query, after the base rule.
  assert.match(css, /\n[ \t]+\.method-list\.method-list-columns \{\s*columns:\s*1/, "one column on narrow screens");
  assert.ok(css.search(/\n[ \t]+\.method-list\.method-list-columns/) > css.search(/\n\.method-list\.method-list-columns/), "override comes after the base rule");
  assert.match(css, /\n[ \t]+\.methodology-lede \{\s*text-align:\s*left/, "justified text is left-aligned on narrow screens, where it would leave wide gaps");
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
if (failures > 0) process.exitCode = 1;

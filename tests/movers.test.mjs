import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { buildDashboardTokens } from "../src/lib/data/live-data.ts";
import { MOVERS_PER_SIDE, formatVolumeCompact, selectMovers } from "../src/lib/ui/movers.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const candidate = (id, symbol, change24hPct, extra = {}) => ({ id, name: `${symbol} name`, symbol, logoUrl: null, change24hPct, ...extra });
const ids = (list) => list.map((mover) => mover.id);

const universe = [
  candidate("render-render", "RENDER", 8.42),
  candidate("solana-jup", "JUP", 7.15),
  candidate("base-aero", "AERO", 6.83),
  candidate("ethereum-uni", "UNI", 1.2),
  candidate("monero-xmr", "XMR", -3.21),
  candidate("cardano-ada", "ADA", -2.84),
  candidate("polygon-pol", "POL", -2.17),
  candidate("ethereum-link", "LINK", -0.5),
];

test("1-2. at most 5 gainers and 5 losers, each ranked by 24h change", () => {
  const { gainers, losers } = selectMovers([...universe, candidate("near-near", "NEAR", 3.1), candidate("sui-sui", "SUI", 0.4), candidate("aptos-apt", "APT", -1.1), candidate("ton-ton", "TON", -0.2)].reverse());
  assert.equal(MOVERS_PER_SIDE, 5);
  assert.deepEqual(ids(gainers), ["render-render", "solana-jup", "base-aero", "near-near", "ethereum-uni"]);
  assert.deepEqual(ids(losers), ["monero-xmr", "cardano-ada", "polygon-pol", "aptos-apt", "ethereum-link"]);
  assert.ok(gainers.every((mover) => mover.change24hPct > 0));
  assert.ok(losers.every((mover) => mover.change24hPct < 0));
});

test("fewer than 5 valid values show only what exists; nothing is padded or fabricated", () => {
  const { gainers, losers } = selectMovers([candidate("a-a", "A", 2), candidate("b-b", "B", -1), candidate("c-c", "C", null)]);
  assert.deepEqual(ids(gainers), ["a-a"]);
  assert.deepEqual(ids(losers), ["b-b"]);
  assert.deepEqual(selectMovers([]), { gainers: [], losers: [], active: [], inactive: [] });
});

test("9. missing, null and non-finite 24h values are excluded; 0% is neither a gain nor a loss", () => {
  const { gainers, losers } = selectMovers([
    candidate("a-a", "A", null), candidate("b-b", "B", undefined), candidate("c-c", "C", Number.NaN),
    candidate("d-d", "D", Number.POSITIVE_INFINITY), candidate("e-e", "E", 0), candidate("f-f", "F", 0.001),
  ]);
  assert.deepEqual(ids(gainers), ["f-f"]);
  assert.deepEqual(losers, []);
});

test("ties break on canonical token ID so the order is stable", () => {
  const { gainers } = selectMovers([candidate("z-z", "Z", 5), candidate("a-a", "A", 5)]);
  assert.deepEqual(ids(gainers), ["a-a", "z-z"]);
});

test("4. only the stored CoinGecko 24h price change is used (never 7d, market-cap or DEX values)", () => {
  const token = { id: "render-render", name: "Render", symbol: "RENDER", chain_id: "solana", contract_address: null, is_native: false, category: "AI", description: null };
  const row = (id, metric_id, provider_id, value, status = "available") => ({
    id, token_id: token.id, chain_id: "solana", metric_id, provider_id, value, status,
    observed_at: "2026-09-25T00:00:00.000Z", collected_at: "2026-09-25T00:00:00.000Z", source_field: metric_id, note: null,
  });
  const only7d = buildDashboardTokens([token], [], [row(1, "price_change_7d_pct", "coingecko", 40), row(2, "price_change_24h_pct", "dexscreener", 30)]);
  assert.deepEqual(selectMovers(only7d), { gainers: [], losers: [], active: [], inactive: [] });
  const unavailable = buildDashboardTokens([token], [], [row(3, "price_change_24h_pct", "coingecko", 12, "unavailable")]);
  assert.deepEqual(selectMovers(unavailable), { gainers: [], losers: [], active: [], inactive: [] });
  const with24h = buildDashboardTokens([token], [], [row(4, "price_change_24h_pct", "coingecko", "8.42"), row(5, "price_change_7d_pct", "coingecko", 40)]);
  assert.equal(selectMovers(with24h).gainers[0].change24hPct, 8.42);
});

test("8. identity is the canonical token ID: same-ticker tokens stay distinct; native and wrapped are separate", () => {
  const { gainers } = selectMovers([
    candidate("bitcoin-btc", "BTC", 3), candidate("ethereum-wbtc", "WBTC", 2.9),
    candidate("ethereum-usdc", "USDC", 0.02), candidate("solana-usdc", "USDC", 0.01),
  ]);
  assert.deepEqual(ids(gainers), ["bitcoin-btc", "ethereum-wbtc", "ethereum-usdc", "solana-usdc"]);
  const dup = selectMovers([candidate("x-x", "X", 1, { volume24hUsd: 5 }), candidate("x-x", "X", 9, { volume24hUsd: 7 })]);
  assert.deepEqual([dup.gainers.length, dup.active.length, dup.inactive.length], [1, 1, 1], "a token appears once per ranking");
  assert.equal(dup.gainers[0].change24hPct, 1, "the first occurrence is kept");
});

test("5. stored logos pass through unchanged; a missing logo stays null (monogram fallback)", () => {
  const logo = "https://coin-images.coingecko.com/coins/images/1/small/x.png";
  const { gainers } = selectMovers([candidate("a-a", "A", 2, { logoUrl: logo }), candidate("b-b", "B", 1, { logoUrl: undefined })]);
  assert.equal(gainers[0].logoUrl, logo);
  assert.equal(gainers[1].logoUrl, null);
  assert.match(source("src/components/SidebarMovers.tsx"), /<TokenLogo src=\{mover\.logoUrl\}/);
  assert.match(source("src/components/TokenLogo.tsx"), /token-logo-fallback/);
});

test("6. no additional API calls: movers reuse dashboard rows or stored observations and logos", () => {
  for (const path of ["src/lib/ui/movers.ts", "src/components/SidebarMovers.tsx"]) {
    assert.doesNotMatch(source(path), /fetch\(|lib\/providers|supabase/i, path);
  }
  const liveData = source("src/lib/data/live-data.ts");
  const body = liveData.slice(liveData.indexOf("async function getSidebarMoversUncached"), liveData.indexOf("export const getSidebarMovers"));
  assert.ok(body.includes("latest_token_metric_observations") && body.includes("readTokenLogos("));
  assert.doesNotMatch(body, /fetch\(|run[A-Z]\w*Collection|lib\/providers/);
  assert.match(source("src/app/page.tsx"), /selectMovers\(data\.tokens\)/);
});

test("7. each row links to the existing Token Profile route by canonical ID", () => {
  assert.match(source("src/components/SidebarMovers.tsx"), /href=\{`\/tokens\/\$\{mover\.id\}`\}/);
  assert.ok(existsSync(new URL("../src/app/tokens/[id]/page.tsx", import.meta.url)));
});

test("10, 12. no provider names or trading/recommendation language in the component", () => {
  const component = source("src/components/SidebarMovers.tsx");
  assert.doesNotMatch(component, /coingecko|defillama|dex ?screener/i);
  assert.doesNotMatch(component, /\b(buy|sell|bullish|bearish|signal|recommend\w*|advice|predict\w*|target|entry|exit)\b/i);
});

test("11. restrained colors: movers use the existing muted tones, no backgrounds, glow or animation", () => {
  const css = source("src/app/globals.css");
  const rules = css.slice(css.indexOf("/* 24H Movers"), css.indexOf(".sidebar-foot {"));
  assert.match(rules, /\.mover-up \{ color: var\(--positive\); \}/);
  assert.match(rules, /\.mover-down \{ color: var\(--negative\); \}/);
  assert.doesNotMatch(rules, /box-shadow|text-shadow|animation|@keyframes|#[0-9a-f]{3,6}/i);
  assert.match(css, /\.sidebar-movers \{ display: none; \}|\.sidebar-foot, \.sidebar-movers \{ display: none; \}/);
});

// ---- 24H Active: volume rankings ----

const vol = (id, volume24hUsd, change = null) => candidate(id, id.toUpperCase(), change, { volume24hUsd });

test("3-4. top 5 active (highest valid 24H volume) and top 5 inactive (lowest), ordered", () => {
  const tokens = [vol("a", 48.2e9), vol("b", 6.4e9), vol("c", 842e6), vol("d", 95.3e6), vol("e", 12e6), vol("f", 3e6), vol("g", 1.5e6)];
  const { active, inactive } = selectMovers(tokens.reverse());
  assert.deepEqual(ids(active), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(inactive), ["g", "f", "e", "d", "c"]);
});

test("5. null/unavailable/non-finite/negative volume is excluded from both volume rankings; a reported 0 is eligible", () => {
  const { active, inactive } = selectMovers([vol("a", null), vol("b", undefined), vol("c", Number.NaN), vol("d", -5), vol("e", 0), vol("f", 10)]);
  assert.deepEqual(ids(inactive), ["e", "f"], "missing volume is never ranked as the lowest");
  assert.deepEqual(ids(active), ["f", "e"]);
  assert.equal(inactive[0].volume24hUsd, 0);
});

test("6. tokens without a valid 24H change are excluded from gainers/losers but can still rank by volume", () => {
  const { gainers, losers, active } = selectMovers([vol("a", 100, null), vol("b", 50, 2), vol("c", 10, -3)]);
  assert.deepEqual([ids(gainers), ids(losers), ids(active)], [["b"], ["c"], ["a", "b", "c"]]);
});

test("volume formatting is compact with at most three significant digits", () => {
  assert.deepEqual([48.2e9, 6.4e9, 842e6, 95.3e6, 0].map(formatVolumeCompact), ["$48.2B", "$6.4B", "$842M", "$95.3M", "$0"]);
});

test("sidebar: labels, neutral volume styling, profile links; Research navigation available at every screen size", () => {
  const component = source("src/components/SidebarMovers.tsx");
  for (const label of ["24H Movers", "Top gainers", "Top losers", "24H Active", "Top active", "Top inactive"]) assert.ok(component.includes(label), label);
  assert.equal((component.match(/href=\{`\/tokens\/\$\{(mover|row)\.id\}`\}/g) ?? []).length, 2, "both row types link to the Token Profile");
  assert.match(component, /className="mover-change mover-volume"/);
  assert.doesNotMatch(component.slice(component.indexOf("function VolumeList")), /mover-up|mover-down|tone-/, "volume rows are not coloured as gains or losses");
  const css = source("src/app/globals.css");
  assert.match(css, /\n\.sidebar-nav \{ display: grid;/, "desktop: Research navigation remains available");
  const tablet = css.slice(css.indexOf("@media (max-width: 1024px)"));
  assert.match(tablet, /\.sidebar-nav \{ display: flex;/, "tablet/mobile top bar keeps its navigation");
  assert.match(css, /\.mover-volume \{ color: var\(--ink\); \}/);
});

test("10. profile pages read change and volume from the same latest-observation view; no API calls", () => {
  const liveData = source("src/lib/data/live-data.ts");
  const body = liveData.slice(liveData.indexOf("async function getSidebarMoversUncached"), liveData.indexOf("export const getSidebarMovers"));
  assert.match(body, /\.in\("metric_id", \["price_change_24h_pct", "volume_24h_usd"\]\)/);
  assert.match(body, /from\("tokens"\)/, "same canonical token registry as the dashboard");
  assert.doesNotMatch(body, /fetch\(|lib\/providers/);
});

let failures = 0;
for (const { name, run } of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
console.log(`${cases.length - failures}/${cases.length} movers checks passed.`);
if (failures > 0) process.exitCode = 1;

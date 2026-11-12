import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnvironment() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

// Usage: pnpm coverage:report [--out=docs/provider-coverage.md]
// Read-only: generates the provider coverage matrix from stored Supabase data. No provider calls, no writes.
const outArg = process.argv.slice(2).find((arg) => arg.startsWith("--out="));
const out = outArg ? outArg.slice("--out=".length) : null;
loadLocalEnvironment();

const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
const { readLatestObservations, readObservationWindow } = await import("../src/lib/data/observation-reads.ts");
const { canonicalTokens, phase15CanonicalTokens } = await import("../src/data/canonical-tokens.ts");
const { tokenCoverage } = await import("../src/data/provider-coverage.ts");
const { defillamaProtocolMappings } = await import("../src/data/defillama-protocol-mappings.ts");

const client = createSupabaseAdminClient();
const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const ids = canonicalTokens.map((token) => token.id);
const newIds = new Set(phase15CanonicalTokens.map((token) => token.id));
const PROVIDER_METRICS = { coingecko: 8, defillama_coins: 1, defillama: 3, dexpaprika: 9 };
const WRAPPED = [
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "so11111111111111111111111111111111111111112", "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0x5555555555555555555555555555555555555555", "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38",
  "0x5c7f8a570d578ed84e63fdfa7b1ee72deae1ae23",
];

const latest = await readLatestObservations(client, ids);
const priceHistory = await readObservationWindow(client, ids, [{ providerId: "coingecko", metricId: "price_usd" }], new Date(now.getTime() - 90 * DAY_MS));

async function latestCalculated() {
  const { data: newest, error } = await client.from("calculated_metric_observations").select("calculated_at").order("calculated_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const since = new Date(Date.parse(newest[0].calculated_at) - 2 * 60 * 60 * 1000).toISOString();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await client.from("calculated_metric_observations")
      .select("id,token_id,metric_id,status,calculated_at,unavailable_reason:provenance->>unavailable_reason")
      .gte("calculated_at", since).order("id").range(offset, offset + 999);
    if (page.error) throw new Error(page.error.message);
    rows.push(...page.data);
    if (page.data.length < 1000) break;
  }
  const byKey = new Map();
  for (const row of rows.sort((a, b) => Date.parse(b.calculated_at) - Date.parse(a.calculated_at) || b.id - a.id)) {
    const key = `${row.token_id}|${row.metric_id}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return { rows: [...byKey.values()], calculatedAt: newest[0].calculated_at };
}
const calculated = await latestCalculated();
const { data: definitions } = await client.from("calculated_metric_definitions").select("id,source_scopes");
const scopesOf = new Map((definitions ?? []).map((row) => [row.id, row.source_scopes ?? ""]));

const rows = canonicalTokens.map((token) => {
  const coverage = tokenCoverage(token);
  const mine = latest.filter((row) => row.token_id === token.id);
  const provider = (id) => {
    const cover = coverage.find((item) => item.provider === id);
    const obs = mine.filter((row) => row.provider_id === id);
    const available = obs.filter((row) => row.status === "available");
    return { mapped: cover.status === "mapped", reason: cover.reason, detail: cover.detail, identifier: cover.identifier, returned: obs.length, available: available.length, missing: obs.filter((row) => row.status !== "available").map((row) => row.metric_id), scopes: [...new Set(obs.map((row) => row.scope))] };
  };
  const points = priceHistory.filter((row) => row.token_id === token.id && row.status === "available").map((row) => Date.parse(row.observed_at)).sort((a, b) => a - b);
  const spanDays = points.length >= 2 ? (points.at(-1) - points[0]) / DAY_MS : 0;
  const calc = calculated.rows.filter((row) => row.token_id === token.id);
  return {
    token, isNew: newIds.has(token.id),
    coingecko: provider("coingecko"), coins: provider("defillama_coins"), protocol: provider("defillama"), dex: provider("dexpaprika"),
    history: { points: points.length, spanDays },
    calc: { available: calc.filter((row) => row.status === "available").length, total: calc.length, unavailable: calc.filter((row) => row.status !== "available") },
    recordId: defillamaProtocolMappings.find((mapping) => mapping.tokenId === token.id)?.recordId ?? null,
  };
});

function summary(subset) {
  const sum = (pick) => subset.reduce((acc, row) => acc + pick(row), 0);
  const count = (pick) => subset.filter(pick).length;
  return {
    tokens: subset.length,
    chains: new Set(subset.map((row) => row.token.chainId)).size,
    categories: new Set(subset.map((row) => row.token.category)).size,
    coingecko: `${count((row) => row.coingecko.mapped)} / ${subset.length} (metrics ${sum((row) => row.coingecko.available)} / ${sum((row) => row.coingecko.returned)})`,
    history: `${count((row) => row.history.spanDays >= 85)} with ≥85 days of 90; ${count((row) => row.history.points >= 2)} with ≥2 price points`,
    coins: `${count((row) => row.coins.mapped && row.coins.available > 0)} / ${subset.length}`,
    protocol: `${count((row) => row.protocol.mapped)} / ${subset.length} (metrics ${sum((row) => row.protocol.available)} / ${sum((row) => row.protocol.returned)})`,
    dex: `${count((row) => row.dex.mapped)} / ${subset.length} (metrics ${sum((row) => row.dex.available)} / ${sum((row) => row.dex.returned)})`,
    calculated: `${sum((row) => row.calc.available)} / ${sum((row) => row.calc.total)}`,
  };
}
const baseline = summary(rows.filter((row) => !row.isNew));
const expanded = summary(rows);
const added = summary(rows.filter((row) => row.isNew));

const cell = (p, id) => {
  if (!p.mapped) return `— *${(p.reason ?? "unmapped").replaceAll("_", " ")}*`;
  const base = `${p.available}/${p.returned || PROVIDER_METRICS[id]}`;
  return p.missing.length ? `${base} (no ${p.missing.map((m) => m.replace(/_usd|_pct|_24h|_count/g, "").replaceAll("_", " ")).join(", ")})` : base;
};
const reasonRows = (key, providerLabel) => {
  const groups = new Map();
  for (const row of rows.filter((item) => !item[key].mapped)) {
    const reason = row[key].reason ?? "unmapped";
    const group = groups.get(reason) ?? { symbols: [], example: row[key].detail };
    group.symbols.push(row.token.symbol);
    groups.set(reason, group);
  }
  return [...groups.entries()].map(([reason, group]) => `| ${providerLabel} | \`${reason}\` | ${group.symbols.length}: ${group.symbols.join(", ")} | ${group.example} |`);
};
const calcCauses = new Map();
for (const row of rows) {
  for (const metric of row.calc.unavailable) {
    const scopes = scopesOf.get(metric.metric_id) ?? "";
    const cause = scopes.includes("protocol") && !row.protocol.mapped ? "No associated protocol mapping (protocol-based metric cannot apply)"
      : scopes.includes("market") && !row.dex.mapped ? "No exact-address DEX mapping (market-based metric cannot apply)"
      // Stored reasons are quoted as written; only token-specific suffixes differ between rows.
      : (metric.unavailable_reason ?? "No reason recorded").replace(/\s+/g, " ").slice(0, 160);
    const entry = calcCauses.get(cause) ?? { rows: 0, tokens: new Set() };
    entry.rows += 1;
    entry.tokens.add(row.token.symbol);
    calcCauses.set(cause, entry);
  }
}

const lines = [
  "# Provider coverage matrix (100 tokens)",
  "",
  `Generated by \`pnpm coverage:report\` from stored Supabase data on ${now.toISOString()}. Latest metrics calculation: ${calculated.calculatedAt}. Do not edit by hand; rerun the script after any coverage change.`,
  "",
  "Scopes never mix: **CoinGecko** and **DeFiLlama price** are TOKEN scope; **DeFiLlama protocol** is PROTOCOL scope (the associated protocol record, not token data; the cell shows the pinned record ID); **DexPaprika** is MARKET scope (exact-address DEX pairs only, not the whole market). A cell shows available/returned metrics for the latest observations; \"—\" means no mapping, with the reason code.",
  "",
  "## Before and after",
  "",
  "| Measure | Baseline 50 | Added 50 | Universe 100 |",
  "| --- | --- | --- | --- |",
  ...[["Tokens", "tokens"], ["Chains", "chains"], ["Categories", "categories"], ["CoinGecko (token)", "coingecko"], ["Historical price data (90D window)", "history"], ["DeFiLlama price (token)", "coins"], ["DeFiLlama protocol (protocol)", "protocol"], ["DexPaprika (market)", "dex"], ["Calculated metrics", "calculated"]]
    .map(([label, key]) => `| ${label} | ${baseline[key]} | ${added[key]} | ${expanded[key]} |`),
  "",
  "Chains and categories in the Added column count those used by the 50 new tokens (some are shared with the baseline).",
  "",
  "## Matrix",
  "",
  "| Token | Chain | Category | CoinGecko (token) | DeFiLlama price (token) | DeFiLlama protocol (protocol) | DexPaprika (market) | History (price, 90D) | Calculated |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.token.symbol}${row.isNew ? " ✦" : ""} | ${row.token.chainId} | ${row.token.category} | ${cell(row.coingecko, "coingecko")} | ${cell(row.coins, "defillama_coins")} | ${row.protocol.mapped ? `${cell(row.protocol, "defillama")} \`${row.recordId}\`` : cell(row.protocol, "defillama")} | ${cell(row.dex, "dexpaprika")} | ${row.history.points} pts / ${row.history.spanDays.toFixed(1)} d | ${row.calc.available}/${row.calc.total} |`),
  "",
  "✦ = added in Phase 15.",
  "",
  "## Why a provider has no mapping",
  "",
  "| Provider | Reason | Tokens | Explanation (example) |",
  "| --- | --- | --- | --- |",
  ...reasonRows("protocol", "DeFiLlama protocol"),
  ...reasonRows("dex", "DexPaprika"),
  "",
  "## Metrics a mapped provider did not return",
  "",
  "| Provider | Metric | Tokens |",
  "| --- | --- | --- |",
  ...["coingecko", "coins", "protocol", "dex"].flatMap((key) => {
    const byMetric = new Map();
    for (const row of rows.filter((item) => item[key].mapped)) for (const metric of row[key].missing) byMetric.set(metric, [...(byMetric.get(metric) ?? []), row.token.symbol]);
    return [...byMetric.entries()].map(([metric, symbols]) => `| ${{ coingecko: "CoinGecko", coins: "DeFiLlama price", protocol: "DeFiLlama protocol", dex: "DexPaprika" }[key]} | \`${metric}\` | ${symbols.length}: ${symbols.join(", ")} |`);
  }),
  "",
  "Unavailable values are stored as unavailable with a note, never as zero.",
  "",
  "## Why calculated metrics are unavailable",
  "",
  "| Cause | Unavailable metric rows | Tokens affected |",
  "| --- | --- | --- |",
  ...[...calcCauses.entries()].sort((a, b) => b[1].rows - a[1].rows).map(([cause, entry]) => `| ${cause} | ${entry.rows} | ${entry.tokens.size} |`),
  "",
  "## Scope integrity",
  "",
  `| Check | Result |`,
  `| --- | --- |`,
  `| Latest provider rows whose scope differs from the provider's scope | ${latest.filter((row) => ({ coingecko: "token", defillama_coins: "token", defillama: "protocol", dexscreener: "market" })[row.provider_id] !== row.scope).length} |`,
  `| Latest rows missing provider asset ID or mapping ID | ${latest.filter((row) => !row.provider_asset_id || !row.mapping_id).length} |`,
  `| Latest DexPaprika rows for tokens without a DEX mapping | ${latest.filter((row) => row.provider_id === "dexpaprika" && !rows.find((item) => item.token.id === row.token_id)?.dex.mapped).length} |`,
  `| Latest DeFiLlama protocol rows for tokens without a protocol mapping | ${latest.filter((row) => row.provider_id === "defillama" && !rows.find((item) => item.token.id === row.token_id)?.protocol.mapped).length} |`,
  `| Native tokens whose provider identifier is a known wrapped address (WETH, wSOL, WBNB, WAVAX, WHYPE, wS, WCRO) | ${latest.filter((row) => rows.find((item) => item.token.id === row.token_id)?.token.isNative && WRAPPED.some((address) => String(row.provider_asset_id ?? "").toLowerCase().includes(address))).length} |`,
  `| Latest DexPaprika rows for ETH, SOL, BNB, AVAX, BTC | ${latest.filter((row) => row.provider_id === "dexpaprika" && ["ethereum-eth", "solana-sol", "bnb-bnb", "avalanche-avax", "bitcoin-btc"].includes(row.token_id)).length} |`,
  "",
  "The wrapped-proxy exclusion migration (`20260928090000_exclude_wrapped_proxy_pairs.sql`) remains in effect; excluded rows are not read by the latest views.",
  "",
];
const markdown = lines.join("\n");
if (out) {
  writeFileSync(out, markdown);
  console.log(`Wrote ${out}.`);
}
console.log(JSON.stringify({ baseline, added, expanded }, null, 1));

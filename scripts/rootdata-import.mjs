import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.resolve(process.env.ROOTDATA_ENV_FILE || path.join(ROOT, ".env.local"));
const args = new Set(process.argv.slice(2));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const outputPath = path.resolve(outputArg?.slice("--output=".length) || path.join(ROOT, "exports", "rootdata-token-profiles.json"));
const partialPath = `${outputPath}.partial`;
const applyToSupabase = args.has("--apply");
const resume = args.has("--resume");
const applyExportArg = process.argv.find((arg) => arg.startsWith("--apply-export="));
const REFRESH_INTERVAL_DAYS = 14;
const EXPECTED_MATCHES = 148;

const aliasProjectIds = new Map(Object.entries({
  ZRX: 1222,
  TURBO: 13944,
  NEO: 31,
  KAVA: 258,
  S: 252,
  LINEA: 6022,
  XVS: 463,
  ORCA: 554,
  SPK: 7775,
  AERO: 9073,
  BAT: 48,
  BNB: 3894,
  ATOM: 27,
  CRV: 362,
  EIGEN: 2980,
  ENJ: 4,
  FDUSD: 4589,
  GRAM: 993,
  ICP: 73,
  JASMY: 93,
  JST: 481,
  MNT: 3913,
  MINA: 126,
  NMR: 63,
  ONDO: 3129,
  SEI: 2790,
  SKY: 24,
  STRK: 2751,
  LUNC: 249,
  TWT: 4409,
  USDC: 4138,
  WLD: 1843,
  XRP: 10,
  T: 997,
}).map(([symbol, id]) => [symbol, Number(id)]));
const unmatchedSymbols = new Set(["PAXG", "RLUSD", "XAUT", "TFUEL", "USDS", "WBTC"]);

function parseEnv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const secrets = parseEnv(envFile);
const rootdataKey = secrets.ROOTDATA_API_KEY;
const supabaseUrl = secrets.SUPABASE_URL?.replace(/\/$/, "");
const supabaseKey = secrets.SUPABASE_SECRET_KEY;
if (!rootdataKey || !supabaseUrl || !supabaseKey) {
  throw new Error("Set ROOTDATA_API_KEY, SUPABASE_URL, and SUPABASE_SECRET_KEY in ROOTDATA_ENV_FILE.");
}

let nextRootDataCallAt = 0;
async function rootdataPost(endpoint, payload = {}) {
  const wait = Math.max(0, nextRootDataCallAt - Date.now());
  if (wait) await delay(wait);
  nextRootDataCallAt = Date.now() + 1_050;
  const response = await fetch(`https://api.rootdata.com/open/${endpoint}`, {
    method: "POST",
    headers: {
      apikey: rootdataKey,
      language: "en",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.result !== 200) {
    throw new Error(`RootData ${endpoint} failed (HTTP ${response.status}, result ${body.result ?? "unknown"}).`);
  }
  return body.data;
}

async function getQuota() {
  const data = await rootdataPost("quotacredits");
  return { level: String(data.level || "unknown"), credits: Number(data.credits), totalCredits: Number(data.total_credits) };
}

async function getTokens() {
  const url = new URL(`${supabaseUrl}/rest/v1/tokens`);
  url.searchParams.set("select", "id,name,symbol,chain_id");
  url.searchParams.set("limit", "1000");
  const response = await fetch(url, { headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } });
  if (!response.ok) throw new Error(`Supabase token list failed (HTTP ${response.status}).`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Supabase token list response was not an array.");
  return rows;
}

async function searchProject(name) {
  const results = await rootdataPost("ser_inv", { query: name });
  if (!Array.isArray(results)) return null;
  const exact = results.filter((item) => item.type === 1 && normalize(item.name) === normalize(name));
  if (exact.length !== 1) return null;
  return exact[0];
}

function loadExistingPartial() {
  if (!resume || !fs.existsSync(partialPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(partialPath, "utf8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function socialField(social, key) {
  if (!social) return null;
  if (Array.isArray(social)) {
    const found = social.find((item) => normalize(item?.type || item?.name) === normalize(key));
    return typeof found?.url === "string" ? found.url : null;
  }
  return typeof social[key] === "string" ? social[key] : null;
}

function profileRow(token, match, profile, collectedAt) {
  const social = profile.social_media ?? {};
  return {
    token_id: token.id,
    chain_id: token.chain_id,
    rootdata_project_id: Number(profile.project_id),
    rootdata_project_name: profile.project_name || match.name,
    token_symbol: profile.token_symbol || token.symbol,
    rootdata_url: profile.rootdataurl || match.rootdataurl || null,
    logo_url: profile.logo || match.logo || null,
    establishment_date: profile.establishment_date || null,
    tags: Array.isArray(profile.tags) ? profile.tags : [],
    one_liner: profile.one_liner || null,
    description: profile.description || null,
    website_url: socialField(social, "website"),
    social_media: social,
    total_funding: profile.total_funding ?? null,
    investors: Array.isArray(profile.investors) ? profile.investors : [],
    static_collected_at: collectedAt,
    financial_collected_at: collectedAt,
    updated_at: collectedAt,
    match_method: match.match_method,
  };
}

async function applyRows(rows) {
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50).map(({ match_method, ...row }) => row);
    const response = await fetch(`${supabaseUrl}/rest/v1/rootdata_project_profiles?on_conflict=token_id`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        authorization: `Bearer ${supabaseKey}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      throw new Error(`Supabase RootData upsert failed for batch ${offset / 50 + 1} (HTTP ${response.status}). Apply the RootData migration first.`);
    }
  }
}

async function applyExistingExport(exportFile) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(exportFile), "utf8"));
  if (parsed.source !== "RootData Open API"
    || parsed.token_count !== 154
    || parsed.matched_count !== EXPECTED_MATCHES
    || parsed.unmatched_count !== 6
    || !Array.isArray(parsed.entries)
    || parsed.entries.length !== EXPECTED_MATCHES) {
    throw new Error("Export did not match the expected 154-token / 148-profile RootData snapshot.");
  }

  const tokens = await getTokens();
  if (tokens.length !== parsed.token_count) {
    throw new Error(`Expected ${parsed.token_count} app tokens; found ${tokens.length}. Refusing to apply a stale export.`);
  }
  const tokensById = new Map(tokens.map((token) => [String(token.id), token]));
  const tokenIds = new Set();
  const projectIds = new Set();
  for (const entry of parsed.entries) {
    const tokenId = String(entry.token_id);
    const projectId = Number(entry.rootdata_project_id);
    const token = tokensById.get(tokenId);
    if (!token || String(token.chain_id) !== String(entry.chain_id)) {
      throw new Error(`Export token ${tokenId} no longer matches the live token universe.`);
    }
    if (!Number.isInteger(projectId) || projectId <= 0 || tokenIds.has(tokenId) || projectIds.has(projectId)) {
      throw new Error("Export contains an invalid or duplicate token / RootData project ID.");
    }
    tokenIds.add(tokenId);
    projectIds.add(projectId);
  }

  await applyRows(parsed.entries);
  console.log(JSON.stringify({ exportFile: path.resolve(exportFile), applied: parsed.entries.length, rootdataCalls: 0 }));
}

async function main() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (applyExportArg) {
    await applyExistingExport(applyExportArg.slice("--apply-export=".length));
    return;
  }
  const quotaBefore = await getQuota();
  console.log(`RootData plan: ${quotaBefore.level}; credits available: ${quotaBefore.credits}.`);

  const tokens = await getTokens();
  if (tokens.length !== 154) throw new Error(`Expected 154 app tokens; found ${tokens.length}. Refusing to use a stale token list.`);

  const matches = [];
  const unresolved = [];
  for (const [index, token] of tokens.entries()) {
    const symbol = String(token.symbol).toUpperCase();
    if (unmatchedSymbols.has(symbol)) {
      unresolved.push({ token_id: token.id, name: token.name, symbol: token.symbol, reason: "previously unconfirmed" });
      continue;
    }
    if (aliasProjectIds.has(symbol)) {
      matches.push({ token, project_id: aliasProjectIds.get(symbol), name: token.name, match_method: "ticker-confirmed alias" });
    } else {
      const project = await searchProject(token.name);
      if (project) matches.push({ token, project_id: Number(project.id), name: project.name, rootdataurl: project.rootdataurl, logo: project.logo, match_method: "exact project name" });
      else unresolved.push({ token_id: token.id, name: token.name, symbol: token.symbol, reason: "no unique exact RootData project-name match" });
    }
    if ((index + 1) % 10 === 0) console.log(`Matched ${matches.length} of ${index + 1}/${tokens.length} token rows.`);
  }

  const projectIds = new Set(matches.map((match) => match.project_id));
  if (matches.length !== EXPECTED_MATCHES || projectIds.size !== matches.length) {
    console.error(JSON.stringify({ matched: matches.length, uniqueProjectIds: projectIds.size, unresolved }));
    throw new Error(`Expected ${EXPECTED_MATCHES} unique confirmed RootData projects; got ${matches.length}. No paid profile calls were made.`);
  }

  const neededCredits = matches.length * 2;
  if (quotaBefore.credits < neededCredits + 50) {
    throw new Error(`Need ${neededCredits} credits plus a 50-credit buffer; only ${quotaBefore.credits} are available. No paid profile calls were made.`);
  }

  const entriesByTokenId = new Map(loadExistingPartial().map((entry) => [entry.token_id, entry]));
  for (const [index, match] of matches.entries()) {
    if (entriesByTokenId.has(match.token.id)) continue;
    let profile;
    try {
      profile = await rootdataPost("get_item", { project_id: match.project_id, include_investors: true });
      if (Number(profile.project_id) !== match.project_id) throw new Error("RootData returned a different project ID.");
      const profileSymbol = String(profile.token_symbol || "").toUpperCase();
      if (match.match_method.includes("alias") && profileSymbol && profileSymbol !== String(match.token.symbol).toUpperCase()) {
        throw new Error(`RootData ticker ${profileSymbol} does not confirm app ticker ${match.token.symbol}.`);
      }
      const collectedAt = new Date().toISOString();
      entriesByTokenId.set(match.token.id, profileRow(match.token, match, profile, collectedAt));
    } catch (error) {
      console.error(`Profile ${index + 1}/${matches.length} failed for ${match.token.symbol}: ${error instanceof Error ? error.message : "request error"}`);
      fs.writeFileSync(partialPath, JSON.stringify({ entries: [...entriesByTokenId.values()] }, null, 2));
      throw error;
    }
    if ((index + 1) % 10 === 0 || index + 1 === matches.length) {
      fs.writeFileSync(partialPath, JSON.stringify({ entries: [...entriesByTokenId.values()] }, null, 2));
      console.log(`Pulled ${entriesByTokenId.size}/${matches.length} project profiles.`);
    }
  }

  const entries = matches.map((match) => entriesByTokenId.get(match.token.id));
  if (entries.some((entry) => !entry)) throw new Error("Some profile records are missing; the partial file was kept for --resume.");
  const result = {
    source: "RootData Open API",
    retrieved_at: new Date().toISOString(),
    token_count: tokens.length,
    matched_count: entries.length,
    unmatched_count: unresolved.length,
    unmatched_tokens: unresolved,
    plan: quotaBefore.level,
    refresh_policy: {
      static_fields: "one-time pull",
      financial_fields: ["total_funding", "investors"],
      interval_days: REFRESH_INTERVAL_DAYS,
      detail: "RootData Basic returns funding totals and investor summaries; detailed funding-round records require a higher API plan.",
    },
    entries,
  };
  fs.writeFileSync(partialPath, JSON.stringify(result, null, 2));
  if (applyToSupabase) await applyRows(entries);
  fs.renameSync(partialPath, outputPath);

  const quotaAfter = await getQuota();
  console.log(JSON.stringify({ outputPath, matched: entries.length, unmatched: unresolved.length, creditsBefore: quotaBefore.credits, creditsAfter: quotaAfter.credits, creditsUsed: quotaBefore.credits - quotaAfter.credits, supabaseApplied: applyToSupabase }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "RootData import failed.");
  process.exitCode = 1;
});

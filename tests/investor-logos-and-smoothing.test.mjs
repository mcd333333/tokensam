import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { VOLUME_SMOOTHING_WINDOW, rollingMedian, smoothGranularPoints } from "../src/lib/data/series-smoothing.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const point = (i, valueUsd, extra = {}) => ({ timestamp: new Date(Date.UTC(2026, 10, 19, 0, i * 15)).toISOString(), valueUsd, sourceId: `obs:${i}`, ...extra });

// ---- investor logos ----
const logos = readJson("../src/data/investor-logos.json").logos;
const profiles = readJson("../src/data/cryptorank-token-profiles.json");
const investorNames = [...new Set(profiles.entries.flatMap((entry) => entry.funding.investors ?? []))];

const LOCAL_LOGO = /^\/investor-logos\/[a-z0-9-]+\.png$/;

test("every investor in the CryptoRank-sourced profiles has a logo", () => {
  assert.equal(investorNames.length, 64);
  assert.deepEqual(investorNames.filter((name) => !logos[name]), []);
});

test("every logo is either an https image on a RootData host or a bare PNG name in public/investor-logos, the only two the page renders", () => {
  for (const [name, url] of Object.entries(logos)) {
    if (LOCAL_LOGO.test(url)) continue;
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:", name);
    assert.ok(parsed.hostname.endsWith(".rootdata.com"), `${name}: ${parsed.hostname}`);
    assert.match(parsed.pathname, /\.(jpg|jpeg|png)$/i, name);
  }
});

test("the two investors RootData has no image for use files shipped in public/investor-logos", () => {
  const local = Object.entries(logos).filter(([, url]) => LOCAL_LOGO.test(url));
  assert.deepEqual(local.map(([name]) => name).sort(), ["Galaxy Digital Ventures", "Mithril Capital"]);
  for (const [name, url] of local) {
    const file = readFileSync(new URL(`../public${url}`, import.meta.url));
    assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name}: a real PNG`);
    const width = file.readUInt32BE(16); const height = file.readUInt32BE(20);
    assert.equal(width, height, `${name}: square, so the circular crop does not cut it`);
    assert.ok(width >= 64 && width <= 512, `${name}: ${width}px`);
    assert.ok(file.length < 40_000, `${name}: ${file.length} bytes`);
  }
});

test("the profile page only accepts a bare file name in the investor logo folder as a local logo", () => {
  const source = readFileSync(new URL("../src/components/TokenProfile.tsx", import.meta.url), "utf8");
  assert.match(source, /function localInvestorLogo\(value: unknown\): string \| null/);
  assert.ok(source.includes("/^\\/investor-logos\\/[a-z0-9-]+\\.png$/"), "the accepted pattern is a single file name under /investor-logos/");
  assert.ok(source.includes("image.hostname.endsWith(\".rootdata.com\") ? image.href : localInvestorLogo(logo)"), "RootData-hosted images are still preferred");
});

test("the map has no stray entries: every key is an investor name used by a profile", () => {
  const known = new Set(investorNames);
  assert.deepEqual(Object.keys(logos).filter((name) => !known.has(name)), []);
});

test("the four logos found by RootData search are present", () => {
  for (const name of ["Oak HC/FT", "Valor Equity Partners", "Bank of America", "DRW"]) assert.ok(logos[name], name);
});

// ---- volume smoothing ----
test("rolling median is centred in the interior and keeps a full window at the ends", () => {
  assert.deepEqual(rollingMedian([1, 2, 3, 4, 5], 3), [2, 2, 3, 4, 4], "the end windows slide inward instead of shrinking");
  assert.deepEqual(rollingMedian([1, 2, 3], 3), [2, 2, 2]);
  assert.deepEqual(rollingMedian([1, 3], 7), [2, 2], "fewer readings than the window: the median of all of them");
  assert.deepEqual(rollingMedian([5], 7), [5]);
  assert.deepEqual(rollingMedian([], 7), []);
});

test("the alternating readings of a noisy token collapse to its baseline", () => {
  // Real readings from theta-tfuel on 2026-11-19, newest last: baseline ~260k with periodic ~430-530k flips.
  const raw = [272686, 272875, 526341, 274525, 264540, 261514, 510253, 483792, 258160, 259022, 432898, 257618];
  const smoothed = rollingMedian(raw, VOLUME_SMOOTHING_WINDOW);
  const spread = (values) => Math.max(...values) / Math.min(...values);
  assert.ok(spread(raw) > 1.9, "the raw series swings by about 2x");
  assert.ok(spread(smoothed) < 1.25, `the smoothed series stays within 25% (got ${spread(smoothed).toFixed(2)}x)`);
});

test("a real, sustained spike survives smoothing", () => {
  const flat = Array(20).fill(100);
  const withSpike = [...flat, ...Array(10).fill(900), ...flat];
  const smoothed = rollingMedian(withSpike, VOLUME_SMOOTHING_WINDOW);
  assert.equal(Math.max(...smoothed), 900, "the plateau keeps its height");
  assert.equal(smoothed[25], 900, "and its interior is unchanged");
});

test("an isolated one-reading spike is removed", () => {
  const raw = [100, 100, 100, 5000, 100, 100, 100];
  assert.deepEqual(rollingMedian(raw, 7), [100, 100, 100, 100, 100, 100, 100]);
});

test("points keep their timestamps and source ids; only the value changes", () => {
  const points = [point(0, 100), point(1, 100), point(2, 900), point(3, 100), point(4, 100)];
  const out = smoothGranularPoints(points);
  assert.deepEqual(out.map((p) => p.timestamp), points.map((p) => p.timestamp));
  assert.deepEqual(out.map((p) => p.sourceId), points.map((p) => p.sourceId));
  assert.equal(out[2].valueUsd, 100);
  assert.equal(points[2].valueUsd, 900, "the input is not mutated");
});

test("daily averages are left alone and break a granular run", () => {
  const avg = (i, v) => point(i, v, { aggregation: { method: "arithmetic_mean", sampleCount: 96 } });
  const points = [avg(0, 1000), avg(1, 1200), point(2, 50), point(3, 50), point(4, 9000), point(5, 50), point(6, 50)];
  const out = smoothGranularPoints(points);
  assert.equal(out[0].valueUsd, 1000);
  assert.equal(out[1].valueUsd, 1200);
  assert.equal(out[4].valueUsd, 50, "the granular spike is removed inside its own run");
  assert.ok(out.slice(2).every((p) => p.valueUsd === 50), "and the averages never leak into the median");
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
if (failures > 0) process.exitCode = 1;

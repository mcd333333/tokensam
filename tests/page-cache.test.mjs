import assert from "node:assert/strict";

import {
  DEFAULT_PAGE_CACHE_TTL_SECONDS,
  isCacheablePageRequest,
  pageCacheOptions,
  resetPageCacheForTests,
  servePageCached,
} from "../cloudflare/page-cache.ts";

const cases = [];
function test(name, run) { cases.push({ name, run }); }

/** A minimal Cache API stand-in: stores clones keyed by URL, like caches.default does for GETs. */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(request) { return store.get(request.url)?.clone(); },
    async put(request, response) { store.set(request.url, response.clone()); },
  };
}
function ctxCollector() {
  const pending = [];
  return { waitUntil(promise) { pending.push(promise); }, async flush() { await Promise.all(pending.splice(0)); } };
}
function originCounter(body = () => "page", init = {}) {
  const state = { calls: 0, next: body };
  state.fn = async () => {
    state.calls += 1;
    return new Response(state.next(state.calls), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", vary: "rsc, next-router-state-tree", ...init.headers }, ...init });
  };
  return state;
}
const OPTIONS = { ttlSeconds: 300, staleSeconds: 900 };
const page = (path = "/", headers = {}) => new Request(`https://example.com${path}`, { headers });

test("the first view renders, later views inside the TTL come from the cache without touching the origin", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter(); let clock = 1_000_000;
  const first = await servePageCached(page("/tokens/bitcoin-btc"), ctx, origin.fn, cache, OPTIONS, () => clock);
  assert.equal(first.headers.get("x-page-cache"), "MISS");
  assert.equal(await first.text(), "page");
  await ctx.flush();
  clock += 120_000;
  const second = await servePageCached(page("/tokens/bitcoin-btc"), ctx, origin.fn, cache, OPTIONS, () => clock);
  assert.equal(second.headers.get("x-page-cache"), "HIT");
  assert.equal(await second.text(), "page");
  assert.equal(origin.calls, 1, "a hit never renders");
  assert.equal(second.headers.get("cache-control"), "public, max-age=0, must-revalidate", "browsers keep revalidating with the edge");
  assert.equal(second.headers.get("x-page-cached-at"), null, "internal stamp is not leaked");
});

test("past the TTL a stale copy is served at once and refreshed once in the background", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter((n) => `render ${n}`); let clock = 5_000_000;
  await servePageCached(page(), ctx, origin.fn, cache, OPTIONS, () => clock); await ctx.flush();
  clock += 400_000; // 6m40s: past the 5 min TTL, inside the stale window
  const stale = await servePageCached(page(), ctx, origin.fn, cache, OPTIONS, () => clock);
  assert.equal(stale.headers.get("x-page-cache"), "STALE");
  assert.equal(await stale.text(), "render 1", "the visitor does not wait for the re-render");
  await ctx.flush();
  assert.equal(origin.calls, 2, "exactly one background render");
  const fresh = await servePageCached(page(), ctx, origin.fn, cache, OPTIONS, () => clock);
  assert.equal(fresh.headers.get("x-page-cache"), "HIT");
  assert.equal(await fresh.text(), "render 2", "the refreshed copy replaced the stale one");
});

test("beyond the stale window the page renders again as a miss", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter((n) => `render ${n}`); let clock = 9_000_000;
  await servePageCached(page(), ctx, origin.fn, cache, OPTIONS, () => clock); await ctx.flush();
  clock += (OPTIONS.ttlSeconds + OPTIONS.staleSeconds) * 1000 + 1;
  const again = await servePageCached(page(), ctx, origin.fn, cache, OPTIONS, () => clock);
  assert.equal(again.headers.get("x-page-cache"), "MISS");
  assert.equal(await again.text(), "render 2");
});

test("a burst of simultaneous misses renders the page once", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const origin = async () => { calls += 1; await gate; return new Response("body", { status: 200, headers: { "content-type": "text/html" } }); };
  const burst = Array.from({ length: 5 }, () => servePageCached(page("/"), ctx, origin, cache, OPTIONS, () => 1));
  release();
  const responses = await Promise.all(burst);
  await ctx.flush();
  assert.equal(calls, 1);
  for (const response of responses) assert.equal(await response.text(), "body", "every visitor in the burst gets the page");
});

test("only plain GET page loads are cacheable", () => {
  assert.equal(isCacheablePageRequest(page("/")), true);
  assert.equal(isCacheablePageRequest(page("/tokens/ethereum-eth")), true);
  assert.equal(isCacheablePageRequest(page("/tokens/ethereum-eth/")), true);
  assert.equal(isCacheablePageRequest(page("/?sort=price")), false, "a query string means a different page");
  assert.equal(isCacheablePageRequest(page("/?_rsc=abc")), false);
  assert.equal(isCacheablePageRequest(page("/api/live-prices")), false);
  assert.equal(isCacheablePageRequest(page("/api/cron/refresh")), false);
  assert.equal(isCacheablePageRequest(page("/get-app")), false);
  assert.equal(isCacheablePageRequest(page("/tokens/a/b")), false);
  assert.equal(isCacheablePageRequest(new Request("https://example.com/", { method: "POST", body: "x" })), false);
  for (const header of ["rsc", "next-router-state-tree", "next-router-prefetch", "next-action", "authorization"]) {
    assert.equal(isCacheablePageRequest(page("/", { [header]: "1" })), false, header);
  }
});

test("uncacheable requests go straight to the origin every time", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter();
  for (let i = 0; i < 3; i += 1) await servePageCached(page("/api/live-prices"), ctx, origin.fn, cache, OPTIONS, () => 1);
  for (let i = 0; i < 3; i += 1) await servePageCached(page("/", { rsc: "1" }), ctx, origin.fn, cache, OPTIONS, () => 1);
  assert.equal(origin.calls, 6);
  assert.equal(cache.store.size, 0);
});

test("a client's no-cache header does not bypass the cache", async () => {
  resetPageCacheForTests();
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter();
  await servePageCached(page("/"), ctx, origin.fn, cache, OPTIONS, () => 1); await ctx.flush();
  const reload = await servePageCached(page("/", { "cache-control": "no-cache", pragma: "no-cache" }), ctx, origin.fn, cache, OPTIONS, () => 2);
  assert.equal(reload.headers.get("x-page-cache"), "HIT");
  assert.equal(origin.calls, 1);
});

test("errors, non-HTML and cookie-setting responses are passed through and never stored", async () => {
  for (const make of [
    () => new Response("nope", { status: 500, headers: { "content-type": "text/html" } }),
    () => new Response("nf", { status: 404, headers: { "content-type": "text/html" } }),
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response("hi", { status: 200, headers: { "content-type": "text/html", "set-cookie": "a=b" } }),
  ]) {
    resetPageCacheForTests();
    const cache = fakeCache(); const ctx = ctxCollector(); let calls = 0;
    const origin = async () => { calls += 1; return make(); };
    const first = await servePageCached(page("/"), ctx, origin, cache, OPTIONS, () => 1); await ctx.flush();
    assert.equal(first.headers.get("x-page-cache"), "BYPASS");
    await servePageCached(page("/"), ctx, origin, cache, OPTIONS, () => 2); await ctx.flush();
    assert.equal(calls, 2, "rendered each time");
    assert.equal(cache.store.size, 0, "nothing stored");
  }
});

test("a TTL of 0, or no cache available (workers.dev), leaves the origin response completely untouched", async () => {
  resetPageCacheForTests();
  const ctx = ctxCollector(); const origin = originCounter();
  const off = await servePageCached(page("/"), ctx, origin.fn, fakeCache(), { ttlSeconds: 0, staleSeconds: 0 }, () => 1);
  assert.equal(off.headers.get("x-page-cache"), null);
  assert.equal(off.headers.get("cache-control"), "private, no-store");
  const none = await servePageCached(page("/"), ctx, origin.fn, undefined, OPTIONS, () => 1);
  assert.equal(none.headers.get("x-page-cache"), null);
  assert.equal(origin.calls, 2);
});

test("a failing cache is skipped rather than failing the page", async () => {
  resetPageCacheForTests();
  const ctx = ctxCollector(); const origin = originCounter();
  const broken = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } };
  const response = await servePageCached(page("/"), ctx, origin.fn, broken, OPTIONS, () => 1);
  await ctx.flush();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "page");
});

test("the defaults are 10 minutes fresh then 5 minutes stale, and the env vars can override either", () => {
  assert.equal(DEFAULT_PAGE_CACHE_TTL_SECONDS, 600);
  assert.deepEqual(pageCacheOptions(undefined), { ttlSeconds: 600, staleSeconds: 300 });
  assert.deepEqual(pageCacheOptions("garbage", "nope"), { ttlSeconds: 600, staleSeconds: 300 });
  assert.deepEqual(pageCacheOptions("-5", "-1"), { ttlSeconds: 600, staleSeconds: 300 });
  assert.deepEqual(pageCacheOptions("120"), { ttlSeconds: 120, staleSeconds: 300 }, "stale keeps its default when only the TTL is set");
  assert.deepEqual(pageCacheOptions("120", "60"), { ttlSeconds: 120, staleSeconds: 60 });
  assert.deepEqual(pageCacheOptions("900", "0"), { ttlSeconds: 900, staleSeconds: 0 }, "a zero stale window is allowed");
  assert.deepEqual(pageCacheOptions("0", "60"), { ttlSeconds: 0, staleSeconds: 0 }, "TTL 0 turns the cache off entirely");
});

test("with the defaults no visitor is served a page older than 15 minutes", async () => {
  resetPageCacheForTests();
  const options = pageCacheOptions(undefined);
  const cache = fakeCache(); const ctx = ctxCollector(); const origin = originCounter((n) => `render ${n}`); let clock = 20_000_000;
  await servePageCached(page(), ctx, origin.fn, cache, options, () => clock); await ctx.flush();
  clock += 599_000; // 9m59s
  assert.equal((await servePageCached(page(), ctx, origin.fn, cache, options, () => clock)).headers.get("x-page-cache"), "HIT");
  clock += 2_000; // 10m01s: stale window, served instantly while one render refreshes
  const stale = await servePageCached(page(), ctx, origin.fn, cache, options, () => clock);
  assert.equal(stale.headers.get("x-page-cache"), "STALE");
  assert.equal(await stale.text(), "render 1");
  await ctx.flush();
  assert.equal(origin.calls, 2);
  // A page nobody refreshed for the whole window: past 15 minutes it is rendered fresh, never served.
  resetPageCacheForTests();
  const cache2 = fakeCache(); const ctx2 = ctxCollector(); const origin2 = originCounter((n) => `render ${n}`);
  await servePageCached(page(), ctx2, origin2.fn, cache2, options, () => 0); await ctx2.flush();
  const late = await servePageCached(page(), ctx2, origin2.fn, cache2, options, () => 901_000);
  assert.equal(late.headers.get("x-page-cache"), "MISS");
  assert.equal(await late.text(), "render 2");
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
if (failures > 0) process.exitCode = 1;

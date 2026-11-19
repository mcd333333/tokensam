/**
 * Edge cache for the two server-rendered HTML pages, so rendering (Worker CPU) and the Supabase reads behind it
 * happen at most once per page per window, however many people visit.
 *
 * Both pages are `force-dynamic` and re-read Supabase on every view, which is why Worker CPU, Supabase egress and
 * log volume all grew with visitors. Their data only changes when a collector runs (CoinGecko every 15 minutes), and
 * the prices that do move are overlaid live in the browser on both pages (src/lib/ui/use-live-prices.ts), so a few
 * minutes of HTML staleness is invisible for them. Relative ages and freshness labels are likewise computed in the
 * browser (src/lib/ui/freshness-display.ts), not baked into the cached HTML.
 *
 * Behaviour:
 * - Only GET `/` and `/tokens/<id>` with no query string, and none of Next's RSC / prefetch / server-action requests.
 * - Fresh for `ttlSeconds`; then served stale for up to `staleSeconds` more while ONE background render refreshes it
 *   (stale-while-revalidate, which the Workers Cache API does not provide natively).
 * - Only 200 text/html responses without Set-Cookie are stored; errors and anything else pass straight through.
 * - The client's own Cache-Control request header is ignored: honouring `no-cache` would let any crawler bypass the cache.
 * - `x-page-cache: HIT | STALE | MISS | BYPASS` on every response it touches, for diagnosis.
 * - Every entry is keyed by the deployed Worker version (`options.version`, from the version-metadata binding). A page's HTML
 *   names that build's hashed JS and CSS files, and a later deploy removes them, so HTML kept across a deploy would load
 *   broken ("This page couldn't load", ChunkLoadError). A new version therefore never sees the old one's entries. With no
 *   version available nothing is cached at all: failing to cache is always safer than caching HTML from another build.
 * - The Cache API works on `*.workers.dev` too (a hit there reports `cf-cache-status: HIT`), so this is live wherever the Worker is.
 */

/** Fresh for 10 minutes, then up to 5 more served stale while one render refreshes it: no page is shown older than 15. */
export const DEFAULT_PAGE_CACHE_TTL_SECONDS = 600;
export const DEFAULT_PAGE_CACHE_STALE_SECONDS = 300;

export type PageCacheOptions = {
  ttlSeconds: number;
  staleSeconds: number;
  /** Identifier of the deployed Worker version; null or empty disables the cache (see the header comment). */
  version: string | null;
};
export type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const CACHED_AT_HEADER = "x-page-cached-at";
const STATUS_HEADER = "x-page-cache";
/** Request headers Next uses for everything that is not a plain page load. */
const NON_PAGE_REQUEST_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-action", "authorization"];

/** In-flight origin renders per cache key, so a burst of misses on one isolate renders the page once. */
const inflight = new Map<string, Promise<Response>>();

function parseSeconds(raw: unknown): number | null {
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/**
 * Cache windows from the PAGE_CACHE_TTL_SECONDS and PAGE_CACHE_STALE_SECONDS variables, plus the deployed Worker version.
 * Unset or invalid values mean the defaults (10 min fresh, 5 min stale); a TTL of 0 turns the cache off, and so does a
 * missing version.
 */
export function pageCacheOptions(rawTtl: unknown, rawStale?: unknown, rawVersion?: unknown): PageCacheOptions {
  const version = typeof rawVersion === "string" && rawVersion.trim() !== "" ? rawVersion.trim() : null;
  const ttlSeconds = parseSeconds(rawTtl) ?? DEFAULT_PAGE_CACHE_TTL_SECONDS;
  if (ttlSeconds === 0) return { ttlSeconds: 0, staleSeconds: 0, version };
  return { ttlSeconds, staleSeconds: parseSeconds(rawStale) ?? DEFAULT_PAGE_CACHE_STALE_SECONDS, version };
}

export function isCacheablePageRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.search) return false;
  if (url.pathname !== "/" && !/^\/tokens\/[^/]+\/?$/.test(url.pathname)) return false;
  return !NON_PAGE_REQUEST_HEADERS.some((name) => request.headers.has(name));
}

/** One entry per page per deployed version: the version is part of the key, never a header to compare. */
function cacheKey(request: Request, version: string): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname}?__v=${encodeURIComponent(version)}`, { method: "GET" });
}

function isStorable(response: Response): boolean {
  return response.status === 200
    && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
    && !response.headers.has("set-cookie");
}

/** The copy kept in the cache: long enough to cover the stale window, stamped so age is known on a hit. */
function toStored(response: Response, options: PageCacheOptions, now: number): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${options.ttlSeconds + options.staleSeconds}`);
  headers.set(CACHED_AT_HEADER, String(now));
  headers.delete(STATUS_HEADER);
  // Next marks pages `Vary: rsc, next-router-state-tree, ...`; only plain page loads are stored here, so
  // that Vary would just make the Cache API refuse to match.
  headers.delete("vary");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** What the visitor gets: the page plus a diagnostic header, and a Cache-Control that keeps browsers revalidating. */
function toClient(response: Response, status: "HIT" | "STALE" | "MISS" | "BYPASS"): Response {
  const headers = new Headers(response.headers);
  headers.set(STATUS_HEADER, status);
  if (status !== "BYPASS") {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    headers.delete(CACHED_AT_HEADER);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function renderOnce(key: string, origin: () => Promise<Response>): Promise<Response> {
  const existing = inflight.get(key);
  if (existing) return (await existing).clone();
  const pending = origin().finally(() => { inflight.delete(key); });
  inflight.set(key, pending);
  return (await pending).clone();
}

/**
 * Serves a cacheable page request from the cache, or renders it through `origin` and caches the result.
 * Requests that are not cacheable pages, or a TTL of 0, go straight to `origin` untouched.
 */
export async function servePageCached(
  request: Request,
  ctx: WaitUntil,
  origin: () => Promise<Response>,
  cache: CacheLike | undefined,
  options: PageCacheOptions,
  now: () => number = Date.now,
): Promise<Response> {
  // No cache, TTL 0, no known version, or not a plain page load: render untouched. A missing version must disable the
  // cache rather than share one key across builds.
  if (!cache || options.ttlSeconds <= 0 || !options.version || !isCacheablePageRequest(request)) return origin();

  const key = cacheKey(request, options.version);
  const keyUrl = key.url;
  let cached: Response | undefined;
  try {
    cached = await cache.match(key);
  } catch {
    cached = undefined; // a cache fault must never take the page down
  }

  const refresh = async () => {
    const rendered = await renderOnce(keyUrl, origin);
    if (isStorable(rendered)) await cache.put(key, toStored(rendered, options, now()));
    return rendered;
  };

  if (cached) {
    const age = now() - Number(cached.headers.get(CACHED_AT_HEADER));
    if (Number.isFinite(age) && age >= 0 && age <= options.ttlSeconds * 1000) return toClient(cached, "HIT");
    if (Number.isFinite(age) && age >= 0 && age <= (options.ttlSeconds + options.staleSeconds) * 1000) {
      ctx.waitUntil(refresh().catch(() => undefined));
      return toClient(cached, "STALE");
    }
  }

  const rendered = await renderOnce(keyUrl, origin);
  if (!isStorable(rendered)) return toClient(rendered, "BYPASS");
  // The put runs after the response is on its way; a failed put only costs the next visitor a render.
  ctx.waitUntil(cache.put(key, toStored(rendered.clone(), options, now())).catch(() => undefined));
  return toClient(rendered, "MISS");
}

/** Test hook: forget in-flight renders. */
export function resetPageCacheForTests(): void {
  inflight.clear();
}

/**
 * Single Worker entry: the OpenNext-built Next.js app plus the 5-minute scheduler.
 *
 * - `fetch`: the public Binance live-price route and the CoinGecko proxy route belong to the
 *   scheduler module (refresh-scheduler/src/index.ts); every other request goes to the app.
 * - `scheduled`: the scheduler runs its cron tick and calls the app's own `/api/cron/*` routes
 *   through an in-process binding (`env.APP`), so no request leaves the Worker and no public URL
 *   or service binding is involved.
 *
 * `.open-next/worker.js` exists only after `opennextjs-cloudflare build`, which is why this file
 * lives under cloudflare/ (excluded from the app's type-check, see tsconfig.json).
 */
// @ts-expect-error generated at build time, no type declarations
import app from "../.open-next/worker.js";
import scheduler from "./refresh-scheduler/src/index.ts";
import { PriceStream } from "./price-stream.ts";
import { pageCacheOptions, servePageCached, type CacheLike, type WaitUntil } from "./page-cache.ts";

// Durable Object class: must be exported from the Worker's entry module (see wrangler.jsonc migrations).
export { PriceStream };

// @ts-expect-error generated at build time, no type declarations
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";

const SCHEDULER_FETCH_PATHS = ["/coingecko-proxy", "/binance-prices"];
/** EXPERIMENT: live prices relayed from Binance / Coinbase WebSockets by a Durable Object (cloudflare/price-stream.ts). */
const PRICE_STREAM_PREFIX = "/ws-prices/";

type Handler = { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(PRICE_STREAM_PREFIX)) {
      const namespace = env.PRICE_STREAM as { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
      const source = pathname.slice(PRICE_STREAM_PREFIX.length).split("/")[0] ?? "";
      return namespace.get(namespace.idFromName(source)).fetch(request);
    }
    if (SCHEDULER_FETCH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
      return scheduler.fetch(request, env as never, ctx as never);
    }
    // The two HTML pages are rendered at most once per PAGE_CACHE_TTL_SECONDS (default 600; 0 turns it off), with
    // PAGE_CACHE_STALE_SECONDS (default 300) more served stale while one render refreshes them, instead of on every
    // view; everything else, including /api/*, goes to the app untouched. See cloudflare/page-cache.ts.
    const edgeCache = (globalThis as { caches?: { default?: CacheLike } }).caches?.default;
    return servePageCached(
      request,
      ctx as WaitUntil,
      () => (app as Handler).fetch(request, env, ctx),
      edgeCache,
      pageCacheOptions(env.PAGE_CACHE_TTL_SECONDS, env.PAGE_CACHE_STALE_SECONDS, (env.CF_VERSION_METADATA as { id?: string } | undefined)?.id),
    );
  },
  async scheduled(event: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> {
    const appBinding = { fetch: (input: string | Request, init?: RequestInit) => (app as Handler).fetch(new Request(input, init), env, ctx) };
    return scheduler.scheduled(event as never, { ...env, APP: appBinding } as never, ctx as never);
  },
};

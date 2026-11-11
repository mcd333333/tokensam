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

// @ts-expect-error generated at build time, no type declarations
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";

const SCHEDULER_FETCH_PATHS = ["/coingecko-proxy", "/binance-prices"];

type Handler = { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (SCHEDULER_FETCH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
      return scheduler.fetch(request, env as never, ctx as never);
    }
    return (app as Handler).fetch(request, env, ctx);
  },
  async scheduled(event: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> {
    const appBinding = { fetch: (input: string | Request, init?: RequestInit) => (app as Handler).fetch(new Request(input, init), env, ctx) };
    return scheduler.scheduled(event as never, { ...env, APP: appBinding } as never, ctx as never);
  },
};

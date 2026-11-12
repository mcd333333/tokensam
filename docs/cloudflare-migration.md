# Moving the app from Vercel to Cloudflare Workers

The Next.js app builds for Cloudflare Workers with OpenNext (`@opennextjs/cloudflare`); Next was
raised to 16.4.6 because the adapter requires 16.4.5 or newer. Requires the Workers Paid plan: the
free plan's 10 ms CPU and 50-subrequest limits cannot run the pages or the cron routes.

**One Worker does everything.** `wrangler.jsonc` (repo root) deploys the existing
`token-samurai-refresh-scheduler` Worker in place: `cloudflare/worker-entry.ts` serves the website and
`/api/*` through the OpenNext build, keeps the scheduler's `/binance-prices` and `/coingecko-proxy`
routes, and runs the 5-minute cron, which calls the app's `/api/cron/*` routes in-process. Its existing
secrets (`CRON_SECRET`, `COINGECKO_API_KEY`, `RESEND_API_KEY`) are kept, and `keep_vars` preserves
variables added in the dashboard.

## Cutover

1. **Change the Worker's build settings** (Workers & Pages, `token-samurai-refresh-scheduler`, Settings, Build):
   - Git branch: `cloudflare-migration` (switch back to `main` after merging)
   - Root directory: `/` (was `cloudflare/refresh-scheduler`)
   - Build command: `pnpm install --frozen-lockfile && pnpm exec opennextjs-cloudflare build`
   - Deploy command: `pnpm exec wrangler deploy`
2. **Add the variables and secrets the app needs** (Settings, Variables and Secrets), same names as `.env.example`:
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `COINGECKO_API_PLAN`, `GECKOTERMINAL_SYNC_ENABLED=true`, the AI provider
   keys and any other values the Vercel project had. `CRON_SECRET` and `COINGECKO_API_KEY` already exist here.
   Leave `COINGECKO_PROXY_URL` unset: the app now egresses from Cloudflare, the same network the proxy used.
3. **Trigger a build** (push, or Retry deployment). Open the Worker's `workers.dev` URL: the home page and a token profile.
4. **Verify collection** after a few minutes (new rows in `token_metric_observations`), then retire the Vercel project.

## Dashboard gotchas

- The Build section's "Variables and secrets" box is for build-time variables only. The app's variables go under
  Runtime, Variables and Secrets. The build itself needs none.
- Saving build settings does not start a build, and "Retry" on an old deployment rebuilds that old commit. Push a
  commit to the production branch to build the new code.
- The "update your Wrangler configuration" banner is informational: `keep_vars` keeps dashboard-only variables across
  deploys, and secrets must not be committed.

## Live prices

Binance's and Coinbase's REST APIs throttle or block Cloudflare Workers' shared addresses (HTTP 403 / 429), so live
exchange prices come from WebSocket feeds held by one Durable Object per exchange (`cloudflare/price-stream.ts`,
binding `PRICE_STREAM`). `src/lib/providers/live-price-source.ts` reads them for both the `/api/live-prices` ticker and
the server-rendered pages: Coinbase where it lists the token (USD-quoted), Binance for the rest (USDT-quoted), Coinbase
REST as the fallback, and the stored CoinGecko price when nothing live exists. Each Durable Object opens its upstream
connection when a request arrives and closes it after 2 minutes without one, to keep duration billing down. Read-only
diagnostics (connection state, last error, message count): `/ws-prices/coinbase` and `/ws-prices/binance`.

## Notes

- `process.env` is populated from the Worker's variables and secrets (`nodejs_compat` with this compatibility date).
- `placement.region = "aws:ap-northeast-2"` runs the Worker next to Supabase (Seoul); each request makes many small database calls, and smart placement left it in Washington (pages took 6-13 s).
- `limits.cpu_ms = 300000` allows the long refresh and retention routes.
- Images use the `IMAGES` binding. Local preview: `pnpm cf:preview` with a `.dev.vars` (see `.dev.vars.example`).
- `vercel.json` and the old scheduler-only deploy (`cloudflare/refresh-scheduler/wrangler.toml`) are not used after cutover.

# Moving the app from Vercel to Cloudflare Workers

The Next.js app builds for Cloudflare Workers with OpenNext (`@opennextjs/cloudflare`); Next was
raised to 16.4.6 because the adapter requires 16.4.5 or newer. Requires the Workers Paid plan: the
free plan's 10 ms CPU and 50-subrequest limits cannot run the pages or the cron routes.

Two Workers, deployed separately:

| Worker | Source | Role |
|---|---|---|
| `tokensam` | repo root (`wrangler.jsonc`, `open-next.config.ts`) | the website and `/api/*` routes |
| `token-samurai-refresh-scheduler` | `cloudflare/refresh-scheduler/` | 5-minute cron that calls the app's cron routes; also serves `/binance-prices` and `/coingecko-proxy` |

## One-time setup

1. **Create the app Worker from the repo** (Workers & Pages, Create, Import a repository):
   - Root directory: `/`
   - Build command: `pnpm install --frozen-lockfile && pnpm exec opennextjs-cloudflare build`
   - Deploy command: `pnpm exec opennextjs-cloudflare deploy`
   - Worker name: `tokensam` (must match `wrangler.jsonc`)
   - Build watch paths (so the scheduler's own folder does not rebuild it): include `/*`, exclude `cloudflare/*`.
2. **Set the Worker's variables and secrets** (Settings, Variables and Secrets). Same names as `.env.example`:
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CRON_SECRET`, `COINGECKO_API_KEY`, `COINGECKO_API_PLAN`,
   `GECKOTERMINAL_SYNC_ENABLED=true`, the AI provider keys, and any other values the Vercel project had.
   Leave `COINGECKO_PROXY_URL` **unset**: the app now egresses from Cloudflare, the same network the proxy used.
3. **Check the app** at `https://tokensam.<your-subdomain>.workers.dev`: the home page, a token profile, and
   `curl -H "authorization: Bearer $CRON_SECRET" https://.../api/cron/exchanges?slice=1`.
4. **Point the scheduler at it** in `cloudflare/refresh-scheduler/wrangler.toml`: set `REFRESH_URL` to the new
   URL and uncomment the `[[services]]` binding (`APP` to `tokensam`), then redeploy the scheduler.
5. **Verify collection** (new rows in `token_metric_observations`), then retire the Vercel project.

## Notes

- `process.env` is populated from the Worker's variables and secrets (`nodejs_compat` with this compatibility date).
- `placement.mode = "smart"` runs the Worker near Supabase (Seoul), since each request makes many small database calls.
- `limits.cpu_ms = 300000` allows the long refresh and retention routes.
- Images use the `IMAGES` binding. Local preview: `pnpm cf:preview` with a `.dev.vars` (see `.dev.vars.example`).
- `vercel.json` is no longer used once the cutover is done.

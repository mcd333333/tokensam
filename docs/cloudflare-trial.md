# Cloudflare Workers trial deployment

Branch `cloudflare-trial` builds the app for Cloudflare Workers with the OpenNext adapter
(`@opennextjs/cloudflare`) next to the existing Vercel deployment. It is for **measuring**, not for
cutting over. `main` is untouched.

## Verified so far (2026-10-29, container build, no Cloudflare account access)

- `pnpm cf:build` succeeds on Next 16.3.5 (all 7 routes, `/` and `/tokens/[id]` dynamic).
- `wrangler deploy --dry-run`: **7.9 MiB raw, 1.6 MiB gzipped** -- under the 3 MiB Free and 10 MiB Paid
  limits.
- Local workerd (`pnpm cf:preview`): cron routes return 401 without the secret, `/api/live-prices`
  returns live Binance prices, `/` renders. Not exercised: anything needing the Supabase service key.

## Deploy

1. Cloudflare dashboard, Workers & Pages, Create, import this repo, branch `cloudflare-trial`
   (or `pnpm cf:deploy` after `wrangler login`). Worker name: `tokensam-trial`.
2. Secrets (Worker settings, never committed): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CRON_SECRET`,
   `COINGECKO_API_KEY`, `COINGECKO_API_PLAN`, `GECKOTERMINAL_SYNC_ENABLED` (set `false` at first).
   `NEXT_PUBLIC_*` values are inlined at build time, so set them as *build* variables.
3. Workers Paid ($5/month) is needed for the CPU and subrequest limits; Free's 10 ms CPU will fail the
   refresh routes. That failure is itself a useful data point if you want to try Free first.

## What to measure (Workers dashboard, Metrics tab, and Observability)

- Requests per day and CPU time p50/p99 per invocation, split by route if Observability allows it.
- Peak memory: the 128 MB isolate limit is the main unknown. Look for "exceeded memory" errors.
- Subrequests per invocation on `/api/cron/refresh` (limit 10,000 on Paid).
- Whether `/api/live-prices` gets HTTP 403 from Binance on Workers egress (the reason it runs on
  Vercel today, see the comment in `src/app/api/live-prices/route.ts`).
- Whether CoinGecko calls work directly from Workers egress without `COINGECKO_PROXY_URL`.

## Running the cron routes without doubling work

The refresh and GeckoTerminal routes decide what is due from rows in Supabase (`data_refresh_runs`,
`geckoterminal_sync_runs`) and take a database lock, so calling them from a second host does not
duplicate collection: whichever call lands first does the due work and the other returns `skipped`.
Add a second cron trigger on the trial Worker that calls its own `/api/cron/refresh` with
`Authorization: Bearer $CRON_SECRET`; do not remove the existing scheduler Worker.
Retention already runs inside Postgres (pg_cron), so the trial does not need `/api/cron/retention`.

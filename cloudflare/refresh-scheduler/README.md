# Token Samurai refresh scheduler (Cloudflare Worker)

External clock for both of Token Samurai's scheduled routes:

- `/api/cron/refresh` — CoinGecko, DeFiLlama, DeFiLlama Coins.
- `/api/cron/dexpaprika` — DexPaprika on-chain DEX data (stalest tokens first).
- `/api/cron/exchanges` — daily exchange volumes.

Vercel's Hobby plan cannot run its own Cron Trigger more often than once a
day, but both routes are designed to be invoked far more often than they
actually do work: each one has its own due-check (`isProviderDue()` /
`REFRESH_POLICY` for the refresh route, a stalest-first walk for DexPaprika) that makes a tick where nothing is due return almost
immediately. This Worker's job is only to provide that frequent tick — every
5 minutes — via a Cloudflare Cron Trigger, which Cloudflare's free tier
supports. All actual scheduling logic (which provider runs when, DexPaprika
rotation/pacing) stays server-side in the Next.js app; this Worker does
not decide anything beyond "call both routes now."

`vercel.json` still declares a once-daily Vercel Cron entry for
`/api/cron/refresh` as a fallback in case this Worker is ever down; that
entry alone is not enough to keep either route's intended cadence, which is
why this Worker exists.

## Deployment

This Worker is deployed via **Cloudflare Workers Builds**, connected to:

- Repository: [`dm999999-ctrl/tokensam`](https://github.com/dm999999-ctrl/tokensam)
- Production branch: `main`
- Deploy command: `cd cloudflare/refresh-scheduler && npx wrangler deploy`

A push to `main` that touches this directory triggers a new build and
deployment automatically; there is no separate manual deploy step for normal
changes. `CRON_SECRET` is configured as a Cloudflare Worker secret directly
in the Cloudflare dashboard (see "Manual/local deploy" below) — it is not
part of the Git-triggered build and is never committed to this repository.

### Manual/local deploy

For local development, or to (re)configure the secret:

```bash
cd cloudflare/refresh-scheduler
pnpm install   # or npm install
npx wrangler secret put CRON_SECRET   # paste the same value as the Vercel project's CRON_SECRET
```

Set `REFRESH_URL` in `wrangler.toml` to the Vercel production **base** URL —
not the complete `/api/cron/refresh` URL — e.g. `https://tokensam.vercel.app`
(no trailing slash needed). The Worker appends `/api/cron/refresh` and
`/api/cron/dexpaprika` to it itself. Then:

```bash
npx wrangler deploy
```

## Verify

```bash
npx wrangler tail
```

Trigger a tick manually with `npx wrangler deployments list` / the dashboard's
"Trigger event," or just visit the Worker's own URL — `fetch()` runs the same
logic as `scheduled()` and returns each route's status as JSON, so it can be
smoke-tested without waiting for the next 5-minute tick.

## What each tick actually costs

- `/api/cron/refresh`: cheap when nothing is due (an empty `due` list); at
  most every 15 minutes it will actually collect CoinGecko, at
  most every 30 for DeFiLlama Coins, and every 6 hours for DeFiLlama.
- `/api/cron/dexpaprika`: refreshes the stalest few tokens (token stats about every 90 minutes, pool lists every 6 hours) and
  does nothing when none is due; a monthly request cap keeps it inside DexPaprika's credit allowance.

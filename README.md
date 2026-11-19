# Crypto Fundamentals Dashboard

A Next.js research dashboard that reads stored token market and protocol fundamentals from Supabase, with per-metric source provenance.

## Package manager

This project requires **pnpm 11.19.0**, pinned in `package.json`. Use pnpm for installs and scripts; do not create or use a parallel npm, Yarn, or Bun lockfile. `pnpm-lock.yaml` is the project's dependency lockfile and should be kept in sync with `package.json`.

## Getting started

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Create a production build:

```bash
pnpm build
```

Run ESLint:

```bash
pnpm lint
```

## pnpm workspace configuration

`pnpm-workspace.yaml` holds pnpm workspace-level settings. Its `allowBuilds` entries control dependency install-time build scripts: `sharp` and `unrs-resolver` are both set to `false`, so their scripts are not approved to run during installation. Keep these settings as committed unless a dependency change is reviewed and requires an intentional build-script approval.

## Application notes

The dashboard, Token Profile, and historical charts read the latest stored observations and calculated metrics from Supabase on the server. No demo values are shown when live data cannot be loaded. See [the live data guide](docs/live-data.md).

Supabase is refreshed automatically by the Cloudflare `token-samurai-refresh-scheduler` Worker. Its five-minute cron calls the secret-protected `/api/cron/refresh` endpoint, which runs whichever market-data collectors are due, recalculates metrics, and records per-provider refresh status shown in the UI. A separate daily cron refreshes RootData funding and investor summaries when they are 14 days old. Run `pnpm refresh` to trigger the market-data workflow locally. Apply the relevant migrations first. See the [automated refresh guide](docs/automated-refresh.md) and [RootData integration guide](docs/rootdata-integration.md).

Historical charts support 24H, 7D, 30D and 90D requested windows and report their actual coverage (observation count and real time span) instead of implying a full period. Nothing is interpolated or zero-filled. `pnpm backfill:coingecko` is a manual, bounded, idempotent backfill of CoinGecko price, market cap and volume history (90 days daily, 7 days hourly). See [the historical data guide](docs/historical-data.md), which also covers provider limits (CoinGecko Demo prohibits commercial use), a CoinMarketCap assessment, and storage growth.

Each Token Profile offers an on-demand **Deep AI Analysis**: a server-side Gemini interpretation of that token's stored observations and calculated metrics, with explicit observation periods, provider freshness, protocol-vs-token scope, and source IDs for each statement. It is never investment advice or a prediction, is generated only when requested, and is stored per token. It requires `GEMINI_API_KEY` (server-only) and its migration; without a key the profile shows "AI analysis unavailable". See [the Deep AI Analysis guide](docs/deep-ai-analysis.md).

A server-only, manually invoked CoinGecko collector is available through `pnpm coingecko:sync`; it writes market observations to Supabase. See [the CoinGecko integration guide](docs/coingecko-integration.md).

A server-only DEX Screener collector is available through `pnpm dexscreener:sync` after applying its Supabase migration. It preserves all exact-address pair records. See [the DEX Screener integration guide](docs/dexscreener-integration.md).

A server-only GeckoTerminal collector calls the standalone GeckoTerminal Public API directly (never CoinGecko's `/onchain` endpoints or its quota) for on-chain DEX pool data, kept independent of the existing CoinGecko integration. It backs the Token Profile's "DEX Markets" and "Contract / On-chain Identity" sections and the Pool/DEX Concentration (HHI) indicators. Run it manually with `pnpm geckoterminal:sync`, or enable a daily scheduled collection via `/api/cron/geckoterminal` (`GECKOTERMINAL_SYNC_ENABLED=true`) so its liquidity/volume history accumulates for future time-series indicators. It is still not part of the hourly `/api/cron/refresh`. See [the GeckoTerminal integration guide](docs/geckoterminal-integration.md).

The deterministic Phase 9 metrics engine reads stored CoinGecko, DeFiLlama, and DEX Screener observations and materializes provenance-bearing derived metrics in Supabase. After applying its migration, run `pnpm metrics:calculate`. It makes no external API calls; the Token Profile displays the stored results. See [the metrics engine guide](docs/metrics-engine.md).

The canonical provider-sync universe contains 50 chain-scoped tokens. See [the token-universe and provider mapping guide](docs/token-universe.md) for the additions and mapping coverage.

The Supabase schema and server-only connection helper support the collectors and the UI's server-side reads. See [the database foundation guide](docs/database-foundation.md) for setup details.

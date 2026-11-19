# RootData project profiles

The dashboard's 154-token universe has 148 confirmed RootData project matches. Six tickers remain unmatched: PAXG, RLUSD, XAUT, TFUEL, USDS, and WBTC.

## Stored fields and refresh policy

`rootdata_project_profiles` holds the persistent profile data, separate from `raw_provider_records` (which has short retention):

- One-time profile fields: RootData project name and URL, logo, establishment date, tags, one-line introduction, description, official website, and social links.
- Financial summary fields include aggregate `total_funding` and the list of known investors. The scheduler checks them every 14 UTC calendar days.

The RootData Basic API supports the aggregate funding and investor summary on `get_item` (2 credits per project request). Detailed funding-round records from `get_fac` require the Plus or Pro plan, so this integration does not claim to store round-by-round history. See the [RootData API docs](https://www.rootdata.com/api/doc).

The Worker checks once per day at 04:00 UTC (noon in Kuala Lumpur). It only requests financial summaries when 14 UTC calendar days have passed since collection. A failed record stays eligible for the next daily check. The route checks the free quota endpoint before spending credits and skips the batch if fewer than the required credits plus a 25-credit buffer remain. A full 148-project refresh costs 296 credits.

## Initial pull

The production Supabase project has this migration applied. For another environment, apply `supabase/migrations/20261114184151_rootdata_project_profiles.sql` first. Then run the one-time importer from the repository root:

```powershell
$env:ROOTDATA_ENV_FILE = ".env.local"
node scripts/rootdata-import.mjs --output=exports/rootdata-token-profiles.json --apply
```

The importer reads the 154 canonical tokens from Supabase, confirms exact project-name matches, uses the previously verified ticker aliases, and requests profiles only for the 148 confirmed projects. Search requests are free; paid profile calls are gated by the live quota. If a request stops partway through, rerun with `--resume` to continue from the local partial file.

The script does not print API keys. Keep `.env.local` out of source control.

## Cloudflare secret

The application reads `ROOTDATA_API_KEY` server-side. It is configured on the production Worker as a `secret_text` binding. To rotate it, use Wrangler so the value is stored as a secret (never as a checked-in Wrangler variable):

```sh
pnpm exec wrangler secret put ROOTDATA_API_KEY
```

The RootData scheduled route uses the Worker's existing `CRON_SECRET` authorization. The Cloudflare scheduler calls `/api/cron/rootdata` from the daily cron trigger; the route leaves the static profile columns untouched.

## Attribution

Keep the `rootdata_url` on each profile and link it under Data provenance in the token profile's Sources & methodology panel.

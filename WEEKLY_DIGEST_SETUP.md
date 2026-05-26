# Weekly Digest — setup notes

The weekly email digest tells users which dividends are hitting their account
in the next 7 days. It runs as two Vercel cron jobs against a small DB cache.

## Architecture

```
Daily 5am ET   ──►  /api/refresh-dividend-calendar
                    ├─ Pull distinct tickers from holdings
                    ├─ Polygon /v3/reference/dividends (1 req per ticker, 13s pacing)
                    └─ Upsert public.dividend_calendar

Monday 9am ET  ──►  /api/weekly-digest
                    ├─ List opted-in users with holdings
                    ├─ Join holdings × dividend_calendar
                    ├─ Filter to next 7 days (fallback: next 28)
                    ├─ Build per-user HTML
                    └─ Send via Resend

Email footer    ──►  /api/unsubscribe?token=...
                    └─ Verify HMAC, flip user_preferences row
```

## DB migration

Run `supabase/migrations/20260526_weekly_digest.sql`. It creates:

- `public.dividend_calendar` — ticker-keyed cache. RLS: read open to authenticated, no writes (service-role only).
- `public.user_preferences` — `user_id` PK, `weekly_digest_enabled` bool default true. RLS: own row CRUD (no delete).

## Environment variables (Vercel)

All server-only (no `VITE_` prefix):

| Var | Description |
|---|---|
| `CRON_SECRET` | Random string. Both crons require `Authorization: Bearer ${CRON_SECRET}`. Vercel attaches this automatically when configured. |
| `SUPABASE_URL` | Same value as `VITE_SUPABASE_URL`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Server-only — never expose client-side. |
| `POLYGON_API_KEY` | Polygon Stocks Starter key (server-side use of the existing key). |
| `RESEND_API_KEY` | Same `re_xxx` key used by the welcome-email function. |
| `RESEND_FROM` | e.g. `YieldOS <hello@yieldos.app>`. |
| `UNSUB_SECRET` | Random string. HMAC secret for unsubscribe tokens — **rotating this invalidates every outstanding email's unsub link**. |
| `APP_URL` | `https://yieldos.app` (no trailing slash). |

Generate the two secrets with:

```bash
openssl rand -base64 32
```

## Cron schedules (UTC)

Vercel cron uses UTC. Times in `vercel.json`:

| Cron | UTC | EDT (Mar-Nov) | EST (Nov-Mar) |
|---|---|---|---|
| `/api/refresh-dividend-calendar` | `0 9 * * *` | 5am | 4am |
| `/api/weekly-digest` | `0 13 * * 1` | 9am Mon | 8am Mon |

This drifts an hour during EST. Acceptable for a Monday-morning email — 8am still works. Re-evaluate if it bothers users.

## Dry-run test

Before the real Monday send, hit the digest endpoint with `?dry=1`:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://yieldos.app/api/weekly-digest?dry=1"
```

Returns the per-user computation without calling Resend. Verify the `sent` count matches your active-user count and there are no errors.

## Local testing

```bash
# Refresh cache locally (uses the same Vercel route via `vercel dev`)
curl -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/refresh-dividend-calendar

# Run digest in dry mode
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/weekly-digest?dry=1"
```

## Operational notes

- **Refresh runtime:** ~13s × N unique tickers. With 49 users averaging ~8 tickers, expect 30-50 unique tickers = ~7-11 minutes. Requires Vercel Pro (Hobby caps at 60s).
- **Digest runtime:** A few seconds even at 1k users — all DB reads, then sequential Resend calls. Resend handles ~10 req/sec; no throttling needed at our scale.
- **Empty week handling:** If a user has zero payments in the next 7 days, the email shows the next 28 days instead. Always sends if any payment is in the 28-day window.
- **Rollout plan:** Deploy → wait for next 5am ET refresh to populate cache → manually trigger digest in dry mode to verify totals → let Monday's cron fire normally.

## Adding an in-app toggle

Future work: add a "Weekly digest" toggle to `AccountModal.jsx`. Reads from / writes to `user_preferences.weekly_digest_enabled`. RLS already allows own-row writes from the browser.

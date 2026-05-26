// Vercel serverless function — daily refresh of dividend_calendar cache.
//
// Trigger:   Vercel cron, daily 5am ET (see vercel.json).
// Purpose:   Hit Polygon /v3/reference/dividends once per distinct ticker
//            across all users, write next-upcoming ex/pay/amount/frequency
//            to public.dividend_calendar. Downstream readers (weekly digest,
//            in-app paycheck calendar) never hit Polygon directly.
//
// Rate limit: Polygon Stocks Starter = 5 req/min. We pace at 13s between
//            calls (≈4.6 req/min, safety margin). For ~30 unique tickers
//            that's ~6 minutes — well under Vercel Pro's 60-min function
//            cap but over the Hobby 60-second cap. This must run on Pro.
//
// Auth:      CRON_SECRET in Authorization header (Vercel automatically adds
//            it to scheduled cron requests if configured in vercel.json).
//
// Env vars (Vercel server-only):
//   CRON_SECRET                  — random string, also set on each cron entry
//   SUPABASE_URL                 — same as VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY    — server-only, bypasses RLS
//   POLYGON_API_KEY              — Polygon Stocks Starter key

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Vercel exposes all env vars (including VITE_ prefixed ones) to serverless
// functions via process.env — the VITE_ prefix only controls client-bundle
// exposure. Read the legacy name first, fall back to the new canonical name.
const POLYGON_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_KEY;
const SLEEP_MS = 13_000;        // 13s between calls — under 5 req/min cap

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Map Polygon's `frequency` integer to a human label. Polygon returns:
//   1 = annual, 2 = semi-annual, 4 = quarterly, 12 = monthly.
function freqLabel(n) {
  return ({ 1: 'Annual', 2: 'Semi-Annual', 4: 'Quarterly', 12: 'Monthly' })[n] || null;
}

// Fetch upcoming dividend records for one ticker. We ask Polygon for the
// next ~5 dividends sorted by ex-date ascending, then filter to ones with
// ex-date >= today. We take the FIRST upcoming one as "next".
async function fetchNextDividend(ticker) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://api.polygon.io/v3/reference/dividends`
    + `?ticker=${encodeURIComponent(ticker)}`
    + `&ex_dividend_date.gte=${today}`
    + `&order=asc&sort=ex_dividend_date&limit=5`
    + `&apiKey=${POLYGON_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Polygon ${res.status} for ${ticker}`);
  }
  const json = await res.json();
  const upcoming = (json.results || []).filter(d => d.ex_dividend_date >= today);
  if (upcoming.length === 0) return null;

  const next = upcoming[0];
  // Polygon may return frequency as either a number (legacy) or a string label.
  // We coerce numbers to labels; pass strings through.
  let frequency = null;
  if (typeof next.frequency === 'number') {
    frequency = freqLabel(next.frequency);
  } else if (typeof next.frequency === 'string') {
    frequency = next.frequency;
  }

  return {
    ticker,
    next_ex_date: next.ex_dividend_date,
    next_pay_date: next.pay_date || null,
    next_amount: next.cash_amount,
    frequency,
    last_refreshed_at: new Date().toISOString(),
    source: 'polygon',
  };
}

export default async function handler(req, res) {
  // Auth: Vercel cron adds `Authorization: Bearer <CRON_SECRET>` if configured.
  // Reject anything else so this endpoint isn't externally pingable.
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (req.headers.authorization !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Pull every distinct ticker currently held by any user.
  const { data: rows, error: tickersErr } = await supabase
    .from('holdings')
    .select('ticker');
  if (tickersErr) {
    return res.status(500).json({ error: 'tickers_query_failed', detail: tickersErr.message });
  }

  const tickers = Array.from(
    new Set(
      (rows || [])
        .map(r => (r.ticker || '').toString().trim().toUpperCase())
        .filter(t => t.length > 0 && t.length <= 6 && /^[A-Z.\-]+$/.test(t))
    )
  ).sort();

  if (tickers.length === 0) {
    return res.status(200).json({ ok: true, tickers_refreshed: 0, errors: [] });
  }

  const startedAt = Date.now();
  const errors = [];
  let refreshed = 0;
  let skipped_no_upcoming = 0;

  for (const ticker of tickers) {
    try {
      const row = await fetchNextDividend(ticker);
      if (!row) {
        skipped_no_upcoming++;
        // Still touch last_refreshed_at so we don't re-fetch repeatedly.
        // Insert a sentinel with nulls so the row exists.
        const { error: upErr } = await supabase
          .from('dividend_calendar')
          .upsert({
            ticker,
            next_ex_date: null,
            next_pay_date: null,
            next_amount: null,
            frequency: null,
            last_refreshed_at: new Date().toISOString(),
            source: 'polygon',
          }, { onConflict: 'ticker' });
        if (upErr) errors.push({ ticker, stage: 'upsert_null', message: upErr.message });
      } else {
        const { error: upErr } = await supabase
          .from('dividend_calendar')
          .upsert(row, { onConflict: 'ticker' });
        if (upErr) {
          errors.push({ ticker, stage: 'upsert', message: upErr.message });
        } else {
          refreshed++;
        }
      }
    } catch (e) {
      errors.push({ ticker, stage: 'fetch', message: e.message });
    }
    await sleep(SLEEP_MS);
  }

  return res.status(200).json({
    ok: true,
    tickers_seen: tickers.length,
    tickers_refreshed: refreshed,
    tickers_skipped_no_upcoming: skipped_no_upcoming,
    errors,
    duration_ms: Date.now() - startedAt,
  });
}

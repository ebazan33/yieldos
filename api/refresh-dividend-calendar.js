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

// Bump function timeout. Default is 10-15s; we need up to ~7min for the
// throttled Polygon loop. 300s is Pro's max without Fluid Compute.
export const config = {
  maxDuration: 300,
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Vercel exposes all env vars (including VITE_ prefixed ones) to serverless
// functions via process.env — the VITE_ prefix only controls client-bundle
// exposure. Read the legacy name first, fall back to the new canonical name.
const POLYGON_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_KEY;
const SLEEP_MS = 12_500;        // 12.5s between calls — just under 5 req/min cap
const MAX_TICKERS_PER_RUN = 22; // keeps total runtime under maxDuration with margin

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Map Polygon's `frequency` integer to a human label. Polygon returns:
//   1 = annual, 2 = semi-annual, 4 = quarterly, 12 = monthly.
function freqLabel(n) {
  return ({ 1: 'Annual', 2: 'Semi-Annual', 4: 'Quarterly', 12: 'Monthly' })[n] || null;
}

// Add N days to a YYYY-MM-DD string. Pure date math, no timezone shenanigans.
function addDaysIso(yyyyMmDd, days) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Infer frequency interval in days from a series of past ex-dates.
// Returns 30 for monthly, 90 for quarterly, 180 for semi-annual, 365 for annual.
function inferFrequencyDays(pastDivs) {
  if (pastDivs.length < 2) return 90; // safe default: quarterly
  // Sort newest first, take recent 12 to be robust.
  const sorted = pastDivs.slice().sort((a, b) =>
    (b.ex_dividend_date || '').localeCompare(a.ex_dividend_date || '')
  ).slice(0, 12);
  // Compute average gap between consecutive ex-dates.
  let totalDays = 0;
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1].ex_dividend_date);
    const b = new Date(sorted[i].ex_dividend_date);
    const days = Math.round((a - b) / (1000 * 60 * 60 * 24));
    if (days > 5 && days < 400) { // sanity-bound
      totalDays += days;
      count++;
    }
  }
  if (count === 0) return 90;
  const avg = totalDays / count;
  // Snap to standard cadences.
  if (avg < 45) return 30;
  if (avg < 135) return 90;
  if (avg < 270) return 180;
  return 365;
}

function freqLabelFromDays(days) {
  if (days <= 30) return 'Monthly';
  if (days <= 90) return 'Quarterly';
  if (days <= 180) return 'Semi-Annual';
  return 'Annual';
}

// Fetch the best-available next dividend for one ticker.
//
// Strategy:
//   1. Pull recent history (~12 dividends), sorted by ex-date desc.
//   2. If any record has ex_dividend_date >= today → return it as declared.
//   3. Else, take the most-recent past dividend and PROJECT the next one by
//      adding the inferred frequency interval. Mark source as 'estimated'.
//   4. If no history at all → return null.
async function fetchNextDividend(ticker) {
  const today = new Date().toISOString().slice(0, 10);
  // Pull a window of recent + upcoming so we can both detect declarations
  // and infer cadence in a single call.
  const url = `https://api.polygon.io/v3/reference/dividends`
    + `?ticker=${encodeURIComponent(ticker)}`
    + `&order=desc&sort=ex_dividend_date&limit=12`
    + `&apiKey=${POLYGON_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Polygon ${res.status} for ${ticker}`);
  }
  const json = await res.json();
  const all = json.results || [];
  if (all.length === 0) return null;

  // 1. Did Polygon declare a future dividend?
  const upcoming = all
    .filter(d => d.ex_dividend_date && d.ex_dividend_date >= today)
    .sort((a, b) => a.ex_dividend_date.localeCompare(b.ex_dividend_date));

  if (upcoming.length > 0) {
    const next = upcoming[0];
    let frequency = null;
    if (typeof next.frequency === 'number') frequency = freqLabel(next.frequency);
    else if (typeof next.frequency === 'string') frequency = next.frequency;
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

  // 2. No upcoming declared. Extrapolate from the most-recent past dividend.
  const past = all
    .filter(d => d.ex_dividend_date && d.ex_dividend_date < today)
    .sort((a, b) => b.ex_dividend_date.localeCompare(a.ex_dividend_date));
  if (past.length === 0) return null;

  const recent = past[0];
  const freqDays = inferFrequencyDays(all);
  const projectedExDate = addDaysIso(recent.ex_dividend_date, freqDays);
  const payOffset = recent.pay_date && recent.ex_dividend_date
    ? Math.max(0, Math.round(
        (new Date(recent.pay_date) - new Date(recent.ex_dividend_date)) / (1000 * 60 * 60 * 24)
      ))
    : 7; // safe default: pay date 1 week after ex-date
  const projectedPayDate = addDaysIso(projectedExDate, payOffset);

  return {
    ticker,
    next_ex_date: projectedExDate,
    next_pay_date: projectedPayDate,
    next_amount: recent.cash_amount, // assume same amount as most recent payment
    frequency: freqLabelFromDays(freqDays),
    last_refreshed_at: new Date().toISOString(),
    source: 'polygon_estimated',
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

  const allTickers = Array.from(
    new Set(
      (rows || [])
        .map(r => (r.ticker || '').toString().trim().toUpperCase())
        .filter(t => t.length > 0 && t.length <= 6 && /^[A-Z.\-]+$/.test(t))
    )
  );

  if (allTickers.length === 0) {
    return res.status(200).json({ ok: true, tickers_refreshed: 0, errors: [] });
  }

  // Order by staleness: tickers absent from dividend_calendar OR with the
  // oldest last_refreshed_at go first. The daily cron caps total work at
  // MAX_TICKERS_PER_RUN; over a few days the cache covers everything.
  const { data: existing } = await supabase
    .from('dividend_calendar')
    .select('ticker, last_refreshed_at');
  const lastRefreshByTicker = new Map();
  for (const r of existing || []) {
    lastRefreshByTicker.set(r.ticker, r.last_refreshed_at || '');
  }
  const tickers = allTickers
    .slice()
    .sort((a, b) => {
      const la = lastRefreshByTicker.get(a) || '';   // empty = never refreshed = oldest
      const lb = lastRefreshByTicker.get(b) || '';
      return la.localeCompare(lb);
    })
    .slice(0, MAX_TICKERS_PER_RUN);

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
    total_tickers_in_holdings: allTickers.length,
    tickers_processed_this_run: tickers.length,
    tickers_remaining_for_next_run: Math.max(0, allTickers.length - tickers.length),
    tickers_refreshed: refreshed,
    tickers_skipped_no_upcoming: skipped_no_upcoming,
    errors,
    duration_ms: Date.now() - startedAt,
  });
}

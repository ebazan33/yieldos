-- import_log — audit trail of CSV imports.
--
-- Why this exists: imports are the highest-stakes flow in yieldos. A parser
-- bug, a malformed CSV, or a flaky Polygon response can result in wrong
-- positions being written to the user's portfolio. Without an audit trail
-- we'd have no way to:
--   - Investigate a support ticket like "my import was wrong, what happened?"
--   - Catch parser regressions in production by querying for spike in
--     failed imports or unusual row counts
--   - Show the user their own import history if they ask
--
-- What we log: counts and totals only — NEVER specific tickers, share
-- counts, or prices. The audit row should be useful for debugging
-- aggregates without storing PII the user didn't ask us to retain.
-- If we ever need ticker-level detail for support, the user can re-upload
-- and we'll see it live, not from history.

create table if not exists public.import_log (
  id              uuid not null primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),

  -- Outcome metrics. Both default to 0 so partial successes show up cleanly.
  success_count   int  not null default 0,
  failed_count    int  not null default 0,
  total_rows      int  not null default 0,

  -- Aggregate USD value imported (sum of shares × price across selected
  -- rows that had a CSV price). Helps spot import-size patterns over time
  -- without storing per-row data.
  total_value_usd numeric(14, 2),

  -- Filename only — no contents stored. Useful for support ("you uploaded
  -- 'fidelity_may.csv', the SCHD row failed") without retaining the file.
  source_filename text,

  -- Free-text error message when the import failed at parse time. Bounded
  -- to 500 chars by application code to avoid bloat.
  error_message   text
);

create index if not exists import_log_user_id_created_at_idx
  on public.import_log (user_id, created_at desc);

alter table public.import_log enable row level security;

drop policy if exists "users read own import log" on public.import_log;
drop policy if exists "users insert own import log" on public.import_log;

-- Read own rows so the user can see their own import history (future UI).
create policy "users read own import log"
  on public.import_log
  for select
  using (auth.uid() = user_id);

-- Insert own rows from the browser. user_id must match the authenticated
-- user — no impersonation. This is the only write the client does.
create policy "users insert own import log"
  on public.import_log
  for insert
  with check (auth.uid() = user_id);

-- Intentionally NO update or delete policies. Audit logs are append-only.
-- Service role (admin) can still delete via Supabase dashboard if a user
-- requests data deletion under GDPR/CCPA.

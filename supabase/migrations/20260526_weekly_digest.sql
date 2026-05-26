-- Weekly Digest feature — dividend_calendar cache + user_preferences.
--
-- Two new tables:
--
-- 1. dividend_calendar — ticker-level cache of upcoming dividends.
--    Refreshed daily by /api/refresh-dividend-calendar.js (Vercel cron, 5am ET).
--    Read by the digest cron and (eventually) by the in-app paycheck calendar
--    so we stop hitting Polygon on every page load.
--
-- 2. user_preferences — per-user toggles. Currently just weekly_digest_enabled,
--    but designed to expand (email cadence, timezone, etc.) without further
--    migrations.
--
-- RLS posture:
--   dividend_calendar: any authenticated user can read (ticker data isn't
--     user-specific), all writes denied (cron writes via service role).
--   user_preferences: read + insert + update own row only. No delete.

-- ── dividend_calendar ──────────────────────────────────────────────────
create table if not exists public.dividend_calendar (
  ticker             text primary key,
  next_ex_date       date,
  next_pay_date      date,
  next_amount        numeric(12, 6),
  frequency          text,                  -- 'Monthly' | 'Quarterly' | 'Semi-Annual' | 'Annual' | null
  last_refreshed_at  timestamptz not null default now(),
  source             text not null default 'polygon'
);

create index if not exists dividend_calendar_next_pay_date_idx
  on public.dividend_calendar (next_pay_date);

alter table public.dividend_calendar enable row level security;

-- Read: any authenticated user.
drop policy if exists "dividend_calendar read" on public.dividend_calendar;
create policy "dividend_calendar read"
  on public.dividend_calendar
  for select
  to authenticated
  using (true);

-- Writes: denied. Service role bypasses RLS, so the cron still works.
-- No insert/update/delete policy is created intentionally.


-- ── user_preferences ───────────────────────────────────────────────────
create table if not exists public.user_preferences (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  weekly_digest_enabled    boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

-- Read own row.
drop policy if exists "user_preferences select own" on public.user_preferences;
create policy "user_preferences select own"
  on public.user_preferences
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Insert own row (defaults on first read in the app).
drop policy if exists "user_preferences insert own" on public.user_preferences;
create policy "user_preferences insert own"
  on public.user_preferences
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Update own row.
drop policy if exists "user_preferences update own" on public.user_preferences;
create policy "user_preferences update own"
  on public.user_preferences
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- updated_at trigger.
create or replace function public.user_preferences_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_preferences_updated_at on public.user_preferences;
create trigger user_preferences_updated_at
  before update on public.user_preferences
  for each row
  execute function public.user_preferences_set_updated_at();

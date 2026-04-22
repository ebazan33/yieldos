-- Portfolio snapshots — one row per user per calendar day, written whenever
-- their holdings change. Replaces the old localStorage-based history so the
-- Dashboard's "portfolio over time" chart works across devices.
--
-- We intentionally do NOT store per-holding snapshots. The chart only needs
-- rolled-up totals, and row count stays bounded (365 per user per year).
CREATE TABLE IF NOT EXISTS public.portfolio_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_date   DATE NOT NULL,
  total_value     NUMERIC(18,2) NOT NULL,
  monthly_income  NUMERIC(18,2) NOT NULL,
  annual_income   NUMERIC(18,2) NOT NULL,
  holdings_count  INTEGER NOT NULL DEFAULT 0,
  -- Cost-basis rollup. Nullable — early rows pre-dating cost-basis support
  -- won't have it. Once a user starts entering basis, this fills in.
  total_cost      NUMERIC(18,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One snapshot per user per day — upsert target for the daily write.
  UNIQUE (user_id, snapshot_date)
);

-- Fast range queries for the dashboard chart (always filtered by user_id).
CREATE INDEX IF NOT EXISTS portfolio_snapshots_user_date_idx
  ON public.portfolio_snapshots (user_id, snapshot_date DESC);

-- RLS — users can only see + manage their own snapshots.
ALTER TABLE public.portfolio_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_select_own" ON public.portfolio_snapshots;
CREATE POLICY "snapshots_select_own"
  ON public.portfolio_snapshots
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_insert_own" ON public.portfolio_snapshots;
CREATE POLICY "snapshots_insert_own"
  ON public.portfolio_snapshots
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_update_own" ON public.portfolio_snapshots;
CREATE POLICY "snapshots_update_own"
  ON public.portfolio_snapshots
  FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_delete_own" ON public.portfolio_snapshots;
CREATE POLICY "snapshots_delete_own"
  ON public.portfolio_snapshots
  FOR DELETE
  USING (auth.uid() = user_id);

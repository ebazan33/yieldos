-- Watchlist — tickers the user is tracking but doesn't own. Same shape as
-- holdings minus the position-specific columns (shares, cost_basis, freq
-- cadence fields). We snapshot price/yield/streak at add time so the list
-- renders without a Polygon call; refresh() re-pulls fresh numbers.
CREATE TABLE IF NOT EXISTS public.watchlist (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker          TEXT NOT NULL,
  name            TEXT,
  price           NUMERIC(14,4),
  yld             NUMERIC(8,4),
  sector          TEXT,
  freq            TEXT,
  safe            TEXT,
  growth_streak   INTEGER,
  badge           TEXT,
  note            TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ticker)
);

CREATE INDEX IF NOT EXISTS watchlist_user_idx
  ON public.watchlist (user_id, added_at DESC);

ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "watchlist_select_own" ON public.watchlist;
CREATE POLICY "watchlist_select_own"
  ON public.watchlist
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "watchlist_insert_own" ON public.watchlist;
CREATE POLICY "watchlist_insert_own"
  ON public.watchlist
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "watchlist_update_own" ON public.watchlist;
CREATE POLICY "watchlist_update_own"
  ON public.watchlist
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "watchlist_delete_own" ON public.watchlist;
CREATE POLICY "watchlist_delete_own"
  ON public.watchlist
  FOR DELETE USING (auth.uid() = user_id);

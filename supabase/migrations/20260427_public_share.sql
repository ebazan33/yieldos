-- Public portfolio share links.
-- A user can generate an opaque slug that renders a read-only, anonymized
-- snapshot of their portfolio. The ACTUAL data is rendered client-side from
-- the holdings table via the slug → user_id lookup; we don't denormalize the
-- holdings snapshot because users want live figures on their share page.
--
-- Kept minimal: one slug per user (they can regenerate to invalidate the old
-- link). `display_name` is shown instead of the email — avoids leaking PII.
-- `show_values` toggles whether dollar totals are shown (off = just yields).
CREATE TABLE IF NOT EXISTS public.portfolio_shares (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  show_values     BOOLEAN NOT NULL DEFAULT true,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portfolio_shares_slug_idx
  ON public.portfolio_shares (slug);

ALTER TABLE public.portfolio_shares ENABLE ROW LEVEL SECURITY;

-- Owner can manage their own row.
DROP POLICY IF EXISTS "portfolio_shares_own" ON public.portfolio_shares;
CREATE POLICY "portfolio_shares_own"
  ON public.portfolio_shares
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- PUBLIC read of enabled rows by slug — anyone with the slug can fetch the
-- matching row (just user_id + display_name + show_values). The holdings
-- themselves still live behind holdings' RLS; that's why we add a dedicated
-- public read policy below on holdings, gated on the share row existing.
DROP POLICY IF EXISTS "portfolio_shares_public_read" ON public.portfolio_shares;
CREATE POLICY "portfolio_shares_public_read"
  ON public.portfolio_shares
  FOR SELECT
  TO anon, authenticated
  USING (enabled = true);

-- Public-read policy on holdings: anyone can SELECT a holding if its
-- user_id has an enabled share row. The share viewer page queries
-- holdings filtered by user_id; RLS lets it through iff this policy matches.
DROP POLICY IF EXISTS "holdings_public_read_via_share" ON public.holdings;
CREATE POLICY "holdings_public_read_via_share"
  ON public.holdings
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.portfolio_shares ps
      WHERE ps.user_id = holdings.user_id
        AND ps.enabled = true
    )
  );

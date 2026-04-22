-- Actual dividend payments log. The paycheck calendar is a *projection* —
-- this table stores what the user reports actually landed in their account,
-- closing the loop: "you said I'd get $X, I got $Y".
--
-- Each row is one paid dividend (per holding per pay date). Amount is in the
-- holding's native currency; we FX-convert at read time for dashboard
-- rollups so the math stays honest even if FX rates change later.
CREATE TABLE IF NOT EXISTS public.dividend_payments (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  holding_id      BIGINT,  -- no FK so deleting the holding doesn't wipe history
  ticker          TEXT NOT NULL,
  pay_date        DATE NOT NULL,
  amount          NUMERIC(14,4) NOT NULL,   -- gross dividend amount received
  shares_at_pay   NUMERIC(18,6),            -- shares held at pay date (for audit)
  currency        TEXT NOT NULL DEFAULT 'USD',
  note            TEXT,                     -- optional user note
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guard non-negative amounts.
ALTER TABLE public.dividend_payments
  DROP CONSTRAINT IF EXISTS dividend_payments_amount_nonneg;
ALTER TABLE public.dividend_payments
  ADD CONSTRAINT dividend_payments_amount_nonneg CHECK (amount >= 0);

ALTER TABLE public.dividend_payments
  DROP CONSTRAINT IF EXISTS dividend_payments_currency_check;
ALTER TABLE public.dividend_payments
  ADD CONSTRAINT dividend_payments_currency_check CHECK (currency IN ('USD', 'CAD'));

-- Fast lookups by user + date range (YTD widget, tax export, paycheck calendar).
CREATE INDEX IF NOT EXISTS dividend_payments_user_date_idx
  ON public.dividend_payments (user_id, pay_date DESC);

CREATE INDEX IF NOT EXISTS dividend_payments_user_ticker_idx
  ON public.dividend_payments (user_id, ticker);

-- RLS — same pattern as portfolio_snapshots.
ALTER TABLE public.dividend_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dividend_payments_select_own" ON public.dividend_payments;
CREATE POLICY "dividend_payments_select_own"
  ON public.dividend_payments
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "dividend_payments_insert_own" ON public.dividend_payments;
CREATE POLICY "dividend_payments_insert_own"
  ON public.dividend_payments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "dividend_payments_update_own" ON public.dividend_payments;
CREATE POLICY "dividend_payments_update_own"
  ON public.dividend_payments
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "dividend_payments_delete_own" ON public.dividend_payments;
CREATE POLICY "dividend_payments_delete_own"
  ON public.dividend_payments
  FOR DELETE USING (auth.uid() = user_id);

-- Dividend growth streak columns.
-- growth_streak: consecutive years where total dividends paid > prior year.
-- pay_streak:    consecutive years where any dividend was paid (less strict).
-- badge:         "King" (50+), "Aristocrat" (25+), "Achiever" (10+),
--                "Challenger" (5+), or NULL. Derived from growth_streak but
--                stored to avoid recomputing for every render.
ALTER TABLE public.holdings
  ADD COLUMN IF NOT EXISTS growth_streak INTEGER,
  ADD COLUMN IF NOT EXISTS pay_streak    INTEGER,
  ADD COLUMN IF NOT EXISTS badge         TEXT;

ALTER TABLE public.holdings
  DROP CONSTRAINT IF EXISTS holdings_badge_check;
ALTER TABLE public.holdings
  ADD CONSTRAINT holdings_badge_check CHECK (badge IS NULL OR badge IN ('Challenger', 'Achiever', 'Aristocrat', 'King'));

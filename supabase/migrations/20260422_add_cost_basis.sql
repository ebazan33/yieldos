-- Cost basis tracking.
-- Stored as cost per share (matches how brokerages report it and keeps math trivial
-- when a user adds extra shares later — just blend). Value is in the holding's
-- native currency (so CAD holdings have CAD cost basis). Nullable because existing
-- holdings pre-dating this column have no basis yet; UI treats NULL as "not set".
ALTER TABLE public.holdings
  ADD COLUMN IF NOT EXISTS cost_basis NUMERIC(18,6);

-- Non-negative guard. NULL is allowed (unset); negatives never make sense.
ALTER TABLE public.holdings
  DROP CONSTRAINT IF EXISTS holdings_cost_basis_nonneg;
ALTER TABLE public.holdings
  ADD CONSTRAINT holdings_cost_basis_nonneg CHECK (cost_basis IS NULL OR cost_basis >= 0);

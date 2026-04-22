-- Migration: add `currency` to holdings so we can support Canadian (TSX) tickers
-- alongside US. Existing rows default to 'USD' — no behavior change for current
-- users. New CAD holdings (TSX .TO / .V / .NE / .CN suffixes) will set 'CAD'
-- from the AddHoldingModal; dashboard / calendar / paycheck math converts
-- everything to USD using a daily-cached FX rate before summing.
--
-- Run this in the Supabase SQL editor. Idempotent — safe to re-run.

ALTER TABLE public.holdings
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';

-- Backfill any pre-existing NULLs just in case (the NOT NULL above should
-- prevent new ones, but defensive belt-and-suspenders).
UPDATE public.holdings
   SET currency = 'USD'
 WHERE currency IS NULL;

-- Constrain to the two currencies we actually handle. Adding more later =
-- drop and recreate the check.
ALTER TABLE public.holdings
  DROP CONSTRAINT IF EXISTS holdings_currency_check;

ALTER TABLE public.holdings
  ADD CONSTRAINT holdings_currency_check
  CHECK (currency IN ('USD', 'CAD'));

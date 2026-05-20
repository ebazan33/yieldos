-- subscriptions table — source of truth for paid-plan state.
--
-- Why this exists: previously the user's plan lived in auth.users.user_metadata,
-- which is writable by the user themselves via supabase.auth.updateUser(). That
-- means any logged-in user could promote themselves to Harvest from the browser
-- console — a hard paywall vulnerability. This table moves plan state to a
-- row that only the Stripe webhook (using the service role key) can write,
-- while users keep read access to their own row.
--
-- Source of truth pipeline:
--   Stripe Checkout/Subscription event
--     → /api/stripe-webhook.js (server, verifies signature)
--     → supabase service role
--     → upsert into public.subscriptions
--     → client reads via RLS-protected select on own user_id

create table if not exists public.subscriptions (
  user_id uuid not null primary key
    references auth.users(id) on delete cascade,

  -- Plan tier. 'Seed' is the free default; anyone without a row is implicitly Seed.
  plan text not null default 'Seed'
    check (plan in ('Seed', 'Grow', 'Harvest')),

  -- Billing cycle. Null for Seed (no billing); 'monthly' or 'annual' otherwise.
  plan_cycle text
    check (plan_cycle in ('monthly', 'annual')),

  -- Mirror of Stripe's subscription.status. Drives the "are they paying?" check.
  status text not null default 'inactive'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'inactive')),

  -- Trial expiry. ISO timestamp from Stripe's trial_end (converted from epoch).
  -- Used by the client to render the Grow trial banner / countdown.
  trial_ends_at timestamptz,

  -- End of the currently-paid period. Drives "your access continues until X"
  -- copy after a cancellation — Stripe lets you keep access until the period
  -- you already paid for ends.
  current_period_end timestamptz,

  -- Stripe identifiers. We need stripe_customer_id to look up the user when
  -- handling subscription.updated/.deleted events (those don't carry
  -- client_reference_id, only the customer id).
  stripe_customer_id text,
  stripe_subscription_id text,

  -- Audit / cache-busting timestamp. Updated by the webhook on every write.
  updated_at timestamptz not null default now()
);

-- Indexes for the webhook's lookup paths.
create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_stripe_subscription_id_idx
  on public.subscriptions (stripe_subscription_id);

-- RLS — users can read their own row, nobody can write via the API.
-- The service role bypasses RLS, so the webhook handler can upsert freely.
alter table public.subscriptions enable row level security;

-- Drop existing policies if re-running this migration.
drop policy if exists "users read own subscription" on public.subscriptions;

create policy "users read own subscription"
  on public.subscriptions
  for select
  using (auth.uid() = user_id);

-- Intentionally NO insert/update/delete policies for authenticated users.
-- Only the Stripe webhook (using SUPABASE_SERVICE_ROLE_KEY) can write rows.

-- ─── Backfill ──────────────────────────────────────────────────────────────
-- One-time backfill from user_metadata for any existing paying users so they
-- don't lose access when the client switches to reading from this table.
-- New users will get their row created by the webhook on first payment.
-- Safe to re-run: ON CONFLICT clause makes this idempotent.

insert into public.subscriptions (user_id, plan, plan_cycle, status, trial_ends_at, updated_at)
select
  u.id as user_id,
  coalesce(u.raw_user_meta_data->>'plan', 'Seed') as plan,
  u.raw_user_meta_data->>'plan_cycle' as plan_cycle,
  case
    when coalesce(u.raw_user_meta_data->>'plan', 'Seed') = 'Seed' then 'inactive'
    when (u.raw_user_meta_data->>'trial_ends_at')::timestamptz > now() then 'trialing'
    else 'active'
  end as status,
  (u.raw_user_meta_data->>'trial_ends_at')::timestamptz as trial_ends_at,
  now() as updated_at
from auth.users u
where coalesce(u.raw_user_meta_data->>'plan', 'Seed') in ('Seed', 'Grow', 'Harvest')
on conflict (user_id) do nothing;

-- ─── Trigger to keep updated_at fresh on every write ───────────────────────
-- Defensive: even though the webhook sets updated_at explicitly, this ensures
-- any future direct writes (psql admin, etc.) don't leave stale timestamps.

create or replace function public.set_subscriptions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row
  execute function public.set_subscriptions_updated_at();

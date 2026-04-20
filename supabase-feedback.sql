-- ============================================================
-- Yieldos — Feedback table
-- Run this in your Supabase SQL Editor:
--   supabase.com → your project → SQL Editor → New query → paste → Run
-- ============================================================

create table if not exists feedback (
  id          uuid default gen_random_uuid() primary key,
  -- Nullable + "on delete set null" so feedback survives a user account deletion.
  -- Keeps the message for our records even if the user nukes their account.
  user_id     uuid references auth.users(id) on delete set null,
  -- User-provided email; prefilled from auth.users for signed-in users but
  -- editable (privacy-forward users can leave their @duck / @me alias here).
  email       text,
  -- Type of feedback — keeps inbox triage sane. Nullable so older rows stay valid
  -- if we change the enum later. Use a CHECK so typos get caught at insert time.
  category    text check (category in ('bug','feature','love','other')),
  -- The actual message. Required, min 1 char (checked app-side too).
  message     text not null,
  -- Debug context — useful when triaging bug reports. All optional.
  user_agent  text,
  page        text,
  plan        text,
  created_at  timestamptz default now()
);

-- Enable Row Level Security. We want the app (and anonymous visitors) to be
-- able to INSERT feedback, but nobody reads it via the client — only you, via
-- the Supabase dashboard (which uses service_role and bypasses RLS).
alter table feedback enable row level security;

-- Anyone (including anon visitors — useful for landing-page feedback if we
-- ever expose it there) can insert feedback. No read/update/delete policy
-- means those operations are blocked for everyone client-side.
create policy "Anyone can submit feedback"
  on feedback for insert
  to anon, authenticated
  with check (true);

-- Index for sorting by newest-first when you read it in the Dashboard or
-- Table Editor. Trivial at your scale, but doesn't hurt.
create index if not exists feedback_created_at_idx on feedback (created_at desc);

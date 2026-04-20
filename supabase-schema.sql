-- Run this in your Supabase SQL Editor
-- Go to: supabase.com → your project → SQL Editor → New Query → paste this → Run

create table holdings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  ticker text not null,
  name text not null,
  shares numeric not null,
  price numeric not null,
  yld numeric not null,
  sector text default 'Unknown',
  freq text default 'Quarterly',
  safe text default 'N/A',
  next_div text default 'TBD',
  created_at timestamptz default now()
);

-- Enable Row Level Security (RLS) so users only see their own holdings
alter table holdings enable row level security;

-- Policy: users can only read their own holdings
create policy "Users can view own holdings"
  on holdings for select
  using (auth.uid() = user_id);

-- Policy: users can insert their own holdings
create policy "Users can insert own holdings"
  on holdings for insert
  with check (auth.uid() = user_id);

-- Policy: users can delete their own holdings
create policy "Users can delete own holdings"
  on holdings for delete
  using (auth.uid() = user_id);

-- Policy: users can update their own holdings
create policy "Users can update own holdings"
  on holdings for update
  using (auth.uid() = user_id);

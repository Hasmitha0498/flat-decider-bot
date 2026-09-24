-- Flat Decider: minimal schema.
-- Run once in the Supabase SQL editor (or with `supabase db push`).

create extension if not exists pgcrypto;

-- One "house search" = one group of flatmates.
create table if not exists groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  join_code   text not null unique,
  created_by  bigint,                              -- Telegram user id of the creator
  status      text not null default 'active' check (status in ('active', 'closed')),
  is_demo     boolean not null default false,      -- demo data can be removed with one delete
  created_at  timestamptz not null default now()
);

-- A Telegram user inside a group. A Telegram user can be in one group at a time.
create table if not exists members (
  id                    uuid primary key default gen_random_uuid(),
  group_id              uuid not null references groups(id) on delete cascade,
  telegram_user_id      bigint unique,             -- null only for demo placeholder members
  telegram_username     text,
  display_name          text not null,
  preferences_complete  boolean not null default false,
  state                 jsonb,                     -- where the member is in the chat flow (question, pending answer...)
  created_at            timestamptz not null default now()
);
create index if not exists members_group_idx on members(group_id);

-- Structured preferences: one row per member per criterion.
-- desired_value is JSONB so new criteria need no new columns.
create table if not exists preferences (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references members(id) on delete cascade,
  criterion      text not null,
  desired_value  jsonb,
  importance     text not null check (importance in ('must_have', 'prefer', 'no_preference')),
  updated_at     timestamptz not null default now(),
  unique (member_id, criterion)
);

-- Flats the members found themselves.
create table if not exists listings (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups(id) on delete cascade,
  submitted_by    uuid not null references members(id) on delete cascade,
  url             text not null,
  normalized_url  text not null,                   -- used for duplicate detection
  manual_text     text,                            -- listing text pasted by the member (fallback source)
  status          text not null default 'pending'
                  check (status in ('pending', 'extracted', 'unreadable', 'failed')),
  status_detail   text,                            -- short user-facing reason when unreadable/failed
  created_at      timestamptz not null default now(),
  unique (group_id, normalized_url)
);
create index if not exists listings_group_idx on listings(group_id);

-- Structured facts Gemini extracted from a listing (cached between /compare runs).
create table if not exists listing_extractions (
  listing_id     uuid primary key references listings(id) on delete cascade,
  input_hash     text not null,                    -- changes when the source text or custom checks change
  source         text not null check (source in ('url', 'manual')),
  facts          jsonb not null,
  custom_checks  jsonb not null default '{}'::jsonb,
  model          text,
  created_at     timestamptz not null default now()
);

-- Snapshot of each /compare result, used by "See full comparison".
create table if not exists comparison_runs (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references groups(id) on delete cascade,
  triggered_by  uuid references members(id) on delete set null,
  results       jsonb not null,
  created_at    timestamptz not null default now()
);
create index if not exists comparison_runs_group_idx on comparison_runs(group_id, created_at desc);

-- Row Level Security is ON with no policies: only the server-side service role key
-- can read/write. If you must use the anon key instead, run optional_anon_key_access.sql.
alter table groups              enable row level security;
alter table members             enable row level security;
alter table preferences         enable row level security;
alter table listings            enable row level security;
alter table listing_extractions enable row level security;
alter table comparison_runs     enable row level security;

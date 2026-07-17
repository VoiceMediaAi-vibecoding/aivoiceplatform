-- Run this in the Supabase SQL Editor to set up the schema

create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  total_cost_usd   numeric(12, 8) default 0,
  cost_by_provider jsonb default '{}'::jsonb,
  room_name   text,
  identity    text
);

create table if not exists api_usage (
  id           bigserial primary key,
  session_id   uuid references sessions(id) on delete cascade,
  provider     text not null,   -- openai | deepgram | elevenlabs
  model        text not null,
  metric_type  text not null,   -- tokens | audio_seconds | characters
  metric_value numeric(14, 4) not null,
  cost_usd     numeric(12, 8) not null,
  timestamp    timestamptz not null default now(),
  metadata     jsonb default '{}'::jsonb
);

-- Indexes for dashboard queries
create index if not exists api_usage_session_idx   on api_usage (session_id);
create index if not exists api_usage_provider_idx  on api_usage (provider);
create index if not exists api_usage_timestamp_idx on api_usage (timestamp desc);
create index if not exists sessions_ended_at_idx   on sessions (ended_at desc);

-- Enable Row Level Security (optional, for multi-tenant use)
-- alter table sessions  enable row level security;
-- alter table api_usage enable row level security;

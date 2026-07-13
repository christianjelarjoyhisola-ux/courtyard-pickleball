-- Durable Open Play session and price snapshots.
-- These nullable columns preserve compatibility with registrations created
-- before a day could contain more than one Open Play session.

alter table public.open_play_registrations
  add column if not exists session_key   text,
  add column if not exists session_start integer,
  add column if not exists session_end   integer,
  add column if not exists base_fee      numeric,
  add column if not exists system_fee    numeric,
  add column if not exists total_due     numeric;

-- `hour` has always represented the selected session's start. Backfill only
-- this unambiguous snapshot so legacy rows participate in per-session counts.
update public.open_play_registrations
set session_start = hour
where session_start is null
  and hour is not null;

-- Capacity checks intentionally continue to filter `hour` so the same query
-- works before and after this migration, including for legacy registrations.
create index if not exists idx_open_play_date_court_hour
  on public.open_play_registrations (date, court_id, hour);

create index if not exists idx_open_play_date_court_session_key
  on public.open_play_registrations (date, court_id, session_key)
  where session_key is not null;

-- Reload PostgREST's schema cache so supabase-js can write the new columns.
notify pgrst, 'reload schema';

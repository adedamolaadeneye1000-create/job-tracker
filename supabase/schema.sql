-- Job Hunt tracker: database setup.
-- Run this once in Supabase: SQL Editor > New query > paste everything > Run.
-- It creates two tables and locks them down with Row Level Security,
-- so each signed-in user can only see and change their own rows.

-- 1. Applications: one row per job you go for.
create table if not exists public.applications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  company          text not null,
  role             text not null,
  track            text not null default 'other',
  location         text,
  status           text not null default 'saved'
                   check (status in ('saved','applied','assessment','interview','final','offer','accepted','rejected','noresponse','withdrawn')),
  furthest         smallint not null default 0 check (furthest between 0 and 5),
  date_applied     date,
  closing_date     date,
  source           text,
  cv               text,
  ref              text,
  salary           text,
  url              text,
  next_action      text,
  next_action_date date,
  feedback         text,
  notes            text,
  needs_update     boolean not null default false,
  check_note       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists applications_user_id_idx on public.applications (user_id);

-- 2. Settings: one row per user (weekly target and plan ticks).
create table if not exists public.settings (
  user_id       uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  weekly_target smallint not null default 8 check (weekly_target between 1 and 30),
  checks        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- 3. Keep updated_at current on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists applications_updated_at on public.applications;
create trigger applications_updated_at
  before update on public.applications
  for each row execute function public.set_updated_at();

drop trigger if exists settings_updated_at on public.settings;
create trigger settings_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- 4. Let signed-in users reach the tables through the API (Row Level Security below still applies).
grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, update on public.settings to authenticated;

-- 5. Row Level Security: nobody can read or write a row unless it is theirs.
alter table public.applications enable row level security;
alter table public.settings enable row level security;

drop policy if exists "Read own applications" on public.applications;
drop policy if exists "Add own applications" on public.applications;
drop policy if exists "Change own applications" on public.applications;
drop policy if exists "Delete own applications" on public.applications;

create policy "Read own applications" on public.applications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add own applications" on public.applications
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Change own applications" on public.applications
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own applications" on public.applications
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Read own settings" on public.settings;
drop policy if exists "Add own settings" on public.settings;
drop policy if exists "Change own settings" on public.settings;

create policy "Read own settings" on public.settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Add own settings" on public.settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Change own settings" on public.settings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

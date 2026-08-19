-- =============================================================================
-- Row Level Security
-- =============================================================================
-- Threat model: every kiosk ships the anon key, and the kiosks are physically
-- reachable by players. So the anon key must be enough to *play* and never
-- enough to read another team's times, read a riddle answer, or write a
-- completion row directly. All state changes go through SECURITY DEFINER RPCs
-- (next migration); the tables themselves are read-mostly to their owner.
-- =============================================================================

alter table public.rooms           enable row level security;
alter table public.riddles         enable row level security;
alter table public.paths           enable row level security;
alter table public.teams           enable row level security;
alter table public.room_visits     enable row level security;
alter table public.answer_attempts enable row level security;
alter table public.event_settings  enable row level security;

-- -----------------------------------------------------------------------------
-- Helper: the calling team's row id, or NULL when unauthenticated.
-- -----------------------------------------------------------------------------
create or replace function public.current_team_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id from public.teams t where t.auth_user_id = auth.uid();
$$;

revoke all on function public.current_team_id() from public;
grant execute on function public.current_team_id() to authenticated;

-- -----------------------------------------------------------------------------
-- rooms :: public read of narrative/config. No answers live here.
-- -----------------------------------------------------------------------------
create policy rooms_read_all
  on public.rooms for select
  to anon, authenticated
  using (is_active);

-- -----------------------------------------------------------------------------
-- event_settings :: public read (event name, attempt cap shown in the UI).
-- -----------------------------------------------------------------------------
create policy event_settings_read_all
  on public.event_settings for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- riddles :: NO direct access at all, for anyone but the service role.
-- The prompt reaches the client through check_in_room(); the answer never does.
-- -----------------------------------------------------------------------------
-- (deliberately no policies: RLS with zero policies denies every row)

-- -----------------------------------------------------------------------------
-- paths :: a team may read only the path it was assigned.
-- Reading all 10 would let a team see how the field is distributed.
-- -----------------------------------------------------------------------------
create policy paths_read_own
  on public.paths for select
  to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.path_id = paths.id
        and t.auth_user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- teams :: a team reads its own row only. enrollment_code stays readable to the
-- owner (harmless once claimed) but the column is not selected by the client.
-- No insert/update/delete: enrollment happens via the edge function.
-- -----------------------------------------------------------------------------
create policy teams_read_own
  on public.teams for select
  to authenticated
  using (auth_user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- room_visits :: a team reads its own timing rows. Writes are RPC-only, so that
-- a team cannot stamp its own completed_at and fabricate a fast time.
-- -----------------------------------------------------------------------------
create policy room_visits_read_own
  on public.room_visits for select
  to authenticated
  using (team_id = public.current_team_id());

-- -----------------------------------------------------------------------------
-- answer_attempts :: own audit trail, read-only.
-- -----------------------------------------------------------------------------
create policy answer_attempts_read_own
  on public.answer_attempts for select
  to authenticated
  using (team_id = public.current_team_id());

-- -----------------------------------------------------------------------------
-- Table privileges
-- -----------------------------------------------------------------------------
-- Grants are set explicitly rather than inherited from the schema's default
-- privileges, which do not reliably cover tables created by a migration. RLS
-- only filters rows a role is already allowed to read, so a missing SELECT and
-- a restrictive policy look identical from the client - being explicit here is
-- what makes the policies above meaningful.
--
-- Start from nothing for the two client-facing roles...
revoke all on all tables in schema public from anon, authenticated;

-- ...then hand back exactly what a kiosk needs to read. Everything a kiosk
-- WRITES goes through a SECURITY DEFINER RPC, so no role below gets DML.
grant select on public.rooms           to anon, authenticated;
grant select on public.event_settings  to anon, authenticated;
grant select on public.teams           to authenticated;  -- own row (RLS)
grant select on public.paths           to authenticated;  -- own path (RLS)
grant select on public.room_visits     to authenticated;  -- own timings (RLS)
grant select on public.answer_attempts to authenticated;  -- own audit (RLS)

-- public.riddles is deliberately absent: no client role may read it at all, so
-- answer_normalised cannot leak. Prompts reach the kiosk via check_in_room().

-- The edge functions run as service_role and need real access. service_role
-- also carries BYPASSRLS, so the policies above do not constrain it - keeping
-- it off the kiosks is what keeps this safe.
grant select, insert, update, delete on all tables in schema public to service_role;

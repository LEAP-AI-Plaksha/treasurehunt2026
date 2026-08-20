-- =============================================================================
-- TREASURE by LEAP - A Louvre Heist :: core schema
-- =============================================================================
-- Model: every team checks in at a single HUB terminal, is handed one of 10
-- pre-generated paths through the 5 rotating game rooms, plays them in that
-- order, then plays the FINAL room - the MLP backtrack - which is the same last
-- stop for everyone, and returns to the HUB to check out.
--
--   HUB  ->  5 rotating rooms in the crew's own order  ->  FINAL  ->  HUB
--
-- Only the rotating rooms are permuted. The final room is deliberately outside
-- the paths so that every crew ends on it. Timing is recorded per room visit.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- rooms
-- -----------------------------------------------------------------------------
-- kind = 'hub'   : the shared start/end terminal (operator-run, no riddle)
-- kind = 'game'  : one of the 5 rotating puzzle rooms that appear in paths
-- kind = 'final' : the MLP backtrack, the same last stop for every crew. Not
--                  permuted, so it carries no ordinal.
-- ordinal        : 0..4 stable index used by the path generator. Rotating rooms
--                  only; NULL for the hub and the final room.
-- -----------------------------------------------------------------------------
create table public.rooms (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  kind          text not null default 'game' check (kind in ('hub', 'game', 'final')),
  ordinal       smallint unique,
  label         text not null,
  terminal_id   text not null,
  frontend_port integer,
  coordinates   jsonb not null default '{}'::jsonb,
  briefing      text not null default '',
  hint          text not null default '',
  points        integer not null default 100 check (points >= 0),
  timer_seconds integer not null default 60 check (timer_seconds > 0),
  max_attempts  integer not null default 3 check (max_attempts > 0),
  -- rooms whose answer is graded by the external ML service instead of a
  -- literal string match (CLIP scoring, image generation, pose tracking).
  ml_graded     boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  -- Only rotating rooms are permuted, so only they carry an ordinal.
  constraint rooms_ordinal_matches_kind check (
    (kind = 'game' and ordinal is not null) or (kind in ('hub', 'final') and ordinal is null)
  )
);

comment on table public.rooms is
  'Physical terminals. Exactly one row each of kind=''hub'' and kind=''final''; the 5 rotating rooms carry ordinal 0..4.';

-- -----------------------------------------------------------------------------
-- riddles
-- -----------------------------------------------------------------------------
-- Answers are never exposed to clients. RLS blocks all direct selects; the
-- submit_answer() RPC is the only thing that reads answer_normalised.
-- Placeholder prompts/answers are seeded and meant to be edited later.
-- -----------------------------------------------------------------------------
create table public.riddles (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references public.rooms(id) on delete cascade,
  prompt             text not null,
  -- lowercased, whitespace-collapsed expected answer. NULL for ml_graded rooms.
  answer_normalised  text,
  -- optional extra accepted answers, same normalisation
  answer_alternates  text[] not null default '{}',
  success_clue       text not null default '',
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- one active riddle per room
create unique index riddles_one_active_per_room
  on public.riddles (room_id) where is_active;

comment on table public.riddles is
  'Placeholder riddles, one active per room. answer_normalised is RLS-protected and read only by submit_answer().';

-- -----------------------------------------------------------------------------
-- paths
-- -----------------------------------------------------------------------------
-- 10 unique orderings of the 5 ROTATING rooms, built from two cyclic Latin
-- squares of order 5. Because 10 divides evenly by 5, every room is the
-- destination of exactly 2 of the 10 paths at every step - a perfectly flat
-- spread. The final room is not in here; it is appended to every route.
-- See the path generator in the next migration.
-- -----------------------------------------------------------------------------
-- Immutable permutation test: is this array exactly 0..n-1 in some order?
-- CHECK constraints cannot contain subqueries, so the rule lives in a function.
-- Deliberately generic in n, so adding or retiring a rotating room does not
-- require editing a constraint.
create or replace function public.is_room_permutation(p_ordinals smallint[])
returns boolean
language sql
immutable
parallel safe
as $$
  select p_ordinals is not null
     and array_length(p_ordinals, 1) > 0
     and (select array_agg(o order by o) from unnest(p_ordinals) as o)
         = (select array_agg(g::smallint order by g)
              from generate_series(0, array_length(p_ordinals, 1) - 1) as g);
$$;

create table public.paths (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  -- rotating room ordinals in play order: each of 0..4 exactly once
  room_ordinals smallint[] not null,
  created_at    timestamptz not null default now(),
  constraint paths_is_permutation check (public.is_room_permutation(room_ordinals))
);

comment on table public.paths is
  '10 unique orderings of the rotating rooms. Assigned at enrollment to spread crews across rooms.';

-- -----------------------------------------------------------------------------
-- teams
-- -----------------------------------------------------------------------------
-- Teams are pre-seeded with a printed enrollment_code. At the hub they claim
-- their slot and choose their own passcode; that creates the auth user and
-- links it here. All RLS keys off teams.auth_user_id = auth.uid().
-- -----------------------------------------------------------------------------
create table public.teams (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  -- printed on the team's slip; consumed once by the enroll-team function
  enrollment_code text not null,
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  path_id         uuid references public.paths(id) on delete restrict,
  enrolled_at     timestamptz,
  -- hub check-in / check-out: brackets the whole run
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint teams_finish_after_start check (
    finished_at is null or started_at is null or finished_at >= started_at
  )
);

comment on column public.teams.enrollment_code is
  'Single-use code printed on the team slip. Verified by the enroll-team edge function, never by a kiosk.';

-- -----------------------------------------------------------------------------
-- room_visits
-- -----------------------------------------------------------------------------
-- The timing record. One row per (team, room). arrived_at is stamped when the
-- team enters their credentials at that room's terminal; completed_at when the
-- riddle is solved (or the room is abandoned/locked out).
-- -----------------------------------------------------------------------------
create table public.room_visits (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams(id) on delete cascade,
  room_id          uuid not null references public.rooms(id) on delete restrict,
  -- Position of this room on the crew's route: 1..5 are the rotating rooms in
  -- their own order, and the last step is always the final room.
  step_index       smallint not null check (step_index >= 1),
  arrived_at       timestamptz not null default now(),
  completed_at     timestamptz,
  attempts         integer not null default 0 check (attempts >= 0),
  points_awarded   integer not null default 0 check (points_awarded >= 0),
  status           text not null default 'in_progress'
                     check (status in ('in_progress', 'completed', 'locked_out')),
  duration_seconds integer generated always as (
    case when completed_at is null then null
         else greatest(0, (extract(epoch from (completed_at - arrived_at)))::integer)
    end
  ) stored,
  constraint room_visits_complete_after_arrive check (
    completed_at is null or completed_at >= arrived_at
  ),
  -- a team plays each room exactly once
  unique (team_id, room_id),
  -- and occupies each step of its path exactly once
  unique (team_id, step_index)
);

create index room_visits_team_idx on public.room_visits (team_id, step_index);
create index room_visits_room_open_idx
  on public.room_visits (room_id) where status = 'in_progress';

comment on table public.room_visits is
  'Per-room timing. arrived_at = credentials entered at the terminal, completed_at = riddle solved.';

-- -----------------------------------------------------------------------------
-- answer_attempts
-- -----------------------------------------------------------------------------
-- Append-only audit of every submission, for scoring disputes and for spotting
-- a room whose placeholder riddle turns out to be unsolvable on the day.
-- -----------------------------------------------------------------------------
create table public.answer_attempts (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references public.teams(id) on delete cascade,
  room_id      uuid not null references public.rooms(id) on delete restrict,
  visit_id     uuid references public.room_visits(id) on delete cascade,
  submission   text not null default '',
  was_correct  boolean not null,
  created_at   timestamptz not null default now()
);

create index answer_attempts_team_room_idx
  on public.answer_attempts (team_id, room_id, created_at desc);

-- -----------------------------------------------------------------------------
-- event_settings :: single-row config, replaces game_settings.json "system"
-- -----------------------------------------------------------------------------
create table public.event_settings (
  id                  boolean primary key default true check (id),
  event_name          text not null default 'TREASURE by LEAP - A Louvre Heist',
  global_max_attempts integer not null default 3,
  -- when false, submit_answer() rejects everything: use to freeze scoring
  scoring_open        boolean not null default true,
  -- when false, teams may play their path in any order (useful for a soft start)
  enforce_path_order  boolean not null default true,
  updated_at          timestamptz not null default now()
);

insert into public.event_settings (id) values (true);

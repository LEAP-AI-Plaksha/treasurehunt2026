-- =============================================================================
-- Failing a room finishes it, exactly like passing does
-- =============================================================================
-- A crew must never be stuck in a room. Two changes:
--
--   1. abandon_room() lets a crew declare itself done with a room immediately,
--      without having to burn three wrong guesses to get out of it.
--
--   2. A room that ends in failure now records its completed_at, so the time the
--      crew spent in there is measured the same way a solved room's is. The
--      column means "when the crew finished with this room", pass or fail; the
--      status and points_awarded are what distinguish the two.
--
-- Route order is unaffected: check_in_room() already treats 'locked_out' as
-- resolved, so a failed room stops blocking the next step the moment it ends.
-- =============================================================================

comment on column public.room_visits.completed_at is
  'When the crew finished with this room, whether they solved it or failed it. Pairs with status/points_awarded to tell the two apart.';
comment on column public.room_visits.status is
  'in_progress | completed (solved) | locked_out (failed). Both completed and locked_out count as resolved for route progression.';

-- -----------------------------------------------------------------------------
-- abandon_room :: "we cannot get this one, let us move on"
-- -----------------------------------------------------------------------------
create or replace function public.abandon_room(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team  public.teams;
  v_room  public.rooms;
  v_visit public.room_visits;
begin
  select * into v_team from public.teams where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;

  select * into v_room from public.rooms
   where code = p_room_code and is_active and kind in ('game', 'final');
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown room');
  end if;

  select * into v_visit from public.room_visits
   where team_id = v_team.id and room_id = v_room.id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Enter your credentials at this terminal first');
  end if;

  -- Already finished with it, either way: nothing to do.
  if v_visit.status <> 'in_progress' then
    return jsonb_build_object(
      'success', true, 'status', v_visit.status,
      'durationSeconds', v_visit.duration_seconds,
      'alreadyResolved', true
    );
  end if;

  update public.room_visits
     set status       = 'locked_out',
         completed_at = now()
   where id = v_visit.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id, 'abandoned', false);

  return jsonb_build_object(
    'success', true,
    'status', v_visit.status,
    'resolved', true,
    'pointsAwarded', 0,
    'durationSeconds', v_visit.duration_seconds,
    'message', 'Room closed out. Proceed to your next room.'
  );
end;
$$;

revoke all on function public.abandon_room(text) from public, anon;
grant execute on function public.abandon_room(text) to authenticated;

-- -----------------------------------------------------------------------------
-- submit_answer :: stamp completed_at when the last attempt is spent, so a
-- failed room carries a duration like a solved one.
-- -----------------------------------------------------------------------------
create or replace function public.submit_answer(p_room_code text, p_submission text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team     public.teams;
  v_room     public.rooms;
  v_riddle   public.riddles;
  v_visit    public.room_visits;
  v_norm     text;
  v_correct  boolean := false;
  v_open     boolean;
  v_skip     boolean;
  v_locked   boolean;
begin
  select scoring_open, skip_riddles into v_open, v_skip
    from public.event_settings where id;
  if not v_open then
    return jsonb_build_object('success', false, 'error', 'Scoring is closed');
  end if;

  select * into v_team from public.teams where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;

  select * into v_room from public.rooms
   where code = p_room_code and is_active and kind in ('game', 'final');
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown room');
  end if;

  select * into v_visit from public.room_visits
   where team_id = v_team.id and room_id = v_room.id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Enter your credentials at this terminal first');
  end if;

  if v_visit.status = 'completed' then
    select * into v_riddle from public.riddles where room_id = v_room.id and is_active;
    return jsonb_build_object(
      'success', true, 'alreadyCompleted', true, 'correct', true, 'resolved', true,
      'pointsAwarded', v_visit.points_awarded,
      'durationSeconds', v_visit.duration_seconds,
      'clue', v_riddle.success_clue
    );
  end if;

  if v_visit.status = 'locked_out' or v_visit.attempts >= v_room.max_attempts then
    return jsonb_build_object(
      'success', false, 'lockout', true, 'resolved', true, 'attemptsRemaining', 0,
      'error', 'No attempts remaining. This room is closed out - proceed to your next room.'
    );
  end if;

  select * into v_riddle from public.riddles where room_id = v_room.id and is_active;
  if not found then
    return jsonb_build_object('success', false, 'error', 'This room has no active riddle');
  end if;

  if v_skip then
    v_correct := true;
  elsif v_room.ml_graded then
    return jsonb_build_object(
      'success', false,
      'error', 'This room is graded by the game module, not by typed answer'
    );
  else
    v_norm := public.normalise_answer(p_submission);
    v_correct := v_norm is not null
             and (v_norm = v_riddle.answer_normalised
                  or v_norm = any (v_riddle.answer_alternates));
  end if;

  v_locked := (not v_correct) and (v_visit.attempts + 1 >= v_room.max_attempts);

  update public.room_visits
     set attempts       = attempts + 1,
         -- stamped on a pass AND on the failing final attempt: either way the
         -- crew is finished with the room, and the time belongs in the record
         completed_at   = case when v_correct or v_locked then now() else completed_at end,
         points_awarded = case when v_correct then v_room.points else points_awarded end,
         status         = case
                            when v_correct then 'completed'
                            when v_locked  then 'locked_out'
                            else status
                          end
   where id = v_visit.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id,
          case when v_skip then 'skip:' || coalesce(p_submission, '') else coalesce(p_submission, '') end,
          v_correct);

  return jsonb_build_object(
    'success', true,
    'correct', v_correct,
    'skipped', v_skip,
    'status', v_visit.status,
    -- true once the crew may move on, whether they solved it or not
    'resolved', v_visit.status in ('completed', 'locked_out'),
    'attempts', v_visit.attempts,
    'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
    'lockout', v_visit.status = 'locked_out',
    'pointsAwarded', v_visit.points_awarded,
    'durationSeconds', v_visit.duration_seconds,
    'completedAt', v_visit.completed_at,
    'clue', case when v_correct then v_riddle.success_clue else null end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- record_ml_result :: same treatment for the machine-graded rooms.
-- -----------------------------------------------------------------------------
create or replace function public.record_ml_result(
  p_team_code text,
  p_room_code text,
  p_passed    boolean,
  p_detail    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team   public.teams;
  v_room   public.rooms;
  v_visit  public.room_visits;
  v_clue   text;
  v_locked boolean;
begin
  select * into v_team from public.teams where code = upper(p_team_code);
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown team');
  end if;

  select * into v_room from public.rooms
   where code = p_room_code and is_active and kind in ('game', 'final');
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown room');
  end if;

  select * into v_visit from public.room_visits
   where team_id = v_team.id and room_id = v_room.id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Team has not checked in at this room');
  end if;

  if v_visit.status <> 'in_progress' then
    return jsonb_build_object('success', true, 'alreadyResolved', true,
                              'status', v_visit.status,
                              'durationSeconds', v_visit.duration_seconds);
  end if;

  v_locked := (not p_passed) and (v_visit.attempts + 1 >= v_room.max_attempts);

  update public.room_visits
     set attempts       = attempts + 1,
         completed_at   = case when p_passed or v_locked then now() else completed_at end,
         points_awarded = case when p_passed then v_room.points else points_awarded end,
         status         = case
                            when p_passed then 'completed'
                            when v_locked then 'locked_out'
                            else status
                          end
   where id = v_visit.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id, 'ml:' || coalesce(p_detail::text, '{}'), p_passed);

  select success_clue into v_clue from public.riddles
   where room_id = v_room.id and is_active;

  return jsonb_build_object(
    'success', true,
    'correct', p_passed,
    'status', v_visit.status,
    'resolved', v_visit.status in ('completed', 'locked_out'),
    'attempts', v_visit.attempts,
    'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
    'durationSeconds', v_visit.duration_seconds,
    'clue', case when p_passed then v_clue else null end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Reporting :: report rooms RESOLVED as well as rooms solved, so it is obvious
-- that a crew got through all six even if they did not clear all six.
-- -----------------------------------------------------------------------------
-- Dropped rather than replaced: new columns land mid-list, and CREATE OR REPLACE
-- VIEW can only append.
drop view if exists public.leaderboard;

create view public.leaderboard
with (security_invoker = true) as
select
  t.code  as team_code,
  t.name  as team_name,
  p.code  as path_code,
  t.started_at,
  t.finished_at,
  count(v.id) filter (where v.status = 'completed')                    as rooms_completed,
  count(v.id) filter (where v.status in ('completed', 'locked_out'))    as rooms_resolved,
  count(v.id) filter (where v.status = 'locked_out')                   as rooms_failed,
  coalesce(sum(v.points_awarded), 0)                                   as total_points,
  coalesce(sum(v.duration_seconds), 0)                                 as total_room_seconds,
  case when t.started_at is null then null
       else (extract(epoch from (coalesce(t.finished_at, now()) - t.started_at)))::integer
  end                                                                  as elapsed_seconds,
  rank() over (
    order by
      coalesce(sum(v.points_awarded), 0) desc,
      coalesce(sum(v.duration_seconds), 2147483647) asc,
      t.finished_at asc nulls last
  )                                                                    as position
from public.teams t
join public.paths p on p.id = t.path_id
left join public.room_visits v on v.team_id = t.id
group by t.id, t.code, t.name, p.code, t.started_at, t.finished_at;

revoke all     on public.leaderboard from anon, authenticated;
grant  select  on public.leaderboard to service_role;

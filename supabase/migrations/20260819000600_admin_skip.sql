-- =============================================================================
-- Admin controls: walk the whole flow without solving anything
-- =============================================================================
-- Two separate tools, because they answer different needs:
--
--   event_settings.skip_riddles  - a global rehearsal switch. While it is on,
--     ANY submission is accepted in ANY room, including the machine-graded ones,
--     so an organiser can walk a crew's full route end to end without running
--     the CV game or knowing the answers. Timing is still recorded normally.
--
--   admin_force_complete()       - surgical, per crew per room. Marks one room
--     complete for one crew without touching the global switch. For the crew
--     whose room broke on the day.
--
-- Both leave an audit trail in answer_attempts, so a skipped room is always
-- distinguishable from a solved one after the event.
-- =============================================================================

alter table public.event_settings
  add column if not exists skip_riddles boolean not null default false;

comment on column public.event_settings.skip_riddles is
  'REHEARSAL ONLY: accept any answer in any room. Must be false during the real event.';

-- -----------------------------------------------------------------------------
-- submit_answer, now honouring skip_riddles
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

  -- lock the visit so two kiosk tabs cannot both spend the last attempt
  select * into v_visit from public.room_visits
   where team_id = v_team.id and room_id = v_room.id
   for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Enter your credentials at this terminal first');
  end if;

  if v_visit.status = 'completed' then
    select * into v_riddle from public.riddles where room_id = v_room.id and is_active;
    return jsonb_build_object(
      'success', true, 'alreadyCompleted', true, 'correct', true,
      'pointsAwarded', v_visit.points_awarded,
      'durationSeconds', v_visit.duration_seconds,
      'clue', v_riddle.success_clue
    );
  end if;

  if v_visit.status = 'locked_out' or v_visit.attempts >= v_room.max_attempts then
    return jsonb_build_object(
      'success', false, 'lockout', true, 'attemptsRemaining', 0,
      'error', 'No attempts remaining in this room'
    );
  end if;

  select * into v_riddle from public.riddles where room_id = v_room.id and is_active;
  if not found then
    return jsonb_build_object('success', false, 'error', 'This room has no active riddle');
  end if;

  if v_skip then
    -- Rehearsal mode: anything counts, in every room type.
    v_correct := true;
  elsif v_room.ml_graded then
    -- Pose tracking / CLIP scoring are graded by the ML service, which reports
    -- its verdict through record_ml_result().
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

  update public.room_visits
     set attempts        = attempts + 1,
         completed_at    = case when v_correct then now() else completed_at end,
         points_awarded  = case when v_correct then v_room.points else points_awarded end,
         status          = case
                             when v_correct then 'completed'
                             when attempts + 1 >= v_room.max_attempts then 'locked_out'
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
-- admin_force_complete :: mark one room done for one crew.
-- service_role only, so it is reachable through the operator function and
-- nowhere else. Checks the crew in first if they never arrived, so an organiser
-- can clear a room a crew could not physically reach.
-- -----------------------------------------------------------------------------
create or replace function public.admin_force_complete(p_team_code text, p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team  public.teams;
  v_room  public.rooms;
  v_visit public.room_visits;
  v_step  smallint;
begin
  select * into v_team from public.teams where code = upper(p_team_code);
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown team');
  end if;

  select * into v_room from public.rooms
   where code = p_room_code and kind in ('game', 'final');
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown room');
  end if;

  select rt.step_index into v_step
    from public.team_route(v_team.id) rt
   where rt.room_id = v_room.id;
  if v_step is null then
    return jsonb_build_object('success', false, 'error', 'That room is not on this crew''s route');
  end if;

  -- A crew being force-completed may never have reached the room, so start the
  -- clock now rather than leaving arrived_at null.
  insert into public.room_visits (team_id, room_id, step_index)
  values (v_team.id, v_room.id, v_step)
  on conflict (team_id, room_id) do nothing;

  update public.room_visits
     set completed_at   = coalesce(completed_at, now()),
         points_awarded = case when status = 'completed' then points_awarded else v_room.points end,
         status         = 'completed'
   where team_id = v_team.id and room_id = v_room.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id, 'admin:force_complete', true);

  return jsonb_build_object(
    'success', true,
    'teamCode', v_team.code,
    'roomCode', v_room.code,
    'stepIndex', v_visit.step_index,
    'durationSeconds', v_visit.duration_seconds,
    'pointsAwarded', v_visit.points_awarded
  );
end;
$$;

revoke all on function public.admin_force_complete(text, text) from public, anon, authenticated;
grant execute on function public.admin_force_complete(text, text) to service_role;

-- -----------------------------------------------------------------------------
-- A skipped or force-completed room stays identifiable after the event.
-- -----------------------------------------------------------------------------
create or replace view public.skipped_rooms
with (security_invoker = true) as
select t.code as team_code,
       r.code as room_code,
       a.submission,
       a.created_at
  from public.answer_attempts a
  join public.teams t on t.id = a.team_id
  join public.rooms r on r.id = a.room_id
 where a.was_correct
   and (a.submission like 'skip:%' or a.submission = 'admin:force_complete')
 order by a.created_at;

revoke all  on public.skipped_rooms from anon, authenticated;
grant select on public.skipped_rooms to service_role;

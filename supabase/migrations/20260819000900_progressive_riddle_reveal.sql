-- =============================================================================
-- Progressive riddle reveal: hub hands out riddle #1, each solved room hands
-- out the next one
-- =============================================================================
-- Model: a crew should never have to wonder what's coming. hub_check_in()
-- reveals the prompt for their first room right away; submit_answer(),
-- record_ml_result() and abandon_room() reveal the NEXT room's prompt the
-- instant the current one is resolved (solved or failed - the crew is moving on
-- either way). check_in_room() still returns the current room's own prompt on
-- arrival too, so nothing depends on a crew remembering what they read earlier.
--
-- Only the ONE next unresolved room's prompt is ever exposed - never the whole
-- route's puzzles at once, and never an answer.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- next_riddle_preview :: the crew's next unresolved room, prompt included.
-- NULL fields mean the crew has resolved every room and should return to the
-- hub. Read-only: does not touch room_visits, so calling it never starts a clock.
-- -----------------------------------------------------------------------------
create or replace function public.next_riddle_preview(p_team_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when rt.room_id is null then null else
    jsonb_build_object(
      'roomCode', rt.room_code,
      'label', rt.label,
      'isFinal', rt.is_final,
      'prompt', r.prompt
    )
  end
  from (
    select rt.room_id, rt.room_code, rt.label, rt.is_final
      from public.team_route(p_team_id) rt
      left join public.room_visits v on v.team_id = p_team_id and v.room_id = rt.room_id
     where coalesce(v.status, 'pending') not in ('completed', 'locked_out')
     order by rt.step_index
     limit 1
  ) rt
  left join public.riddles r on r.room_id = rt.room_id and r.is_active;
$$;

grant execute on function public.next_riddle_preview(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- hub_check_in :: now hands out the crew's first riddle
-- -----------------------------------------------------------------------------
create or replace function public.hub_check_in()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team public.teams;
begin
  select * into v_team from public.teams where auth_user_id = auth.uid() for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;
  if v_team.path_id is null then
    return jsonb_build_object('success', false, 'error', 'Team has no path assigned');
  end if;

  if v_team.started_at is null then
    update public.teams set started_at = now() where id = v_team.id;
  end if;

  perform public.claim_session(v_team.id, 'HUB');

  return public.my_run() || jsonb_build_object('nextRiddle', public.next_riddle_preview(v_team.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- submit_answer, record_ml_result, abandon_room :: reveal the next room's
-- prompt the moment the current one resolves, pass or fail alike.
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
  v_conflict text;
  v_result   jsonb;
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

  v_conflict := public.session_conflict(v_team.id);
  if v_conflict is not null then
    return jsonb_build_object('success', false, 'sessionConflict', true, 'error', v_conflict);
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
      'clue', v_riddle.success_clue,
      'nextRiddle', public.next_riddle_preview(v_team.id)
    );
  end if;

  if v_visit.status = 'locked_out' or v_visit.attempts >= v_room.max_attempts then
    return jsonb_build_object(
      'success', false, 'lockout', true, 'resolved', true, 'attemptsRemaining', 0,
      'error', 'No attempts remaining. This room is closed out - proceed to your next room.',
      'nextRiddle', public.next_riddle_preview(v_team.id)
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

  v_result := jsonb_build_object(
    'success', true,
    'correct', v_correct,
    'skipped', v_skip,
    'status', v_visit.status,
    'resolved', v_visit.status in ('completed', 'locked_out'),
    'attempts', v_visit.attempts,
    'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
    'lockout', v_visit.status = 'locked_out',
    'pointsAwarded', v_visit.points_awarded,
    'durationSeconds', v_visit.duration_seconds,
    'completedAt', v_visit.completed_at,
    'clue', case when v_correct then v_riddle.success_clue else null end
  );

  -- Resolved either way (pass or fail) means the crew is moving on, so this is
  -- exactly when the next room's puzzle should be revealed.
  if v_visit.status in ('completed', 'locked_out') then
    v_result := v_result || jsonb_build_object('nextRiddle', public.next_riddle_preview(v_team.id));
  end if;

  return v_result;
end;
$$;

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
  v_result jsonb;
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
                              'durationSeconds', v_visit.duration_seconds,
                              'nextRiddle', public.next_riddle_preview(v_team.id));
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

  v_result := jsonb_build_object(
    'success', true,
    'correct', p_passed,
    'status', v_visit.status,
    'resolved', v_visit.status in ('completed', 'locked_out'),
    'attempts', v_visit.attempts,
    'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
    'durationSeconds', v_visit.duration_seconds,
    'clue', case when p_passed then v_clue else null end
  );

  if v_visit.status in ('completed', 'locked_out') then
    v_result := v_result || jsonb_build_object('nextRiddle', public.next_riddle_preview(v_team.id));
  end if;

  return v_result;
end;
$$;

create or replace function public.abandon_room(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team     public.teams;
  v_room     public.rooms;
  v_visit    public.room_visits;
  v_conflict text;
begin
  select * into v_team from public.teams where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;

  v_conflict := public.session_conflict(v_team.id);
  if v_conflict is not null then
    return jsonb_build_object('success', false, 'sessionConflict', true, 'error', v_conflict);
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

  if v_visit.status <> 'in_progress' then
    return jsonb_build_object(
      'success', true, 'status', v_visit.status,
      'durationSeconds', v_visit.duration_seconds, 'alreadyResolved', true,
      'nextRiddle', public.next_riddle_preview(v_team.id)
    );
  end if;

  update public.room_visits
     set status = 'locked_out', completed_at = now()
   where id = v_visit.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id, 'abandoned', false);

  return jsonb_build_object(
    'success', true, 'status', v_visit.status, 'resolved', true, 'pointsAwarded', 0,
    'durationSeconds', v_visit.duration_seconds,
    'message', 'Room closed out. Proceed to your next room.',
    'nextRiddle', public.next_riddle_preview(v_team.id)
  );
end;
$$;

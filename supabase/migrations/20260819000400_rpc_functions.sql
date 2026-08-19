-- =============================================================================
-- RPC surface
-- =============================================================================
-- These are the only way a kiosk changes state. Each is SECURITY DEFINER and
-- derives the acting team from the JWT via current_team_id(), so a team can
-- never act as another team and never write its own completion timestamp.
--
-- Every function returns jsonb shaped { success, ... } or { success:false, error }.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- normalise_answer :: lowercase, collapse whitespace, trim.
-- Deliberately forgiving about spacing/case and nothing else, so that a
-- placeholder answer like 'ARTEMIS PROTOCOL SEVEN' matches typed input.
-- -----------------------------------------------------------------------------
create or replace function public.normalise_answer(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p_text, '')), '\s+', ' ', 'g')), '');
$$;

-- -----------------------------------------------------------------------------
-- my_run :: full snapshot for the calling team.
-- The hub screen and every room screen bootstrap from this.
-- -----------------------------------------------------------------------------
create or replace function public.my_run()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_team   public.teams;
  v_result jsonb;
begin
  select * into v_team from public.teams where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;

  select jsonb_build_object(
    'success', true,
    'team', jsonb_build_object(
      'code', v_team.code,
      'name', v_team.name,
      'enrolledAt', v_team.enrolled_at,
      'startedAt', v_team.started_at,
      'finishedAt', v_team.finished_at
    ),
    'path', (
      select jsonb_build_object(
        'code', p.code,
        -- Rotating rooms in this crew's order, then the shared final room.
        'steps', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'stepIndex', rt.step_index,
              'roomCode', rt.room_code,
              'label', rt.label,
              'terminalId', rt.terminal_id,
              'points', rt.points,
              'isFinal', rt.is_final,
              'status', coalesce(v.status, 'pending'),
              'arrivedAt', v.arrived_at,
              'completedAt', v.completed_at,
              'durationSeconds', v.duration_seconds,
              'attempts', coalesce(v.attempts, 0),
              'pointsAwarded', coalesce(v.points_awarded, 0)
            ) order by rt.step_index
          )
          from public.team_route(v_team.id) rt
          left join public.room_visits v
            on v.team_id = v_team.id and v.room_id = rt.room_id
        ), '[]'::jsonb)
      )
      from public.paths p where p.id = v_team.path_id
    ),
    'totals', (
      select jsonb_build_object(
        'roomsCompleted', count(*) filter (where status = 'completed'),
        'totalPoints', coalesce(sum(points_awarded), 0),
        'totalRoomSeconds', coalesce(sum(duration_seconds), 0),
        'elapsedSeconds', case
          when v_team.started_at is null then null
          else (extract(epoch from (coalesce(v_team.finished_at, now()) - v_team.started_at)))::integer
        end
      )
      from public.room_visits where team_id = v_team.id
    )
  ) into v_result;

  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- hub_check_in :: team's first action of the event, at the shared hub terminal.
-- Stamps started_at (once) and hands back the assigned path.
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

  return public.my_run();
end;
$$;

-- -----------------------------------------------------------------------------
-- hub_check_out :: team returns to the hub at the end of the run.
-- Stamps finished_at. Allowed even with rooms unsolved (a team can run out of
-- time), so the response reports how many they actually cleared.
-- -----------------------------------------------------------------------------
create or replace function public.hub_check_out()
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
  if v_team.started_at is null then
    return jsonb_build_object('success', false, 'error', 'Team never checked in at the hub');
  end if;

  if v_team.finished_at is null then
    update public.teams set finished_at = now() where id = v_team.id;
  end if;

  return public.my_run();
end;
$$;

-- -----------------------------------------------------------------------------
-- check_in_room :: "the team enters their creds at a room terminal".
-- Stamps arrived_at and starts the clock for that room. Idempotent, so a kiosk
-- reload does not restart the timer. Returns the riddle prompt.
-- -----------------------------------------------------------------------------
create or replace function public.check_in_room(p_room_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team       public.teams;
  v_room       public.rooms;
  v_riddle     public.riddles;
  v_visit      public.room_visits;
  v_step       smallint;
  v_next_step  smallint;
  v_enforce    boolean;
begin
  select * into v_team from public.teams where auth_user_id = auth.uid();
  if not found then
    return jsonb_build_object('success', false, 'error', 'No team linked to this login');
  end if;

  -- Rotating rooms and the final room are both enterable; the hub is not.
  select * into v_room from public.rooms
   where code = p_room_code and is_active and kind in ('game', 'final');
  if not found then
    return jsonb_build_object('success', false, 'error', 'Unknown room: ' || coalesce(p_room_code, 'null'));
  end if;

  if v_team.started_at is null then
    return jsonb_build_object('success', false, 'error', 'Check in at the hub terminal first');
  end if;
  if v_team.finished_at is not null then
    return jsonb_build_object('success', false, 'error', 'This team has already checked out');
  end if;

  -- Where does this room sit on the crew's route? team_route() puts the crew's
  -- rotating rooms at steps 1..n and the final room last.
  select rt.step_index into v_step
    from public.team_route(v_team.id) rt
   where rt.room_id = v_room.id;

  if v_step is null then
    return jsonb_build_object('success', false, 'error', 'This room is not on your route');
  end if;

  select * into v_visit from public.room_visits
   where team_id = v_team.id and room_id = v_room.id;

  -- Route order is enforced on FIRST arrival only. Once a visit row exists the
  -- team is already standing in this room, so a kiosk reload - or a team walking
  -- back to re-read the clue of a room it solved - simply gets the current
  -- state rather than an "out of order" refusal.
  if not found then
    select enforce_path_order into v_enforce from public.event_settings where id;

    if v_enforce then
      -- The lowest step the crew has neither solved nor burnt all its attempts
      -- on. locked_out counts as finished with it: otherwise one unsolved room
      -- would strand the crew there for the rest of the event. Because the final
      -- room is the last step, this also stops a crew reaching the finale early.
      select coalesce(min(rt.step_index), public.final_step_index() + 1)
        into v_next_step
        from public.team_route(v_team.id) rt
        left join public.room_visits v
          on v.team_id = v_team.id and v.room_id = rt.room_id
       where coalesce(v.status, 'pending') not in ('completed', 'locked_out');

      if v_step <> v_next_step then
        return jsonb_build_object(
          'success', false,
          'error', format('Out of order: this is step %s of your route, you are due at step %s',
                          v_step, v_next_step),
          'expectedStepIndex', v_next_step
        );
      end if;
    end if;

    insert into public.room_visits (team_id, room_id, step_index)
    values (v_team.id, v_room.id, v_step)
    on conflict (team_id, room_id) do nothing;

    select * into v_visit from public.room_visits
     where team_id = v_team.id and room_id = v_room.id;
  end if;

  select * into v_riddle from public.riddles
   where room_id = v_room.id and is_active;

  return jsonb_build_object(
    'success', true,
    'room', jsonb_build_object(
      'code', v_room.code,
      'label', v_room.label,
      'terminalId', v_room.terminal_id,
      'coordinates', v_room.coordinates,
      'briefing', v_room.briefing,
      'hint', v_room.hint,
      'points', v_room.points,
      'timerSeconds', v_room.timer_seconds,
      'maxAttempts', v_room.max_attempts,
      'mlGraded', v_room.ml_graded,
      'isFinal', v_room.kind = 'final'
    ),
    'riddle', case when v_riddle.id is null then null
                   else jsonb_build_object('prompt', v_riddle.prompt) end,
    'visit', jsonb_build_object(
      'stepIndex', v_visit.step_index,
      'status', v_visit.status,
      'arrivedAt', v_visit.arrived_at,
      'completedAt', v_visit.completed_at,
      'durationSeconds', v_visit.duration_seconds,
      'attempts', v_visit.attempts,
      'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
      'pointsAwarded', v_visit.points_awarded
    ),
    -- the clue is only in the payload once the room is actually solved
    'clue', case when v_visit.status = 'completed' then v_riddle.success_clue else null end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- submit_answer :: grade a riddle submission and, on success, stamp the
-- completion time. This is where "completion + time" is recorded.
-- -----------------------------------------------------------------------------
create or replace function public.submit_answer(p_room_code text, p_submission text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team       public.teams;
  v_room       public.rooms;
  v_riddle     public.riddles;
  v_visit      public.room_visits;
  v_norm       text;
  v_correct    boolean := false;
  v_open       boolean;
begin
  select scoring_open into v_open from public.event_settings where id;
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

  if v_room.ml_graded then
    -- Pose tracking / CLIP scoring / image forgery are graded by the external
    -- ML service, which calls record_ml_result() with the service role key.
    return jsonb_build_object(
      'success', false,
      'error', 'This room is graded by the game module, not by typed answer'
    );
  end if;

  v_norm := public.normalise_answer(p_submission);
  v_correct := v_norm is not null
           and (v_norm = v_riddle.answer_normalised
                or v_norm = any (v_riddle.answer_alternates));

  update public.room_visits
     set attempts       = attempts + 1,
         completed_at   = case when v_correct then now() else completed_at end,
         points_awarded  = case when v_correct then v_room.points else points_awarded end,
         status         = case
                            when v_correct then 'completed'
                            when attempts + 1 >= v_room.max_attempts then 'locked_out'
                            else status
                          end
   where id = v_visit.id
  returning * into v_visit;

  insert into public.answer_attempts (team_id, room_id, visit_id, submission, was_correct)
  values (v_team.id, v_room.id, v_visit.id, coalesce(p_submission, ''), v_correct);

  return jsonb_build_object(
    'success', true,
    'correct', v_correct,
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
-- record_ml_result :: service-role only. The Flask ML service calls this after
-- it has scored a pose hold / CLIP similarity / sketch match, naming the team
-- explicitly because it acts on the team's behalf rather than as the team.
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
  v_team  public.teams;
  v_room  public.rooms;
  v_visit public.room_visits;
  v_clue  text;
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

  if v_visit.status = 'completed' then
    return jsonb_build_object('success', true, 'alreadyCompleted', true,
                              'durationSeconds', v_visit.duration_seconds);
  end if;

  update public.room_visits
     set attempts       = attempts + 1,
         completed_at   = case when p_passed then now() else completed_at end,
         points_awarded  = case when p_passed then v_room.points else points_awarded end,
         status         = case
                            when p_passed then 'completed'
                            when attempts + 1 >= v_room.max_attempts then 'locked_out'
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
    'attempts', v_visit.attempts,
    'attemptsRemaining', greatest(0, v_room.max_attempts - v_visit.attempts),
    'durationSeconds', v_visit.duration_seconds,
    'clue', case when p_passed then v_clue else null end
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: kiosks may call the team-scoped RPCs, nothing else.
-- -----------------------------------------------------------------------------
revoke all on function public.my_run()                              from public, anon;
revoke all on function public.hub_check_in()                        from public, anon;
revoke all on function public.hub_check_out()                       from public, anon;
revoke all on function public.check_in_room(text)                   from public, anon;
revoke all on function public.submit_answer(text, text)             from public, anon;
revoke all on function public.record_ml_result(text, text, boolean, jsonb) from public, anon, authenticated;

grant execute on function public.my_run()                  to authenticated;
grant execute on function public.hub_check_in()            to authenticated;
grant execute on function public.hub_check_out()           to authenticated;
grant execute on function public.check_in_room(text)       to authenticated;
grant execute on function public.submit_answer(text, text) to authenticated;
grant execute on function public.record_ml_result(text, text, boolean, jsonb) to service_role;

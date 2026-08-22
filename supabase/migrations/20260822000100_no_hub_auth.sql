-- =============================================================================
-- The hub stops being a checkpoint: no crew authentication there
-- =============================================================================
-- Crews are handed their team code, passcode and first riddle by hand at the
-- operations base, so the hub terminal no longer signs anyone in. That leaves
-- the run's clock - which is what decides standings once rooms cleared are tied
-- - with nothing to start or stop it, because started_at came only from
-- hub_check_in() and finished_at only from hub_check_out().
--
-- Both move onto the route itself:
--
--   started_at   stamped by check_in_room() the first time a crew authenticates
--                at any room terminal. "Authentication to completion" is now
--                measured from the crew's own first sign-in.
--   finished_at  stamped when the last room on the crew's route resolves,
--                whether they cleared it or not, by a trigger on room_visits so
--                that every route to resolution is covered - submit_answer,
--                record_ml_result, abandon_room and an operator's force alike.
--
-- hub_check_in() and hub_check_out() are left in place and still work; nothing
-- calls them now. Keeping them means an organiser can still bracket a run by
-- hand, and re-running an older client against this database is not an error.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_in_room(p_room_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- The hub no longer authenticates anyone: crews are handed their team code,
  -- passcode and first riddle by hand, so the run's clock starts at the first
  -- room terminal a crew signs in at. This used to refuse entry until
  -- hub_check_in() had stamped started_at, which made the hub a mandatory gate.
  if v_team.started_at is null then
    update public.teams set started_at = now() where id = v_team.id
    returning * into v_team;
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

  perform public.claim_session(v_team.id, v_room.code);

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
$function$;


-- -----------------------------------------------------------------------------
-- finish_run_when_route_resolved :: stamp finished_at on the last room
-- -----------------------------------------------------------------------------
-- A crew is done when every room on their route is resolved. "Resolved" is the
-- same rule route progression already uses - completed or locked_out - so a crew
-- that fails their way to the end still finishes, and still gets a time.
--
-- Written as a trigger rather than a call inside each RPC because there are four
-- ways a visit can resolve, and a fifth (an operator's force) that bypasses them
-- all. One trigger covers every one of them and cannot drift out of step.
create or replace function public.finish_run_when_route_resolved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_route_rooms    integer;
  v_resolved_rooms integer;
begin
  -- Only ever interesting when a visit has just become resolved.
  if new.status not in ('completed', 'locked_out') then
    return new;
  end if;

  select count(*) into v_route_rooms
    from public.team_route(new.team_id);

  select count(*) into v_resolved_rooms
    from public.team_route(new.team_id) rt
    join public.room_visits v
      on v.team_id = new.team_id and v.room_id = rt.room_id
   where v.status in ('completed', 'locked_out');

  if v_route_rooms > 0 and v_resolved_rooms >= v_route_rooms then
    -- coalesce, not overwrite: the first completion of the route is the finish.
    update public.teams
       set finished_at = coalesce(finished_at, now())
     where id = new.team_id;
  end if;

  return new;
end;
$$;

drop trigger if exists room_visits_finish_run on public.room_visits;

create trigger room_visits_finish_run
  after insert or update of status on public.room_visits
  for each row
  execute function public.finish_run_when_route_resolved();

comment on function public.finish_run_when_route_resolved() is
  'Stamps teams.finished_at once every room on a crew''s route is resolved (completed or locked_out). Replaces hub_check_out() as the end of the clock.';

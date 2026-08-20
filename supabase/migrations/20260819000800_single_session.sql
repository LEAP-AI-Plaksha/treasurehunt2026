-- =============================================================================
-- One live session per crew
-- =============================================================================
-- A crew must not be signed in on two terminals at once. Route order already
-- means only one room is ever enterable, so a crew could not play two rooms in
-- parallel - but they could still hold a login in two places, which makes
-- "who is where" ambiguous for the operator and lets a crew leave a terminal
-- logged in behind them.
--
-- Enforced on the crew's JWT session_id rather than with Supabase's native
-- single-session setting: that setting stops the old session REFRESHING, but a
-- JWT is stateless and stays valid until it expires (an hour here), which is
-- longer than the whole event. Pinning the session in the database takes effect
-- on the very next request.
--
-- Policy: the newest login wins. A crew walking into their next room takes the
-- session with them, and the terminal they left goes dead - which is what
-- physically happened.
-- =============================================================================

alter table public.teams
  add column if not exists active_session_id   uuid,
  add column if not exists active_session_at   timestamptz,
  add column if not exists active_session_room text;

comment on column public.teams.active_session_id is
  'The crew''s one live login (JWT session_id). Claimed on hub check-in and on entering a room; newest wins.';

-- -----------------------------------------------------------------------------
-- current_session_id :: the calling JWT's session, or NULL outside a request
-- -----------------------------------------------------------------------------
create or replace function public.current_session_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

grant execute on function public.current_session_id() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- claim_session :: this terminal is now the crew's live session
-- -----------------------------------------------------------------------------
create or replace function public.claim_session(p_team_id uuid, p_room_code text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.teams
     set active_session_id   = public.current_session_id(),
         active_session_at   = now(),
         active_session_room = p_room_code
   where id = p_team_id
     -- NULL session means the caller is not a crew request; leave the claim alone
     and public.current_session_id() is not null;
$$;

-- -----------------------------------------------------------------------------
-- session_conflict :: NULL when this terminal holds the crew's session,
-- otherwise a message naming where the crew actually is.
-- -----------------------------------------------------------------------------
create or replace function public.session_conflict(p_team_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_active uuid;
  v_room   text;
  v_mine   uuid := public.current_session_id();
begin
  select active_session_id, active_session_room into v_active, v_room
    from public.teams where id = p_team_id;

  -- Nothing claimed yet, or a non-crew caller: nothing to conflict with.
  if v_active is null or v_mine is null then
    return null;
  end if;

  if v_active = v_mine then
    return null;
  end if;

  return format(
    'This crew is signed in at another terminal%s. Only one terminal at a time - sign out there, or sign in again here to take over.',
    case when v_room is null then '' else ' (' || v_room || ')' end
  );
end;
$$;

grant execute on function public.session_conflict(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Wire it into the crew RPCs.
--
-- claim  on hub_check_in / check_in_room : the crew is physically here now
-- assert on submit_answer / abandon_room : refuse work from a superseded terminal
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
  return public.my_run();
end;
$$;

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

  perform public.claim_session(v_team.id, 'HUB');
  return public.my_run();
end;
$$;

-- submit_answer and abandon_room must refuse a terminal that has been superseded.
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
      'durationSeconds', v_visit.duration_seconds, 'alreadyResolved', true
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
    'message', 'Room closed out. Proceed to your next room.'
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- active_sessions :: operator view of where each crew is signed in
-- -----------------------------------------------------------------------------
create or replace view public.active_sessions
with (security_invoker = true) as
select t.code                as team_code,
       t.name                as team_name,
       t.active_session_room as signed_in_at,
       t.active_session_at   as since,
       (t.active_session_id is not null) as has_live_session
  from public.teams t
 order by length(t.code), t.code;

revoke all    on public.active_sessions from anon, authenticated;
grant  select on public.active_sessions to service_role;

-- -----------------------------------------------------------------------------
-- check_in_room, restated so that it claims the session.
--
-- The crew is physically standing at this terminal, so entering a room takes the
-- session with them and the terminal they left goes dead. Stated in full rather
-- than patched in place: a migration that rewrites another migration's function
-- body by string substitution breaks silently the moment that body is reformatted.
-- -----------------------------------------------------------------------------
create or replace function public.check_in_room(p_room_code text)
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
$function$

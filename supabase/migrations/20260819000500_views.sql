-- =============================================================================
-- Operator views
-- =============================================================================
-- These deliberately cross team boundaries, so they are granted to service_role
-- only and reached through the `operator` edge function. No kiosk can read them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- team_room_times :: the flat "completion and time for all games for each team"
-- table. One row per crew per room on their route, whether played or not, with
-- the crew's rotating rooms at steps 1..n and the shared final room last.
-- -----------------------------------------------------------------------------
create or replace view public.team_room_times
with (security_invoker = true) as
select
  t.code                        as team_code,
  t.name                        as team_name,
  p.code                        as path_code,
  rt.step_index,
  rt.room_code,
  rt.label                      as room_label,
  rt.is_final,
  coalesce(v.status, 'pending') as status,
  v.arrived_at,
  v.completed_at,
  v.duration_seconds,
  coalesce(v.attempts, 0)       as attempts,
  coalesce(v.points_awarded, 0) as points_awarded
from public.teams t
join public.paths p on p.id = t.path_id
cross join lateral public.team_route(t.id) rt
left join public.room_visits v on v.team_id = t.id and v.room_id = rt.room_id;

comment on view public.team_room_times is
  'Per-team, per-room completion and timing. The primary export for scoring.';

-- -----------------------------------------------------------------------------
-- leaderboard :: ranked standings.
-- Points first, then total time inside rooms, then whoever finished earlier.
-- Teams that have not started sort last.
-- -----------------------------------------------------------------------------
create or replace view public.leaderboard
with (security_invoker = true) as
select
  t.code  as team_code,
  t.name  as team_name,
  p.code  as path_code,
  t.started_at,
  t.finished_at,
  count(v.id) filter (where v.status = 'completed')          as rooms_completed,
  coalesce(sum(v.points_awarded), 0)                          as total_points,
  coalesce(sum(v.duration_seconds), 0)                        as total_room_seconds,
  case when t.started_at is null then null
       else (extract(epoch from (coalesce(t.finished_at, now()) - t.started_at)))::integer
  end                                                         as elapsed_seconds,
  rank() over (
    order by
      coalesce(sum(v.points_awarded), 0) desc,
      coalesce(sum(v.duration_seconds), 2147483647) asc,
      t.finished_at asc nulls last
  )                                                           as position
from public.teams t
join public.paths p on p.id = t.path_id
left join public.room_visits v on v.team_id = t.id
group by t.id, t.code, t.name, p.code, t.started_at, t.finished_at;

-- -----------------------------------------------------------------------------
-- room_occupancy :: live view of who is standing in which room right now.
-- The operator uses this to spot a room that has backed up.
-- -----------------------------------------------------------------------------
create or replace view public.room_occupancy
with (security_invoker = true) as
select
  r.code  as room_code,
  r.label as room_label,
  (r.kind = 'final') as is_final,
  count(v.id) filter (where v.status = 'in_progress')  as teams_in_room,
  count(v.id) filter (where v.status = 'completed')    as teams_cleared,
  count(v.id) filter (where v.status = 'locked_out')   as teams_locked_out,
  coalesce(round(avg(v.duration_seconds) filter (where v.status = 'completed'))::integer, 0)
          as avg_solve_seconds
from public.rooms r
left join public.room_visits v on v.room_id = r.id
where r.kind in ('game', 'final')
group by r.id, r.code, r.label, r.ordinal, r.kind
-- rotating rooms in ordinal order, then the finale
order by (r.kind = 'final'), r.ordinal;

-- -----------------------------------------------------------------------------
-- enrollment_status :: which teams have claimed a login and which path they hold.
-- Never exposes the enrollment code or the passcode.
-- -----------------------------------------------------------------------------
create or replace view public.enrollment_status
with (security_invoker = true) as
select
  t.code   as team_code,
  t.name   as team_name,
  t.auth_user_id is not null as has_login,
  p.code   as path_code,
  p.room_ordinals,
  -- full route as walked: rotating rooms in order, then the shared finale
  (select array_agg(rt.room_code order by rt.step_index)
     from public.team_route(t.id) rt) as route,
  t.enrolled_at,
  t.started_at,
  t.finished_at
from public.teams t
left join public.paths p on p.id = t.path_id
order by t.code;

-- -----------------------------------------------------------------------------
-- Lock the operator views down. security_invoker = true means these views run
-- with the caller's RLS, so an authenticated team would only ever see its own
-- rows anyway, but revoking makes the intent explicit.
-- -----------------------------------------------------------------------------
revoke all on public.team_room_times   from anon, authenticated;
revoke all on public.leaderboard       from anon, authenticated;
revoke all on public.room_occupancy    from anon, authenticated;
revoke all on public.enrollment_status from anon, authenticated;
revoke all on public.path_balance      from anon, authenticated;

grant select on public.team_room_times   to service_role;
grant select on public.leaderboard       to service_role;
grant select on public.room_occupancy    to service_role;
grant select on public.enrollment_status to service_role;
grant select on public.path_balance      to service_role;

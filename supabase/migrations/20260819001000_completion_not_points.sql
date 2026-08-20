-- =============================================================================
-- Scoring model: completion (and failure), not points
-- =============================================================================
-- A room is worth clearing or not clearing - not a point value. Standings are
-- decided by how many rooms a crew actually SOLVED, and only broken by time
-- when two crews solved the same number. points_awarded / rooms.points stay in
-- the schema (harmless, and still useful if an organiser wants a bonus stat
-- later) but no longer drive ranking anywhere.
-- =============================================================================

drop view if exists public.leaderboard;

create view public.leaderboard
with (security_invoker = true) as
select
  t.code  as team_code,
  t.name  as team_name,
  p.code  as path_code,
  t.started_at,
  t.finished_at,
  count(v.id) filter (where v.status = 'completed')                   as rooms_completed,
  count(v.id) filter (where v.status in ('completed', 'locked_out'))   as rooms_resolved,
  count(v.id) filter (where v.status = 'locked_out')                  as rooms_failed,
  case when t.started_at is null then null
       else (extract(epoch from (coalesce(t.finished_at, now()) - t.started_at)))::integer
  end                                                                 as elapsed_seconds,
  coalesce(sum(v.duration_seconds), 0)                                as total_room_seconds,
  rank() over (
    order by
      -- 1. clear more rooms, rank higher
      count(v.id) filter (where v.status = 'completed') desc,
      -- 2. tiebreak on time: faster hub-to-hub run wins. Unstarted/live runs
      --    sort last rather than falsely looking instant.
      case when t.started_at is null then 2147483647
           else (extract(epoch from (coalesce(t.finished_at, now()) - t.started_at)))::integer
      end asc,
      -- 3. still tied (e.g. two runs still in progress): whoever finished first
      t.finished_at asc nulls last
  )                                                                   as position
from public.teams t
join public.paths p on p.id = t.path_id
left join public.room_visits v on v.team_id = t.id
group by t.id, t.code, t.name, p.code, t.started_at, t.finished_at;

comment on view public.leaderboard is
  'Ranked by rooms_completed desc, then elapsed_seconds asc as the tiebreaker. Points play no part in position.';

revoke all     on public.leaderboard from anon, authenticated;
grant  select  on public.leaderboard to service_role;

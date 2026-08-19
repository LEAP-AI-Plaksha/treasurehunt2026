-- =============================================================================
-- The 10 paths, and the one definition of a crew's route
-- =============================================================================
-- Only the 5 ROTATING rooms are permuted. The final room - the MLP backtrack -
-- is the same last stop for every crew, so it sits outside the paths entirely
-- and is appended to every route by team_route() below.
--
--   HUB  ->  5 rotating rooms in the crew's own order  ->  FINAL  ->  HUB
--
-- Construction: two cyclic Latin squares of order 5 over the rotating ordinals.
--   Square A (stride 1) : path i, step j -> (i + 1j) mod 5   for i = 0..4
--   Square B (stride 2) : path i, step j -> (i + 2j) mod 5   for i = 0..4
-- Both are Latin squares because 1 and 2 are each coprime to 5, so every column
-- of each square contains all 5 rooms exactly once.
--
-- Five rows from A plus five from B gives the 10 paths, and because each square
-- contributes each room exactly once per column, EVERY room is the destination
-- of exactly 2 of the 10 paths at EVERY step. 10 crews over 5 rooms divides
-- evenly, so this spread is perfectly flat - no room is ever busier than another.
--
-- The two squares share no row: a row of A equals a row of B only if stride
-- 1 = stride 2 (mod 5), which is false, so all 10 orderings are distinct.
--
-- Verify any time with:  select * from public.path_balance;
-- =============================================================================

insert into public.paths (code, room_ordinals)
select
  'PATH-' || lpad((row_number() over (order by stride, i))::text, 2, '0'),
  ordinals
from (
  select stride, i, array(
    select ((i + stride * j) % 5)::smallint from generate_series(0, 4) as j
  ) as ordinals
  from generate_series(1, 2) as stride,
       generate_series(0, 4) as i
) as generated;

-- -----------------------------------------------------------------------------
-- final_step_index :: which step number the final room occupies.
-- Derived from how many rotating rooms are active, so retiring or adding a
-- rotating room does not leave a hard-coded 6 behind.
-- -----------------------------------------------------------------------------
create or replace function public.final_step_index()
returns smallint
language sql
stable
as $$
  select (count(*) + 1)::smallint
    from public.rooms where kind = 'game' and is_active;
$$;

-- -----------------------------------------------------------------------------
-- team_route :: THE definition of where a crew goes, in order.
--
-- Steps 1..n are the crew's permuted rotating rooms; the last step is always the
-- final room. Everything that needs to know a crew's route - check_in_room,
-- my_run, the reporting views, admin_force_complete - reads it from here, so the
-- "final room comes last" rule exists in exactly one place.
--
-- Invoker rights on purpose: called by a crew it is filtered by RLS to their own
-- team, and the SECURITY DEFINER RPCs that call it already run with the rights
-- they need.
-- -----------------------------------------------------------------------------
create or replace function public.team_route(p_team_id uuid)
returns table (
  step_index  smallint,
  room_id     uuid,
  room_code   text,
  label       text,
  terminal_id text,
  points      integer,
  is_final    boolean
)
language sql
stable
as $$
  -- the rotating rooms, in this crew's assigned order
  select s.step_index::smallint, r.id, r.code, r.label, r.terminal_id, r.points, false
    from public.teams t
    join public.paths p on p.id = t.path_id
    cross join lateral unnest(p.room_ordinals) with ordinality as s(ordinal, step_index)
    join public.rooms r on r.ordinal = s.ordinal and r.kind = 'game' and r.is_active
   where t.id = p_team_id

  union all

  -- and the finale, identical for everyone
  select public.final_step_index(), r.id, r.code, r.label, r.terminal_id, r.points, true
    from public.rooms r
   where r.kind = 'final' and r.is_active
     and exists (select 1 from public.teams t where t.id = p_team_id and t.path_id is not null)

  order by 1;
$$;

grant execute on function public.final_step_index() to anon, authenticated, service_role;
grant execute on function public.team_route(uuid)   to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- path_balance :: how many of the 10 paths send a crew to each room at each step
-- Rotating rooms should read 2 in every cell; the final room takes all 10 crews
-- at the last step, which is the point of it.
-- -----------------------------------------------------------------------------
create or replace view public.path_balance as
select
  step.step_index::smallint as step_index,
  r.code                    as room_code,
  count(*)                  as teams_arriving
from public.paths p
cross join lateral unnest(p.room_ordinals) with ordinality as step(ordinal, step_index)
join public.rooms r on r.ordinal = step.ordinal and r.kind = 'game'
group by step.step_index, r.code

union all

select
  public.final_step_index(),
  r.code,
  (select count(*) from public.paths)
from public.rooms r
where r.kind = 'final' and r.is_active

order by 1, 2;

comment on view public.path_balance is
  'Path spread check: every rotating cell should read 2, and the final room takes all crews at the last step.';

-- =============================================================================
-- A 22nd path, so every crew including the test crew has its own route
-- =============================================================================
-- 21 event crews plus ALPHA is 22 crews, and ALPHA had been doubling up on
-- PATH-01 with TEAM1. Doubling was always harmless for scoring - progress is
-- tracked per team_id - but two crews on one route walk the rooms in lockstep,
-- which is exactly the congestion the paths exist to avoid. So ALPHA gets its
-- own.
--
-- 22 crews over 5 rotating rooms cannot divide evenly (22 = 4x5 + 2), so no set
-- of 22 paths can be perfectly flat. The best achievable is every cell at 4 or
-- 5, with exactly two rooms taking 5 crews at each step, and that is what this
-- reaches.
--
-- PATH-01..20 are the four cyclic Latin squares (strides 1-4) and contribute
-- exactly 4 to every cell. PATH-21 and PATH-22 each add 1 to five cells, so the
-- only way a cell reaches 6 is if both add to the same one. PATH-22 is therefore
-- chosen to be DISCORDANT with PATH-21 - a different room at every single step:
--
--   PATH-21  0 1 2 4 3
--   PATH-22  1 0 3 2 4
--            ^ ^ ^ ^ ^  all five positions differ
--
-- It is also not of the (i + stride*j) form - its successive differences are not
-- constant - so it duplicates none of the twenty. Result, per step: three rooms
-- take 4 crews and two take 5.
--
-- Verify with:  select * from public.path_balance;
-- =============================================================================

insert into public.paths (code, room_ordinals)
values ('PATH-22', array[1, 0, 3, 2, 4]::smallint[])
on conflict (code) do nothing;

-- Move the test crew off TEAM1's route onto its own. Unconditional, unlike the
-- seed's "only if path_id is null", because ALPHA already holds PATH-01 here.
update public.teams
   set path_id = (select id from public.paths where code = 'PATH-22')
 where code = 'ALPHA';

comment on table public.paths is
  '22 routes over the 5 rotating rooms, one per crew (21 event crews + ALPHA); the final room is appended by team_route() and is not stored here. PATH-01..20 are four cyclic Latin squares (strides 1-4) and are perfectly balanced. PATH-21 and PATH-22 are discordant with each other, which is what keeps every cell at 4 or 5 crews - the best possible when 22 does not divide by 5.';

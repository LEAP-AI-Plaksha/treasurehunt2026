-- =============================================================================
-- Paths for a 21-crew event
-- =============================================================================
-- The roster is up to 21 crews, so 10 paths is no longer enough to give each
-- crew its own route. This extends the existing construction rather than
-- replacing it: PATH-01..10 keep their exact orders, so any route card already
-- printed stays correct, and crews already holding a path keep it.
--
-- 20260819000300_paths.sql built PATH-01..10 as two cyclic Latin squares of
-- order 5 over the rotating room ordinals:
--
--   path i, step j  ->  (i + stride * j) mod 5,  for stride 1 and 2
--
-- Every stride coprime to 5 yields a Latin square, and 5 is prime, so strides
-- 3 and 4 give ten more rows on the same rule - PATH-11..20. Rows from
-- different strides can never coincide (that would need stride a = stride b
-- mod 5), so all twenty orderings are distinct, and each of the four squares
-- contributes every room exactly once per column: across PATH-01..20 every room
-- is the destination of exactly 4 paths at every step. Perfectly flat.
--
-- PATH-21 is the awkward one, and unavoidably so: 21 crews over 5 rotating
-- rooms cannot divide evenly, so no 21st route can keep the spread flat. It is
-- written out explicitly and is deliberately NOT of the (i + stride*j) form -
-- its consecutive differences are not constant - so it duplicates none of the
-- twenty. It leaves each room the destination of 4 or 5 paths at every step,
-- which is the best any 21st path can do.
--
-- Verify the spread any time with:  select * from public.path_balance;
-- =============================================================================

-- PATH-11..20 :: strides 3 and 4, numbered on from the existing ten.
insert into public.paths (code, room_ordinals)
select
  'PATH-' || lpad((10 + row_number() over (order by stride, i))::text, 2, '0'),
  ordinals
from (
  select stride, i, array(
    select ((i + stride * j) % 5)::smallint from generate_series(0, 4) as j
  ) as ordinals
  from generate_series(3, 4) as stride,
       generate_series(0, 4) as i
) as generated
on conflict (code) do nothing;

-- PATH-21 :: the odd one out, see the note above.
insert into public.paths (code, room_ordinals)
values ('PATH-21', array[0, 1, 2, 4, 3]::smallint[])
on conflict (code) do nothing;

comment on table public.paths is
  '21 routes over the 5 rotating rooms; the final room is appended by team_route() and is not stored here. PATH-01..20 are four cyclic Latin squares (strides 1-4) and are perfectly balanced; PATH-21 exists because 21 crews cannot divide evenly over 5 rooms.';

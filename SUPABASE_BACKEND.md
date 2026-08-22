# Supabase backend — TREASURE by LEAP: A Louvre Heist

Five rotating rooms, a fixed finale, one shared origin, ten perfectly balanced
routes, and a per-room record of who finished what and how long it took.

```
HUB  ->  5 rotating rooms, in the crew's own order  ->  MLP BACKTRACK  ->  HUB
```

Crews are briefed at the **hub** (origin) — team code, passcode and first riddle
handed over by hand, with no sign-in there — and each of the 22 crews holds its
own route through the five rotating rooms. After clearing those they all converge
on the same last stop — **CLASSROOM_1101 / NEURAL BYPASS**, the MLP backtrack.

Two clocks, both stamped server-side. A **room's** clock starts when the crew
types its credentials at that room's terminal and stops when the room resolves.
The **run's** clock starts at the crew's first room and stops when the last room
on their route resolves, cleared or failed; it is the tiebreaker in the
standings.

---

## Architecture

| Concern | Lives in | Why |
|---|---|---|
| Team auth, sessions | Supabase Auth | Real JWTs, so RLS can key off `auth.uid()` |
| Rooms, riddles, routes | Postgres tables | One source of truth for every terminal |
| "Finale comes last" | `team_route()` | The rule exists in exactly one place |
| Completion + timing | `room_visits`, stamped by RPCs | Server clock only; a kiosk cannot fake a time |
| Enrollment, operator tools | Edge Functions | Hold the service role key server-side |
| Pose / CLIP / image generation | Flask (`backend/`) | Supabase cannot host torch |

Every room frontend is the same Vite app with a different `VITE_ROOM_ID`, all
pointing at one Supabase project.

### Why kiosks are safe to leave unattended

The only key that ships to a room terminal is the anon key. With it, a player who
opens devtools can read the room narrative and their **own** team's rows — and
nothing else:

- `riddles` has no client grant at all, so answers cannot be read.
- No client role holds INSERT/UPDATE/DELETE anywhere, so a completion time
  cannot be forged. Every write goes through a `SECURITY DEFINER` RPC.
- RLS restricts `teams`, `paths`, `room_visits` and `answer_attempts` to the
  calling crew.
- Cross-crew views (`leaderboard`, `team_room_times`) are granted to
  `service_role` only, reachable through the operator function.

---

## The 22 routes

Only the **five rotating rooms** are permuted. The finale sits outside the paths
entirely, so every crew ends on it.

Built from two cyclic Latin squares of order 5 over the rotating ordinals:

- **Square A**, stride 1: path `i`, step `j` → `(i + 1j) mod 5`, for `i = 0..4`
- **Square B**, stride 2: path `i`, step `j` → `(i + 2j) mod 5`, for `i = 0..4`

Both are Latin squares because 1 and 2 are each coprime to 5, so every column of
each square contains all five rooms exactly once. 5 is prime, so strides 3 and 4
work the same way and give **squares C and D** — twenty paths in all, each square
contributing every room exactly once per column, so **every room is the
destination of exactly 4 of those 20 paths at every step**. No two squares share
a row (that would need stride *a* ≡ stride *b* mod 5), so all twenty orderings
are distinct.

The roster is 22 crews, though — 21 event teams plus `ALPHA` — and one route each
means two more paths that no stride produces:

- **`PATH-21`** = `0 1 2 4 3`
- **`PATH-22`** = `1 0 3 2 4`

Neither has constant successive differences, so neither duplicates one of the
twenty. They are also **discordant with each other** — a different room at every
single step — which is what keeps any one cell from being incremented twice.

22 crews over 5 rooms cannot divide evenly, so no set of 22 paths is perfectly
flat. This one is as close as it gets: **every room takes 4 or 5 crews at every
step**, three rooms on 4 and two on 5.

Check it any time:

```bash
node scripts/operator.mjs balance
```

```
room            s1  s2  s3  s4  s5  s6  total
CLASSROOM_1101  0   0   0   0   0   10  10     <- the finale, same for everyone
CTLC_LAB        2   2   2   2   2   0   10
H2_LOUNGE       2   2   2   2   2   0   10
MUSIC_ROOM      2   2   2   2   2   0   10
NOSE_DRAW       2   2   2   2   2   0   10
YOGA_ROOM       2   2   2   2   2   0   10
```

Rotating rooms carry a stable `ordinal` 0–4. **Changing an ordinal re-points all
ten seeded routes**, so treat them as fixed once route cards are printed. The hub
and the finale carry no ordinal, which is what keeps them out of the permutation.

### One definition of a route

`public.team_route(team_id)` returns a crew's rooms in order: their permuted
rotating rooms at steps 1–5, then the finale at step 6. `check_in_room`,
`my_run`, `admin_force_complete` and every reporting view read from it, so the
"finale comes last" rule is defined once rather than in five places.

A useful consequence: because the finale is the highest step, the ordinary
route-order check is also what stops a crew reaching it early — no special case.
`final_step_index()` derives that step number from how many rotating rooms are
active, so adding or retiring a rotating room does not leave a hard-coded `6`.

---

## Setup

### 1. Database

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Locally this project uses the `544xx` port range so it can run beside another
Supabase project on the defaults.

Then load the rooms, placeholder riddles, 22 routes and 22 crews:

```bash
supabase db execute --file supabase/seed.sql
```

Locally, `supabase start` applies migrations and the seed automatically.
This project's local ports are shifted to the `544xx` range so it can run
alongside another local Supabase project.

### 2. Edge function secrets

```bash
cp supabase/functions/.env.example supabase/functions/.env   # then edit
supabase secrets set --env-file supabase/functions/.env
supabase functions deploy enroll-team
supabase functions deploy operator
```

- `OPERATOR_KEY` — treat as an admin password. It can read every crew's times
  and reset passcodes. Never put it on a room kiosk.
- `ALLOWED_ORIGINS` — the hub plus each room origin. Empty means `*`, which is
  fine locally and wrong in production.
- `TEAM_EMAIL_DOMAIN` — must match the frontend and Flask, or crew logins will
  not resolve to a team.

### 3. Frontends

```bash
cd "Kiosk-Style Treasure Hunt UI"
cp .env.example .env.local        # set VITE_ROOM_ID per machine
npm install
npm run dev:yoga                  # or dev:ctlc, dev:music, dev:h2, dev:classroom, dev:nosedraw, dev:hub
```

`VITE_OPERATOR_KEY` belongs **only** in the hub terminal's `.env.local`.

### 4. Flask ML service

```bash
cd backend
cp .env.example .env              # add SUPABASE_URL, SERVICE_ROLE_KEY, JWT_SECRET
pip install -r requirements.txt
python app.py
```

It now serves only `/api/health`, `/api/game/launch`, `/api/memory/images`,
`/api/memory/generate` and `/api/ml/report`. The auth, config, validate and
score endpoints were removed — the frontend calls Supabase for those.

---

## Running the event

### Before crews arrive

Create every crew's login in one go and print the slips:

```bash
node scripts/operator.mjs provision
```

That generates a typeable password per crew (one word plus three digits, no
ambiguous characters), creates the Supabase Auth users, and prints a sheet:

```
team    password     path     route
TEAM1   <generated>  PATH-01  YOGA_ROOM > CTLC_LAB > MUSIC_ROOM > H2_LOUNGE > NOSE_DRAW > CLASSROOM_1101
TEAM2   <generated>  PATH-02  CTLC_LAB > MUSIC_ROOM > H2_LOUNGE > NOSE_DRAW > YOGA_ROOM > CLASSROOM_1101
...
TEAM10  <generated>  PATH-10  NOSE_DRAW > CTLC_LAB > H2_LOUNGE > YOGA_ROOM > MUSIC_ROOM > CLASSROOM_1101
```

Real passwords are shown in your terminal and written to the file below; they are
deliberately not reproduced in this document, which is committed.

It also writes `team-credentials.txt` in the repo root — **gitignored**, and the
only real secret in the project. Print it, hand out one line per crew, and keep
the sheet off the kiosks.

Re-running `provision` resets passwords rather than failing, which is what you
want if a sheet goes missing. `provision <shared-password>` gives every crew the
same password — handy for a rehearsal, wrong for the real event, since crews
could then log in as each other and touch a rival's score.

Crews type their **team code and password** at the hub to start, and the same
pair at every room. Nothing else to set up.

> Passwords are never committed and never stored in plaintext in the database —
> Supabase Auth holds only a bcrypt hash. If you lose the sheet, re-provision.

<details>
<summary>Alternative: let crews choose their own passcode at the hub</summary>

Instead of `provision`, give each crew the `enrollment_code` printed on its slip
and have them pick a passcode at the hub terminal:

```bash
node scripts/operator.mjs enroll TEAM1 LVR-T01-4417 <their-passcode>
```

An enrollment code can only be claimed once. Replace the placeholder codes in
`supabase/seed.sql` before the event if you use this route.

</details>

### While it runs

```bash
node scripts/operator.mjs occupancy      # which rooms have backed up
node scripts/operator.mjs leaderboard    # standings
node scripts/operator.mjs times TEAM1    # one crew's per-room times
```

### Recovery

```bash
node scripts/operator.mjs passcode TEAM1 <new>     # crew forgot their password
node scripts/operator.mjs force TEAM1 YOGA_ROOM    # a room broke: credit it
node scripts/operator.mjs reset TEAM1              # wipe a crew's run
node scripts/operator.mjs scoring closed           # freeze scoring at the end
```

A crew that burns all three attempts in a room is **not** stranded: the room is
marked `locked_out`, scores zero, and they move on to their next step.

---

## Riddles reveal progressively

A crew is handed one riddle at a time, never the whole route's puzzles at once:

- The **first** riddle is handed out on paper at the operations base. The hub
  terminal does not sign anyone in, so nothing digital reveals it.
- **`check_in_room()`** returns the current room's own prompt on arrival, so
  nothing depends on anyone remembering what they were given.
- **`submit_answer()`, `record_ml_result()`, `abandon_room()`** all return the
  **next** unresolved room's prompt (`nextRiddle`) the instant the current one
  is resolved - pass or fail. A crew that fails a room learns their next
  assignment just as fast as one that solves it.
- Once every room is resolved, `nextRiddle` comes back `null`, and the run is
  already finished server-side (see below) — nothing more is required of the
  crew than walking back.

Only ever ONE room's prompt is exposed at a time - never the whole route, and
never an answer. The underlying read is `next_riddle_preview(team_id)`, a
read-only function so calling it never starts a clock.

---

## Flow control: what stops a crew jumping ahead

Three independent rules, all enforced in Postgres, so they hold no matter which
of the seven devices a crew walks up to.

**1. The clock starts at the first room.** `check_in_room()` stamps
`started_at` when it is still null, so a crew's run begins the moment they
authenticate anywhere on their route. It used to refuse every room until
`hub_check_in()` had stamped it, which made the hub a mandatory gate; the hub no
longer signs anyone in, so that gate would strand every crew.

The other end is symmetrical: a trigger on `room_visits`
(`finish_run_when_route_resolved`) stamps `finished_at` once every room on the
crew's route is resolved, cleared or failed. It is a trigger rather than a call
inside each RPC because four functions can resolve a visit — `submit_answer`,
`record_ml_result`, `abandon_room` — and `admin_force_complete` bypasses all of
them.

```
> first room sign-in, no hub visit
started_at stamped -> the run's clock is running
```

**2. Rooms open strictly in the crew's own order.** Only the next unresolved step
is enterable. A crew due at step 1 is refused at steps 2, 4 and 6 alike — and
because the finale is the highest step, the same rule is what stops anyone
reaching the MLP backtrack early. No special case.

```
> enter H2_LOUNGE while due at step 1
"Out of order: this is step 4 of your route, you are due at step 1"
```

**3. One live session per crew.** A crew cannot hold a login on two terminals.
The newest sign-in wins — walking into the next room takes the session along, and
the terminal they left goes dead on its very next request:

```
> device A submits after the crew signed in at device B
"This crew is signed in at another terminal (YOGA_ROOM).
 Only one terminal at a time - sign out there, or sign in again here to take over."
```

Enforced on the JWT's `session_id`, pinned in `teams.active_session_id`, rather
than with Supabase's native single-session option: that option stops the old
session *refreshing*, but a JWT is stateless and stays valid until it expires —
an hour here, longer than the event. Pinning in the database takes effect on the
next request. `select * from active_sessions` shows where every crew is signed in.

Because state lives in Postgres rather than in a browser, any terminal sees a
crew's progress the instant it changes. Nothing is cached per device.

## Scoring: completion and failure, not points

Standings rank by **how many rooms a crew actually solved**, not by a point
total. Time only breaks a tie.

```
position by:
  1. rooms_completed  desc   (more rooms solved wins)
  2. elapsed_seconds   asc   (hub-to-hub wall clock, tiebreaker only)
  3. finished_at       asc   (final fallback if still tied)
```

`rooms.points` / `room_visits.points_awarded` remain in the schema - they cost
nothing to keep and might be useful for a bonus stat later - but nothing in
`leaderboard`'s ranking reads them. `node scripts/operator.mjs leaderboard`
shows `rooms_completed`, `rooms_failed`, and `elapsed_seconds`.

## Failing a room also finishes it

A crew is never stuck. Pass or fail, a room is *resolved* and the next one opens:

| Outcome | `status` | Points | Time recorded | Next room opens |
|---|---|---|---|---|
| Solved | `completed` | full | yes | yes |
| All attempts spent | `locked_out` | 0 | yes | yes |
| Gave up (`abandon_room`) | `locked_out` | 0 | yes | yes |

`abandon_room()` exists so a stuck crew does not have to burn three wrong guesses
to move on. `leaderboard` reports `rooms_completed` (solved) alongside
`rooms_resolved` (got through) and `rooms_failed`, so "reached the end" and
"cleared everything" stay distinguishable.

---

## Rehearsal: walk the whole flow without solving anything

```bash
node scripts/operator.mjs skip on                  # any answer works, in any room
node scripts/operator.mjs enroll ALPHA LVR-ALPHA-4417 rehearse1
node scripts/operator.mjs walk ALPHA rehearse1     # hub -> 5 rooms -> finale -> hub
node scripts/operator.mjs walk-all rehearse1       # every enrolled crew
node scripts/operator.mjs skip off                 # BEFORE the real event
```

`skip on` also bypasses the machine-graded rooms, so the full route can be walked
without running the CV game. Timing is still recorded normally, and every skipped
room stays identifiable afterwards:

```bash
node scripts/operator.mjs skipped
```

> `skip_riddles` must be **off** during the real event. `operator skip off`
> is the switch, and `event_settings.skip_riddles` is the flag to verify.

---

## The pose game runs inside the kiosk page

`YOGA_ROOM` used to spawn `louvre_laser_game.py` as a separate native window
(`cv2.imshow`) outside the browser - slow to appear and never actually part of
the kiosk UI. It now streams into the page directly:

- `GET /api/game/video_feed?token=&roomId=` (Flask) runs the exact same
  detection/scoring/HUD code as the standalone script, but yields MJPEG frames
  instead of opening a window. The kiosk just points an `<img>` tag at it - no
  video library on either side.
- The crew's JWT travels as a query parameter, because an `<img src>` cannot
  send an Authorization header. It is the same short-lived Supabase access
  token used everywhere else.
- Opening the `<img>` **is** the launch: there is no separate "start" call.
  Loading the YOLO model and opening the webcam takes a few seconds on a cold
  start - the kiosk shows a loading state until the first frame arrives.
- A win is still reported the same way as before: a loopback POST to
  `/api/ml/report`, which calls `record_ml_result()` in Supabase. Flask must
  run with `threaded=True` for this to work - a self-referential POST on a
  single-threaded dev server would deadlock against its own still-open stream.
- Disconnecting (closing the tab, navigating away) tears down the generator and
  releases the camera via a `finally` block - verified with no lingering
  process or camera handle after a client drops mid-stream.

`run_game()`, the desktop version, is untouched - `python louvre_laser_game.py`
still opens a native window for standalone development exactly as before. The
streaming path is a second, additive entry point (`stream_game_frames()`), not
a rewrite of the original.

Every room also has a manual typed-answer fallback (`ManualAnswerFallback`)
below whatever module it has, submitted through the normal `submit_answer()`
RPC. This matters most for `CLASSROOM_1101` (the finale) and `H2_LOUNGE`,
which previously had no way to progress at all if their module wasn't running.

## The pose game's HUD is themed, not raw OpenCV text

The camera overlay used to draw plain Hershey-font text in ad-hoc colors -
visibly a different application from the browser it now streams into. It is
rendered through Pillow instead (`hud_theme.py`), using the kiosk's own
JetBrains Mono files and exact Tailwind hex palette (`#337DFF` / `#00FF88` /
`#FF3333` / `#000307`), with the same bordered-panel-plus-corner-accent
language as `KioskBadge`/`AuthModal` in the React UI.

`hud_theme.Canvas` does the BGR<->RGB round trip once per frame - not once per
label - and blends each translucent panel into the frame **immediately**
rather than deferring all panels to a single composite at the end of the
frame: deferring would put every panel visually on top of everything else
regardless of the order the code drew things in, which is exactly what
happened during development - an opaque button fill silently erased the label
drawn "after" it in the source, because both were doomed to sit under the same
end-of-frame overlay. Measured overhead is ~30ms/frame against a ~300ms/frame
YOLO inference cost - not a bottleneck.

`assets/fonts/` bundles the JetBrains Mono TTF files (OFL-1.1 licensed)
directly, rather than depending on whatever fonts happen to be installed on
each kiosk machine's OS.

## Editing riddles

Prompts, answers and clues are placeholders. They live in `public.riddles`, one
active row per room. `answer_normalised` must already be lowercase and
single-spaced, because `submit_answer()` compares it against
`normalise_answer(submission)` — which lowercases, collapses whitespace and
trims, and is forgiving about nothing else.

```sql
update public.riddles r
   set prompt            = 'Your real riddle text',
       answer_normalised = public.normalise_answer('The Real Answer'),
       answer_alternates = array[public.normalise_answer('an accepted variant')],
       success_clue      = 'CLUE: where they go next',
       updated_at        = now()
  from public.rooms m
 where r.room_id = m.id and m.code = 'YOGA_ROOM' and r.is_active;
```

For a room graded by the CV game or CLIP instead of typed text:

```sql
update public.rooms set ml_graded = true where code = 'YOGA_ROOM';
```

Every room ships with `ml_graded = false`, so the whole event is playable by typed
answer out of the box. Flip a room only once its game module is wired up.

`submit_answer()` then refuses typed answers there, and the room is completed by
Flask calling `record_ml_result()` — so its time comes from the same clock as
every other room.

---

## RPC reference

Crew-facing (`authenticated`):

| RPC | Purpose |
|---|---|
| `check_in_room(code)` | Credentials entered at a room; stamps `arrived_at`, and `started_at` on the crew's first room; returns the riddle. Idempotent |
| `submit_answer(code, text)` | Grade an answer; on success stamps `completed_at` |
| `hub_check_in()` / `hub_check_out()` | Legacy hub bracketing. Nothing calls these — the clock now starts at the first room and ends on a trigger. Kept so an organiser can still bracket a run by hand |
| `abandon_room(code)` | Give up on a room: 0 points, time recorded, next room opens |
| `my_run()` | The crew's whole route with per-room status and timing |

Service role only:

| RPC | Purpose |
|---|---|
| `record_ml_result(team, room, passed, detail)` | Flask reports a machine-graded verdict |
| `admin_force_complete(team, room)` | Credit one room to one crew |

Route order is enforced on **first arrival only**. Once a visit row exists the
crew is already in the room, so a kiosk reload — or walking back to re-read a
clue — returns the current state instead of an "out of order" refusal.

---

## Reporting views

| View | Contents |
|---|---|
| `team_room_times` | The scoring export: completion and duration per crew per room, `is_final` flags the finale |
| `leaderboard` | Ranked by **rooms completed**, then elapsed time (first sign-in → finish). Points play no part |
| `room_occupancy` | Live load and average solve time per room |
| `enrollment_status` | Who has enrolled, and their route |
| `path_balance` | Crews arriving per room per step; with 22 crews every cell should read 4 or 5 |
| `skipped_rooms` | Rooms skipped or force-completed |
| `active_sessions` | Which terminal each crew is currently signed in at |

All are `service_role` only, reached through the `operator` edge function.

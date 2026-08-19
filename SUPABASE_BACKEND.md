# Supabase backend — TREASURE by LEAP: A Louvre Heist

Five rotating rooms, a fixed finale, one shared origin, ten perfectly balanced
routes, and a per-room record of who finished what and how long it took.

```
HUB  ->  5 rotating rooms, in the crew's own order  ->  MLP BACKTRACK  ->  HUB
```

Crews check in at the **hub** (origin) and are handed one of ten routes through
the five rotating rooms. After clearing those they all converge on the same last
stop — **CLASSROOM_1101 / NEURAL BYPASS**, the MLP backtrack — then return to the
hub to check out.

The clock for a room starts the moment the crew types its credentials at that
room's terminal and stops when the room is cleared.

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

## The ten routes

Only the **five rotating rooms** are permuted. The finale sits outside the paths
entirely, so every crew ends on it.

Built from two cyclic Latin squares of order 5 over the rotating ordinals:

- **Square A**, stride 1: path `i`, step `j` → `(i + 1j) mod 5`, for `i = 0..4`
- **Square B**, stride 2: path `i`, step `j` → `(i + 2j) mod 5`, for `i = 0..4`

Both are Latin squares because 1 and 2 are each coprime to 5, so every column of
each square contains all five rooms exactly once. Five rows from A plus five from
B gives ten paths, and since each square contributes each room once per column,
**every room is the destination of exactly 2 of the 10 paths at every step**.

Ten crews over five rooms divides evenly, so this spread is perfectly flat — no
room is ever busier than another. The two squares share no row (a row of A equals
a row of B only if stride 1 ≡ stride 2 mod 5, which is false), so all ten
orderings are distinct.

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

Then load the rooms, placeholder riddles, ten routes and ten crews:

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

Replace the placeholder `enrollment_code` values in `supabase/seed.sql` with
codes you print on each crew's slip. Anyone holding a code can claim that crew's
login once.

### At the hub, as each crew arrives

The crew types its team code, its printed enrollment code, and **a passcode they
choose**. That creates their login and prints their route:

```bash
node scripts/operator.mjs enroll ALPHA LVR-ALPHA-4417 <their-passcode>
```

Then they check in at the hub with that passcode, which stamps `started_at`, and
disperse. At every room they type the same team code and passcode.

### While it runs

```bash
node scripts/operator.mjs occupancy      # which rooms have backed up
node scripts/operator.mjs leaderboard    # standings
node scripts/operator.mjs times ALPHA    # one crew's per-room times
```

### Recovery

```bash
node scripts/operator.mjs passcode ALPHA <new>     # crew forgot their passcode
node scripts/operator.mjs force ALPHA YOGA_ROOM    # a room broke: credit it
node scripts/operator.mjs reset ALPHA              # wipe a crew's run
node scripts/operator.mjs scoring closed           # freeze scoring at the end
```

A crew that burns all three attempts in a room is **not** stranded: the room is
marked `locked_out`, scores zero, and they move on to their next step.

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
| `hub_check_in()` | Leave the origin; stamps `started_at`, returns the route |
| `check_in_room(code)` | Credentials entered at a room; stamps `arrived_at`, returns the riddle. Idempotent |
| `submit_answer(code, text)` | Grade an answer; on success stamps `completed_at` and awards points |
| `hub_check_out()` | Return to the origin; stamps `finished_at` |
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
| `leaderboard` | Ranked by points, then time in rooms, then finish time |
| `room_occupancy` | Live load and average solve time per room |
| `enrollment_status` | Who has enrolled, and their route |
| `path_balance` | Crews arriving per room per step; rotating cells should all read 2 |
| `skipped_rooms` | Rooms skipped or force-completed |

All are `service_role` only, reached through the `operator` edge function.

# Running the Heist locally — one room per laptop

Practical setup guide for **TREASURE by LEAP: A Louvre Heist**. For the design
of the database and why it is built this way, see [SUPABASE_BACKEND.md](SUPABASE_BACKEND.md).

---

## How the pieces fit together

```
                    ┌────────────────────────────┐
                    │   Supabase  (hosted, 1x)   │
                    │  auth · riddles · routes   │
                    │  timing · leaderboard      │
                    └─────────────┬──────────────┘
                                  │  every laptop talks to this
      ┌───────────┬───────────┬───┴───────┬───────────┬───────────┐
      │           │           │           │           │           │
   ┌──┴──┐     ┌──┴──┐     ┌──┴──┐     ┌──┴──┐     ┌──┴──┐     ┌──┴──┐
   │ HUB │     │YOGA │     │CTLC │     │MUSIC│     │ H2  │     │NOSE │  ...
   └─────┘     └──┬──┘     └─────┘     └─────┘     └──┬──┘     └─────┘
                  │                                   │
              local Flask                         local Flask
              + webcam                            + internet
```

**One shared Supabase. One laptop per room. Vite runs locally on each laptop.**

The Flask ML service is **not** shared over the network — the two rooms that
need it each run their own copy on `localhost`. The pose room grabs the camera
server-side through OpenCV, so the Flask process must be on the same machine as
the webcam.

---

## What each laptop actually needs

| Room | `VITE_ROOM_ID` | Port | Flask? | Webcam? | Internet? |
|---|---|---|---|---|---|
| OPERATIONS BASE | `HUB` | 5172 | – | – | yes (briefing board — no crew login) |
| LASER GRID | `YOGA_ROOM` | 5173 | **yes, full** | **yes** | yes |
| SILENT RELAY | `CTLC_LAB` | 5174 | – | yes (in browser) | yes |
| VOICE INTERCEPT | `MUSIC_ROOM` | 5175 | – | – | yes |
| MEMORY FORGERY | `H2_LOUNGE` | 5176 | **yes, full** | – | yes |
| BIOMETRIC SKETCH | `NOSE_DRAW` | 5178 | – | yes (in browser) | yes |
| NEURAL BYPASS | `CLASSROOM_1101` | 5177 | – | – | yes |

Only **two** laptops need Python at all. `CTLC_LAB` and `NOSE_DRAW` run their
hand/face tracking entirely in the browser (MediaPipe), so they need a webcam
but no Flask.

Both Flask laptops need the **same full install** now. `H2_LOUNGE` grades each
round with real CLIP + SSIM + color-histogram scoring (`backend/scoring.py`),
not a rubber stamp — that needs torch/transformers locally, same as the pose
room's YOLO model.

---

## Prerequisites

Every laptop needs **Node.js 20+**. Check with `node -v`.

The two Flask laptops also need **Python 3.11+**.

---

## Part 1 — Shared setup (do this once, on any laptop)

The database is already migrated and seeded, and both edge functions are
deployed. You only need this part if you are rebuilding the project from
scratch:

```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase db execute --file supabase/seed.sql
```

### If a hosted project is behind on migrations

Worth checking before an event, because the failure is total rather than
partial: the kiosk has no hub login, so a database still carrying the old
`check_in_room()` refuses **every** crew at **every** room with *"Check in at the
hub terminal first"*.

Two quick checks against the project, both read-only:

```bash
# Should list finish_run_when_route_resolved. If it does not, 20260822000100 is missing.
curl -s "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_ANON_KEY" \
  | grep -o 'finish_run_when_route_resolved'

# Should be 22.
curl -s "$SUPABASE_URL/rest/v1/paths?select=code" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | tr ',' '\n' | grep -c PATH-
```

To fix it, `supabase db push` if you can link the project. If you cannot — the
project lives in someone else's Supabase account, say — open the dashboard SQL
editor and paste the migrations it is missing, **in filename order**, from
`supabase/migrations/`. They are written to be idempotent, so re-running one that
is already applied is harmless.

One caution if crews have already started: apply only the schema migrations. Do
not re-run `seed.sql`, and do not reassign paths — moving a crew's route mid-run
changes which rooms they are due at.

### Create the crew logins

The roster is **21 teams** (`TEAM1`–`TEAM21`), plus `ALPHA` as a standing
admin/test crew alongside the 21 event slots. There are **22 routes for 22
crews**, so no two crews share one: `TEAM1`–`TEAM21` take `PATH-01`–`PATH-21`
and `ALPHA` takes `PATH-22`.

22 crews over 5 rotating rooms does not divide evenly, so the spread cannot be
perfectly flat — every room takes 4 or 5 crews at every step, which is the best
possible. Check it any time with `select * from public.path_balance;`.

Run once, from any laptop, before the event:

```bash
export SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
export SUPABASE_ANON_KEY=<anon key from Settings → API>
export OPERATOR_KEY=<the same string set in supabase/functions/.env>
node scripts/operator.mjs provision
```

This writes **`team-credentials.txt`** in the repo root — gitignored, and the
only real secret in the project. Print it and hand one line to each crew.

> Re-running `provision` resets every password, including ones already handed
> out. If credentials were generated another way (directly against the
> database, for instance) and you want to keep them, don't run this again.

---

## Part 2 — Every laptop: the kiosk frontend

Same on all seven machines except for one line.

```bash
git clone https://github.com/LEAP-AI-Plaksha/treasurehunt2026.git
cd treasurehunt2026/"Kiosk-Style Treasure Hunt UI"
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```ini
# CHANGE THIS PER LAPTOP — see the table above
VITE_ROOM_ID=YOGA_ROOM

VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key from Settings → API>
VITE_TEAM_EMAIL_DOMAIN=louvre.local

# Only matters on the two Flask laptops; harmless elsewhere.
# Both already default to these values, so you can leave them out entirely.
VITE_ML_BASE_URL=/api
VITE_API_BASE_URL=http://localhost:4000
```

> **The anon key is the only key that belongs on a room kiosk.** It cannot read
> riddle answers and cannot write a completion time — every write goes through a
> `SECURITY DEFINER` function. Leaving a kiosk unattended is safe.

Start it with the script for that room:

```bash
npm run dev:hub         # HUB
npm run dev:yoga        # YOGA_ROOM
npm run dev:sign        # CTLC_LAB   ← note: "sign", not "ctlc"
npm run dev:music       # MUSIC_ROOM
npm run dev:h2          # H2_LOUNGE
npm run dev:classroom   # CLASSROOM_1101
npm run dev:nosedraw    # NOSE_DRAW
```

Each script pins the right room ID and port, so `.env.local`'s `VITE_ROOM_ID` is
really only a fallback. Open `http://localhost:<port>` and press F11 for
fullscreen kiosk mode.

### The hub laptop only

**The hub does not sign anyone in.** Crews are handed their team code, passcode
and first riddle by hand at the operations base, so `npm run dev:hub` serves a
briefing board with no team-code prompt on it. It needs no keys beyond the anon
key every terminal has.

That means the run's clock is bracketed by the rooms, not the hub:

| | when it is stamped |
|---|---|
| `started_at` | the crew's **first room** sign-in (`check_in_room`) |
| `finished_at` | when the **last room on their route resolves**, cleared or failed |

Standings and per-room times are read with the operator CLI (`node
scripts/operator.mjs leaderboard`), which carries `OPERATOR_KEY` in its own
environment. Nothing in the frontend reads standings any more, so
`VITE_OPERATOR_KEY` is no longer needed on any terminal — including the hub.

---

## Part 3 — The two Flask laptops

Both `YOGA_ROOM` and `H2_LOUNGE` run the same `backend/app.py`, and both need
the **full install** — OpenCV + YOLO pose for the laser room, torch +
transformers for `H2_LOUNGE`'s CLIP/SSIM scoring. Roughly 2 GB of
dependencies, so do this well before the event, on wifi you trust.

```bash
cd treasurehunt2026
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### Configure and start (both laptops)

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```ini
PORT=4000
HOST=0.0.0.0
FLASK_ENV=development

SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key from Settings → API>

# Leave BLANK. This project signs JWTs with ES256 and the service verifies
# them against the project's public JWKS. The HS256 secret is a legacy
# fallback and is not needed.
SUPABASE_JWT_SECRET=

TEAM_EMAIL_DOMAIN=louvre.local

# H2_LOUNGE only — image generation. Comma-separated account_id:token pairs,
# tried in order so a rate-limited account fails over to the next.
CF_ACCOUNTS=<account_id>:<token>,<account_id>:<token>
CF_ACCOUNT_ID=<first account id>
CF_API_TOKEN=<first token>

# Also H2_LOUNGE only — the CLIP model backend/scoring.py loads to grade each
# round. Defaults to openai/clip-vit-base-patch32 if left unset.
CLIP_MODEL_NAME=openai/clip-vit-base-patch32
```

Then:

```bash
source .venv/bin/activate
python backend/app.py
```

Confirm it came up:

```bash
curl http://localhost:4000/api/health
```

You want `{"status": "ok", "event": "TREASURE by LEAP - A Louvre Heist"}`.

> **Why port 4000 and not the documented 5000?** On macOS, port 5000 is taken by
> the AirPlay Receiver and Flask will fail with *"Address already in use"*. If
> you change it, change `VITE_API_BASE_URL` to match — `app.py`'s own port
> default currently ignores the `PORT` env var and is hardcoded in its
> `__main__` block, so check there directly if `curl` doesn't answer.

---

## Demo mode — see the UI with no backend at all

To show the terminals to someone, or to work on the frontend without Supabase,
Flask, or crew logins, add one line to `.env.local`:

```ini
VITE_DEMO_MODE=1
```

Restart the dev server. Every room then serves its config from
`src/services/demoApi.ts` instead of Supabase, **any** team code and password
are accepted at the auth prompt, and every submission passes — so you can walk
the full idle → auth → briefing → challenge → success flow on any terminal.

The two ML-backed rooms fall back to manual answer entry, since there is no
Flask service to stream pose frames or generate images.

Remove the line to go back to the real backend. With the flag unset — which is
always the case in production — `demoApi.ts` is tree-shaken out of the bundle
entirely, so this cannot be left on by accident in a build. Delete
`src/services/demoApi.ts` and the two-line switch at the bottom of
`src/services/api.ts` to remove demo mode for good.

---

## Part 4 — Check it before the crews arrive

The operator CLI can drive every crew through their entire route, first room to
last. This is the real end-to-end test:

```bash
export SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
export SUPABASE_ANON_KEY=<anon key>
export OPERATOR_KEY=<operator secret>

node scripts/operator.mjs walk-all TESTPASS123   # drive every crew through
node scripts/operator.mjs leaderboard            # times should be recorded
node scripts/operator.mjs reset TEAM1            # wipe a crew before the real run
```

Reset every crew, or re-run `provision`, before the actual event.

### While it runs

```bash
node scripts/operator.mjs occupancy    # which rooms have backed up
node scripts/operator.mjs leaderboard  # standings
node scripts/operator.mjs times TEAM1  # one crew's per-room times
```

### When something breaks

```bash
node scripts/operator.mjs passcode TEAM1 <new>    # crew forgot their password
node scripts/operator.mjs force TEAM1 YOGA_ROOM   # a room died: credit it
node scripts/operator.mjs skip on                 # accept any answer, anywhere
node scripts/operator.mjs scoring closed          # freeze at the end
```

A crew that burns all three attempts is not stranded — the room is marked
`locked_out` and they move on.

---

## Things that will actually go wrong

**`TEAM_EMAIL_DOMAIN` must be identical in three places.** If it drifts, crew
logins resolve to the wrong team or to nothing, and the failure is silent:

| File | Variable |
|---|---|
| `supabase/functions/.env` | `TEAM_EMAIL_DOMAIN` |
| `backend/.env` | `TEAM_EMAIL_DOMAIN` |
| `Kiosk-Style Treasure Hunt UI/.env.local` | `VITE_TEAM_EMAIL_DOMAIN` |

Leave it at `louvre.local` everywhere and it cannot drift.

**"TERMINAL OFFLINE — cannot reach the event backend" means Supabase, not
Flask.** It appears whenever the kiosk cannot read its room config, and only two
of the seven terminals run Flask at all. Check `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` and the wifi before going looking for Python. (This
screen used to name `localhost:5000` and send people after the wrong service.)

**Every room has a GIVE UP button** in the top-right of the active-challenge
header (a two-tap confirm, so a stray touch can't end a run). It always
registers as a fail on the server — `abandon_room()` stamps the visit
`locked_out` and logs it — same as running out of attempts. Use it to unstick
a crew stuck on a broken terminal without an operator having to intervene.

**MEMORY FORGERY (`H2_LOUNGE`) is three rounds, not one.** Each round: two
fresh photos sourced live from the internet (Lorem Picsum, never reused),
memorise, describe, then Flask grades the AI reconstruction against the
original with real CLIP + SSIM + color scoring — not a rubber stamp. A round
needs 5/10 or better; the room needs 2 of 3 rounds to pass. Tune
`MEMORY_PASS_SCORE` and `MEMORY_ROUND_MIN_PASSES` in `backend/app.py` after a
rehearsal if it's too easy or too hard — there's no calibration data behind
those defaults yet.

**Use `localhost`, not the LAN IP,** in the browser on each kiosk. The edge
functions only allow the origins listed in `ALLOWED_ORIGINS`, and that list is
localhost ports. If you must use a LAN IP, add it there and re-push secrets:

```bash
supabase secrets set --env-file supabase/functions/.env
```

**Do not rename the files in `Kiosk-Style Treasure Hunt UI/public/audio/`.**
They are deliberately plain ASCII (`voice_1_...mp3`). Filenames containing
commas, ampersands or en dashes are not matched by Vite's static handler — the
request falls through to the SPA fallback and the `<audio>` element receives
`index.html` as `text/html`, which fails silently with no console error and no
sound. The original ElevenLabs filenames are kept in `heist_audio_files/`.

**The riddles in `seed.sql` are placeholders.** Write the real ones before the
event, or every room ships with dummy text.

**The pose game is driven from the kiosk page, not the keyboard shortcuts in
the game.** It streams into the browser as an MJPEG image, so there is no OpenCV
window to receive key presses. The kiosk shows **RESTART**, **SKIP POSE** and
**END MODULE** buttons, and binds the same actions to `SPACE`/`R`, `N` and `Q`
in the page. Clearing 7 of the 10 poses passes the room; a run that misses it is
a spent attempt, and after three the room closes out and the crew moves on —
either way the outcome is recorded, so a crew is never stuck watching a dead
feed.

**Camera permission is per-origin and per-browser.** Approve it once on each
camera laptop during setup — do not let a crew meet the permission dialog for
the first time mid-run.

---

## Quick reference

| Laptop | One-time | Every boot |
|---|---|---|
| HUB | `npm install`, `.env.local` | `npm run dev:hub` (briefing board, no login) |
| YOGA_ROOM | `npm install`, `pip install -r backend/requirements.txt`, both env files | `python backend/app.py` **and** `npm run dev:yoga` |
| CTLC_LAB | `npm install`, `.env.local` | `npm run dev:sign` |
| MUSIC_ROOM | `npm install`, `.env.local` | `npm run dev:music` |
| H2_LOUNGE | `npm install`, `pip install -r backend/requirements.txt`, both env files | `python backend/app.py` **and** `npm run dev:h2` |
| NOSE_DRAW | `npm install`, `.env.local` | `npm run dev:nosedraw` |
| CLASSROOM_1101 | `npm install`, `.env.local` | `npm run dev:classroom` |

Never commit `.env`, `.env.local`, `supabase/functions/.env`, or
`team-credentials.txt`. All four are already in `.gitignore`.

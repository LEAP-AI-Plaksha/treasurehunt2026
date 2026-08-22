-- =============================================================================
-- Seed data
-- =============================================================================
-- Re-runnable: every insert upserts, so `supabase db reset` and a plain re-run
-- both land on the same state. Riddle prompts, answers and clues are all
-- PLACEHOLDERS - see the "Editing riddles" section of SUPABASE_BACKEND.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Event settings
-- -----------------------------------------------------------------------------
update public.event_settings
   set event_name          = 'TREASURE by LEAP - A Louvre Heist',
       global_max_attempts = 3,
       scoring_open        = true,
       enforce_path_order  = true
 where id;

-- -----------------------------------------------------------------------------
-- Rooms :: the hub, the 5 ROTATING game rooms, and the FINAL room.
--
-- ordinal 0..4 is what the path generator permutes; keep these stable or the
-- 21 seeded paths change meaning.
--
-- CLASSROOM_1101 - the MLP backtrack - is kind='final' with no ordinal: it is
-- deliberately outside the paths so that it is the same last stop for every
-- crew, played after their 5 rotating rooms and before they return to the hub.
-- -----------------------------------------------------------------------------
insert into public.rooms
  (code, kind, ordinal, label, terminal_id, frontend_port, coordinates,
   briefing, hint, points, timer_seconds, max_attempts, ml_graded)
values
  ('HUB', 'hub', null, 'OPERATIONS BASE', 'HUB-00', 5172,
   '{"lat": "48.8600 N", "lng": "2.3380 E"}'::jsonb,
   'Operations base. Every crew is briefed here, receives its route, and returns here for extraction once all six rooms are cleared.',
   'Set your crew passcode, collect your route, and report back here when you are done.',
   0, 600, 99, false),

  ('YOGA_ROOM', 'game', 0, 'LASER GRID', 'ALPHA-01', 5173,
   '{"lat": "48.8606 N", "lng": "2.3376 E"}'::jsonb,
   'The Louvre east wing laser grid pulses at irregular intervals. Your team must hold the deactivation pose without breaking contact. Moving out of frame trips the alarm.',
   '',
   150, 10, 3, false),

  ('CTLC_LAB', 'game', 1, 'SILENT RELAY', 'BETA-02', 5174,
   '{"lat": "48.8608 N", "lng": "2.3364 E"}'::jsonb,
   'The guard rotation has been intercepted. A silent channel is open to your inside contact. The target phrase must be relayed without speaking - recognition microphones are live.',
   '',
   120, 5, 3, false),

  ('MUSIC_ROOM', 'game', 2, 'VOICE INTERCEPT', 'GAMMA-03', 5175,
   '{"lat": "48.8612 N", "lng": "2.3352 E"}'::jsonb,
   'An intercepted transmission is incoming on the guard frequency. Decide whether the voice on the channel belongs to a human guard or an AI decoy before you answer.',
   '',
   130, 30, 3, false),

  ('H2_LOUNGE', 'game', 3, 'MEMORY FORGERY', 'DELTA-04', 5176,
   '{"lat": "48.8619 N", "lng": "2.3341 E"}'::jsonb,
   'Your asset photographed the target artefact. The classified image self-destructs on a timer. Study every detail, then reconstruct it for the forger.',
   '',
   140, 10, 3, false),

  ('NOSE_DRAW', 'game', 4, 'BIOMETRIC SKETCH', 'ZETA-06', 5178,
   '{"lat": "48.8625 N", "lng": "2.3329 E"}'::jsonb,
   'A biometric scanner wants a sketch of the guard captain, drawn without using your hands. Unconventional, but it stays clear of the cameras watching for motion.',
   '',
   100, 300, 3, false),

  -- The finale. Every crew ends here, so it is not part of any path.
  ('CLASSROOM_1101', 'final', null, 'NEURAL BYPASS', 'EPSILON-05', 5177,
   '{"lat": "48.8621 N", "lng": "2.3338 E"}'::jsonb,
   'Last stand. The museum neural authentication system must be bypassed before extraction. Your cryptographer has isolated the vulnerable weights layer - backtrack through it and submit the injection signature.',
   '',
   160, 120, 3, false)
on conflict (code) do update set
  kind          = excluded.kind,
  ordinal       = excluded.ordinal,
  label         = excluded.label,
  terminal_id   = excluded.terminal_id,
  frontend_port = excluded.frontend_port,
  coordinates   = excluded.coordinates,
  briefing      = excluded.briefing,
  hint          = excluded.hint,
  points        = excluded.points,
  timer_seconds = excluded.timer_seconds,
  max_attempts  = excluded.max_attempts,
  ml_graded     = excluded.ml_graded;

-- -----------------------------------------------------------------------------
-- Riddles :: one active placeholder per playable room, finale included.
-- answer_normalised must already be lowercase / single-spaced, because
-- submit_answer() compares it against normalise_answer(submission).
-- -----------------------------------------------------------------------------
with seed(room_code, prompt, answer, alternates, clue) as (
  values
    ('YOGA_ROOM',
     'PLACEHOLDER RIDDLE - LASER GRID: I have no body, yet I bend around every obstacle in this hall. Cut me and the alarm sleeps. What am I?',
     'light', array['beam','laser']::text[],
     'CLUE: The Mona Lisa hangs 47 paces north. The third panel from the left conceals the keycard.'),

    ('CTLC_LAB',
     'PLACEHOLDER RIDDLE - SILENT RELAY: Your inside contact just signed a phrase on the silent channel. The room already grades this for you the moment you sign it correctly - nothing to type here.',
     'frogs love rain', array[]::text[],
     'CLUE: Access Level 4 requires a vocal signature. The audio file has been uploaded to terminal H2-LOUNGE.'),

    ('MUSIC_ROOM',
     'PLACEHOLDER RIDDLE - VOICE INTERCEPT: The voice on the frequency never draws breath between sentences. Human guard, or AI decoy?',
     'ai', array['ai decoy','decoy','artificial intelligence']::text[],
     'CLUE: The decoy runs on NODE-7. Disable it from the server room panel - code 4471.'),

    ('H2_LOUNGE',
     'PLACEHOLDER RIDDLE - MEMORY FORGERY: The artefact was cast from a metal that greens with age and rings when struck. Name it.',
     'bronze', array['brass']::text[],
     'CLUE: The forger workshop is in Sub-Level B, behind the restoration studio. Passcode: VENUS.'),

    ('CLASSROOM_1101',
     'PLACEHOLDER RIDDLE - NEURAL BYPASS: Four weights unlock the layer. Your cryptographer left them in descending order of confidence: 0.89, 0.73, 0.44, 0.12. Submit them in layer order instead.',
     '0.73,0.12,0.89,0.44', array['0.73, 0.12, 0.89, 0.44']::text[],
     'CLUE: Authentication bypass confirmed. Emergency exit C is unlocked for 120 seconds.'),

    ('NOSE_DRAW',
     'PLACEHOLDER RIDDLE - BIOMETRIC SKETCH: Your hands are watched, so you drew with the one feature that leads every face. What did you draw with?',
     'nose', array[]::text[],
     'CLUE: Biometric match confirmed. Vault access granted. The extraction window opens in 3 minutes.')
)
insert into public.riddles (room_id, prompt, answer_normalised, answer_alternates, success_clue, is_active)
select r.id, s.prompt, public.normalise_answer(s.answer), s.alternates, s.clue, true
  from seed s
  join public.rooms r on r.code = s.room_code
on conflict (room_id) where is_active do update set
  prompt            = excluded.prompt,
  answer_normalised = excluded.answer_normalised,
  answer_alternates = excluded.answer_alternates,
  success_clue      = excluded.success_clue,
  updated_at        = now();

-- -----------------------------------------------------------------------------
-- Teams :: 10 crews, one per path.
--
-- Codes are deliberately plain - a crew types its code at every terminal, so
-- TEAM1 beats a themed name under time pressure. Emails are derived from the
-- code (TEAM1 -> team1@<TEAM_EMAIL_DOMAIN>), which is how a login maps to a crew.
--
-- Passwords are NOT here. This repo is public, so credentials are generated at
-- provision time by `node scripts/operator.mjs provision`, which writes them to
-- a gitignored file for printing. enrollment_code is only used if you ever want
-- crews to choose their own passcode at the hub instead.
-- -----------------------------------------------------------------------------
insert into public.teams (code, name, enrollment_code)
values
  ('TEAM1',  'Team 1',  'LVR-T01-4417'),
  ('TEAM2',  'Team 2',  'LVR-T02-8823'),
  ('TEAM3',  'Team 3',  'LVR-T03-1902'),
  ('TEAM4',  'Team 4',  'LVR-T04-7365'),
  ('TEAM5',  'Team 5',  'LVR-T05-5514'),
  ('TEAM6',  'Team 6',  'LVR-T06-2278'),
  ('TEAM7',  'Team 7',  'LVR-T07-9046'),
  ('TEAM8',  'Team 8',  'LVR-T08-3391'),
  ('TEAM9',  'Team 9',  'LVR-T09-6127'),
  ('TEAM10', 'Team 10', 'LVR-T10-4680'),
  ('TEAM11', 'Team 11', 'LVR-T11-2059'),
  ('TEAM12', 'Team 12', 'LVR-T12-7731'),
  ('TEAM13', 'Team 13', 'LVR-T13-4406'),
  ('TEAM14', 'Team 14', 'LVR-T14-9188'),
  ('TEAM15', 'Team 15', 'LVR-T15-3572'),
  ('TEAM16', 'Team 16', 'LVR-T16-6640'),
  ('TEAM17', 'Team 17', 'LVR-T17-1295'),
  ('TEAM18', 'Team 18', 'LVR-T18-8817'),
  ('TEAM19', 'Team 19', 'LVR-T19-5063'),
  ('TEAM20', 'Team 20', 'LVR-T20-2984'),
  ('TEAM21', 'Team 21', 'LVR-T21-7426')
on conflict (code) do update set
  name            = excluded.name,
  enrollment_code = excluded.enrollment_code;

-- -----------------------------------------------------------------------------
-- ALPHA :: a standing admin/test crew, alongside the 21 event slots.
--
-- Holds PATH-22, its own route. It used to double up on TEAM1's PATH-01, which
-- scored fine (progress is per team_id) but walked the two crews through the
-- rooms in lockstep - the congestion the paths exist to prevent. Pinned here
-- explicitly so it stays out of the TEAM1..21 assignment query below.
-- -----------------------------------------------------------------------------
insert into public.teams (code, name, enrollment_code)
values ('ALPHA', 'Alpha (admin test)', 'LVR-ALPHA-TEST')
on conflict (code) do update set
  name            = excluded.name,
  enrollment_code = excluded.enrollment_code;

update public.teams
   set path_id = (select id from public.paths where code = 'PATH-22')
 where code = 'ALPHA' and path_id is null;

-- -----------------------------------------------------------------------------
-- Path assignment :: one crew per path, deterministic so route cards can be
-- printed before the event. Every route ends with the finale, which is appended
-- by team_route() rather than stored.
--
-- Crews needing a path are matched against the paths NOBODY HOLDS YET, in order.
-- Both halves of that matter:
--
--   - Only unassigned crews are ranked, so a crew pinned earlier in this file
--     (ALPHA, on PATH-22) does not consume a slot and shift everyone down.
--   - The target is the free paths rather than PATH-01, PATH-02, ... by rank.
--     Ranking straight onto path numbers is only correct when every crew is
--     unassigned: run the seed again after adding crews and the new batch
--     restarts at PATH-01 and doubles up on crews that already hold it, which
--     is what put TEAM11..TEAM20 on PATH-01..10 alongside TEAM1..TEAM10.
--
-- Idempotent: a crew that already holds a path keeps it, and re-running assigns
-- nothing because no crew is left unassigned.
-- -----------------------------------------------------------------------------
with free_paths as (
  select p.id,
         row_number() over (order by p.code) as slot
    from public.paths p
   where not exists (
     select 1 from public.teams t where t.path_id = p.id
   )
),
ranked as (
  select t.id,
         -- length first, so TEAM10 sorts after TEAM9 instead of after TEAM1
         row_number() over (order by length(t.code), t.code) as slot
    from public.teams t
   where t.path_id is null
)
update public.teams t
   set path_id = f.id
  from ranked r
  join free_paths f on f.slot = r.slot
 where t.id = r.id
   and t.path_id is null;

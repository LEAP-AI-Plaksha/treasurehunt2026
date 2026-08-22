#!/usr/bin/env node
// =============================================================================
// Louvre Heist operator CLI
// =============================================================================
// Drives the Supabase backend from a terminal: enrol crews, watch the field,
// flip rehearsal mode, and walk a crew's entire route end to end.
//
// Configuration is read from the environment, falling back to
// supabase/functions/.env for the operator key:
//
//   SUPABASE_URL        e.g. http://127.0.0.1:54421  (or your project URL)
//   SUPABASE_ANON_KEY   the anon/publishable key
//   OPERATOR_KEY        the shared operator secret
//   TEAM_EMAIL_DOMAIN   default louvre.local
//
// Usage:
//   node scripts/operator.mjs help
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

function loadDotEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

const fileEnv = loadDotEnv(join(REPO, 'supabase', 'functions', '.env'))
const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://127.0.0.1:54421').replace(/\/$/, '')
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''
const OPERATOR_KEY = process.env.OPERATOR_KEY || fileEnv.OPERATOR_KEY || ''
const EMAIL_DOMAIN = process.env.TEAM_EMAIL_DOMAIN || fileEnv.TEAM_EMAIL_DOMAIN || 'louvre.local'

if (!ANON_KEY) {
  console.error('SUPABASE_ANON_KEY is not set. Get it from `supabase status` or your dashboard.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function operator(action, extra = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/operator`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ANON_KEY}`,
      'x-operator-key': OPERATOR_KEY,
    },
    body: JSON.stringify({ action, ...extra }),
  })
  return res.json()
}

async function enroll(teamCode, enrollmentCode, passcode) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/enroll-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ teamCode, enrollmentCode, passcode }),
  })
  return res.json()
}

async function signIn(teamCode, passcode) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({
      email: `${teamCode.toLowerCase()}@${EMAIL_DOMAIN}`,
      password: passcode,
    }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`Sign in failed for ${teamCode}: ${body.msg ?? body.error_description ?? 'unknown'}`)
  return body.access_token
}

/** Call an RPC as a crew, the way a kiosk does. */
async function rpc(name, body, jwt) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ---------------------------------------------------------------------------
// Credential generation
// ---------------------------------------------------------------------------
// Passwords a crew has to type on a kiosk under time pressure, so: lowercase,
// no ambiguous characters, one word plus three digits. Short enough to read off
// a slip, long enough that crews cannot guess each other's and tamper with a
// rival's score.
const PASSWORD_WORDS = [
  'vault', 'louvre', 'heist', 'mosaic', 'atrium', 'cipher', 'relay', 'canvas',
  'gallery', 'lantern', 'marble', 'archive', 'gilded', 'fresco', 'pigment',
  'curator', 'obelisk', 'rotunda', 'palette', 'bronze',
]

function generatePasscode() {
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  const word = PASSWORD_WORDS[bytes[0] % PASSWORD_WORDS.length]
  const digits = String(((bytes[1] << 8) | bytes[2]) % 900 + 100) // always 3 digits
  return `${word}${digits}`
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))

function table(rows, columns) {
  if (!rows?.length) return console.log('(no rows)')
  const cols = columns ?? Object.keys(rows[0])
  const width = (c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length))
  const w = Object.fromEntries(cols.map((c) => [c, width(c)]))
  console.log(cols.map((c) => c.padEnd(w[c])).join('  '))
  console.log(cols.map((c) => '-'.repeat(w[c])).join('  '))
  for (const r of rows) console.log(cols.map((c) => String(r[c] ?? '').padEnd(w[c])).join('  '))
}

// ---------------------------------------------------------------------------
// walk :: drive a crew's whole route, hub to hub
// ---------------------------------------------------------------------------
// This is the end-to-end rehearsal. With rehearsal mode on (`skip on`) it needs
// no answers at all; with it off, pass the real answers via --answers.
async function walk(teamCode, passcode) {
  console.log(`\n=== walking ${teamCode} ===`)
  const jwt = await signIn(teamCode, passcode)

  const start = await rpc('hub_check_in', {}, jwt)
  if (!start?.success) return console.error('  hub check-in failed:', start?.error)
  const route = start.path.steps
  console.log(`  path ${start.path.code}: ${route.map((s) => s.roomCode).join(' > ')}`)
  console.log(`  left origin at ${start.team.startedAt}`)

  for (const step of route) {
    const arrive = await rpc('check_in_room', { p_room_code: step.roomCode }, jwt)
    if (!arrive?.success) {
      console.error(`  step ${step.stepIndex} ${step.roomCode}: check-in FAILED - ${arrive?.error}`)
      continue
    }
    const answer = await rpc(
      'submit_answer',
      { p_room_code: step.roomCode, p_submission: 'rehearsal' },
      jwt,
    )
    const mark = answer?.correct ? 'OK  ' : 'FAIL'
    console.log(
      `  step ${step.stepIndex} ${mark} ${step.roomCode.padEnd(15)}` +
        ` ${answer?.durationSeconds ?? '-'}s  ${answer?.pointsAwarded ?? 0}pts` +
        (answer?.skipped ? '  (skipped)' : '') +
        (answer?.error ? `  ${answer.error}` : ''),
    )
  }

  const end = await rpc('hub_check_out', {}, jwt)
  if (!end?.success) return console.error('  hub check-out failed:', end?.error)
  console.log(`  back at origin at ${end.team.finishedAt}`)
  console.log(`  totals:`, end.totals)
  return end.totals
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2)

const commands = {
  async help() {
    console.log(`
Louvre Heist operator CLI            target: ${SUPABASE_URL}

  Setup
    provision                                create ALL crew logins, print slips
    provision <SHARED_PASSWORD>              same password for everyone (rehearsal)
    passcode <TEAM> <NEW_PASSCODE>           reset one crew's password
    enrollment                               who has a login, and their route
    enroll <TEAM> <ENROLL_CODE> <PASSCODE>   crew picks its own passcode instead

  Running the event
    start <TEAM> <PASSWORD>                  hub check-in (required before any room)
    start-all <PASSWORD>                     hub check-in for every crew

  Rehearsal
    skip on|off                              accept ANY answer in ANY room
    order on|off                             enforce route order, or allow any
    scoring open|closed                      freeze answer submission
    walk <TEAM> <PASSCODE>                   drive one crew hub-to-hub
    walk-all <PASSCODE>                      drive every enrolled crew
    force <TEAM> <ROOM>                      mark one room done for one crew

  Watching
    leaderboard                              ranked standings
    times [TEAM]                             completion + time per room
    occupancy                                live load per room
    balance                                  crews arriving per room per step
    skipped                                  rooms skipped or force-completed
    reset <TEAM>                             wipe a crew's run
`)
  },

  async enroll() {
    const [team, code, pass] = args
    if (!team || !code || !pass) return console.error('usage: enroll <TEAM> <ENROLL_CODE> <PASSCODE>')
    out(await enroll(team, code, pass))
  },

  /**
   * Create every crew's login up front with a known password, so slips can be
   * printed and handed out. Re-running resets passwords rather than failing.
   *
   *   provision                 generate a password for every seeded crew
   *   provision <pass>          give every crew the SAME password (rehearsals only)
   */
  async provision() {
    const shared = args[0]
    if (shared && shared.length < 6) {
      return console.error('A shared password must be at least 6 characters')
    }

    const status = await operator('enrollment')
    if (!status.success) return out(status)

    const crews = [...status.teams].sort(
      (a, b) => a.team_code.length - b.team_code.length || a.team_code.localeCompare(b.team_code),
    )
    if (!crews.length) return console.error('No crews in the database. Run the seed first.')

    const payload = crews.map((t) => ({
      teamCode: t.team_code,
      name: t.team_name,
      passcode: shared || generatePasscode(),
    }))

    const res = await operator('provisionTeams', { teams: payload })
    if (!res.success && !res.provisioned) return out(res)

    const passcodeFor = new Map(payload.map((p) => [p.teamCode, p.passcode]))
    const rows = res.provisioned.map((r) => ({
      team: r.teamCode,
      password: r.success ? passcodeFor.get(r.teamCode) : '-',
      path: r.pathCode ?? '-',
      route: (r.route ?? []).join(' > '),
      status: r.success ? 'ok' : r.error,
    }))

    console.log('\n=== CREDENTIALS - hand these out ===\n')
    table(rows, ['team', 'password', 'path', 'route', 'status'])

    // Written to disk because a terminal scrollback is a bad place to keep the
    // only copy. Gitignored: this file is the one real secret in the project.
    const file = join(REPO, 'team-credentials.txt')
    // The project URL belongs in the file. A passcode only exists on the
    // Supabase it was written against, and an unlabelled sheet generated
    // against a local stack looks identical to one for the hosted project -
    // it just fails at the terminal with "Invalid team code or passcode",
    // which sends you hunting the wrong problem.
    const header =
      `TREASURE by LEAP - A Louvre Heist\nTeam credentials\n\n` +
      `PROJECT: ${SUPABASE_URL}\n` +
      `These passwords exist ONLY on that project. A sheet generated against a\n` +
      `different Supabase - a local stack, say - is rejected here.\n\n` +
      `Crews type their TEAM CODE and PASSWORD at every ROOM terminal. There is\n` +
      `no sign-in at the hub - hand out the code, the passcode and the first\n` +
      `riddle there by hand. The clock starts at their first room.\n` +
      `Route is the order of rooms for that crew; the last room is the same for everyone.\n\n`
    writeFileSync(
      file,
      header +
        rows
          .map(
            (r) =>
              `${r.team.padEnd(8)} password: ${String(r.password).padEnd(12)} ` +
              `path: ${r.path}\n         route: ${r.route}\n`,
          )
          .join('\n'),
      'utf8',
    )
    console.log(`\nWritten to ${file} (gitignored)`)

    const failed = rows.filter((r) => r.status !== 'ok')
    if (failed.length) console.error(`\n${failed.length} crew(s) failed - see the status column`)
  },

  /**
   * Hub check-in from the terminal, for testing without opening the hub kiosk.
   * A crew cannot enter any room until this has happened - that is the rule that
   * makes the run start at the origin.
   *
   *   start <TEAM> <PASSWORD>     one crew
   *   start-all <PASSWORD>        every crew (shared password)
   */
  async start() {
    const [team, pass] = args
    if (!team || !pass) return console.error('usage: start <TEAM> <PASSWORD>')
    const jwt = await signIn(team, pass)
    const res = await rpc('hub_check_in', {}, jwt)
    if (!res?.success) return console.error(`${team}: ${res?.error}`)
    const next = res.path.steps.find((s) => s.status !== 'completed' && s.status !== 'locked_out')
    console.log(`${team}: checked in, path ${res.path.code}, due at ${next?.roomCode ?? '(done)'}`)
  },

  async 'start-all'() {
    const pass = args[0]
    if (!pass) return console.error('usage: start-all <PASSWORD>   (all crews must share this password)')
    const r = await operator('enrollment')
    if (!r.success) return out(r)
    const crews = [...r.teams]
      .filter((t) => t.has_login)
      .sort((a, b) => a.team_code.length - b.team_code.length || a.team_code.localeCompare(b.team_code))
    for (const t of crews) {
      try {
        const jwt = await signIn(t.team_code, pass)
        const res = await rpc('hub_check_in', {}, jwt)
        const next = res?.success
          ? res.path.steps.find((s) => s.status !== 'completed' && s.status !== 'locked_out')
          : null
        console.log(
          res?.success
            ? `${t.team_code.padEnd(8)} checked in -> due at ${next?.roomCode ?? '(done)'}`
            : `${t.team_code.padEnd(8)} FAILED: ${res?.error}`,
        )
      } catch (err) {
        console.log(`${t.team_code.padEnd(8)} FAILED: ${err.message}`)
      }
    }
  },

  async passcode() {
    const [team, pass] = args
    if (!team || !pass) return console.error('usage: passcode <TEAM> <NEW_PASSCODE>')
    out(await operator('resetPasscode', { teamCode: team, passcode: pass }))
  },

  async skip() {
    const on = args[0] === 'on'
    if (!['on', 'off'].includes(args[0])) return console.error('usage: skip on|off')
    out(await operator('setSkipRiddles', { skip: on }))
  },

  async order() {
    if (!['on', 'off'].includes(args[0])) return console.error('usage: order on|off')
    out(await operator('setPathOrder', { enforce: args[0] === 'on' }))
  },

  async scoring() {
    if (!['open', 'closed'].includes(args[0])) return console.error('usage: scoring open|closed')
    out(await operator('setScoring', { open: args[0] === 'open' }))
  },

  async force() {
    const [team, room] = args
    if (!team || !room) return console.error('usage: force <TEAM> <ROOM>')
    out(await operator('forceComplete', { teamCode: team, roomCode: room }))
  },

  async reset() {
    if (!args[0]) return console.error('usage: reset <TEAM>')
    out(await operator('resetTeam', { teamCode: args[0] }))
  },

  async leaderboard() {
    const r = await operator('leaderboard')
    if (!r.success) return out(r)
    table(r.leaderboard, ['position', 'team_code', 'path_code',
                          'rooms_completed', 'rooms_failed', 'elapsed_seconds', 'total_room_seconds'])
  },

  async times() {
    const r = await operator('teamTimes', { teamCode: args[0] })
    if (!r.success) return out(r)
    table(r.rows, ['team_code', 'step_index', 'room_code', 'status',
                   'duration_seconds', 'attempts', 'points_awarded'])
  },

  async occupancy() {
    const r = await operator('occupancy')
    if (!r.success) return out(r)
    table(r.rooms)
  },

  async enrollment() {
    const r = await operator('enrollment')
    if (!r.success) return out(r)
    table(r.teams.map((t) => ({ ...t, route: (t.route ?? []).join(' > ') })),
          ['team_code', 'has_login', 'path_code', 'route', 'started_at', 'finished_at'])
  },

  async balance() {
    const r = await operator('pathBalance')
    if (!r.success) return out(r)
    // pivot into a room x step grid, which is how the spread is meant to be read
    const rooms = [...new Set(r.cells.map((c) => c.room_code))].sort()
    const grid = rooms.map((room) => {
      const row = { room }
      let total = 0
      for (let step = 1; step <= 6; step++) {
        const cell = r.cells.find((c) => c.room_code === room && c.step_index === step)
        row[`s${step}`] = cell?.teams_arriving ?? 0
        total += cell?.teams_arriving ?? 0
      }
      row.total = total
      return row
    })
    table(grid)
  },

  async skipped() {
    const r = await operator('skipped')
    if (!r.success) return out(r)
    table(r.skipped, ['team_code', 'room_code', 'submission', 'created_at'])
  },

  async walk() {
    const [team, pass] = args
    if (!team || !pass) return console.error('usage: walk <TEAM> <PASSCODE>')
    await walk(team, pass)
  },

  async 'walk-all'() {
    const pass = args[0]
    if (!pass) return console.error('usage: walk-all <PASSCODE>   (all crews must share this passcode)')
    const r = await operator('enrollment')
    if (!r.success) return out(r)
    const enrolled = r.teams.filter((t) => t.has_login)
    console.log(`walking ${enrolled.length} enrolled crews`)
    for (const t of enrolled) {
      try {
        await walk(t.team_code, pass)
      } catch (err) {
        console.error(`  ${t.team_code}: ${err.message}`)
      }
    }
  },
}

const handler = commands[cmd ?? 'help'] ?? commands.help
await handler()

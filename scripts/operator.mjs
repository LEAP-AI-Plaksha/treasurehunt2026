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

import { readFileSync } from 'node:fs'
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
    enroll <TEAM> <ENROLL_CODE> <PASSCODE>   claim a crew's login
    passcode <TEAM> <NEW_PASSCODE>           reset a lost passcode
    enrollment                               who has enrolled, and their route

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
    table(r.leaderboard, ['position', 'team_code', 'path_code', 'rooms_completed',
                          'total_points', 'total_room_seconds', 'elapsed_seconds'])
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

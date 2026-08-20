// =============================================================================
// operator
// =============================================================================
// The single privileged endpoint, for the hub terminal the organisers hold.
// Gated by the OPERATOR_KEY secret, which the hub app sends in the
// x-operator-key header. Nothing here is reachable from a room kiosk.
//
// Actions:
//   leaderboard    - ranked standings
//   teamTimes      - per team, per room completion + duration (the scoring export)
//   occupancy      - who is standing in which room right now
//   enrollment     - which crews have claimed a login, and their routes
//   pathBalance    - teams arriving per room per step, to verify path spread
//   resetPasscode  - set a new passcode for a crew that lost theirs
//   resetTeam      - wipe a crew's visits and timestamps for a clean re-run
//   setScoring     - freeze or reopen answer submission event-wide
//   setPathOrder   - require crews to follow their route, or allow any order
//   setSkipRiddles - REHEARSAL: accept any answer in any room, to walk the flow
//   forceComplete  - mark one room done for one crew
//   skipped        - list every room that was skipped or force-completed
//   provisionTeams - create every crew's login up front with a known password,
//                    so credentials can be printed and handed out
// =============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/cors.ts'

interface OperatorBody {
  action?: string
  teamCode?: string
  roomCode?: string
  passcode?: string
  open?: boolean
  enforce?: boolean
  skip?: boolean
  teams?: { teamCode?: string; name?: string; passcode?: string }[]
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  const origin = req.headers.get('Origin')
  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405, origin)
  }

  const operatorKey = Deno.env.get('OPERATOR_KEY')
  if (!operatorKey) {
    return json({ success: false, error: 'OPERATOR_KEY is not configured' }, 500, origin)
  }
  if (req.headers.get('x-operator-key') !== operatorKey) {
    return json({ success: false, error: 'Not authorised' }, 401, origin)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  let body: OperatorBody
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Malformed JSON body' }, 400, origin)
  }

  const teamCode = (body.teamCode ?? '').trim().toUpperCase()

  switch (body.action) {
    // -------------------------------------------------------------------------
    // Read-only reporting
    // -------------------------------------------------------------------------
    case 'leaderboard': {
      const { data, error } = await admin.from('leaderboard').select('*').order('position')
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, leaderboard: data }, 200, origin)
    }

    case 'teamTimes': {
      let query = admin
        .from('team_room_times')
        .select('*')
        .order('team_code')
        .order('step_index')
      if (teamCode) query = query.eq('team_code', teamCode)
      const { data, error } = await query
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, rows: data }, 200, origin)
    }

    case 'occupancy': {
      const { data, error } = await admin.from('room_occupancy').select('*')
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, rooms: data }, 200, origin)
    }

    case 'enrollment': {
      const { data, error } = await admin.from('enrollment_status').select('*')
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, teams: data }, 200, origin)
    }

    case 'pathBalance': {
      const { data, error } = await admin
        .from('path_balance')
        .select('*')
        .order('step_index')
        .order('room_code')
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, cells: data }, 200, origin)
    }

    // -------------------------------------------------------------------------
    // Recovery actions
    // -------------------------------------------------------------------------
    case 'resetPasscode': {
      if (!teamCode || !body.passcode) {
        return json({ success: false, error: 'teamCode and passcode are required' }, 400, origin)
      }
      if (body.passcode.length < 6) {
        return json({ success: false, error: 'Passcode must be at least 6 characters' }, 400, origin)
      }

      const { data: team, error: teamErr } = await admin
        .from('teams')
        .select('auth_user_id')
        .eq('code', teamCode)
        .maybeSingle()

      if (teamErr) return json({ success: false, error: teamErr.message }, 500, origin)
      if (!team?.auth_user_id) {
        return json(
          { success: false, error: 'That crew has not enrolled yet - use enroll-team' },
          404,
          origin,
        )
      }

      const { error } = await admin.auth.admin.updateUserById(team.auth_user_id, {
        password: body.passcode,
      })
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, teamCode }, 200, origin)
    }

    case 'resetTeam': {
      if (!teamCode) return json({ success: false, error: 'teamCode is required' }, 400, origin)

      const { data: team, error: teamErr } = await admin
        .from('teams')
        .select('id')
        .eq('code', teamCode)
        .maybeSingle()

      if (teamErr) return json({ success: false, error: teamErr.message }, 500, origin)
      if (!team) return json({ success: false, error: 'Unknown team code' }, 404, origin)

      // answer_attempts cascade from room_visits, so deleting visits clears both.
      const { error: delErr } = await admin.from('room_visits').delete().eq('team_id', team.id)
      if (delErr) return json({ success: false, error: delErr.message }, 500, origin)

      const { error: clearErr } = await admin
        .from('teams')
        .update({ started_at: null, finished_at: null })
        .eq('id', team.id)
      return clearErr
        ? json({ success: false, error: clearErr.message }, 500, origin)
        : json({ success: true, teamCode, reset: true }, 200, origin)
    }

    // -------------------------------------------------------------------------
    // Event switches
    // -------------------------------------------------------------------------
    case 'setScoring': {
      if (typeof body.open !== 'boolean') {
        return json({ success: false, error: 'open must be true or false' }, 400, origin)
      }
      const { error } = await admin
        .from('event_settings')
        .update({ scoring_open: body.open, updated_at: new Date().toISOString() })
        .eq('id', true)
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, scoringOpen: body.open }, 200, origin)
    }

    case 'setPathOrder': {
      if (typeof body.enforce !== 'boolean') {
        return json({ success: false, error: 'enforce must be true or false' }, 400, origin)
      }
      const { error } = await admin
        .from('event_settings')
        .update({ enforce_path_order: body.enforce, updated_at: new Date().toISOString() })
        .eq('id', true)
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, enforcePathOrder: body.enforce }, 200, origin)
    }

    case 'setSkipRiddles': {
      if (typeof body.skip !== 'boolean') {
        return json({ success: false, error: 'skip must be true or false' }, 400, origin)
      }
      const { error } = await admin
        .from('event_settings')
        .update({ skip_riddles: body.skip, updated_at: new Date().toISOString() })
        .eq('id', true)
      if (error) return json({ success: false, error: error.message }, 500, origin)
      return json(
        {
          success: true,
          skipRiddles: body.skip,
          warning: body.skip
            ? 'Rehearsal mode ON: every room accepts any answer. Turn this off before the event.'
            : 'Rehearsal mode OFF: real answers required.',
        },
        200,
        origin,
      )
    }

    case 'forceComplete': {
      if (!teamCode || !body.roomCode) {
        return json({ success: false, error: 'teamCode and roomCode are required' }, 400, origin)
      }
      const { data, error } = await admin.rpc('admin_force_complete', {
        p_team_code: teamCode,
        p_room_code: body.roomCode,
      })
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json(data, 200, origin)
    }

    case 'skipped': {
      const { data, error } = await admin.from('skipped_rooms').select('*')
      return error
        ? json({ success: false, error: error.message }, 500, origin)
        : json({ success: true, skipped: data }, 200, origin)
    }

    // -------------------------------------------------------------------------
    // Bulk provisioning
    // -------------------------------------------------------------------------
    case 'provisionTeams': {
      // Creates or updates each crew's login with a password you already know,
      // so slips can be printed and handed out instead of crews choosing a
      // passcode at the hub. Idempotent: re-running resets the password rather
      // than failing, which is what you want if a sheet gets lost.
      if (!Array.isArray(body.teams) || body.teams.length === 0) {
        return json({ success: false, error: 'teams must be a non-empty array' }, 400, origin)
      }

      const emailDomain = Deno.env.get('TEAM_EMAIL_DOMAIN') ?? 'louvre.local'
      const results: unknown[] = []

      // One lookup up front: the admin API cannot filter users by email, and
      // doing it per crew would be a request each.
      const { data: userPage } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const byEmail = new Map(
        (userPage?.users ?? []).map((u) => [(u.email ?? '').toLowerCase(), u.id]),
      )

      for (const entry of body.teams) {
        const code = (entry.teamCode ?? '').trim().toUpperCase()
        const passcode = entry.passcode ?? ''

        if (!code || passcode.length < 6) {
          results.push({ teamCode: code, success: false, error: 'Passcode must be at least 6 characters' })
          continue
        }

        const email = `${code.toLowerCase()}@${emailDomain}`

        // The crew row must already exist (it comes from the seed), so that
        // provisioning cannot silently invent a team that has no path.
        const { data: team, error: teamErr } = await admin
          .from('teams')
          .select('id, code, name, path_id, auth_user_id')
          .eq('code', code)
          .maybeSingle()

        if (teamErr || !team) {
          results.push({ teamCode: code, success: false, error: teamErr?.message ?? 'Unknown team code' })
          continue
        }

        // Assign the least-loaded path if the seed did not pre-assign one.
        let pathId = team.path_id as string | null
        if (!pathId) {
          const { data: paths } = await admin.from('paths').select('id, code, teams(count)').order('code')
          const load = (p: { teams?: { count: number }[] }) => p.teams?.[0]?.count ?? 0
          pathId = paths?.length ? [...paths].sort((a, b) => load(a) - load(b))[0].id : null
        }

        const existingId = (team.auth_user_id as string | null) ?? byEmail.get(email) ?? null
        let userId = existingId

        if (existingId) {
          const { error } = await admin.auth.admin.updateUserById(existingId, { password: passcode })
          if (error) {
            results.push({ teamCode: code, success: false, error: error.message })
            continue
          }
        } else {
          const { data: created, error } = await admin.auth.admin.createUser({
            email,
            password: passcode,
            email_confirm: true,
            user_metadata: { team_code: code, team_name: entry.name ?? team.name },
          })
          if (error || !created?.user) {
            results.push({ teamCode: code, success: false, error: error?.message ?? 'Could not create login' })
            continue
          }
          userId = created.user.id
        }

        const { error: linkErr } = await admin
          .from('teams')
          .update({
            auth_user_id: userId,
            path_id: pathId,
            enrolled_at: new Date().toISOString(),
            ...(entry.name ? { name: entry.name } : {}),
          })
          .eq('id', team.id)

        if (linkErr) {
          results.push({ teamCode: code, success: false, error: linkErr.message })
          continue
        }

        const { data: status } = await admin
          .from('enrollment_status')
          .select('path_code, route')
          .eq('team_code', code)
          .maybeSingle()

        results.push({
          teamCode: code,
          name: entry.name ?? team.name,
          email,
          success: true,
          pathCode: status?.path_code ?? null,
          route: status?.route ?? [],
        })
      }

      return json(
        {
          success: results.every((r) => (r as { success: boolean }).success),
          provisioned: results,
        },
        200,
        origin,
      )
    }

    default:
      return json({ success: false, error: `Unknown action: ${body.action}` }, 400, origin)
  }
})

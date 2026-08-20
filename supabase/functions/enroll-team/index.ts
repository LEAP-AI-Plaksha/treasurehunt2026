// =============================================================================
// enroll-team
// =============================================================================
// Runs at the hub terminal, once per crew, at the start of the event:
//
//   crew types team code + printed enrollment code + a passcode of their choosing
//     -> this function verifies the enrollment code
//     -> creates the Supabase Auth user  <team>@<TEAM_EMAIL_DOMAIN>
//     -> links it to the team row and assigns a path if one is not set
//     -> returns the crew's route so the operator can hand it over
//
// The service role key lives here, in the function, never in a kiosk bundle.
// A crew can only be claimed once; a lost passcode is reset by the operator
// function, not by re-running this.
// =============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/cors.ts'

const MIN_PASSCODE_LENGTH = 6

interface EnrollBody {
  teamCode?: string
  enrollmentCode?: string
  passcode?: string
}

Deno.serve(async (req) => {
  const pre = preflight(req)
  if (pre) return pre

  const origin = req.headers.get('Origin')
  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405, origin)
  }

  const emailDomain = Deno.env.get('TEAM_EMAIL_DOMAIN') ?? 'louvre.local'
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  let body: EnrollBody
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Malformed JSON body' }, 400, origin)
  }

  const teamCode = (body.teamCode ?? '').trim().toUpperCase()
  const enrollmentCode = (body.enrollmentCode ?? '').trim()
  const passcode = body.passcode ?? ''

  if (!teamCode || !enrollmentCode || !passcode) {
    return json(
      { success: false, error: 'teamCode, enrollmentCode and passcode are all required' },
      400,
      origin,
    )
  }
  if (passcode.length < MIN_PASSCODE_LENGTH) {
    return json(
      { success: false, error: `Passcode must be at least ${MIN_PASSCODE_LENGTH} characters` },
      400,
      origin,
    )
  }

  // ---------------------------------------------------------------------------
  // Verify the crew and its printed enrollment code
  // ---------------------------------------------------------------------------
  const { data: team, error: teamErr } = await admin
    .from('teams')
    .select('id, code, name, enrollment_code, auth_user_id, path_id')
    .eq('code', teamCode)
    .maybeSingle()

  if (teamErr) return json({ success: false, error: teamErr.message }, 500, origin)
  if (!team) return json({ success: false, error: 'Unknown team code' }, 404, origin)

  // Compared case-insensitively because these get read off a printed slip.
  if (team.enrollment_code.trim().toUpperCase() !== enrollmentCode.toUpperCase()) {
    return json({ success: false, error: 'Enrollment code does not match' }, 403, origin)
  }
  if (team.auth_user_id) {
    return json(
      {
        success: false,
        error: 'This crew has already set a passcode. Ask the operator for a reset.',
      },
      409,
      origin,
    )
  }

  // ---------------------------------------------------------------------------
  // Assign a path if the seed did not pre-assign one.
  // Least-loaded path wins, so adding an 11th crew doubles up the quietest route
  // rather than piling onto PATH-01.
  // ---------------------------------------------------------------------------
  let pathId = team.path_id as string | null
  if (!pathId) {
    const { data: paths, error: pathErr } = await admin
      .from('paths')
      .select('id, code, teams(count)')
      .order('code', { ascending: true })

    if (pathErr) return json({ success: false, error: pathErr.message }, 500, origin)
    if (!paths?.length) return json({ success: false, error: 'No paths defined' }, 500, origin)

    const load = (p: { teams?: { count: number }[] }) => p.teams?.[0]?.count ?? 0
    pathId = [...paths].sort((a, b) => load(a) - load(b))[0].id
  }

  // ---------------------------------------------------------------------------
  // Create the auth user. The email is synthetic and never receives mail; it
  // exists so that Supabase Auth can issue the crew a normal JWT.
  // ---------------------------------------------------------------------------
  const email = `${teamCode.toLowerCase()}@${emailDomain}`
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password: passcode,
    email_confirm: true,
    user_metadata: { team_code: teamCode, team_name: team.name },
  })

  if (authErr || !created?.user) {
    return json(
      { success: false, error: authErr?.message ?? 'Could not create the crew login' },
      500,
      origin,
    )
  }

  // ---------------------------------------------------------------------------
  // Link the login to the crew. If this fails the auth user would be orphaned,
  // so it gets deleted rather than left behind to block a retry.
  // ---------------------------------------------------------------------------
  const { error: linkErr } = await admin
    .from('teams')
    .update({
      auth_user_id: created.user.id,
      path_id: pathId,
      enrolled_at: new Date().toISOString(),
    })
    .eq('id', team.id)
    .is('auth_user_id', null)

  if (linkErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ success: false, error: linkErr.message }, 500, origin)
  }

  // ---------------------------------------------------------------------------
  // Hand back the route for the operator to read out / print
  // ---------------------------------------------------------------------------
  const { data: status } = await admin
    .from('enrollment_status')
    .select('team_code, team_name, path_code, route')
    .eq('team_code', teamCode)
    .maybeSingle()

  return json(
    {
      success: true,
      teamCode,
      teamName: team.name,
      email,
      pathCode: status?.path_code ?? null,
      route: status?.route ?? [],
    },
    200,
    origin,
  )
})

import { createClient } from '../Kiosk-Style Treasure Hunt UI/node_modules/@supabase/supabase-js/dist/index.mjs'

const SUPABASE_URL = 'https://lgntnkmzvcyezlherjvk.supabase.co'
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbnRua216dmN5ZXpsaGVyanZrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzIzODg2NCwiZXhwIjoyMTAyODE0ODY0fQ.aFJa-AgCZZeSxJLKPxgXHci--pzqXwl8YdLFiWdZ3Vk'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnbnRua216dmN5ZXpsaGVyanZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMzg4NjQsImV4cCI6MjEwMjgxNDg2NH0.TMn0cvU1Ctfyh-sEqF4db8BI41hctYsmJtfVlLAoeS4'
const EMAIL_DOMAIN = 'louvre.local'

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const client = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

const TEAMS_TO_UPDATE = [
  { code: 'ALPHA', password: 'heist775', pathCode: 'PATH-22' },
  { code: 'TEAM1', password: 'atelier480', pathCode: 'PATH-01' },
  { code: 'TEAM2', password: 'marble594', pathCode: 'PATH-02' },
  { code: 'TEAM3', password: 'palette874', pathCode: 'PATH-03' },
  { code: 'TEAM4', password: 'vault979', pathCode: 'PATH-04' },
  { code: 'TEAM5', password: 'atelier334', pathCode: 'PATH-05' },
  { code: 'TEAM6', password: 'gilded904', pathCode: 'PATH-06' },
  { code: 'TEAM7', password: 'vault469', pathCode: 'PATH-07' },
  { code: 'TEAM8', password: 'gilded230', pathCode: 'PATH-08' },
  { code: 'TEAM9', password: 'vault489', pathCode: 'PATH-09' },
  { code: 'TEAM10', password: 'atelier851', pathCode: 'PATH-10' },
  { code: 'TEAM11', password: 'atelier704', pathCode: 'PATH-11' },
  { code: 'TEAM12', password: 'mosaic402', pathCode: 'PATH-12' },
  { code: 'TEAM13', password: 'lantern457', pathCode: 'PATH-13' },
  { code: 'TEAM14', password: 'louvre955', pathCode: 'PATH-14' },
  { code: 'TEAM15', password: 'cipher750', pathCode: 'PATH-15' },
  { code: 'TEAM16', password: 'louvre663', pathCode: 'PATH-16' },
  { code: 'TEAM17', password: 'marble288', pathCode: 'PATH-17' },
  { code: 'TEAM18', password: 'marble214', pathCode: 'PATH-18' },
  { code: 'TEAM19', password: 'lantern621', pathCode: 'PATH-19' },
  { code: 'TEAM20', password: 'gilded994', pathCode: 'PATH-20' },
  { code: 'TEAM21', password: 'cipher426', pathCode: 'PATH-21' },
]

async function main() {
  console.log('Fetching all users from auth.admin...')
  const { data: userList, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) {
    console.error('Failed to list users:', listErr)
    process.exit(1)
  }

  const userMap = new Map()
  for (const u of userList.users) {
    if (u.email) userMap.set(u.email.toLowerCase(), u)
  }

  // Fetch all paths to map pathCode -> pathId
  const { data: paths, error: pathErr } = await admin.from('paths').select('id, code')
  if (pathErr) {
    console.error('Failed to fetch paths:', pathErr)
    process.exit(1)
  }
  const pathMap = new Map(paths.map(p => [p.code, p.id]))

  for (const item of TEAMS_TO_UPDATE) {
    const email = `${item.code.toLowerCase()}@${EMAIL_DOMAIN}`
    const existingUser = userMap.get(email)
    let userId

    if (existingUser) {
      console.log(`Updating password for existing user: ${item.code} (${email})...`)
      const { data: updated, error: updateErr } = await admin.auth.admin.updateUserById(existingUser.id, {
        password: item.password,
        email_confirm: true,
        user_metadata: { team_code: item.code }
      })
      if (updateErr) {
        console.error(`Error updating user ${item.code}:`, updateErr)
        continue
      }
      userId = updated.user.id
    } else {
      console.log(`Creating user: ${item.code} (${email})...`)
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: item.password,
        email_confirm: true,
        user_metadata: { team_code: item.code }
      })
      if (createErr) {
        console.error(`Error creating user ${item.code}:`, createErr)
        continue
      }
      userId = created.user.id
    }

    // Ensure team in public.teams has correct auth_user_id and path_id
    const targetPathId = pathMap.get(item.pathCode)
    const { error: teamUpdateErr } = await admin.from('teams').upsert({
      code: item.code,
      name: item.code === 'ALPHA' ? 'Alpha (admin test)' : `Team ${item.code.replace('TEAM', '')}`,
      enrollment_code: item.code === 'ALPHA' ? 'LVR-ALPHA-TEST' : `LVR-T${item.code.replace('TEAM', '').padStart(2, '0')}-0000`,
      auth_user_id: userId,
      path_id: targetPathId,
      enrolled_at: new Date().toISOString()
    }, { onConflict: 'code' })

    if (teamUpdateErr) {
      console.error(`Error upserting team table for ${item.code}:`, teamUpdateErr)
    }

    // Verify sign in
    const { data: authData, error: signInErr } = await client.auth.signInWithPassword({
      email,
      password: item.password
    })
    if (signInErr) {
      console.error(`❌ Verification sign-in failed for ${item.code}:`, signInErr.message)
    } else {
      console.log(`✅ ${item.code} verified successfully! (JWT user id: ${authData.user.id})`)
    }
  }

  console.log('\nAll team passwords updated and verified in Supabase!')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

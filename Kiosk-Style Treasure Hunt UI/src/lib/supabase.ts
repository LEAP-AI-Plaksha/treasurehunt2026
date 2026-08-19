// Supabase client for a room kiosk.
//
// Each room runs its own copy of this frontend on its own port/host, but they
// all talk to one Supabase project. The only key that ships here is the anon
// key: everything a crew can do is expressed as an RLS policy or a SECURITY
// DEFINER RPC, so a player who opens devtools on a kiosk still cannot read
// another crew's times or a riddle answer.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.',
  )
}

/** Synthetic login domain. Team ALPHA signs in as alpha@<domain>. */
export const TEAM_EMAIL_DOMAIN =
  (import.meta.env.VITE_TEAM_EMAIL_DOMAIN as string) || 'louvre.local'

/** A crew's team code is what they type; this turns it into their login. */
export function teamEmail(teamCode: string): string {
  return `${teamCode.trim().toLowerCase()}@${TEAM_EMAIL_DOMAIN}`
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // sessionStorage, not localStorage: a kiosk reload keeps the crew signed in,
    // but closing the tab between crews does not leave the last one logged in.
    storage: typeof window === 'undefined' ? undefined : window.sessionStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

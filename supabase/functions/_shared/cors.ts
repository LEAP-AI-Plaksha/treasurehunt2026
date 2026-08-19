// Shared CORS handling for the kiosk-facing edge functions.
//
// Every room runs on its own origin (localhost:5173..5178 in dev, one host per
// room in production), so ALLOWED_ORIGINS is a comma-separated secret rather
// than a wildcard - these endpoints hold the service role key and must not be
// callable from an arbitrary page.

const allowList = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

export function corsHeaders(origin: string | null): Record<string, string> {
  // With no allow-list configured we fall back to '*', which is fine for local
  // development but should never be the production posture.
  const allowed = allowList.length === 0
    ? '*'
    : origin && allowList.includes(origin)
    ? origin
    : allowList[0]

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

export function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  })
}

export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders(req.headers.get('Origin')) })
}

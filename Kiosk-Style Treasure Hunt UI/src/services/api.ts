// Type-safe API service layer for the Heist kiosk frontend.
//
// Two backends, split by what each is good at:
//   Supabase  - auth, room config, riddles, route order, completion + timing.
//               Reached directly; every write goes through an RPC that stamps
//               the time server-side, so a kiosk cannot fake a fast run.
//   Flask     - the ML rooms only (pose tracking, CLIP scoring, image
//               generation). Kept because Supabase cannot host torch.
//
// The exported `gameApi` surface is unchanged from the original Flask-only
// version, so the screens in App.tsx did not have to move.

import { supabase, teamEmail } from '@/lib/supabase'
import { CURRENT_ROOM_ID } from '@/config/gameSettings'

const ML_BASE = (import.meta.env.VITE_ML_BASE_URL as string) || '/api'

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface RoomConfigData {
  terminalId: string
  label: string
  coordinates: { lat: string; lng: string }
  briefing: string
  hint: string
  points: number
  timerSeconds: number
  maxAttempts: number
}

export interface LoginResponse {
  success: boolean
  token?: string
  teamId?: string
  message?: string
  error?: string
  /** The room's riddle, returned by the same call that starts the clock. */
  riddle?: string | null
  /** 1..6 position of this room on the crew's route. */
  stepIndex?: number
  attemptsRemaining?: number
  /** Set when the crew has already solved this room and walked back in. */
  alreadyCompleted?: boolean
  clue?: string | null

  // Hub terminal only: signing in there brackets the run instead of opening a riddle.
  isHub?: boolean
  hubAction?: 'checked-in' | 'checked-out' | 'already-finished'
  /** The crew's rooms in order, so the hub can print/read out their route. */
  route?: string[]
  /** The next room the crew is due at, or null once they are done. */
  nextRoom?: string | null
  totals?: RunSnapshot['totals']
}

export interface ValidateResponse {
  success: boolean
  completed?: boolean
  points?: number
  clue?: string
  message?: string
  attemptsRemaining?: number
  lockout?: boolean
  error?: string
  /** Server-measured seconds the crew spent in the room. */
  durationSeconds?: number
  /** True once the crew may move on - whether they solved the room or failed it. */
  resolved?: boolean
  /**
   * The crew took their session to another terminal, so this one is stale.
   * When set, this kiosk has been signed out and should return to its idle screen.
   */
  sessionConflict?: boolean
}

export interface GameStateResponse {
  success: boolean
  attempts: number
  attemptsRemaining: number
  completed: boolean
  score: number
  lockout: boolean
}

/** Shape returned by the my_run() RPC, used by the progress/route displays. */
export interface RunStep {
  stepIndex: number
  roomCode: string
  label: string
  terminalId: string
  points: number
  /** True for the finale (the MLP backtrack), which is every crew's last stop. */
  isFinal: boolean
  status: 'pending' | 'in_progress' | 'completed' | 'locked_out'
  arrivedAt: string | null
  completedAt: string | null
  durationSeconds: number | null
  attempts: number
  pointsAwarded: number
}

export interface RunSnapshot {
  success: boolean
  error?: string
  team?: { code: string; name: string; startedAt: string | null; finishedAt: string | null }
  path?: { code: string; steps: RunStep[] }
  totals?: {
    roomsCompleted: number
    totalPoints: number
    totalRoomSeconds: number
    elapsedSeconds: number | null
  }
}

// ---------------------------------------------------------------------------
// Session helpers
//
// Supabase owns the session now, so these read through to it instead of
// managing their own sessionStorage keys. getToken() stays synchronous because
// callers use it inside render paths.
// ---------------------------------------------------------------------------

const TEAM_KEY = 'heist_team_id'

function getToken(): string | null {
  // Kept for callers that only need "is someone signed in". The real token is
  // attached to requests by the Supabase client itself.
  return sessionStorage.getItem(TEAM_KEY) ? 'supabase-session' : null
}

function getStoredTeam(): string | null {
  return sessionStorage.getItem(TEAM_KEY)
}

function clearToken(): void {
  sessionStorage.removeItem(TEAM_KEY)
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const gameApi = {
  getToken,
  getStoredTeam,
  clearToken,

  /** Fetch this room's narrative and rules. Readable without signing in. */
  async getRoomConfig(roomId: string): Promise<{ success: boolean; data: RoomConfigData }> {
    const { data, error } = await supabase
      .from('rooms')
      .select('terminal_id, label, coordinates, briefing, hint, points, timer_seconds, max_attempts')
      .eq('code', roomId)
      .maybeSingle()

    if (error || !data) {
      throw new Error(error?.message ?? `Room ${roomId} not found`)
    }

    return {
      success: true,
      data: {
        terminalId: data.terminal_id,
        label: data.label,
        coordinates: data.coordinates as { lat: string; lng: string },
        briefing: data.briefing,
        hint: data.hint,
        points: data.points,
        timerSeconds: data.timer_seconds,
        maxAttempts: data.max_attempts,
      },
    }
  },

  /**
   * A crew entering its credentials at this terminal.
   *
   * This is the moment the room's clock starts: signing in is followed
   * immediately by check_in_room(), which stamps arrived_at server-side and
   * returns the riddle. Idempotent - a kiosk reload does not restart the clock.
   */
  async login(
    teamId: string,
    passcode: string,
    roomId: string = CURRENT_ROOM_ID,
  ): Promise<LoginResponse> {
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: teamEmail(teamId),
      password: passcode,
    })

    if (authError) {
      return { success: false, error: 'Invalid team code or passcode' }
    }

    // The hub is not a playable room: signing in there brackets the run rather
    // than starting a riddle. First visit stamps the start, the return visit
    // stamps the finish.
    if (roomId === 'HUB') {
      return hubLogin(teamId)
    }

    const { data, error } = await supabase.rpc('check_in_room', { p_room_code: roomId })

    if (error) {
      await supabase.auth.signOut()
      return { success: false, error: error.message }
    }
    if (!data?.success) {
      // Signed in fine, but this crew is not due in this room - keep them signed
      // out so the kiosk returns to a clean state for the next crew.
      await supabase.auth.signOut()
      return { success: false, error: data?.error ?? 'Cannot enter this room yet' }
    }

    const code = teamId.trim().toUpperCase()
    sessionStorage.setItem(TEAM_KEY, code)

    return {
      success: true,
      token: 'supabase-session',
      teamId: code,
      riddle: data.riddle?.prompt ?? null,
      stepIndex: data.visit?.stepIndex,
      attemptsRemaining: data.visit?.attemptsRemaining,
      alreadyCompleted: data.visit?.status === 'completed',
      clue: data.clue ?? null,
      message: `Welcome, ${code}`,
    }
  },

  async logout(): Promise<void> {
    try {
      await supabase.auth.signOut()
    } finally {
      clearToken()
    }
  },

  /** Attempts and completion for this room, from the crew's own run snapshot. */
  async getGameState(roomId: string): Promise<GameStateResponse> {
    const empty: GameStateResponse = {
      success: false, attempts: 0, attemptsRemaining: 0,
      completed: false, score: 0, lockout: false,
    }

    const [{ data: run, error }, { data: room }] = await Promise.all([
      supabase.rpc('my_run'),
      supabase.from('rooms').select('max_attempts').eq('code', roomId).maybeSingle(),
    ])

    if (error || !run?.success) return empty

    const step = (run as RunSnapshot).path?.steps.find((s) => s.roomCode === roomId)
    if (!step) return empty

    const maxAttempts = room?.max_attempts ?? 3
    return {
      success: true,
      attempts: step.attempts,
      attemptsRemaining: Math.max(0, maxAttempts - step.attempts),
      completed: step.status === 'completed',
      score: step.pointsAwarded,
      lockout: step.status === 'locked_out',
    }
  },

  /** The crew's whole route, for a progress panel or the hub display. */
  async getRun(): Promise<RunSnapshot> {
    const { data, error } = await supabase.rpc('my_run')
    if (error) return { success: false, error: error.message }
    return data as RunSnapshot
  },

  /**
   * Submit a riddle answer. The server stamps completed_at, so the recorded
   * time is never the client's idea of how long it took.
   *
   * `elapsedSeconds` is still accepted for the timer-based rooms, which report
   * their hold duration to the ML service rather than being graded here.
   */
  async validateTask(
    roomId: string,
    opts: { submission?: string; elapsedSeconds?: number },
  ): Promise<ValidateResponse> {
    const { data, error } = await supabase.rpc('submit_answer', {
      p_room_code: roomId,
      p_submission: opts.submission ?? '',
    })

    if (error) return { success: false, error: error.message }
    if (!data?.success) {
      // A crew can only hold one live session. If they signed in elsewhere this
      // terminal is stale, so drop its session rather than leaving a screen that
      // looks live but rejects everything.
      if (data?.sessionConflict) {
        await this.logout()
        return { success: false, sessionConflict: true, error: data.error }
      }
      return {
        success: false,
        error: data?.error,
        lockout: data?.lockout ?? false,
        resolved: data?.resolved ?? false,
        attemptsRemaining: data?.attemptsRemaining ?? 0,
      }
    }

    return {
      success: true,
      completed: data.correct === true,
      points: data.pointsAwarded ?? 0,
      clue: data.clue ?? undefined,
      attemptsRemaining: data.attemptsRemaining ?? 0,
      lockout: data.lockout ?? false,
      durationSeconds: data.durationSeconds ?? undefined,
      resolved: data.resolved ?? false,
      message: data.correct ? 'Correct' : 'Incorrect',
    }
  },

  /**
   * Close out a room the crew cannot solve, without making them burn their
   * remaining guesses. Counts as finishing the room: 0 points, but the time is
   * recorded and their next room opens immediately.
   */
  async abandonRoom(roomId: string = CURRENT_ROOM_ID): Promise<{
    success: boolean; status?: string; durationSeconds?: number
    message?: string; error?: string; sessionConflict?: boolean
  }> {
    const { data, error } = await supabase.rpc('abandon_room', { p_room_code: roomId })
    if (error) return { success: false, error: error.message }
    if (data?.sessionConflict) {
      await this.logout()
      return { success: false, sessionConflict: true, error: data.error }
    }
    return data as { success: boolean; status?: string; durationSeconds?: number; message?: string }
  },

  /** Standings are operator-only (RLS hides other crews), so this returns the
   *  crew's own totals rather than a field-wide leaderboard. */
  async getScores(): Promise<{ teamId: string; totalScore: number }[]> {
    const run = await this.getRun()
    if (!run.success || !run.team || !run.totals) return []
    return [{ teamId: run.team.code, totalScore: run.totals.totalPoints }]
  },

  // -------------------------------------------------------------------------
  // ML service (Flask). These need torch, so they stay off Supabase. The crew's
  // Supabase JWT is forwarded so Flask can confirm who is asking.
  // -------------------------------------------------------------------------

  async launchGame(roomId: string): Promise<{ success: boolean; message?: string; error?: string }> {
    return mlPost('/game/launch', { roomId })
  },

  async getMemoryImages(): Promise<{
    success: boolean; left?: string; right?: string; displaySeconds?: number; error?: string
  }> {
    return mlPost('/memory/images', {})
  },

  async generateMemoryImages(promptLeft: string, promptRight: string): Promise<{
    success: boolean; generatedLeft?: string; generatedRight?: string; error?: string
  }> {
    return mlPost('/memory/generate', { promptLeft, promptRight })
  },
}

// ---------------------------------------------------------------------------
// Hub terminal
// ---------------------------------------------------------------------------
// A crew signs in at the hub twice: once on the way out, once on the way back.
// hub_check_in is idempotent, so this decides which of the two is happening from
// the crew's own progress rather than from a button the operator has to press.
async function hubLogin(teamId: string): Promise<LoginResponse> {
  const { data: started, error: startErr } = await supabase.rpc('hub_check_in')
  if (startErr) {
    await supabase.auth.signOut()
    return { success: false, error: startErr.message }
  }
  if (!started?.success) {
    await supabase.auth.signOut()
    return { success: false, error: started?.error ?? 'Could not check in at the hub' }
  }

  const code = teamId.trim().toUpperCase()
  sessionStorage.setItem(TEAM_KEY, code)

  const run = started as RunSnapshot
  const steps = run.path?.steps ?? []
  // A room is "resolved" once it is cleared or its attempts are spent, which is
  // also what lets a crew move on, so the same rule decides when they are done.
  const allResolved =
    steps.length > 0 && steps.every((s) => s.status === 'completed' || s.status === 'locked_out')

  if (allResolved && !run.team?.finishedAt) {
    const { data: finished } = await supabase.rpc('hub_check_out')
    const done = finished as RunSnapshot | null
    return {
      success: true,
      token: 'supabase-session',
      teamId: code,
      isHub: true,
      hubAction: 'checked-out',
      route: steps.map((s) => s.roomCode),
      totals: done?.totals ?? run.totals,
      message: `Run complete. ${done?.totals?.roomsCompleted ?? 0} rooms, ${done?.totals?.totalPoints ?? 0} points.`,
    }
  }

  const next = steps.find((s) => s.status !== 'completed' && s.status !== 'locked_out')
  return {
    success: true,
    token: 'supabase-session',
    teamId: code,
    isHub: true,
    hubAction: run.team?.finishedAt ? 'already-finished' : 'checked-in',
    route: steps.map((s) => s.roomCode),
    nextRoom: next?.roomCode ?? null,
    totals: run.totals,
    message: next ? `Proceed to ${next.label ?? next.roomCode}` : 'Return to the hub',
  }
}

/**
 * URL for the live pose-tracking MJPEG stream. An <img> tag cannot attach an
 * Authorization header, so the crew's token travels as a query parameter -
 * short-lived (the Supabase access token expires in an hour) and scoped to
 * this one room the same way the header-based calls are.
 */
export async function poseStreamUrl(roomId: string): Promise<string | null> {
  const token = await accessToken()
  if (!token) return null
  // A relative /api/... URL works directly as an <img src> too - the browser
  // resolves it against the page origin, and Vite's dev proxy forwards it to
  // Flask exactly like every other request in this file.
  return `${ML_BASE}/game/video_feed?token=${encodeURIComponent(token)}&roomId=${encodeURIComponent(roomId)}`
}

async function mlPost<T>(path: string, body: unknown): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`${ML_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

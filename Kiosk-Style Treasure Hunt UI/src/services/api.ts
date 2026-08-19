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
  /** Server-measured seconds between credential entry and the correct answer. */
  durationSeconds?: number
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
      return {
        success: false,
        error: data?.error,
        lockout: data?.lockout ?? false,
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
      message: data.correct ? 'Correct' : 'Incorrect',
    }
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

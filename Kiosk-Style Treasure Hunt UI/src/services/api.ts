// Type-safe API service layer for the Heist kiosk frontend.
// All requests go to the unified Python backend.

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:5000/api'

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
}

export interface GameStateResponse {
  success: boolean
  attempts: number
  attemptsRemaining: number
  completed: boolean
  score: number
  lockout: boolean
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'heist_auth_token'
const TEAM_KEY = 'heist_team_id'

function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

function setToken(token: string, teamId: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
  sessionStorage.setItem(TEAM_KEY, teamId)
}

function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TEAM_KEY)
}

function getStoredTeam(): string | null {
  return sessionStorage.getItem(TEAM_KEY)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get<T>(path: string, auth = false): Promise<T> {
  const headers: Record<string, string> = {}
  if (auth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${API_BASE}${path}`, { headers })
  return res.json() as Promise<T>
}

async function post<T>(path: string, body?: unknown, auth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const gameApi = {
  // Session helpers
  getToken,
  getStoredTeam,
  clearToken,

  /** Fetch public room config (narrative text, timer, points) from the server. */
  async getRoomConfig(roomId: string): Promise<{ success: boolean; data: RoomConfigData }> {
    return get(`/config/${roomId}`)
  },

  /** Authenticate team credentials. On success stores the token in sessionStorage. */
  async login(teamId: string, passcode: string): Promise<LoginResponse> {
    const result = await post<LoginResponse>('/auth/login', { teamId, passcode })
    if (result.success && result.token && result.teamId) {
      setToken(result.token, result.teamId)
    }
    return result
  },

  /** Clear server session and local token. */
  async logout(): Promise<void> {
    try {
      await post('/auth/logout', undefined, true)
    } finally {
      clearToken()
    }
  },

  /** Fetch current attempt count and completion status for a room. */
  async getGameState(roomId: string): Promise<GameStateResponse> {
    return get(`/game/state/${roomId}`, true)
  },

  /** Launch external game module */
  async launchGame(roomId: string): Promise<{ success: boolean; message?: string; error?: string }> {
    return post('/game/launch', { roomId }, true)
  },

  /**
   * Validate a puzzle answer or hold-timer result.
   * - For answer-based rooms: pass `submission`.
   * - For timer-based rooms: pass `elapsedSeconds`.
   * - For open description rooms (H2 Lounge, Nose Draw): pass `submission` with the text.
   */
  async validateTask(
    roomId: string,
    opts: { submission?: string; elapsedSeconds?: number },
  ): Promise<ValidateResponse> {
    return post<ValidateResponse>(
      '/game/validate',
      { roomId, submission: opts.submission ?? '', elapsedSeconds: opts.elapsedSeconds ?? 0 },
      true,
    )
  },

  /** Memory-to-Image room: request a new image pair from the server. */
  async getMemoryImages(): Promise<{ success: boolean; left?: string; right?: string; displaySeconds?: number; error?: string }> {
    return post('/memory/images', {}, true)
  },

  /** Memory-to-Image room: send prompts, get generated image URLs. */
  async generateMemoryImages(promptLeft: string, promptRight: string): Promise<{
    success: boolean
    generatedLeft?: string
    generatedRight?: string
    error?: string
  }> {
    return post('/memory/generate', { promptLeft, promptRight }, true)
  },

  /** Leaderboard: fetch all team scores. */
  async getScores(): Promise<{ teamId: string; totalScore: number }[]> {
    return get('/scores/summary')
  },
}

// Operator / hub terminal API.
//
// This module talks to the two edge functions, which hold the service role key
// server-side. It must only ever be bundled into the hub app the organisers run
// on their own machine - never into a room kiosk, because the operator key it
// sends can read every crew's times and reset passcodes.

import { supabase } from '@/lib/supabase'

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const OPERATOR_KEY = (import.meta.env.VITE_OPERATOR_KEY as string) || ''

export interface EnrollResult {
  success: boolean
  teamCode?: string
  teamName?: string
  email?: string
  pathCode?: string
  route?: string[]
  error?: string
}

export interface LeaderboardRow {
  team_code: string
  team_name: string
  path_code: string
  started_at: string | null
  finished_at: string | null
  /** Rooms actually solved. This is the primary ranking criterion. */
  rooms_completed: number
  /** Rooms the crew got through (solved or gave up on) - always >= rooms_completed. */
  rooms_resolved: number
  rooms_failed: number
  /** Hub-to-hub wall clock. The tiebreaker when rooms_completed is equal. */
  elapsed_seconds: number | null
  total_room_seconds: number
  position: number
}

export interface TeamRoomTimeRow {
  team_code: string
  team_name: string
  path_code: string
  step_index: number
  room_code: string
  room_label: string
  status: 'pending' | 'in_progress' | 'completed' | 'locked_out'
  arrived_at: string | null
  completed_at: string | null
  duration_seconds: number | null
  attempts: number
  points_awarded: number
}

async function callFunction<T>(name: string, body: unknown, withOperatorKey = true): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ANON_KEY}`,
      ...(withOperatorKey ? { 'x-operator-key': OPERATOR_KEY } : {}),
    },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

export const operatorApi = {
  /**
   * Start of the event: a crew chooses its own passcode at the hub terminal.
   * Needs the enrollment code printed on the crew's slip, not the operator key,
   * so the crew can type their passcode without an organiser holding the keyboard.
   */
  async enrollTeam(teamCode: string, enrollmentCode: string, passcode: string): Promise<EnrollResult> {
    return callFunction<EnrollResult>('enroll-team', { teamCode, enrollmentCode, passcode }, false)
  },

  async leaderboard(): Promise<{ success: boolean; leaderboard?: LeaderboardRow[]; error?: string }> {
    return callFunction('operator', { action: 'leaderboard' })
  },

  /** The scoring export: completion and time for every game, for every crew. */
  async teamTimes(teamCode?: string): Promise<{ success: boolean; rows?: TeamRoomTimeRow[]; error?: string }> {
    return callFunction('operator', { action: 'teamTimes', teamCode })
  },

  /** Live room load, for spotting a room that has backed up. */
  async occupancy(): Promise<{ success: boolean; rooms?: unknown[]; error?: string }> {
    return callFunction('operator', { action: 'occupancy' })
  },

  async enrollmentStatus(): Promise<{ success: boolean; teams?: unknown[]; error?: string }> {
    return callFunction('operator', { action: 'enrollment' })
  },

  /** Teams arriving per room per step - confirms the 10 routes stay balanced. */
  async pathBalance(): Promise<{ success: boolean; cells?: unknown[]; error?: string }> {
    return callFunction('operator', { action: 'pathBalance' })
  },

  async resetPasscode(teamCode: string, passcode: string): Promise<{ success: boolean; error?: string }> {
    return callFunction('operator', { action: 'resetPasscode', teamCode, passcode })
  },

  /** Wipes a crew's visits and hub timestamps so they can run again cleanly. */
  async resetTeam(teamCode: string): Promise<{ success: boolean; error?: string }> {
    return callFunction('operator', { action: 'resetTeam', teamCode })
  },

  async setScoring(open: boolean): Promise<{ success: boolean; error?: string }> {
    return callFunction('operator', { action: 'setScoring', open })
  },

  async setPathOrder(enforce: boolean): Promise<{ success: boolean; error?: string }> {
    return callFunction('operator', { action: 'setPathOrder', enforce })
  },

  /**
   * REHEARSAL ONLY. While on, every room accepts any answer - including the
   * machine-graded ones - so the whole route can be walked without solving
   * anything or running the CV game. Turn it off before the real event.
   */
  async setSkipRiddles(skip: boolean): Promise<{ success: boolean; skipRiddles?: boolean; warning?: string; error?: string }> {
    return callFunction('operator', { action: 'setSkipRiddles', skip })
  },

  /** Mark a single room complete for a single crew, without the global switch. */
  async forceComplete(teamCode: string, roomCode: string): Promise<{ success: boolean; error?: string }> {
    return callFunction('operator', { action: 'forceComplete', teamCode, roomCode })
  },

  /** Every room that was skipped or force-completed, for post-event scoring. */
  async skippedRooms(): Promise<{ success: boolean; skipped?: unknown[]; error?: string }> {
    return callFunction('operator', { action: 'skipped' })
  },
}

// ---------------------------------------------------------------------------
// Hub check-in / check-out
//
// These run as the CREW, not as the operator: the crew signs in at the hub the
// same way they will at every room, which is what stamps started_at and, on
// their return, finished_at.
// ---------------------------------------------------------------------------

export const hubApi = {
  /** Crew leaves the origin: stamps started_at and returns their route. */
  async checkIn(): Promise<unknown> {
    const { data, error } = await supabase.rpc('hub_check_in')
    if (error) return { success: false, error: error.message }
    return data
  },

  /** Crew returns to the origin: stamps finished_at and closes out the run. */
  async checkOut(): Promise<unknown> {
    const { data, error } = await supabase.rpc('hub_check_out')
    if (error) return { success: false, error: error.message }
    return data
  },
}

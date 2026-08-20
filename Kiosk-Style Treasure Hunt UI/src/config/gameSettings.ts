// Type-safe loader for per-room config read from the backend API.
// At runtime the frontend reads room config from Supabase, so this file only
// holds the TypeScript types and the ROOM_ID constant derived from .env.local.

export type RoomId =
  | 'HUB'
  | 'YOGA_ROOM'
  | 'CTLC_LAB'
  | 'MUSIC_ROOM'
  | 'H2_LOUNGE'
  | 'CLASSROOM_1101'
  | 'NOSE_DRAW'

// The room this kiosk terminal is assigned to.
// Set VITE_ROOM_ID in .env.local for each physical machine.
export const CURRENT_ROOM_ID: RoomId =
  ((import.meta.env.VITE_ROOM_ID as string) || 'YOGA_ROOM') as RoomId

/** True on the operator's hub terminal, which enrolls crews and closes out runs. */
export const IS_HUB = CURRENT_ROOM_ID === 'HUB'

// Global attempt limit shown in the UI while config loads.
// The authoritative value comes from the rooms table in Supabase.
export const DEFAULT_MAX_ATTEMPTS = 3

// Local fallback labels used before the server config arrives.
export const ROOM_LABELS: Record<RoomId, string> = {
  HUB:            'OPERATIONS BASE',
  YOGA_ROOM:      'LASER GRID',
  CTLC_LAB:       'SILENT RELAY',
  MUSIC_ROOM:     'VOICE INTERCEPT',
  H2_LOUNGE:      'MEMORY FORGERY',
  CLASSROOM_1101: 'NEURAL BYPASS',
  NOSE_DRAW:      'BIOMETRIC SKETCH',
}

// ---------------------------------------------------------------------------
// DEMO MODE - offline UI preview. Not used unless VITE_DEMO_MODE=1.
//
// Lets every kiosk render its full screen flow with no Supabase project, no
// crew logins and no Flask service: room config is served from this file and
// any credentials are accepted. Nothing here runs when the flag is unset, and
// nothing here touches the real code path in api.ts.
//
// Turn it on:   VITE_DEMO_MODE=1 in .env.local
// Turn it off:  remove that line. Delete this file to remove demo mode entirely.
// ---------------------------------------------------------------------------

import type { RoomConfigData } from './api'

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === '1'

const DEMO_ROOMS: Record<string, RoomConfigData> = {
  "YOGA_ROOM": {
    "terminalId": "ALPHA-01",
    "label": "LASER GRID",
    "coordinates": {
      "lat": "48.8606 N",
      "lng": "2.3376 E"
    },
    "briefing": "The Louvre east wing laser grid pulses at irregular intervals. Your team must hold the deactivation pose for exactly 10 seconds without breaking contact. Triggering early or moving out of frame will trip the alarm.",
    "hint": "Hold the DEACTIVATE button for exactly 10 seconds. Release at the tone.",
    "points": 150,
    "timerSeconds": 10,
    "maxAttempts": 3
  },
  "CTLC_LAB": {
    "terminalId": "BETA-02",
    "label": "SILENT RELAY",
    "coordinates": {
      "lat": "48.8608 N",
      "lng": "2.3364 E"
    },
    "briefing": "The guard rotation has been intercepted. A silent communication channel has been established with your inside contact. The target phrase must be memorised and relayed without speaking - facial recognition microphones are active.",
    "hint": "Hold REVEAL PHRASE to view your target message. Memorise it - the display clears in 5 seconds.",
    "points": 120,
    "timerSeconds": 5,
    "maxAttempts": 3
  },
  "MUSIC_ROOM": {
    "terminalId": "GAMMA-03",
    "label": "VOICE INTERCEPT",
    "coordinates": {
      "lat": "48.8612 N",
      "lng": "2.3352 E"
    },
    "briefing": "An intercepted transmission is incoming on the guard frequency. Identify whether the voice on the channel is a human guard or an AI decoy before you respond - one wrong move compromises the entire operation.",
    "hint": "Analyse the incoming transmission. Is it a Human guard or an AI decoy system?",
    "points": 130,
    "timerSeconds": 30,
    "maxAttempts": 3
  },
  "H2_LOUNGE": {
    "terminalId": "DELTA-04",
    "label": "MEMORY FORGERY",
    "coordinates": {
      "lat": "48.8619 N",
      "lng": "2.3341 E"
    },
    "briefing": "Your asset inside the museum photographed the target artefact. The classified image will self-destruct after 10 seconds. Study every detail to construct an accurate description for the forger.",
    "hint": "Memorise the artifact in 10 seconds. Describe shapes, materials, and distinct engravings.",
    "points": 140,
    "timerSeconds": 10,
    "maxAttempts": 3
  },
  "CLASSROOM_1101": {
    "terminalId": "EPSILON-05",
    "label": "NEURAL BYPASS",
    "coordinates": {
      "lat": "48.8621 N",
      "lng": "2.3338 E"
    },
    "briefing": "The museum neural network authentication system must be bypassed. Your team cryptographer has isolated the vulnerable weights layer. Submit the correct backpropagation values to inject your bypass signature.",
    "hint": "Input the correct weight values for each layer node. The gradient descent target is 0.001.",
    "points": 160,
    "timerSeconds": 120,
    "maxAttempts": 3
  },
  "NOSE_DRAW": {
    "terminalId": "ZETA-06",
    "label": "BIOMETRIC SKETCH",
    "coordinates": {
      "lat": "48.8625 N",
      "lng": "2.3329 E"
    },
    "briefing": "The final biometric scanner requires a physical sketch of the guard captain face - drawn using only your nose. This unconventional method bypasses motion-detection cameras watching your hands.",
    "hint": "Hold your sketch up to the camera or describe what you drew to validate against the target profile.",
    "points": 100,
    "timerSeconds": 300,
    "maxAttempts": 3
  },
  "HUB": {
    "terminalId": "HUB-00",
    "label": "OPERATIONS BASE",
    "coordinates": {
      "lat": "48.8606 N",
      "lng": "2.3376 E"
    },
    "briefing": "DEMO MODE. Operations base. Crews check in here, receive their route, and return here to check out.",
    "hint": "Demo mode - no Supabase connection. Any credentials are accepted.",
    "points": 0,
    "timerSeconds": 60,
    "maxAttempts": 3
  }
}

const ok = <T,>(v: T) => Promise.resolve(v)

// A fixed stand-in for next_riddle_preview() - just enough to render the
// "NEXT ROOM" block on the success and give-up screens in demo mode.
const DEMO_NEXT_RIDDLE = {
  roomCode: 'MUSIC_ROOM',
  label: 'VOICE INTERCEPT',
  isFinal: false,
  prompt: 'DEMO MODE - this is where the next room\'s riddle prompt appears.',
}

/** Stand-in for `gameApi` that never makes a network call. */
export const demoGameApi = {
  async getRoomConfig(roomId: string) {
    const data = DEMO_ROOMS[roomId] ?? DEMO_ROOMS.YOGA_ROOM
    return ok({ success: true, data })
  },

  // Any team code and passcode are accepted.
  async login(teamId: string) {
    return ok({ success: true, teamId: teamId || 'DEMO', token: 'demo-token' } as never)
  },

  async logout() { return ok(undefined) },

  async getGameState() {
    return ok({ success: true, roomId: '', completed: false, attemptsRemaining: 3 } as never)
  },

  async getRun() {
    return ok({ success: true, steps: [], currentStep: 0 } as never)
  },

  // Every submission passes, so the success screen is reachable in every room.
  async validateTask() {
    return ok({
      success: true,
      correct: true,
      clue: 'DEMO MODE - this is where the real clue for this room appears.',
      points: 0,
      attemptsRemaining: 3,
      lockout: false,
      nextRiddle: DEMO_NEXT_RIDDLE,
    } as never)
  },

  async abandonRoom() { return ok({ success: true, nextRiddle: DEMO_NEXT_RIDDLE } as never) },
  async getScores() { return ok([] as never) },
  async launchGame() { return ok({ success: false, error: 'Demo mode: no ML service.' }) },
  // Accepted and dropped: demo mode has no pose stream to steer, and the
  // controls must not throw on a terminal being demoed with no Flask running.
  async sendGameControl() { return ok({ success: true }) },

  // Simulated 3-round Memory Forgery flow - a placeholder photo per side and
  // an always-passing score, so the room's full round loop is reachable with
  // no Flask service running.
  async getMemoryImages(round: number) {
    return ok({
      success: true,
      left: 'https://picsum.photos/seed/demo-left/800/600',
      right: 'https://picsum.photos/seed/demo-right/800/600',
      round,
      totalRounds: 3,
      displaySeconds: 10,
    } as never)
  },
  async generateMemoryImages() {
    return ok({
      success: true,
      generatedLeft: 'https://picsum.photos/seed/demo-gen-left/800/600',
      generatedRight: 'https://picsum.photos/seed/demo-gen-right/800/600',
      round: 3,
      totalRounds: 3,
      roundScore: 7,
      roundPassed: true,
      final: true,
      overallPassed: true,
      passes: 3,
    } as never)
  },
}

/** No pose stream in demo mode; the room falls back to manual answer entry. */
export async function demoPoseStreamUrl(): Promise<string | null> {
  return null
}

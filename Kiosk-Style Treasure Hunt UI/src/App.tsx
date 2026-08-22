import { useState, useEffect, useRef } from 'react'
import imgBackground from '@/imports/LaserGrid/73ecf9f6066a41d6d2daab627902dcec860f5ac3.png'
import { gameApi, poseStreamUrl, type RoomConfigData, type NextRiddlePreview } from '@/services/api'
import { CURRENT_ROOM_ID, DEFAULT_MAX_ATTEMPTS, IS_HUB, ROOM_LABELS, type RoomId } from '@/config/gameSettings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Screen = 'idle' | 'auth' | 'briefing' | 'active' | 'resolution' | 'success' | 'lockout'

// ---------------------------------------------------------------------------
// Ambient components
// ---------------------------------------------------------------------------

function KioskBadge({ terminalId, label }: { terminalId: string; label: string }) {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-3">
      <div className="text-right">
        <div className="font-mono text-[10px] text-[#669EFF] tracking-widest opacity-70">
          {time.toLocaleTimeString('en-US', { hour12: false })}
        </div>
        <div className="font-mono text-[10px] text-[#669EFF] tracking-widest opacity-50">
          {time.toLocaleDateString('en-US', { day:'2-digit', month:'short', year:'numeric' }).toUpperCase()}
        </div>
      </div>
      <div className="border border-[#337DFF] bg-[#000307]/80 px-3 py-2">
        <div className="font-mono text-[9px] text-[#669EFF] tracking-[0.2em] opacity-70">TERMINAL</div>
        <div className="font-mono text-xs text-white tracking-widest font-bold">{label}</div>
        <div className="font-mono text-[9px] text-[#337DFF] tracking-widest">{terminalId}</div>
      </div>
      <div className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
    </div>
  )
}

function AttemptTracker({ remaining, max }: { remaining: number; max: number }) {
  return (
    <div className="fixed bottom-8 left-8 z-50">
      <div className="font-mono text-[9px] text-[#669EFF] tracking-[0.2em] mb-2 opacity-70">ATTEMPTS</div>
      <div className="flex gap-2">
        {Array.from({ length: max }).map((_, i) => {
          const active = i < remaining
          return (
            <div
              key={i}
              className="w-8 h-8 border flex items-center justify-center transition-all duration-500"
              style={{
                borderColor: active ? '#337DFF' : '#1a1a2e',
                background: active ? 'rgba(51,125,255,0.12)' : 'rgba(255,51,51,0.06)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1L13 4V7C13 10.5 10 13 7 13C4 13 1 10.5 1 7V4L7 1Z"
                  stroke={active ? '#337DFF' : '#FF3333'}
                  strokeWidth="1.2"
                  fill={active ? 'rgba(51,125,255,0.2)' : 'rgba(255,51,51,0.08)'}
                />
              </svg>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ScanlineOverlay() {
  return (
    <div className="fixed inset-0 pointer-events-none z-40">
      <div
        className="absolute inset-0"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.05) 2px, rgba(0,0,0,0.05) 4px)',
        }}
      />
    </div>
  )
}

function GridLines() {
  return (
    <div className="absolute inset-0 pointer-events-none opacity-8" style={{
      backgroundImage: 'linear-gradient(rgba(51,125,255,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(51,125,255,0.3) 1px, transparent 1px)',
      backgroundSize: '60px 60px',
    }} />
  )
}

function BackgroundLayer() {
  return (
    <div className="fixed inset-0 z-0">
      <img
        src={imgBackground}
        alt=""
        className="absolute w-[132%] h-[124%] left-[-3%] top-[-18%] object-cover opacity-25"
        style={{ mixBlendMode: 'luminosity' }}
      />
      <div className="absolute inset-0 bg-[#000307]/85" />
      <GridLines />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Idle screen
// ---------------------------------------------------------------------------

function IdleScreen({ label, terminalId, onAuthenticate }: { label: string; terminalId: string; onAuthenticate: () => void }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(p => p + 1), 2000)
    return () => clearInterval(t)
  }, [])

  const statusMessages = [
    'AWAITING TEAM AUTHENTICATION',
    'SYSTEM ARMED - STAND BY',
    'SECURITY LEVEL: MAXIMUM',
    'ALL CHANNELS ENCRYPTED',
    'KIOSK LOCKED TO LOCALHOST',
  ]

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center z-10 animate-flicker">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] text-center">
        <div className="font-mono text-[10px] tracking-[0.4em] text-[#337DFF] mb-6 opacity-70">
          AI@PLAKSHA - TREASURE HUNT 2026
        </div>
        <h1 className="text-7xl font-black tracking-[-0.02em] text-white mb-1">
          TREASURE
        </h1>
        <p className="text-xl font-light text-[#669EFF] tracking-[0.3em] mb-2">A LOUVRE HEIST</p>
        <div className="w-full h-px bg-gradient-to-r from-transparent via-[#337DFF] to-transparent my-6 opacity-40" />
        <div className="font-mono text-sm text-white tracking-widest mb-1">{label}</div>
        <div className="font-mono text-xs text-[#337DFF] tracking-widest opacity-60">{terminalId}</div>
      </div>

      <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 translate-y-1/2 flex flex-col items-center gap-8">
        <div className="font-mono text-xs text-[#669EFF] tracking-[0.3em] opacity-60 transition-all duration-700">
          {statusMessages[tick % statusMessages.length]}
          <span className="animate-blink">_</span>
        </div>
        <button
          onClick={onAuthenticate}
          className="group relative border border-[#337DFF] px-12 py-4 font-mono font-bold tracking-[0.3em] text-sm text-white transition-all duration-200 hover:bg-[#337DFF] active:scale-95"
        >
          <span className="relative z-10">AUTHENTICATE TEAM</span>
        </button>
        <div className="font-mono text-[9px] text-[#337DFF] opacity-30 tracking-[0.2em]">
          48.8606 N · 2.3376 E · LOCALHOST LOCKED
        </div>
      </div>

      {/* Corner decorations */}
      {[['top-16 left-16', 'border-t border-l'], ['top-16 right-16', 'border-t border-r'], ['bottom-16 left-16', 'border-b border-l'], ['bottom-16 right-16', 'border-b border-r']].map(([pos, border], i) => (
        <div key={i} className={`absolute ${pos} w-8 h-8 ${border} border-[#337DFF] opacity-30`} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Auth modal - now calls the API
// ---------------------------------------------------------------------------

function AuthModal({
  terminalId,
  onSuccess,
  onCancel,
}: {
  terminalId: string
  onSuccess: (teamId: string) => void
  onCancel: () => void
}) {
  const [teamId, setTeamId] = useState('')
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shaking, setShaking] = useState(false)

  const handleSubmit = async () => {
    if (loading) return
    const id = teamId.trim().toUpperCase()
    const pw = passcode.trim()
    if (!id || !pw) { setError('ENTER TEAM ID AND PASSWORD'); return }

    setLoading(true)
    setError('')
    try {
      const result = await gameApi.login(id, pw)
      if (result.success) {
        onSuccess(id)
      } else {
        // Login can fail for reasons that have nothing to do with attempts left
        // in this room - wrong password, but also "check in at the hub first",
        // "it isn't your turn for this room yet", or another terminal holding
        // this crew's session. Show the server's actual reason rather than a
        // generic message, and leave the modal open so the crew can read it and
        // retry instead of the screen silently bouncing back to idle.
        setError(result.error?.toUpperCase() ?? 'ACCESS DENIED')
        setShaking(true)
        setTimeout(() => setShaking(false), 600)
      }
    } catch {
      setError('NETWORK ERROR - BACKEND UNREACHABLE')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-[#000307]/70 backdrop-blur-sm" onClick={onCancel} />
      <div
        className={`relative border border-[#337DFF] bg-[#000307] p-8 w-[420px] ${shaking ? 'animate-[shake_0.5s_ease]' : ''}`}
      >
        {/* Header */}
        <div className="border-b border-[#337DFF]/30 pb-4 mb-6">
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] opacity-70 mb-1">
            SECURE ACCESS PROTOCOL - {terminalId}
          </div>
          <div className="font-mono text-lg font-bold text-white tracking-widest">TEAM AUTHENTICATION</div>
        </div>

        {error && (
          <div className="border border-red-500/50 bg-red-500/10 px-3 py-2 mb-4 font-mono text-xs text-red-400 tracking-widest">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] block mb-2">TEAM ID</label>
            <input
              type="text"
              value={teamId}
              onChange={e => setTeamId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="ENTER TEAM ID"
              autoFocus
              className="w-full bg-[#0a0f1e] border border-[#337DFF]/40 px-4 py-3 font-mono text-sm text-white tracking-widest placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors"
            />
          </div>
          <div>
            <label className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] block mb-2">PASSWORD</label>
            <input
              type="password"
              value={passcode}
              onChange={e => setPasscode(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="**********"
              className="w-full bg-[#0a0f1e] border border-[#337DFF]/40 px-4 py-3 font-mono text-sm text-white tracking-widest placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onCancel}
            className="flex-1 border border-[#337DFF]/30 py-3 font-mono text-xs text-[#337DFF]/60 tracking-widest hover:border-[#337DFF]/60 transition-colors"
          >
            ABORT
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="flex-[2] bg-[#337DFF] py-3 font-mono text-xs font-bold text-white tracking-widest hover:bg-[#4488ff] active:scale-95 transition-all disabled:opacity-50"
          >
            {loading ? 'VERIFYING...' : 'COMMENCE HACK'}
          </button>
        </div>

        {/* Corner accents */}
        <div className="absolute top-2 right-2 w-3 h-3 border-t border-r border-[#337DFF] opacity-40" />
        <div className="absolute bottom-2 left-2 w-3 h-3 border-b border-l border-[#337DFF] opacity-40" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Briefing screen - shows server-loaded narrative
// ---------------------------------------------------------------------------

function BriefingScreen({ config, teamId, onStart }: { config: RoomConfigData; teamId: string; onStart: () => void }) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 400)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10">
      <div
        className="border border-[#337DFF]/50 bg-[#000307]/90 p-10 max-w-2xl w-full mx-8 transition-all duration-700"
        style={{
          opacity: revealed ? 1 : 0,
          transform: revealed ? 'translateY(0)' : 'translateY(20px)',
        }}
      >
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] mb-1 opacity-70">
          MISSION BRIEFING - {config.terminalId}
        </div>
        <div className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] mb-6 opacity-50">
          OPERATIVE: {teamId}
        </div>

        <div className="w-full h-px bg-[#337DFF]/20 mb-6" />

        <h2 className="font-black text-2xl text-white tracking-wide mb-4">{config.label}</h2>

        <p className="text-[#aabddd] leading-relaxed text-sm mb-6 font-light">
          {config.briefing}
        </p>

        {config.hint && (
          <div className="border-l-2 border-[#337DFF] pl-4 mb-8">
            <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] mb-1">DIRECTIVE</div>
            <p className="text-white text-sm font-mono">{config.hint}</p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div />
          <button
            onClick={onStart}
            className="border border-[#337DFF] px-8 py-3 font-mono text-xs font-bold text-white tracking-[0.3em] hover:bg-[#337DFF] transition-all duration-200 active:scale-95"
          >
            START ATTEMPT
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resolution screen
// ---------------------------------------------------------------------------

// Shown once a room is actually resolved (solved, locked out, or abandoned) -
// never on a mid-run retry, since the server itself withholds nextRiddle
// until then. `undefined` (not yet known) renders nothing; `null` means the
// crew has cleared every room on their route.
// The riddle sending a crew to their next room is the one thing on this screen
// that they have to read, discuss and act on, often standing back from the
// kiosk - so it is the centerpiece rather than a footnote. It used to render at
// text-xs in a small panel below the result banner, which is unreadable at more
// than arm's length.
function NextRoomPreview({ nextRiddle }: { nextRiddle?: NextRiddlePreview | null }) {
  if (nextRiddle === undefined) return null

  if (nextRiddle === null) {
    return (
      <div className="border-2 border-[#337DFF]/50 bg-[#337DFF]/05 px-8 py-10 mb-8 text-center">
        <div className="font-mono text-[11px] text-[#337DFF] tracking-[0.4em] mb-4 opacity-80">ROUTE CLEARED</div>
        <p className="font-mono text-2xl md:text-3xl text-white tracking-wide leading-snug">
          All rooms resolved. Return to the operations base.
        </p>
      </div>
    )
  }

  return (
    <div className="border-2 border-[#337DFF]/60 bg-[#337DFF]/08 px-8 py-10 md:px-12 md:py-12 mb-8 text-left shadow-[0_0_40px_rgba(51,125,255,0.15)]">
      <div className="flex items-baseline justify-between gap-4 mb-6">
        <div className="font-mono text-[11px] text-[#337DFF] tracking-[0.4em] opacity-80">
          YOUR NEXT RIDDLE{nextRiddle.isFinal ? ' - FINAL ROOM' : ''}
        </div>
      </div>

      {/* The riddle itself: as large as the headline above it, and left-aligned
          with generous leading because it is read aloud, not glanced at. */}
      <p className="font-mono text-2xl md:text-4xl text-white leading-[1.35] tracking-wide">
        {nextRiddle.prompt}
      </p>

      <div className="w-full h-px bg-[#337DFF]/25 my-8" />

      <div className="font-mono text-[11px] text-[#669EFF]/70 tracking-[0.3em] mb-2">SOLVE IT TO FIND</div>
      <div className="font-mono text-xl md:text-2xl text-[#00FF88] font-bold tracking-[0.2em]">
        {nextRiddle.label}
      </div>
    </div>
  )
}

function ResolutionScreen({
  success,
  clue,
  teamId,
  terminalId,
  attemptsLeft,
  maxAttempts,
  gaveUp,
  nextRiddle,
  onRetry,
  onReset,
}: {
  success: boolean
  clue?: string
  teamId: string
  terminalId: string
  attemptsLeft: number
  maxAttempts: number
  gaveUp?: boolean
  nextRiddle?: NextRiddlePreview | null
  onRetry: () => void
  onReset: () => void
}) {
  if (!success && attemptsLeft === 0) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
        <div className="text-center max-w-4xl w-full mx-8">
          <div className="font-digital text-8xl text-red-500 mb-4">000</div>
          <div className="font-mono text-[9px] tracking-[0.4em] text-red-400 mb-6 opacity-70">
            {gaveUp ? 'ROOM ABANDONED' : 'TERMINAL LOCKOUT'}
          </div>
          <h2 className="text-3xl font-black text-white mb-4 tracking-wide">
            {gaveUp ? 'OPERATION ABORTED' : 'OPERATION COMPROMISED'}
          </h2>
          <p className="text-[#aabddd] text-sm mb-8 font-light leading-relaxed">
            {gaveUp
              ? 'Your crew withdrew from this room. The attempt is recorded as a fail - proceed to your next room.'
              : 'All authentication attempts exhausted. This terminal has been locked. Alert the game master for manual override.'}
          </p>
          <div className="border border-red-500/30 bg-red-500/05 px-6 py-4 mb-8 font-mono text-xs text-red-400/70 tracking-widest">
            TERMINAL {terminalId} - {gaveUp ? 'ABANDONED' : 'LOCKED'} - TEAM: {teamId}
          </div>
          <NextRoomPreview nextRiddle={nextRiddle} />
          <button
            onClick={onReset}
            className="border border-red-500/50 px-8 py-3 font-mono text-xs text-red-400 tracking-widest hover:bg-red-500/10 transition-colors"
          >
            {gaveUp ? 'RESET TERMINAL' : 'GAME MASTER RESET'}
          </button>
        </div>
      </div>
    )
  }

  if (!success) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
        <div className="text-center max-w-4xl w-full mx-8">
          <div className="font-digital text-8xl text-amber-500 mb-4">
            {'0'.repeat(maxAttempts).split('').map((_, i) => i < attemptsLeft ? '●' : '○').join('')}
          </div>
          <div className="font-mono text-[9px] tracking-[0.4em] text-amber-400 mb-6 opacity-70">AUTHENTICATION FAILED</div>
          <h2 className="text-3xl font-black text-white mb-4 tracking-wide">ACCESS DENIED</h2>
          <p className="text-[#aabddd] text-sm mb-8 font-light">
            Incorrect response detected. {attemptsLeft} attempt{attemptsLeft !== 1 ? 's' : ''} remaining before terminal lockout.
          </p>
          <button
            onClick={onRetry}
            className="border border-[#337DFF] px-10 py-3 font-mono text-xs font-bold text-white tracking-[0.3em] hover:bg-[#337DFF] transition-all active:scale-95"
          >
            RETRY HACK
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
      <div className="max-w-4xl w-full mx-8">
        <div className="text-center mb-8">
          <div className="font-digital text-7xl text-[#00FF88] mb-2">ACCESS</div>
          <div className="font-digital text-7xl text-[#00FF88]">GRANTED</div>
        </div>

        <div className="border border-[#00FF88]/40 bg-[#00FF88]/05 p-8">
          <div className="font-mono text-[9px] text-[#00FF88] tracking-[0.3em] mb-4 opacity-70">
            CHALLENGE CLEARED - OPERATIVE: {teamId}
          </div>
          <div className="w-full h-px bg-[#00FF88]/20 mb-4" />
          <div className="font-mono text-[9px] text-[#00FF88] tracking-[0.3em] mb-2 opacity-60">CLASSIFIED CLUE</div>
          <p className="font-mono text-sm text-white leading-relaxed tracking-wide">{clue}</p>
        </div>

        <div className="mt-6">
          <NextRoomPreview nextRiddle={nextRiddle} />
        </div>

        <div className="flex justify-center mt-2">
          <button
            onClick={onReset}
            className="border border-[#337DFF]/40 px-8 py-3 font-mono text-xs text-[#337DFF]/60 tracking-widest hover:border-[#337DFF] hover:text-white transition-colors"
          >
            RESET TERMINAL
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: Yoga Room (Laser Grid) - timer hold
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Manual answer fallback - shown on every module-backed challenge so a room
// is never blocked on a camera, an iframe, or an image-generation service that
// isn't running. The server is the source of truth for whether an answer is
// right (or, in rehearsal mode, accepts anything) - this is just another way
// to reach submit_answer, not a second grading path.
// ---------------------------------------------------------------------------

function ManualAnswerFallback({
  onSubmit,
  label = 'MODULE UNAVAILABLE - ENTER ANSWER MANUALLY',
}: {
  onSubmit: (text: string) => void
  label?: string
}) {
  const [value, setValue] = useState('')
  const submit = () => {
    const text = value.trim()
    if (text) onSubmit(text)
  }
  return (
    <div className="mt-6 w-full max-w-md mx-auto border-t border-[#337DFF]/20 pt-6">
      <div className="font-mono text-[9px] text-[#669EFF]/60 tracking-[0.3em] mb-2 text-center">{label}</div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="TYPE ANSWER"
          autoFocus
          className="flex-1 bg-[#0a0f1e] border border-[#337DFF]/40 px-3 py-2 font-mono text-xs text-white tracking-widest placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors"
        />
        <button
          onClick={submit}
          disabled={!value.trim()}
          className="bg-[#337DFF]/20 border border-[#337DFF]/50 px-4 py-2 font-mono text-xs text-white tracking-widest hover:bg-[#337DFF]/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
        >
          SUBMIT
        </button>
      </div>
    </div>
  )
}

// The pose gauntlet runs in Flask and arrives here as an MJPEG <img>, which has
// two consequences this component exists to handle.
//
// 1. The crew never has focus on the OpenCV window - there isn't one - so the
//    game's own R / N / Q keys are dead. The controls below post the same three
//    actions to /api/game/control, and the keyboard handler binds R, N, Q and
//    SPACE here in the page so the keys a player naturally reaches for work.
//
// 2. The stream cannot tell us how the run went; Supabase can. The game reports
//    its own verdict (>= 7 of 10 poses held) and Supabase burns an attempt for
//    every finished sequence, pass or fail, closing the room out on the last
//    one. So this polls the crew's own room state and reacts to what the server
//    says rather than trying to score anything client-side:
//      completed          -> cleared, hand off to the success screen
//      locked_out         -> out of attempts, hand off to the lockout screen,
//                            which is what reveals the next room's riddle
//      attempts went up   -> a spent attempt with some left: show the verdict
//                            and let them run it again
function YogaRoomChallenge({
  roomId,
  timerSeconds,
  onSuccess,
  onResolvedFail,
  onAttemptsChanged,
}: {
  roomId: string
  timerSeconds: number
  onSuccess: (elapsed: number) => void
  onResolvedFail: () => void
  onAttemptsChanged: (remaining: number) => void
}) {
  const [phase, setPhase] = useState<'ready' | 'loading' | 'streaming' | 'spent' | 'error'>('ready')
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Attempts already on the record when this terminal opened the module. The
  // poller compares against this to spot "a sequence just finished" without
  // needing the stream to report anything back to the browser.
  const baselineAttempts = useRef<number | null>(null)
  // Guards the one-shot handoffs: onSuccess/onResolvedFail must not fire twice
  // if a poll lands while the parent is already switching screens.
  const handedOff = useRef(false)

  const stopPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }

  const poll = async () => {
    const res = await gameApi.getGameState(roomId)
    if (!res.success || handedOff.current) return

    setAttemptsLeft(res.attemptsRemaining)
    onAttemptsChanged(res.attemptsRemaining)

    if (res.completed) {
      handedOff.current = true
      stopPolling()
      onSuccess(timerSeconds)
      return
    }

    if (res.lockout) {
      handedOff.current = true
      stopPolling()
      onResolvedFail()
      return
    }

    if (baselineAttempts.current === null) {
      baselineAttempts.current = res.attempts
      return
    }

    // The run ended and did not clear the gauntlet, but they still have a go
    // left. Drop the dead stream and offer it again.
    if (res.attempts > baselineAttempts.current) {
      baselineAttempts.current = res.attempts
      stopPolling()
      setStreamUrl(null)
      setPhase('spent')
    }
  }

  const startStream = async () => {
    setError('')
    setPhase('loading')
    const url = await poseStreamUrl(roomId)
    if (!url) {
      setError('Not signed in - cannot open the camera feed.')
      setPhase('error')
      return
    }
    // The <img> tag itself is what triggers Flask to open the camera and start
    // the sequence - there is no separate "launch" call. Loading the model and
    // opening the webcam takes a few seconds on a cold start; the <img>'s
    // onLoad only fires once the first frame actually arrives.
    //
    // The cache-buster matters on a retry: without it the browser reuses the
    // finished response for an identical URL and the second run never opens.
    setStreamUrl(`${url}&t=${Date.now()}`)

    // In Chrome/Edge, <img> onLoad does not fire on multipart/x-mixed-replace MJPEG streams.
    // Transition to streaming state after a brief buffer so the loading card doesn't block the video.
    setTimeout(() => {
      setPhase(p => (p === 'loading' ? 'streaming' : p))
    }, 1500)

    stopPolling()
    intervalRef.current = setInterval(poll, 2000)
  }

  const handleStart = async () => {
    if (phase !== 'ready') return
    // Read the attempt count before the first sequence can change it.
    const before = await gameApi.getGameState(roomId)
    if (before.success) {
      baselineAttempts.current = before.attempts
      setAttemptsLeft(before.attemptsRemaining)
    }
    await startStream()
  }

  // restart re-runs the gauntlet inside the already-open stream; quit tears the
  // module down and hands the terminal back to the crew.
  const control = async (command: 'restart' | 'skip' | 'quit') => {
    if (phase !== 'streaming' && phase !== 'loading') return
    try {
      await gameApi.sendGameControl(roomId, command)
    } catch {
      setError('Could not reach the camera module. Alert the game master.')
      return
    }
    if (command === 'quit') {
      stopPolling()
      setStreamUrl(null)
      setPhase('ready')
    }
  }

  // The keys the game binds at its own window, bound here instead. SPACE and R
  // both restart, matching the native window where SPACE replays and R restarts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (phase !== 'streaming' && phase !== 'loading') return
      const key = e.key.toLowerCase()
      if (key === ' ' || key === 'spacebar' || key === 'r') {
        e.preventDefault()   // SPACE would otherwise scroll the kiosk page
        void control('restart')
      } else if (key === 'n') {
        e.preventDefault()
        void control('skip')
      } else if (key === 'q') {
        e.preventDefault()
        void control('quit')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // Re-bound when the phase changes, so the handler's own phase guard and the
    // control() it closes over are never a render behind.
  }, [phase])

  // Tearing down the component must also stop the camera: without the quit the
  // generator keeps running until Flask notices the dropped socket.
  useEffect(() => () => {
    stopPolling()
    void gameApi.sendGameControl(roomId, 'quit').catch(() => {})
  }, [roomId])

  const live = phase === 'streaming' || phase === 'loading'

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 select-none">
      <div className="text-center">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">LASER DEACTIVATION SEQUENCE</div>
        <h3 className="text-xl font-bold text-white tracking-widest">PHYSICAL POSE VERIFICATION</h3>
        <div className="font-mono text-[9px] text-[#669EFF]/60 tracking-[0.2em] mt-2">
          HOLD 7 OF 10 POSES TO CLEAR THE GRID
          {attemptsLeft !== null && ` - ${attemptsLeft} ATTEMPT${attemptsLeft === 1 ? '' : 'S'} REMAINING`}
        </div>
      </div>

      {error && (
        <div className="text-red-500 font-mono text-xs">{error}</div>
      )}

      {phase === 'ready' && (
        <button
          onClick={handleStart}
          className="border-2 px-16 py-6 font-mono font-bold text-sm tracking-[0.3em] transition-all duration-100 active:scale-95 cursor-pointer border-[#337DFF] text-white hover:bg-[#337DFF]/10"
        >
          LAUNCH CAMERA MODULE
        </button>
      )}

      {phase === 'spent' && (
        <div className="flex flex-col items-center gap-5">
          <div className="border border-[#FF3333]/50 bg-[#FF3333]/5 px-10 py-6 text-center">
            <div className="font-mono text-[9px] text-[#FF3333] tracking-[0.3em] mb-2">SEQUENCE FAILED</div>
            <p className="font-mono text-sm text-white tracking-wide">
              FEWER THAN 7 POSES HELD - ATTEMPT RECORDED
            </p>
            {attemptsLeft !== null && (
              <p className="font-mono text-xs text-[#669EFF]/70 tracking-wide mt-2">
                {attemptsLeft} ATTEMPT{attemptsLeft === 1 ? '' : 'S'} REMAINING
              </p>
            )}
          </div>
          <button
            onClick={startStream}
            className="border-2 px-12 py-4 font-mono font-bold text-sm tracking-[0.3em] transition-all active:scale-95 cursor-pointer border-[#337DFF] text-white hover:bg-[#337DFF]/10"
          >
            RUN SEQUENCE AGAIN
          </button>
        </div>
      )}

      {phase === 'loading' && (
        <div className="border border-[#337DFF]/40 bg-[#337DFF]/05 p-8 text-center animate-pulse">
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] mb-2 opacity-70">INITIALISING</div>
          <p className="font-mono text-sm text-[#337DFF] tracking-wide">
            LOADING POSE MODEL AND OPENING CAMERA - A FEW SECONDS...
          </p>
        </div>
      )}

      {streamUrl && (
        <img
          src={streamUrl}
          alt="Live pose tracking feed"
          onLoad={() => setPhase('streaming')}
          onError={() => { setError('Camera module failed to start. Alert the game master.'); setPhase('error') }}
          className={`border border-[#00FF88]/40 max-w-full max-h-[55vh] ${phase === 'loading' ? 'hidden' : 'block'}`}
        />
      )}

      {live && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3">
            <button
              onClick={() => control('restart')}
              className="border border-[#337DFF]/50 px-6 py-2 font-mono text-[11px] text-white tracking-[0.2em] hover:bg-[#337DFF]/20 active:scale-95 transition-all"
            >
              RESTART
            </button>
            <button
              onClick={() => control('skip')}
              className="border border-[#337DFF]/50 px-6 py-2 font-mono text-[11px] text-white tracking-[0.2em] hover:bg-[#337DFF]/20 active:scale-95 transition-all"
            >
              SKIP POSE
            </button>
            <button
              onClick={() => control('quit')}
              className="border border-[#FF3333]/50 px-6 py-2 font-mono text-[11px] text-[#FF6666] tracking-[0.2em] hover:bg-[#FF3333]/15 active:scale-95 transition-all"
            >
              END MODULE
            </button>
          </div>
          <div className="font-mono text-[9px] text-[#669EFF]/45 tracking-[0.2em]">
            SPACE / R RESTART - N SKIP POSE - Q END MODULE
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: CTLC Lab (Silent Communication)
// ---------------------------------------------------------------------------

// The ASL page owns the target phrase and only ever posts a message when the
// crew actually signs it correctly - it hands back the exact phrase it tested
// them on, so that (and only that) is what gets submitted as the room's
// answer. Previously this sent a fixed "SIGN_LANGUAGE_SUCCESS" string that
// could never match the room's real riddle answer, so finishing the ASL game
// could never actually clear CTLC_LAB.
function CTLCLabChallenge({ onSuccess }: { onSuccess: (submission: string) => void }) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'HEIST_SUCCESS') {
        onSuccess(event.data.phrase || '')
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onSuccess]);

  return (
    <div className="flex flex-col items-center h-full w-full overflow-y-auto">
      <iframe
        src="/sign_language_asl.html"
        className="w-full h-[70%] max-w-5xl mx-auto border-none bg-transparent flex-shrink-0"
        allow="camera"
        title="Sign Language Challenge"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: Music Room (Turing Test)
// ---------------------------------------------------------------------------

// Intercept pool includes both human guards and AI decoy syntheses.
interface AudioTrack {
  file: string
  type: 'HUMAN' | 'AI'
}

const AUDIO_TRACKS: AudioTrack[] = [
  { file: 'Hooman 1.mp3', type: 'HUMAN' },
  { file: 'voice_1_arvi_desi_conversational.mp3', type: 'AI' },
  { file: 'voice_2_monika_bored_flat.mp3', type: 'AI' },
  { file: 'hooman 2.mp3', type: 'HUMAN' },
  { file: 'voice_3_yatin_serious_punjabi.mp3', type: 'AI' },
  { file: 'voice_4_sanchit_scared_immersive.mp3', type: 'AI' },
  { file: 'voice_5_parveen_indian_male.mp3', type: 'AI' },
  { file: 'voice_6_nikita_encouraging_serious.mp3', type: 'AI' },
]

const PASS_THRESHOLD = 5 // Need to correctly classify at least 5 out of 8

function MusicRoomChallenge({ onSuccess, onFail }: { onSuccess: (submission: string) => void; onFail: () => void }) {
  const [currentIdx, setCurrentIdx] = useState(0)
  const [classifications, setClassifications] = useState<Array<'HUMAN' | 'AI'>>([])
  const [choice, setChoice] = useState<'HUMAN' | 'AI' | null>(null)
  const [phase, setPhase] = useState<'listening' | 'result' | 'done'>('listening')
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null)
  const total = AUDIO_TRACKS.length
  const currentTrack = AUDIO_TRACKS[currentIdx]

  const handleClassify = () => {
    if (!choice) return
    const correct = choice === currentTrack.type
    const newClassifications = [...classifications, choice]
    setClassifications(newClassifications)
    setLastCorrect(correct)
    setPhase('result')

    setTimeout(() => {
      if (currentIdx + 1 >= total) {
        // All done — tally score
        const correctCount = newClassifications.reduce(
          (acc, c, i) => acc + (c === AUDIO_TRACKS[i].type ? 1 : 0),
          0
        )
        if (correctCount >= PASS_THRESHOLD) {
          onSuccess('ai')
        } else {
          onFail()
        }
      } else {
        setCurrentIdx(i => i + 1)
        setChoice(null)
        setLastCorrect(null)
        setPhase('listening')
      }
    }, 1800)
  }

  const audioSrc = `/audio/${encodeURIComponent(currentTrack.file)}`

  return (
    <div className="flex h-full gap-6 max-w-3xl mx-auto py-4">
      {/* Audio pane */}
      <div className="flex-1 border border-[#337DFF]/30 bg-[#0a0f1e] flex flex-col">
        <div className="border-b border-[#337DFF]/20 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
            <div className="font-mono text-[9px] text-[#669EFF] tracking-widest">GUARD FREQUENCY 7.4 MHz - LIVE</div>
          </div>
          <div className="font-mono text-[9px] text-[#337DFF] tracking-widest opacity-70">
            INTERCEPT {currentIdx + 1} / {total}
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex gap-2 px-4 pt-3">
          {AUDIO_TRACKS.map((track, i) => (
            <div
              key={i}
              className="flex-1 h-1 rounded-full transition-all"
              style={{
                background: i < currentIdx
                  ? (classifications[i] === AUDIO_TRACKS[i].type ? '#00FF88' : '#FF3333')
                  : i === currentIdx ? '#337DFF' : '#337DFF22'
              }}
            />
          ))}
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
          {phase === 'result' && lastCorrect !== null ? (
            <div
              className="text-center py-6 px-10 border animate-pulse"
              style={{
                borderColor: lastCorrect ? '#00FF88' : '#FF3333',
                background: lastCorrect ? 'rgba(0,255,136,0.05)' : 'rgba(255,51,51,0.05)',
              }}
            >
              <div
                className="font-digital text-4xl mb-2"
                style={{ color: lastCorrect ? '#00FF88' : '#FF3333' }}
              >
                {lastCorrect ? 'CORRECT' : 'INCORRECT'}
              </div>
              <div className="font-mono text-xs tracking-widest" style={{ color: lastCorrect ? '#00FF88' : '#FF3333' }}>
                {lastCorrect
                  ? (currentTrack.type === 'AI' ? 'AI DECOY IDENTIFIED' : 'HUMAN OPERATOR IDENTIFIED')
                  : (currentTrack.type === 'AI' ? 'MISCLASSIFIED - SIGNAL WAS AI' : 'MISCLASSIFIED - SIGNAL WAS HUMAN')}
              </div>
            </div>
          ) : (
            <>
              <div className="font-mono text-sm text-[#337DFF]/70 tracking-widest">
                INTERCEPTED TRANSMISSION #{currentIdx + 1}
              </div>
              <audio
                key={audioSrc}
                controls
                autoPlay
                src={audioSrc}
                className="w-full grayscale invert opacity-80"
              />
            </>
          )}
        </div>

        {/* Waveform */}
        <div className="border-t border-[#337DFF]/20 px-4 py-3 flex items-center justify-center gap-1">
          {Array.from({ length: 60 }).map((_, i) => (
            <div
              key={i}
              className="w-0.5 bg-[#337DFF] rounded-full"
              style={{
                height: `${4 + Math.sin(i * 0.8) * 8}px`,
                opacity: 0.4 + (i % 3) * 0.15,
              }}
            />
          ))}
        </div>
      </div>

      {/* Classification pane */}
      <div className="w-56 border border-[#337DFF]/30 bg-[#0a0f1e] flex flex-col p-6 gap-6">
        <div>
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] opacity-70 mb-1">CLASSIFY ENTITY</div>
          <div className="font-mono text-[9px] text-[#669EFF]/50 tracking-widest mb-4">
            NEED {PASS_THRESHOLD}/{total} CORRECT
          </div>
          {phase === 'listening' ? (
            <div className="space-y-3">
              {(['HUMAN', 'AI'] as const).map(opt => (
                <button
                  key={opt}
                  onClick={() => setChoice(opt)}
                  className="w-full border py-3 font-mono text-xs font-bold tracking-widest transition-all duration-200"
                  style={{
                    borderColor: choice === opt ? (opt === 'HUMAN' ? '#00FF88' : '#FF3333') : '#337DFF44',
                    color: choice === opt ? (opt === 'HUMAN' ? '#00FF88' : '#FF3333') : '#aabddd',
                    background: choice === opt ? (opt === 'HUMAN' ? 'rgba(0,255,136,0.08)' : 'rgba(255,51,51,0.08)') : 'transparent',
                  }}
                >
                  {opt === 'HUMAN' ? '◉ HUMAN' : '⊗ AI DECOY'}
                </button>
              ))}
            </div>
          ) : (
            <div className="font-mono text-[9px] text-[#669EFF]/50 tracking-widest text-center py-4">
              {currentIdx + 1 < total ? 'LOADING NEXT...' : 'TALLYING RESULTS...'}
            </div>
          )}
        </div>

        <div className="mt-auto">
          <button
            onClick={handleClassify}
            disabled={!choice || phase !== 'listening'}
            className="w-full bg-[#337DFF] py-3 font-mono text-xs font-bold text-white tracking-widest hover:bg-[#4488ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            CLASSIFY
          </button>
          <div className="font-mono text-[8px] text-[#337DFF]/30 tracking-widest text-center mt-3">
            LISTEN THEN CLASSIFY<br />CANNOT GO BACK
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: H2 Lounge (Memory + Description)
// ---------------------------------------------------------------------------

// The Flask ML service's own origin. Vite's dev proxy only forwards /api, not
// /static, and the images route returns paths like /static/images/foo.jpg -
// so those need the real backend origin, not a hardcoded guess (this used to
// be a bare "http://localhost:5000", which 403s on macOS because that port is
// AirPlay Receiver, not Flask - see run.md). The fallback tracks the port
// app.py listens on, so a device that never set VITE_API_BASE_URL still works.
const ML_ORIGIN = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4000'

// Three memorise-and-reconstruct rounds, six fresh online photos in total
// (two per round). Mirrors backend/app.py's MEMORY_TOTAL_ROUNDS - the crew's
// browser drives round advancement, but the server decides pass/fail and
// grades every image against the original with real CLIP/SSIM scoring, not
// this component.
function H2LoungeChallenge({ timerSeconds, onSuccess, onFail }: { timerSeconds: number; onSuccess: (submission?: string) => void; onFail: () => void }) {
  const [round, setRound] = useState(1)
  const [totalRounds, setTotalRounds] = useState(3)
  const [phase, setPhase] = useState<'loading' | 'viewing' | 'input' | 'generating' | 'roundResult' | 'final'>('loading')
  const [countdown, setCountdown] = useState(timerSeconds)
  const [images, setImages] = useState<{ left: string; right: string }>({ left: '', right: '' })
  const [prompts, setPrompts] = useState({ left: '', right: '' })
  const [generated, setGenerated] = useState<{ left: string; right: string }>({ left: '', right: '' })
  const [roundScore, setRoundScore] = useState<number | null>(null)
  const [roundPassed, setRoundPassed] = useState(false)
  const [overallPassed, setOverallPassed] = useState(false)
  const [passes, setPasses] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    setPhase('loading')
    setPrompts({ left: '', right: '' })
    gameApi.getMemoryImages(round).then(res => {
      if (res.success && res.left && res.right) {
        setImages({ left: res.left.startsWith('http') ? res.left : `${ML_ORIGIN}${res.left}`, right: res.right.startsWith('http') ? res.right : `${ML_ORIGIN}${res.right}` })
        setTotalRounds(res.totalRounds ?? 3)
        setCountdown(res.displaySeconds ?? timerSeconds)
        setPhase('viewing')
      } else {
        setError(res.error || 'Failed to load images')
      }
    }).catch(() => {
      setError('Network error loading images')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round])

  useEffect(() => {
    if (phase !== 'viewing') return
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(t)
          setPhase('input')
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [phase])

  const handleSubmit = async () => {
    if (prompts.left.trim().length < 5 || prompts.right.trim().length < 5) return
    setPhase('generating')
    try {
      const res = await gameApi.generateMemoryImages(prompts.left, prompts.right)
      if (res.success && res.generatedLeft && res.generatedRight) {
        setGenerated({
          left: res.generatedLeft.startsWith('http') ? res.generatedLeft : `${ML_ORIGIN}${res.generatedLeft}`,
          right: res.generatedRight.startsWith('http') ? res.generatedRight : `${ML_ORIGIN}${res.generatedRight}`
        })
        setRoundScore(res.roundScore ?? null)
        setRoundPassed(!!res.roundPassed)
        if (res.final) {
          setOverallPassed(!!res.overallPassed)
          setPasses(res.passes ?? 0)
          setPhase('final')
        } else {
          setPhase('roundResult')
        }
      } else {
        setError(res.error || 'Failed to generate images')
        setPhase('input')
      }
    } catch (e) {
      setError('Network error during generation')
      setPhase('input')
    }
  }

  const handleContinue = () => {
    setRound(r => r + 1)
  }

  const handleFinish = () => {
    if (overallPassed) onSuccess(`MEMORY_ROUNDS_${passes}_OF_${totalRounds}`)
    else onFail()
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 max-w-4xl mx-auto">
      <div className="text-center">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">
          TARGET ARTEFACTS - CLASSIFIED - ROUND {round} OF {totalRounds}
        </div>
        <h3 className="text-xl font-bold text-white tracking-widest">MEMORISE AND RECONSTRUCT</h3>
      </div>

      {error && <div className="text-[#FF3333] font-mono text-xs">{error}</div>}

      {phase === 'loading' && (
        <div className="text-[#337DFF] font-mono text-sm tracking-widest animate-pulse">FETCHING CLASSIFIED INTEL...</div>
      )}

      {phase === 'viewing' && (
        <div className="relative w-full flex gap-4">
          <img src={images.left} alt="Target 1" className="w-1/2 h-64 object-cover border border-[#337DFF]/40" />
          <img src={images.right} alt="Target 2" className="w-1/2 h-64 object-cover border border-[#337DFF]/40" />
          <div
            className="absolute inset-0 border border-[#FF3333]/60 flex items-end p-3 pointer-events-none"
            style={{ background: 'linear-gradient(to top, rgba(255,51,51,0.25) 0%, transparent 60%)' }}
          >
            <div className="font-mono text-[9px] text-[#FF3333] tracking-widest">
              SELF-DESTRUCT IN {countdown}s
            </div>
            <div
              className="absolute bottom-0 left-0 h-0.5 bg-[#FF3333]"
              style={{ width: `${(countdown / timerSeconds) * 100}%`, transition: 'width 1s linear' }}
            />
          </div>
          <div className="absolute top-2 right-2 font-digital text-2xl text-[#FF3333] pointer-events-none">
            {String(countdown).padStart(2, '0')}
          </div>
        </div>
      )}

      {phase === 'input' && (
        <div className="w-full space-y-4">
          <div className="border border-[#FF3333]/30 bg-[#FF3333]/05 p-4 font-mono text-xs text-[#FF3333]/80 tracking-widest text-center">
            IMAGES DESTROYED - RECONSTRUCTION PHASE ACTIVE
          </div>
          <div className="flex gap-4">
            <div className="w-1/2">
              <div className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] opacity-70 mb-2">DESCRIBE LEFT IMAGE</div>
              <textarea
                value={prompts.left}
                onChange={e => setPrompts(p => ({ ...p, left: e.target.value }))}
                placeholder="Describe colours, composition, features..."
                rows={4}
                className="w-full bg-[#0a0f1e] border border-[#337DFF]/40 px-4 py-3 font-mono text-sm text-white placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors resize-none"
              />
            </div>
            <div className="w-1/2">
              <div className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] opacity-70 mb-2">DESCRIBE RIGHT IMAGE</div>
              <textarea
                value={prompts.right}
                onChange={e => setPrompts(p => ({ ...p, right: e.target.value }))}
                placeholder="Describe colours, composition, features..."
                rows={4}
                className="w-full bg-[#0a0f1e] border border-[#337DFF]/40 px-4 py-3 font-mono text-sm text-white placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors resize-none"
              />
            </div>
          </div>
          <button
            onClick={handleSubmit}
            disabled={prompts.left.trim().length < 5 || prompts.right.trim().length < 5}
            className="w-full bg-[#337DFF] py-3 font-mono text-xs font-bold text-white tracking-[0.3em] hover:bg-[#4488ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            SYNTHESIZE RECONSTRUCTION
          </button>
        </div>
      )}

      {phase === 'generating' && (
        <div className="flex flex-col items-center justify-center p-12 border border-[#337DFF]/30 w-full bg-[#0a0f1e]">
          <div className="w-8 h-8 border-4 border-[#337DFF]/20 border-t-[#337DFF] rounded-full animate-spin mb-4" />
          <div className="font-mono text-xs text-[#337DFF] tracking-widest">
            AI SYNTHESIZING NEURAL RECONSTRUCTION...
          </div>
        </div>
      )}

      {(phase === 'roundResult' || phase === 'final') && (
        <div className="w-full space-y-6">
          <div className="flex gap-4">
            <div className="w-1/2 space-y-2 text-center">
              <div className="font-mono text-[9px] text-[#00FF88] tracking-widest">RECONSTRUCTION ALPHA</div>
              <img src={generated.left} alt="Generated 1" className="w-full h-64 object-cover border border-[#00FF88]/40" />
            </div>
            <div className="w-1/2 space-y-2 text-center">
              <div className="font-mono text-[9px] text-[#00FF88] tracking-widest">RECONSTRUCTION BETA</div>
              <img src={generated.right} alt="Generated 2" className="w-full h-64 object-cover border border-[#00FF88]/40" />
            </div>
          </div>

          <div className={`border p-4 text-center font-mono ${roundPassed ? 'border-[#00FF88]/40 bg-[#00FF88]/05 text-[#00FF88]' : 'border-[#FFAA00]/40 bg-[#FFAA00]/05 text-[#FFAA00]'}`}>
            <div className="text-[9px] tracking-[0.3em] opacity-70 mb-1">ROUND {round} MATCH SCORE</div>
            <div className="text-2xl font-bold">{roundScore ?? '-'}/10</div>
            <div className="text-xs tracking-widest mt-1">{roundPassed ? 'CLOSE ENOUGH TO THE TRUTH' : 'TOO FAR FROM THE ORIGINAL'}</div>
          </div>

          {phase === 'roundResult' && (
            <button
              onClick={handleContinue}
              className="w-full border border-[#337DFF] bg-[#337DFF]/10 py-4 font-mono text-sm font-bold text-white tracking-[0.3em] hover:bg-[#337DFF]/20 transition-all active:scale-95"
            >
              PROCEED TO ROUND {round + 1} OF {totalRounds}
            </button>
          )}

          {phase === 'final' && (
            <div className="space-y-3">
              <div className={`border p-4 text-center font-mono ${overallPassed ? 'border-[#00FF88]/40 bg-[#00FF88]/05 text-[#00FF88]' : 'border-[#FF3333]/40 bg-[#FF3333]/05 text-[#FF3333]'}`}>
                <div className="text-[9px] tracking-[0.3em] opacity-70 mb-1">FINAL RESULT</div>
                <div className="text-lg font-bold tracking-widest">
                  {passes} OF {totalRounds} ROUNDS PASSED
                </div>
              </div>
              <button
                onClick={handleFinish}
                className={`w-full border py-4 font-mono text-sm font-bold tracking-[0.3em] transition-all active:scale-95 ${
                  overallPassed
                    ? 'border-[#00FF88] bg-[#00FF88]/10 text-[#00FF88] hover:bg-[#00FF88]/20'
                    : 'border-[#FF3333] bg-[#FF3333]/10 text-[#FF3333] hover:bg-[#FF3333]/20'
                }`}
              >
                {overallPassed ? 'SUBMIT FOR VERIFICATION' : 'ACKNOWLEDGE FAILURE'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: Classroom 1101 (Neural Bypass)
// ---------------------------------------------------------------------------

function ClassroomChallenge({ onSuccess }: { onSuccess: (submission: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8">
      <div className="text-center">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">NEURAL NETWORK BYPASS</div>
        <h3 className="text-xl font-bold text-white tracking-widest">SUBMIT THE INJECTION SIGNATURE</h3>
      </div>
      <ManualAnswerFallback label="ENTER THE BYPASS VALUES" onSubmit={onSuccess} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: Nose Draw (Sketch Portal)
// ---------------------------------------------------------------------------

// Like the ASL page, the sketch page judges the attempt in the browser and hands
// back the token it accepted, which is what gets submitted. It used to submit
// nothing at all - an empty submission normalises to NULL server-side and
// matches no answer, so a crew that drew the circle correctly was recorded as a
// failed attempt and, three tries in, locked out of a room they had solved.
function NoseDrawChallenge({ onSuccess, onFail }: { onSuccess: (submission: string) => void; onFail: () => void }) {
  const [phase, setPhase] = useState<'ready' | 'drawing' | 'done'>('ready')

  useEffect(() => {
    if (phase !== 'drawing') return
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOSE_DRAW_SUCCESS') onSuccess(event.data.phrase || '')
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [phase, onSuccess])

  return (
    <div className="flex flex-col items-center h-full w-full gap-4">
      <div className="text-center flex-shrink-0">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">BIOMETRIC SKETCH VALIDATION</div>
        <h3 className="text-xl font-bold text-white tracking-widest">NOSE-DRAW CHALLENGE</h3>
      </div>

      {phase === 'ready' && (
        <div className="flex flex-col items-center gap-6">
          <div className="border border-[#337DFF]/30 bg-[#0a0f1e] p-6 max-w-sm text-center">
            <div className="text-5xl mb-4 opacity-60">👃</div>
            <div className="font-mono text-xs text-[#aabddd] leading-relaxed">
              Use your nose to draw <span className="text-[#337DFF] font-bold">CAT EARS</span> in the air.
              Follow the blue guide on screen.
            </div>
          </div>
          <button
            onClick={() => setPhase('drawing')}
            className="border-2 border-[#337DFF] px-16 py-6 font-mono font-bold text-sm tracking-[0.3em] text-white hover:bg-[#337DFF]/10 transition-all active:scale-95"
          >
            LAUNCH NOSE CAMERA MODULE
          </button>
        </div>
      )}

      {phase === 'drawing' && (
        <iframe
          src="/nose_draw.html"
          className="flex-1 w-full max-w-5xl mx-auto border border-[#337DFF]/30"
          allow="camera"
          title="Nose Draw Challenge"
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Active challenge wrapper
// ---------------------------------------------------------------------------

function GiveUpButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const handleClick = () => {
    if (!armed) {
      setArmed(true)
      timerRef.current = setTimeout(() => setArmed(false), 4000)
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    onConfirm()
  }

  return (
    <button
      onClick={handleClick}
      className={`border px-4 py-2 font-mono text-[9px] tracking-[0.2em] transition-colors ${
        armed
          ? 'border-red-500 bg-red-500/10 text-red-400'
          : 'border-red-500/30 text-red-400/60 hover:border-red-500/60 hover:text-red-400'
      }`}
    >
      {armed ? 'CONFIRM GIVE UP?' : 'GIVE UP'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Operations base (HUB)
// ---------------------------------------------------------------------------
// The hub does not authenticate anyone. Crews are handed their team code,
// passcode and first riddle by hand here, and the run's clock starts when they
// sign in at their first ROOM - not here. So this terminal is a sign, not a
// kiosk: it deliberately has no team-code prompt to mistype into.
function HubScreen({ label, terminalId }: { label: string; terminalId: string }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
      <div className="max-w-3xl w-full mx-8 text-center">
        <div className="font-mono text-[10px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-3">
          {terminalId} - OPERATIONS BASE
        </div>
        <h1 className="text-4xl md:text-5xl font-black text-white tracking-widest mb-8">{label}</h1>

        <div className="border-2 border-[#337DFF]/50 bg-[#337DFF]/05 px-8 py-10 text-left">
          <div className="font-mono text-[11px] text-[#337DFF] tracking-[0.4em] mb-5 opacity-80">
            BRIEFING PROCEDURE
          </div>
          <ol className="font-mono text-lg md:text-xl text-white leading-relaxed space-y-3 list-decimal list-inside">
            <li>Hand the crew their team code and passcode.</li>
            <li>Hand them their first riddle on paper.</li>
            <li>Send them off - their clock starts when they sign in at that room.</li>
          </ol>
          <div className="w-full h-px bg-[#337DFF]/25 my-7" />
          <p className="font-mono text-sm text-[#aabddd] leading-relaxed">
            No sign-in happens at this terminal. Standings and per-room times are
            read with the operator CLI:
            <span className="text-[#00FF88]"> node scripts/operator.mjs leaderboard</span>.
          </p>
        </div>
      </div>
    </div>
  )
}

function ActiveScreen({
  config,
  roomId,
  teamId,
  onSuccess,
  onFail,
  onGiveUp,
  onAttemptsChanged,
}: {
  config: RoomConfigData
  roomId: RoomId
  teamId: string
  onSuccess: (opts: { submission?: string; elapsedSeconds?: number }) => void
  onFail: () => void
  onGiveUp: () => void
  onAttemptsChanged: (remaining: number) => void
}) {
  return (
    <div className="fixed inset-0 flex flex-col z-10">
      {/* Header bar */}
      {/* pr reserves room for the fixed KioskBadge clock/terminal readout in
          the top-right corner (top-4 right-4 z-50, present on every screen),
          so this row's own right-aligned content does not render underneath it. */}
      <div className="border-b border-[#337DFF]/20 pl-8 pr-64 py-3 flex items-center justify-between flex-shrink-0">
        <div>
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] opacity-70">OPERATIVE: {teamId}</div>
          <div className="font-mono text-xs text-white tracking-widest font-bold">{config.label}</div>
        </div>
        <div className="flex items-center gap-4">
          <div className="font-mono text-[9px] text-[#337DFF]/50 tracking-widest">
            {config.terminalId} - ACTIVE SESSION
          </div>
          <GiveUpButton onConfirm={onGiveUp} />
        </div>
      </div>

      {/* Challenge area */}
      <div className="flex-1 px-8 py-6 overflow-hidden">
        {roomId === 'YOGA_ROOM' && (
          <YogaRoomChallenge
            roomId={roomId}
            timerSeconds={config.timerSeconds}
            onSuccess={elapsed => onSuccess({ elapsedSeconds: elapsed })}
            // The pose game already reported the failure and Supabase already
            // closed the room out, so this only has to surface the outcome and
            // the next room's riddle - onFail's submit_answer call hits the
            // locked_out branch, which returns exactly that and changes nothing.
            onResolvedFail={onFail}
            onAttemptsChanged={onAttemptsChanged}
          />
        )}
        {roomId === 'CTLC_LAB' && (
          <CTLCLabChallenge
            onSuccess={submission => onSuccess({ submission })}
          />
        )}
        {roomId === 'MUSIC_ROOM' && (
          <MusicRoomChallenge
            onSuccess={submission => onSuccess({ submission })}
            onFail={onFail}
          />
        )}
        {roomId === 'H2_LOUNGE' && (
          <H2LoungeChallenge
            timerSeconds={config.timerSeconds}
            onSuccess={submission => onSuccess({ submission: submission ?? 'FLUX_SUCCESS' })}
            onFail={onFail}
          />
        )}
        {roomId === 'CLASSROOM_1101' && (
          <ClassroomChallenge
            onSuccess={submission => onSuccess({ submission })}
          />
        )}
        {roomId === 'NOSE_DRAW' && (
          <NoseDrawChallenge
            onSuccess={submission => onSuccess({ submission })}
            onFail={onFail}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main App - loads config from server, orchestrates screens
// ---------------------------------------------------------------------------

export default function App() {
  const roomId = CURRENT_ROOM_ID
  const [roomConfig, setRoomConfig] = useState<RoomConfigData | null>(null)
  const [configError, setConfigError] = useState(false)

  const [screen, setScreen] = useState<Screen>('idle')
  const [attemptsLeft, setAttemptsLeft] = useState(DEFAULT_MAX_ATTEMPTS)
  const [teamId, setTeamId] = useState('')
  const [successClue, setSuccessClue] = useState('')
  const [gaveUp, setGaveUp] = useState(false)
  const [nextRiddle, setNextRiddle] = useState<NextRiddlePreview | null>(null)

  // Fetch room config from the backend on mount
  useEffect(() => {
    gameApi.getRoomConfig(roomId).then(res => {
      if (res.success) {
        setRoomConfig(res.data)
        setAttemptsLeft(res.data.maxAttempts)
      } else {
        setConfigError(true)
      }
    }).catch(() => setConfigError(true))
  }, [roomId])

  const reset = () => {
    setScreen('idle')
    setAttemptsLeft(roomConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    setTeamId('')
    setSuccessClue('')
    setGaveUp(false)
    setNextRiddle(null)
  }

  const handleAuthSuccess = (id: string) => {
    setTeamId(id)
    setScreen('briefing')
  }

  const handleChallengeSuccess = async (opts: { submission?: string; elapsedSeconds?: number }) => {
    try {
      const res = await gameApi.validateTask(roomId, {
        submission: opts.submission ?? '',
        elapsedSeconds: opts.elapsedSeconds ?? 0,
      })
      if (res.success) {
        setSuccessClue(res.clue ?? '')
        setNextRiddle(res.nextRiddle ?? null)
        setScreen('success')
      } else {
        const next = attemptsLeft - 1
        setAttemptsLeft(next)
        // nextRiddle is only present once the server considers the room
        // resolved (this was the last attempt) - null on a mid-run retry.
        if (res.nextRiddle !== undefined) setNextRiddle(res.nextRiddle ?? null)
        if (next <= 0 || res.lockout) setScreen('lockout')
        else setScreen('resolution')
      }
    } catch {
      // If backend is unreachable, still allow local success
      setScreen('success')
    }
  }

  const handleChallengeFail = async () => {
    try {
      const res = await gameApi.validateTask(roomId, { submission: '__FAIL__', elapsedSeconds: 0 })
      const left = res.attemptsRemaining ?? attemptsLeft - 1
      setAttemptsLeft(left)
      if (res.nextRiddle !== undefined) setNextRiddle(res.nextRiddle ?? null)
      if (left <= 0 || res.lockout) setScreen('lockout')
      else setScreen('resolution')
    } catch {
      const next = attemptsLeft - 1
      setAttemptsLeft(next)
      if (next <= 0) setScreen('lockout')
      else setScreen('resolution')
    }
  }

  // A crew can quit a room outright. This always registers as a fail on the
  // server - abandon_room() stamps the visit locked_out and logs a failed
  // answer_attempts row - so the record of pass/fail is server-side and
  // tamper-proof either way, same as every other resolution in this app.
  const handleGiveUp = async () => {
    setGaveUp(true)
    try {
      const res = await gameApi.abandonRoom(roomId)
      setNextRiddle(res.nextRiddle ?? null)
    } catch {
      // Even if the network call failed, honour the crew's choice locally so
      // they are not stuck on a broken terminal - the server is the source of
      // truth for scoring, and a failed abandon call still leaves the visit
      // as in_progress there, which a game master can resolve manually.
    }
    setAttemptsLeft(0)
    setScreen('lockout')
  }

  // The hub is not a playable terminal and never signs a crew in, so it short
  // circuits the whole idle -> auth -> challenge machine below. Its labels come
  // from the local room table rather than roomConfig, so the briefing board
  // still reads correctly even when the backend is unreachable.
  if (IS_HUB) {
    const hubLabel = roomConfig?.label ?? ROOM_LABELS[roomId]
    const hubTerminal = roomConfig?.terminalId ?? roomId
    return (
      <div className="fixed inset-0 bg-[#000307] overflow-hidden">
        <BackgroundLayer />
        <ScanlineOverlay />
        <KioskBadge label={hubLabel} terminalId={hubTerminal} />
        <HubScreen label={hubLabel} terminalId={hubTerminal} />
      </div>
    )
  }

  // Loading / error fallback
  if (configError) {
    return (
      <div className="fixed inset-0 bg-[#000307] flex items-center justify-center">
        <div className="text-center">
          {/* This fires when the room's config cannot be read, which is a
              Supabase problem, not a Flask one - only two devices even run
              Flask. The old copy named a local port and sent operators
              hunting for the wrong service. */}
          <div className="font-mono text-[#FF3333] tracking-widest mb-4">TERMINAL OFFLINE</div>
          <div className="font-mono text-xs text-[#669EFF]/60 leading-relaxed">
            Cannot reach the event backend.<br />
            Check this device's network, then VITE_SUPABASE_URL and
            VITE_SUPABASE_ANON_KEY in .env.local.
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 border border-[#337DFF] px-6 py-2 font-mono text-xs text-white tracking-widest hover:bg-[#337DFF]/20"
          >
            RETRY CONNECTION
          </button>
        </div>
      </div>
    )
  }

  const label = roomConfig?.label ?? ROOM_LABELS[roomId]
  const terminalId = roomConfig?.terminalId ?? roomId
  const maxAttempts = roomConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  return (
    <div className="fixed inset-0 bg-[#000307] overflow-hidden">
      <BackgroundLayer />
      <ScanlineOverlay />

      <KioskBadge label={label} terminalId={terminalId} />
      {(screen === 'active' || screen === 'briefing') && (
        <AttemptTracker remaining={attemptsLeft} max={maxAttempts} />
      )}

      {screen === 'idle' && (
        <IdleScreen label={label} terminalId={terminalId} onAuthenticate={() => setScreen('auth')} />
      )}

      {screen === 'auth' && (
        <>
          <IdleScreen label={label} terminalId={terminalId} onAuthenticate={() => {}} />
          <AuthModal
            terminalId={terminalId}
            onSuccess={handleAuthSuccess}
            onCancel={() => setScreen('idle')}
          />
        </>
      )}

      {screen === 'briefing' && roomConfig && (
        <BriefingScreen config={roomConfig} teamId={teamId} onStart={() => setScreen('active')} />
      )}

      {screen === 'active' && roomConfig && (
        <ActiveScreen
          config={roomConfig}
          roomId={roomId}
          teamId={teamId}
          onSuccess={handleChallengeSuccess}
          onFail={handleChallengeFail}
          onGiveUp={handleGiveUp}
          // The machine-graded rooms burn attempts server-side, so the header's
          // tracker has to be told rather than counting submissions itself.
          onAttemptsChanged={setAttemptsLeft}
        />
      )}

      {screen === 'resolution' && (
        <ResolutionScreen
          success={false}
          clue={successClue}
          teamId={teamId}
          terminalId={terminalId}
          attemptsLeft={attemptsLeft}
          maxAttempts={maxAttempts}
          onRetry={() => setScreen('briefing')}
          onReset={reset}
        />
      )}

      {screen === 'success' && (
        <ResolutionScreen
          success={true}
          clue={successClue}
          teamId={teamId}
          terminalId={terminalId}
          attemptsLeft={attemptsLeft}
          maxAttempts={maxAttempts}
          nextRiddle={nextRiddle}
          onRetry={() => setScreen('briefing')}
          onReset={reset}
        />
      )}

      {screen === 'lockout' && (
        <ResolutionScreen
          success={false}
          clue=""
          teamId={teamId}
          terminalId={terminalId}
          attemptsLeft={0}
          maxAttempts={maxAttempts}
          gaveUp={gaveUp}
          nextRiddle={nextRiddle}
          onRetry={() => {}}
          onReset={reset}
        />
      )}
    </div>
  )
}

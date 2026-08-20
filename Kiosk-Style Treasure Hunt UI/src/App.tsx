import { useState, useEffect, useRef, useCallback } from 'react'
import imgBackground from '@/imports/LaserGrid/73ecf9f6066a41d6d2daab627902dcec860f5ac3.png'
import { gameApi, poseStreamUrl, type RoomConfigData } from '@/services/api'
import { CURRENT_ROOM_ID, DEFAULT_MAX_ATTEMPTS, ROOM_LABELS, type RoomId } from '@/config/gameSettings'

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
          AI@PLAKSHA - TREASURE HUNT 2024
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

        <div className="border-l-2 border-[#337DFF] pl-4 mb-8">
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] mb-1">DIRECTIVE</div>
          <p className="text-white text-sm font-mono">{config.hint}</p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[9px] text-[#669EFF] opacity-50 tracking-widest">INTEL VALUE</div>
            <div className="font-digital text-2xl text-[#337DFF]">{config.points} PTS</div>
          </div>
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

function ResolutionScreen({
  success,
  clue,
  points,
  teamId,
  terminalId,
  attemptsLeft,
  maxAttempts,
  onRetry,
  onReset,
}: {
  success: boolean
  clue?: string
  points?: number
  teamId: string
  terminalId: string
  attemptsLeft: number
  maxAttempts: number
  onRetry: () => void
  onReset: () => void
}) {
  if (!success && attemptsLeft === 0) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
        <div className="text-center max-w-xl mx-8">
          <div className="font-digital text-8xl text-red-500 mb-4">000</div>
          <div className="font-mono text-[9px] tracking-[0.4em] text-red-400 mb-6 opacity-70">TERMINAL LOCKOUT</div>
          <h2 className="text-3xl font-black text-white mb-4 tracking-wide">OPERATION COMPROMISED</h2>
          <p className="text-[#aabddd] text-sm mb-8 font-light leading-relaxed">
            All authentication attempts exhausted. This terminal has been locked. Alert the game master for manual override.
          </p>
          <div className="border border-red-500/30 bg-red-500/05 px-6 py-4 mb-8 font-mono text-xs text-red-400/70 tracking-widest">
            TERMINAL {terminalId} - LOCKED - TEAM: {teamId}
          </div>
          <button
            onClick={onReset}
            className="border border-red-500/50 px-8 py-3 font-mono text-xs text-red-400 tracking-widest hover:bg-red-500/10 transition-colors"
          >
            GAME MASTER RESET
          </button>
        </div>
      </div>
    )
  }

  if (!success) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center z-10">
        <div className="text-center max-w-xl mx-8">
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
      <div className="max-w-2xl w-full mx-8">
        <div className="text-center mb-8">
          <div className="font-digital text-7xl text-[#00FF88] mb-2">ACCESS</div>
          <div className="font-digital text-7xl text-[#00FF88]">GRANTED</div>
        </div>

        <div className="border border-[#00FF88]/40 bg-[#00FF88]/05 p-8">
          <div className="font-mono text-[9px] text-[#00FF88] tracking-[0.3em] mb-4 opacity-70">
            INTEL RETRIEVED - {points} POINTS AWARDED - OPERATIVE: {teamId}
          </div>
          <div className="w-full h-px bg-[#00FF88]/20 mb-4" />
          <div className="font-mono text-[9px] text-[#00FF88] tracking-[0.3em] mb-2 opacity-60">CLASSIFIED CLUE</div>
          <p className="font-mono text-sm text-white leading-relaxed tracking-wide">{clue}</p>
        </div>

        <div className="flex justify-center mt-8">
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

function YogaRoomChallenge({ roomId, timerSeconds, onSuccess, onManualSubmit }: { roomId: string; timerSeconds: number; onSuccess: (elapsed: number) => void; onManualSubmit: (text: string) => void }) {
  const [phase, setPhase] = useState<'ready' | 'loading' | 'streaming' | 'error'>('ready')
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const handleStart = async () => {
    if (phase !== 'ready') return
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
    setStreamUrl(url)

    intervalRef.current = setInterval(async () => {
      const stateRes = await gameApi.getGameState(roomId)
      if (stateRes.success && stateRes.completed) {
        clearInterval(intervalRef.current!)
        onSuccess(timerSeconds)
      }
    }, 2000)
  }

  useEffect(() => () => clearInterval(intervalRef.current!), [])

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 select-none">
      <div className="text-center">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">LASER DEACTIVATION SEQUENCE</div>
        <h3 className="text-xl font-bold text-white tracking-widest">PHYSICAL POSE VERIFICATION</h3>
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

      {phase === 'loading' && (
        <div className="border border-[#337DFF]/40 bg-[#337DFF]/05 p-8 text-center animate-pulse">
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] mb-2 opacity-70">INITIALISING</div>
          <p className="font-mono text-sm text-[#337DFF] tracking-wide">
            LOADING POSE MODEL AND OPENING CAMERA - A FEW SECONDS...
          </p>
        </div>
      )}

      {(phase === 'loading' || phase === 'streaming') && streamUrl && (
        <img
          src={streamUrl}
          alt="Live pose tracking feed"
          onLoad={() => setPhase('streaming')}
          onError={() => { setError('Camera module failed to start. Type your answer below instead.'); setPhase('error') }}
          className="border border-[#00FF88]/40 max-w-full max-h-[60vh]"
        />
      )}

      <ManualAnswerFallback onSubmit={onManualSubmit} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: CTLC Lab (Silent Communication)
// ---------------------------------------------------------------------------

function CTLCLabChallenge({ config, onSuccess, onFail }: { config: RoomConfigData; onSuccess: (submission: string) => void; onFail: () => void }) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'HEIST_SUCCESS') {
        onSuccess("SIGN_LANGUAGE_SUCCESS");
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
      <ManualAnswerFallback onSubmit={onSuccess} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: Music Room (Turing Test)
// ---------------------------------------------------------------------------

const AUDIO_FILES = [
  'ElevenLabs_2026-08-17T18_59_11_Arvi – Desi Conversational Voice_pvc_s50_m2.mp3',
  'ElevenLabs_2026-08-17T19_02_05_Monika Sogam – Bored, Flat & Uninterested_pvc_sp84_s11_sb92_m2.mp3',
  'ElevenLabs_2026-08-18T14_46_46_Yatin – Serious Punjabi Friend_pvc_s50_m2.mp3',
  'ElevenLabs_2026-08-18T14_51_17_Sanchit K - Scared & Immersive_pvc_s50_m2.mp3',
  'ElevenLabs_2026-08-18T14_52_59_Parveen - Indian Male_pvc_s50_m2.mp3',
  'ElevenLabs_2026-08-18T14_55_18_Nikita - Encouraging, Clear and Serious_pvc_sp83_s73_sb75_m2.mp3'
]

function MusicRoomChallenge({ onSuccess, onFail }: { onSuccess: (submission: string) => void; onFail: () => void }) {
  const [choice, setChoice] = useState<'HUMAN' | 'AI' | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [audioSrc, setAudioSrc] = useState('')

  useEffect(() => {
    const randomAudio = AUDIO_FILES[Math.floor(Math.random() * AUDIO_FILES.length)]
    setAudioSrc(`/audio/${encodeURIComponent(randomAudio)}`)
  }, [])

  // Pass the selected choice to the parent for server-side validation
  const handleSubmit = () => {
    if (!choice) return
    setSubmitted(true)
    onSuccess(choice)
  }

  return (
    <div className="flex h-full gap-6 max-w-3xl mx-auto py-4">
      {/* Audio pane */}
      <div className="flex-1 border border-[#337DFF]/30 bg-[#0a0f1e] flex flex-col">
        <div className="border-b border-[#337DFF]/20 px-4 py-3 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
          <div className="font-mono text-[9px] text-[#669EFF] tracking-widest">GUARD FREQUENCY 7.4 MHz - LIVE</div>
        </div>
        
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-6">
          <div className="font-mono text-sm text-[#337DFF]/70 tracking-widest mb-4">
            PLAYING INTERCEPTED AUDIO
          </div>
          {audioSrc && (
            <audio controls src={audioSrc} className="w-full grayscale invert opacity-80" />
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
      <div className="w-52 border border-[#337DFF]/30 bg-[#0a0f1e] flex flex-col p-6 gap-6">
        <div>
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] opacity-70 mb-4">CLASSIFY ENTITY</div>
          <div className="space-y-3">
            {(['HUMAN', 'AI'] as const).map(opt => (
              <button
                key={opt}
                onClick={() => !submitted && setChoice(opt)}
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
        </div>

        <div className="mt-auto">
          <button
            onClick={handleSubmit}
            disabled={!choice || submitted}
            className="w-full bg-[#337DFF] py-3 font-mono text-xs font-bold text-white tracking-widest hover:bg-[#4488ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            CLASSIFY
          </button>
          <div className="font-mono text-[8px] text-[#337DFF]/30 tracking-widest text-center mt-3">
            ONE CLASSIFICATION<br />IRREVERSIBLE
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Challenge: H2 Lounge (Memory + Description)
// ---------------------------------------------------------------------------

function H2LoungeChallenge({ timerSeconds, onSuccess }: { timerSeconds: number; onSuccess: (submission?: string) => void }) {
  const [phase, setPhase] = useState<'loading' | 'viewing' | 'input' | 'generating' | 'done'>('loading')
  const [countdown, setCountdown] = useState(timerSeconds)
  const [images, setImages] = useState<{ left: string; right: string }>({ left: '', right: '' })
  const [prompts, setPrompts] = useState({ left: '', right: '' })
  const [generated, setGenerated] = useState<{ left: string; right: string }>({ left: '', right: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    gameApi.getMemoryImages().then(res => {
      if (res.success && res.left && res.right) {
        // Assume API returns absolute or relative paths
        setImages({ left: res.left.startsWith('http') ? res.left : `http://localhost:5000${res.left}`, right: res.right.startsWith('http') ? res.right : `http://localhost:5000${res.right}` })
        setCountdown(res.displaySeconds ?? timerSeconds)
        setPhase('viewing')
      } else {
        setError(res.error || 'Failed to load images')
        setPhase('input')
      }
    }).catch(err => {
      setError('Network error loading images')
      setPhase('input')
    })
  }, [timerSeconds])

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
          left: res.generatedLeft.startsWith('http') ? res.generatedLeft : `http://localhost:5000${res.generatedLeft}`,
          right: res.generatedRight.startsWith('http') ? res.generatedRight : `http://localhost:5000${res.generatedRight}`
        })
        setPhase('done')
      } else {
        setError(res.error || 'Failed to generate images')
        setPhase('input')
      }
    } catch (e) {
      setError('Network error during generation')
      setPhase('input')
    }
  }

  const handleValidate = () => {
    onSuccess() // Notify backend of success
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 max-w-4xl mx-auto">
      <div className="text-center">
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">TARGET ARTEFACTS - CLASSIFIED</div>
        <h3 className="text-xl font-bold text-white tracking-widest">MEMORISE AND RECONSTRUCT</h3>
      </div>

      {error && <div className="text-[#FF3333] font-mono text-xs">{error}</div>}

      {(phase === 'loading' || phase === 'input') && (
        <ManualAnswerFallback
          label="RECONSTRUCTION SERVICE UNAVAILABLE - DESCRIBE THE ARTEFACT DIRECTLY"
          onSubmit={onSuccess}
        />
      )}

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

      {phase === 'done' && (
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
          <button
            onClick={handleValidate}
            className="w-full border border-[#00FF88] bg-[#00FF88]/10 py-4 font-mono text-sm font-bold text-[#00FF88] tracking-[0.3em] hover:bg-[#00FF88]/20 transition-all active:scale-95"
          >
            SUBMIT FOR VERIFICATION
          </button>
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

function NoseDrawChallenge({ onSuccess, onFail }: { onSuccess: () => void; onFail: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const [sketchCode, setSketchCode] = useState('')

  const handleValidate = () => {
    if (confirmed && sketchCode.trim().length >= 3) onSuccess()
    else onFail()
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 max-w-lg mx-auto text-center">
      <div>
        <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.4em] opacity-70 mb-2">BIOMETRIC SKETCH VALIDATION</div>
        <h3 className="text-xl font-bold text-white tracking-widest">NOSE-DRAW SUBMISSION PORTAL</h3>
      </div>

      <div className="w-full border border-[#337DFF]/30 bg-[#0a0f1e] p-6">
        <div className="w-32 h-32 border-2 border-dashed border-[#337DFF]/30 rounded mx-auto mb-4 flex items-center justify-center">
          <div className="text-4xl opacity-30">👃</div>
        </div>
        <div className="font-mono text-xs text-[#aabddd] leading-relaxed">
          Present your physical nose-drawn sketch to the game master for validation scan.
        </div>
      </div>

      <div className="w-full space-y-4">
        <div>
          <label className="font-mono text-[9px] text-[#669EFF] tracking-[0.3em] block mb-2 text-left opacity-70">
            SKETCH VALIDATION CODE (from game master)
          </label>
          <input
            type="text"
            value={sketchCode}
            onChange={e => setSketchCode(e.target.value)}
            placeholder="ENTER CODE"
            className="w-full bg-[#0a0f1e] border border-[#337DFF]/40 px-4 py-3 font-mono text-sm text-white tracking-widest placeholder:text-[#337DFF]/25 focus:outline-none focus:border-[#337DFF] transition-colors text-center"
          />
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            onClick={() => setConfirmed(p => !p)}
            className="w-5 h-5 border flex items-center justify-center flex-shrink-0 transition-all"
            style={{
              borderColor: confirmed ? '#00FF88' : '#337DFF44',
              background: confirmed ? 'rgba(0,255,136,0.12)' : 'transparent',
            }}
          >
            {confirmed && <span className="text-[#00FF88] text-xs">✓</span>}
          </div>
          <span className="font-mono text-xs text-[#aabddd] text-left">
            I confirm my physical sketch matches the target profile
          </span>
        </label>
        <button
          onClick={handleValidate}
          disabled={!confirmed || sketchCode.trim().length < 3}
          className="w-full bg-[#337DFF] py-3 font-mono text-xs font-bold text-white tracking-[0.3em] hover:bg-[#4488ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95"
        >
          VALIDATE SKETCH
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Active challenge wrapper
// ---------------------------------------------------------------------------

function ActiveScreen({
  config,
  roomId,
  teamId,
  onSuccess,
  onFail,
}: {
  config: RoomConfigData
  roomId: RoomId
  teamId: string
  onSuccess: (opts: { submission?: string; elapsedSeconds?: number }) => void
  onFail: () => void
}) {
  return (
    <div className="fixed inset-0 flex flex-col z-10">
      {/* Header bar */}
      <div className="border-b border-[#337DFF]/20 px-8 py-3 flex items-center justify-between flex-shrink-0">
        <div>
          <div className="font-mono text-[9px] text-[#337DFF] tracking-[0.3em] opacity-70">OPERATIVE: {teamId}</div>
          <div className="font-mono text-xs text-white tracking-widest font-bold">{config.label}</div>
        </div>
        <div className="font-mono text-[9px] text-[#337DFF]/50 tracking-widest">
          {config.terminalId} - ACTIVE SESSION
        </div>
      </div>

      {/* Challenge area */}
      <div className="flex-1 px-8 py-6 overflow-hidden">
        {roomId === 'YOGA_ROOM' && (
          <YogaRoomChallenge
            roomId={roomId}
            timerSeconds={config.timerSeconds}
            onSuccess={elapsed => onSuccess({ elapsedSeconds: elapsed })}
            onManualSubmit={submission => onSuccess({ submission })}
          />
        )}
        {roomId === 'CTLC_LAB' && (
          <CTLCLabChallenge
            config={config}
            onSuccess={submission => onSuccess({ submission })}
            onFail={onFail}
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
          />
        )}
        {roomId === 'CLASSROOM_1101' && (
          <ClassroomChallenge
            onSuccess={submission => onSuccess({ submission })}
          />
        )}
        {roomId === 'NOSE_DRAW' && (
          <NoseDrawChallenge
            onSuccess={() => onSuccess({})}
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
  const [successPoints, setSuccessPoints] = useState(0)

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
    setSuccessPoints(0)
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
        setSuccessPoints(res.points ?? 0)
        setScreen('success')
      } else {
        const next = attemptsLeft - 1
        setAttemptsLeft(next)
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
      if (left <= 0 || res.lockout) setScreen('lockout')
      else setScreen('resolution')
    } catch {
      const next = attemptsLeft - 1
      setAttemptsLeft(next)
      if (next <= 0) setScreen('lockout')
      else setScreen('resolution')
    }
  }

  // Loading / error fallback
  if (configError) {
    return (
      <div className="fixed inset-0 bg-[#000307] flex items-center justify-center">
        <div className="text-center">
          <div className="font-mono text-[#FF3333] tracking-widest mb-4">BACKEND OFFLINE</div>
          <div className="font-mono text-xs text-[#669EFF]/60">
            Start the backend server at localhost:5000 then refresh.
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
        />
      )}

      {screen === 'resolution' && (
        <ResolutionScreen
          success={false}
          clue={successClue}
          points={successPoints}
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
          points={successPoints}
          teamId={teamId}
          terminalId={terminalId}
          attemptsLeft={attemptsLeft}
          maxAttempts={maxAttempts}
          onRetry={() => setScreen('briefing')}
          onReset={reset}
        />
      )}

      {screen === 'lockout' && (
        <ResolutionScreen
          success={false}
          clue=""
          points={0}
          teamId={teamId}
          terminalId={terminalId}
          attemptsLeft={0}
          maxAttempts={maxAttempts}
          onRetry={() => {}}
          onReset={reset}
        />
      )}
    </div>
  )
}

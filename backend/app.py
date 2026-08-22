"""Flask ML service for the Louvre Heist.

Auth, riddles, route order, scoring and all timing live in Supabase. What is
left here is the work Supabase cannot do: torch and CLIP for the machine-graded
rooms, Cloudflare image generation, and launching the OpenCV pose game.

Crews authenticate with their Supabase JWT (see supabase_bridge.require_team_jwt),
and results are reported to Supabase with record_ml_result() so that every room
in the event is timed by the same clock.

Superseded endpoints - /api/config/*, /api/auth/*, /api/game/state,
/api/game/validate, /api/scores* - were removed; the frontend calls Supabase
directly for those. See SUPABASE_BACKEND.md.
"""

import os
import json
import uuid
import base64

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import requests as http_requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

from supabase_bridge import fetch_room_config, record_ml_result, require_team_jwt, team_code_from_token

# ---------------------------------------------------------------------------
# Load centralized settings
# ---------------------------------------------------------------------------

CONFIG_PATH = os.getenv("CONFIG_PATH", "config/game_settings.json")
_config_abs = os.path.join(os.path.dirname(__file__), CONFIG_PATH)
with open(_config_abs, "r", encoding="utf-8") as _f:
    GAME_SETTINGS: dict = json.load(_f)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "heist-fallback-key")

allowed_origins = GAME_SETTINGS["system"]["corsAllowedOrigins"]
CORS(
    app,
    resources={r"/api/*": {"origins": allowed_origins}},
    supports_credentials=True,
)

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

# Memory Forgery room (H2_LOUNGE): team_code -> {
#   round: current round number (1-based),
#   original_paths: {"left": path, "right": path} for the round in progress,
#   rounds: [{round, leftScore, rightScore, roundScore, passed}, ...] so far,
# }
# Keyed by team rather than by token: Supabase refreshes access tokens during a
# run, so the token is not a stable identifier for a crew.
IMAGE_SESSIONS: dict[str, dict] = {}

os.makedirs(os.path.join(os.path.dirname(__file__), "static", "generated"), exist_ok=True)
os.makedirs(os.path.join(os.path.dirname(__file__), "static", "images", "online"), exist_ok=True)

# ---------------------------------------------------------------------------
# Memory Forgery room tuning
# ---------------------------------------------------------------------------
# Three memorise-and-reconstruct rounds per attempt, two fresh online photos
# each (six photos total). A round passes at MEMORY_PASS_SCORE or above on
# scoring.compute_combined_score()'s 0-10 scale (CLIP content + SSIM structure
# + color histogram); the room passes once MEMORY_ROUND_MIN_PASSES rounds have
# cleared that bar. There is no rehearsal data to calibrate against yet -
# retune both constants after a dry run if crews are sailing through or
# nobody is passing.
MEMORY_TOTAL_ROUNDS = 3
MEMORY_PASS_SCORE = 5
MEMORY_ROUND_MIN_PASSES = 2

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def _room_timer_seconds(room_code: str, fallback: int) -> int:
    """Room timer from Supabase, falling back if the backend is unreachable."""
    try:
        return int(fetch_room_config(room_code)["timer_seconds"])
    except Exception:
        return fallback

# ---------------------------------------------------------------------------
# Routes - public
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "event": GAME_SETTINGS["system"]["eventName"]})





@app.route("/api/game/launch", methods=["POST"])
@require_team_jwt
def launch_game(team_id: str):
    """Deprecated for YOGA_ROOM: the pose game now streams into the kiosk page
    via /api/game/video_feed instead of spawning a native window (see below).
    Kept for any future room whose module genuinely needs its own OS process.
    """
    data = request.get_json(silent=True) or {}
    room_id = data.get("roomId", "")
    return jsonify({"success": False, "error": f"No external module configured for {room_id or 'this room'}."}), 400


@app.route("/api/game/video_feed", methods=["GET"])
def game_video_feed():
    """MJPEG stream of the live pose-tracking session, embedded via <img src=...>.

    An <img> tag cannot send an Authorization header, so the crew's token
    travels as a query parameter instead - the same JWT that would otherwise go
    in the header, verified the same way by require_team_jwt's underlying check.
    """
    token = request.args.get("token", "")
    room_id = request.args.get("roomId", "")
    if not token or not room_id:
        return jsonify({"success": False, "error": "token and roomId are required"}), 400

    try:
        team_code_from_token(token)
    except Exception as exc:
        return jsonify({"success": False, "error": f"Invalid token: {exc}"}), 401

    import sys as _sys
    script_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if script_dir not in _sys.path:
        _sys.path.insert(0, script_dir)
    from louvre_laser_game import stream_game_frames

    return app.response_class(
        stream_game_frames(token, room_id),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )

# ---------------------------------------------------------------------------
# Routes - machine-graded results
# ---------------------------------------------------------------------------

@app.route("/api/ml/report", methods=["POST"])
@require_team_jwt
def ml_report(team_id: str):
    """Report the outcome of a machine-graded room to Supabase.

    Used by the OpenCV pose game and the CLIP-scored rooms. Flask decides only
    pass/fail; Supabase stamps completed_at, awards the points and enforces the
    attempt limit, so a crew cannot be timed by a different clock in one room.
    """
    data = request.get_json(silent=True) or {}
    room_id = data.get("roomId", "")
    if not room_id:
        return jsonify({"success": False, "error": "roomId is required"}), 400

    passed = bool(data.get("passed", False))
    detail = data.get("detail") or {}
    if not isinstance(detail, dict):
        detail = {"value": detail}

    try:
        result = record_ml_result(team_id, room_id, passed, detail)
    except Exception as exc:
        return jsonify({"success": False, "error": f"Could not record result: {exc}"}), 502

    return jsonify(result)


# ---------------------------------------------------------------------------
# Routes - Memory-to-Image room (H2 Lounge) - image generation pipeline
# ---------------------------------------------------------------------------

def _fetch_random_online_photo(dest_path: str, timeout: int = 15) -> None:
    """Download one real, freely-licensed photo from Lorem Picsum.

    A fresh cache-busting query param on every call is required - picsum.photos
    caches by URL, so a repeated URL returns the same cached photo instead of a
    new random one.
    """
    url = f"https://picsum.photos/800/600?random={uuid.uuid4().hex}"
    resp = http_requests.get(url, timeout=timeout)
    resp.raise_for_status()
    with open(dest_path, "wb") as fh:
        fh.write(resp.content)


@app.route("/api/memory/images", methods=["POST"])
@require_team_jwt
def memory_images(team_id: str):
    """Fetch a fresh pair of random online photos for one memorise round.

    Three rounds per attempt (MEMORY_TOTAL_ROUNDS), two photos each - six
    freshly-sourced photos in total, never reused within a session. Round 1
    starts a new session and discards any previous one; the crew's browser
    drives which round this is, same as every other multi-step room here.
    """
    data = request.get_json(silent=True) or {}
    round_num = data.get("round", 1)
    if not isinstance(round_num, int) or not (1 <= round_num <= MEMORY_TOTAL_ROUNDS):
        return jsonify({"success": False, "error": f"round must be 1-{MEMORY_TOTAL_ROUNDS}"}), 400

    if round_num == 1:
        IMAGE_SESSIONS[team_id] = {"round": 1, "rounds": []}

    session = IMAGE_SESSIONS.get(team_id)
    if not session or len(session.get("rounds", [])) != round_num - 1:
        return jsonify({"success": False, "error": "Round out of sequence - start again from round 1"}), 400

    image_dir = os.path.join(os.path.dirname(__file__), "static", "images", "online")
    paths = {}
    try:
        for side in ("left", "right"):
            filename = f"{team_id}_{round_num}_{side}_{uuid.uuid4().hex[:8]}.jpg"
            dest = os.path.join(image_dir, filename)
            _fetch_random_online_photo(dest)
            paths[side] = dest
    except Exception as exc:
        return jsonify({"success": False, "error": f"Could not fetch a photo online: {exc}"}), 502

    session["round"] = round_num
    session["original_paths"] = paths

    return jsonify({
        "success": True,
        "left": f"/static/images/online/{os.path.basename(paths['left'])}",
        "right": f"/static/images/online/{os.path.basename(paths['right'])}",
        "round": round_num,
        "totalRounds": MEMORY_TOTAL_ROUNDS,
        # Read from Supabase so the timer is not maintained in two places.
        "displaySeconds": _room_timer_seconds("H2_LOUNGE", fallback=10),
    })


# ---------------------------------------------------------------------------
# Cloudflare Workers AI Pool & Failover
# ---------------------------------------------------------------------------

CF_KEY_POOL: list[dict[str, str]] = []
_CURRENT_CF_INDEX = 0


def _get_cf_key_pool() -> list[dict[str, str]]:
    global CF_KEY_POOL
    if CF_KEY_POOL:
        return CF_KEY_POOL

    pool: list[dict[str, str]] = []
    raw_accounts = os.getenv("CF_ACCOUNTS", "").strip()
    if raw_accounts:
        for pair in raw_accounts.split(","):
            if ":" in pair:
                acc_id, token = pair.split(":", 1)
                acc_id, token = acc_id.strip(), token.strip()
                if acc_id and token:
                    pool.append({"account_id": acc_id, "api_token": token})

    # Fallback to single CF_ACCOUNT_ID and CF_API_TOKEN
    if not pool:
        acc_id = os.getenv("CF_ACCOUNT_ID", "").strip()
        token = os.getenv("CF_API_TOKEN", "").strip()
        if acc_id and token:
            pool.append({"account_id": acc_id, "api_token": token})

    CF_KEY_POOL = pool
    return CF_KEY_POOL


def call_cloudflare_image_generation(prompt: str, timeout: int = 40) -> str:
    """Generate image via Cloudflare Workers AI with automatic failover between keys."""
    global _CURRENT_CF_INDEX
    pool = _get_cf_key_pool()
    if not pool:
        raise RuntimeError("No Cloudflare credentials available.")

    cf_model = "@cf/black-forest-labs/flux-1-schnell"
    total_keys = len(pool)
    last_error = "Unknown error"

    for attempt in range(total_keys):
        idx = (_CURRENT_CF_INDEX + attempt) % total_keys
        cred = pool[idx]
        acc_id = cred["account_id"]
        token = cred["api_token"]

        cf_url = f"https://api.cloudflare.com/client/v4/accounts/{acc_id}/ai/run/{cf_model}"
        cf_headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        try:
            print(f"[*] Cloudflare AI request using key index {idx} (Account: {acc_id[:8]}...)")
            resp = http_requests.post(cf_url, headers=cf_headers, json={"prompt": prompt}, timeout=timeout)

            if resp.status_code == 200:
                result = resp.json()
                img_b64 = None
                if isinstance(result.get("result"), dict):
                    img_b64 = result["result"].get("image")

                if img_b64:
                    _CURRENT_CF_INDEX = idx  # keep successful key as default
                    print(f"[*] Cloudflare image generated successfully on key index {idx}")
                    return img_b64

                last_error = f"Invalid response payload: {resp.text[:200]}"
                print(f"[!] Key {idx} returned 200 but missing image payload: {last_error}")
            else:
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                print(f"[!] Key {idx} failed with {last_error}")

        except http_requests.exceptions.Timeout:
            last_error = f"Timeout after {timeout}s"
            print(f"[!] Key {idx} timed out. Switching to next key...")
        except Exception as exc:
            last_error = str(exc)
            print(f"[!] Key {idx} error: {last_error}. Switching to next key...")

    raise RuntimeError(f"All {total_keys} Cloudflare keys failed. Last error: {last_error}")


@app.route("/api/memory/generate", methods=["POST"])
@require_team_jwt
def memory_generate(team_id: str):
    """Generate this round's reconstructions and grade them against the originals.

    Scores each side with scoring.compute_combined_score() (CLIP content + SSIM
    structure + color histogram, 0-10). A round passes at MEMORY_PASS_SCORE or
    above; the room passes once MEMORY_ROUND_MIN_PASSES rounds have. The CLIP
    model is imported lazily here, same reason the pose model is lazy in
    /api/game/video_feed: it should not slow down every other room's requests.
    """
    session = IMAGE_SESSIONS.get(team_id)
    if not session or "original_paths" not in session:
        return jsonify({"success": False, "error": "No active memory session - fetch images first"}), 400

    data = request.get_json(silent=True) or {}
    prompt_left = data.get("promptLeft", "").strip() or "a random abstract colorful image"
    prompt_right = data.get("promptRight", "").strip() or "a random abstract colorful image"

    generated = {}
    generated_paths = {}
    for side, prompt in [("left", prompt_left), ("right", prompt_right)]:
        try:
            img_b64 = call_cloudflare_image_generation(prompt=prompt, timeout=40)
            filename = f"{team_id}_{side}_{uuid.uuid4().hex[:6]}.png"
            save_path = os.path.join(os.path.dirname(__file__), "static", "generated", filename)
            with open(save_path, "wb") as fh:
                fh.write(base64.b64decode(img_b64))

            generated[side] = f"/static/generated/{filename}"
            generated_paths[side] = save_path
        except Exception as exc:
            return jsonify({"success": False, "error": f"Generation error ({side}): {str(exc)}"}), 502

    import scoring
    original_paths = session["original_paths"]
    left_score = scoring.compute_combined_score(original_paths["left"], generated_paths["left"])
    right_score = scoring.compute_combined_score(original_paths["right"], generated_paths["right"])
    round_score = round((left_score["score"] + right_score["score"]) / 2, 1)
    round_passed = round_score >= MEMORY_PASS_SCORE

    round_num = session["round"]
    session["rounds"].append({
        "round": round_num,
        "leftScore": left_score["score"],
        "rightScore": right_score["score"],
        "roundScore": round_score,
        "passed": round_passed,
    })

    response = {
        "success": True,
        "generatedLeft": generated["left"],
        "generatedRight": generated["right"],
        "round": round_num,
        "totalRounds": MEMORY_TOTAL_ROUNDS,
        "roundScore": round_score,
        "roundPassed": round_passed,
        "final": round_num >= MEMORY_TOTAL_ROUNDS,
    }

    if round_num >= MEMORY_TOTAL_ROUNDS:
        passes = sum(1 for r in session["rounds"] if r["passed"])
        overall_passed = passes >= MEMORY_ROUND_MIN_PASSES
        try:
            room_result = record_ml_result(
                team_id, "H2_LOUNGE", overall_passed,
                detail={"rounds": session["rounds"], "passes": passes},
            )
        except Exception as exc:
            return jsonify({"success": False, "error": f"Could not record result: {exc}"}), 502

        response["overallPassed"] = overall_passed
        response["passes"] = passes
        response["roomResult"] = room_result
        IMAGE_SESSIONS.pop(team_id, None)

    return jsonify(response)



# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 4000))
    host = os.getenv("HOST", "0.0.0.0")
    debug = os.getenv("FLASK_ENV", "development") == "development"
    print(f"[*] Heist backend starting on http://{host}:{port}")
    print(f"[*] Config: {CONFIG_PATH}")
    print(f"[*] CORS origins: {len(allowed_origins)} allowed")
    # threaded=True is required: the video stream route makes a loopback
    # POST back into this same process to report a win. On a single-threaded
    # dev server that self-call would block waiting for a worker that is the
    # one and only worker, currently busy serving the still-open stream.
    app.run(host=host, port=4000, debug=debug, threaded=True)

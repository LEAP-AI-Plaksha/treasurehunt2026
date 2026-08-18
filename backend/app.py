"""Unified Flask backend for the Louvre Heist game system.

Serves all room terminals running on separate frontend ports.
CORS is configured to accept requests from each terminal port defined in game_settings.json.
All game rules - credentials, attempt limits, timers, clues - are loaded from config/game_settings.json.
"""

import os
import json
import time
import uuid
import base64
import random
from datetime import datetime, timezone
from functools import wraps

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import requests as http_requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

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

# token -> { team_id, logged_in_at }
ACTIVE_SESSIONS: dict[str, dict] = {}

# "TEAM_ID__ROOM_ID" -> { attempts, completed, score }
GAME_STATE: dict[str, dict] = {}

# Memory-to-Image room: token -> { image_set, generated_left, generated_right }
IMAGE_SESSIONS: dict[str, dict] = {}

os.makedirs(os.path.join(os.path.dirname(__file__), "static", "generated"), exist_ok=True)

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def _valid_teams() -> dict[str, str]:
    """Return mapping of teamId -> passcode from config."""
    return {t["teamId"]: t["passcode"] for t in GAME_SETTINGS["auth"]["teams"]}


def require_auth(f):
    """Decorator that validates the Bearer token and injects team_id."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"success": False, "error": "Missing authorization token"}), 401
        token = auth_header.split(" ", 1)[1].strip()
        session = ACTIVE_SESSIONS.get(token)
        if session is None:
            return jsonify({"success": False, "error": "Invalid or expired token"}), 401
        return f(session["team_id"], *args, **kwargs)
    return decorated

# ---------------------------------------------------------------------------
# Routes - public
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "event": GAME_SETTINGS["system"]["eventName"]})


@app.route("/api/config/<room_id>", methods=["GET"])
def get_room_config(room_id: str):
    """Serve public room metadata - narrative text, timers, points.
    The correct answer is never sent to the client.
    """
    room = GAME_SETTINGS["rooms"].get(room_id)
    if not room:
        return jsonify({"success": False, "error": "Room not found"}), 404

    return jsonify({
        "success": True,
        "data": {
            "terminalId":   room["terminalId"],
            "label":        room["label"],
            "coordinates":  room["coordinates"],
            "briefing":     room["briefing"],
            "hint":         room["hint"],
            "points":       room["points"],
            "timerSeconds": room["timerSeconds"],
            "maxAttempts":  room.get("maxAttempts", GAME_SETTINGS["system"]["globalMaxAttempts"]),
        },
    })


@app.route("/api/config/rooms", methods=["GET"])
def list_rooms():
    """Return the list of room IDs and their ports for discovery."""
    rooms_summary = {
        room_id: {"port": cfg["port"], "label": cfg["label"], "terminalId": cfg["terminalId"]}
        for room_id, cfg in GAME_SETTINGS["rooms"].items()
    }
    return jsonify({"success": True, "rooms": rooms_summary})

# ---------------------------------------------------------------------------
# Routes - auth
# ---------------------------------------------------------------------------

@app.route("/api/auth/login", methods=["POST"])
def team_login():
    """Authenticate team credentials and issue a session token."""
    data = request.get_json(silent=True) or {}
    team_id = data.get("teamId", "").strip().upper()
    passcode = data.get("passcode", "").strip()

    valid = _valid_teams()
    if team_id not in valid or valid[team_id] != passcode:
        return jsonify({"success": False, "error": "Invalid Team ID or password"}), 401

    token = f"heist_{team_id}_{uuid.uuid4().hex[:12]}"
    ACTIVE_SESSIONS[token] = {
        "team_id": team_id,
        "logged_in_at": datetime.now(timezone.utc).isoformat(),
    }

    return jsonify({
        "success": True,
        "token": token,
        "teamId": team_id,
        "message": f"Authentication granted. Welcome, {team_id}.",
    })


@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def team_logout(team_id: str):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.split(" ", 1)[1].strip()
    ACTIVE_SESSIONS.pop(token, None)
    return jsonify({"success": True})

# ---------------------------------------------------------------------------
# Routes - game state
# ---------------------------------------------------------------------------

@app.route("/api/game/state/<room_id>", methods=["GET"])
@require_auth
def get_game_state(team_id: str, room_id: str):
    """Return current attempt count and completion status for this team/room."""
    room = GAME_SETTINGS["rooms"].get(room_id)
    if not room:
        return jsonify({"success": False, "error": "Room not found"}), 404

    key = f"{team_id}__{room_id}"
    state = GAME_STATE.get(key, {"attempts": 0, "completed": False, "score": 0})
    max_attempts = room.get("maxAttempts", GAME_SETTINGS["system"]["globalMaxAttempts"])

    return jsonify({
        "success": True,
        "attempts": state["attempts"],
        "attemptsRemaining": max(0, max_attempts - state["attempts"]),
        "completed": state["completed"],
        "score": state["score"],
        "lockout": state["attempts"] >= max_attempts and not state["completed"],
    })


@app.route("/api/game/validate", methods=["POST"])
@require_auth
def validate_task(team_id: str):
    """Validate puzzle answer or hold-timer for the specified room.

    Body:
      roomId          - room identifier string
      submission      - text answer (optional, used for answer-based rooms)
      elapsedSeconds  - float, used for timer-based rooms
    """
    data = request.get_json(silent=True) or {}
    room_id = data.get("roomId", "")
    submission = data.get("submission", "")
    elapsed = float(data.get("elapsedSeconds", 0))

    room = GAME_SETTINGS["rooms"].get(room_id)
    if not room:
        return jsonify({"success": False, "error": "Invalid room"}), 400

    key = f"{team_id}__{room_id}"
    state = GAME_STATE.setdefault(key, {"attempts": 0, "completed": False, "score": 0})

    # Already cleared
    if state["completed"]:
        return jsonify({
            "success": True,
            "completed": True,
            "message": "Room already cleared.",
            "clue": room["successClue"],
        })

    max_attempts = room.get("maxAttempts", GAME_SETTINGS["system"]["globalMaxAttempts"])

    # Lockout check
    if state["attempts"] >= max_attempts:
        return jsonify({
            "success": False,
            "lockout": True,
            "error": "Maximum attempts exceeded. Terminal locked.",
        }), 403

    state["attempts"] += 1

    # Validation logic
    correct_answer = room.get("correctAnswer")
    is_success = False

    if correct_answer is None:
        # Timer-based or open-input rooms (Yoga Room, H2 Lounge, Nose Draw)
        target = float(room["timerSeconds"])
        if elapsed >= target - 0.5:
            is_success = True
        elif len(str(submission).strip()) >= 10:
            # H2 Lounge / Nose Draw: accept non-empty description
            is_success = True
    else:
        # Exact match (case-insensitive, stripped)
        is_success = str(submission).strip().upper() == str(correct_answer).strip().upper()

    if is_success:
        state["completed"] = True
        state["score"] = room["points"]
        return jsonify({
            "success": True,
            "completed": True,
            "points": room["points"],
            "clue": room["successClue"],
            "message": "Bypass verified. Security protocol unlocked.",
        })

    remaining = max_attempts - state["attempts"]
    return jsonify({
        "success": False,
        "completed": False,
        "attemptsRemaining": remaining,
        "lockout": remaining <= 0,
        "error": f"Verification failed. {remaining} attempt(s) remaining.",
    }), 400


@app.route("/api/game/launch", methods=["POST"])
@require_auth
def launch_game(team_id: str):
    """Launch an external python game script (like the OpenCV laser grid)."""
    import subprocess, sys
    data = request.get_json(silent=True) or {}
    room_id = data.get("roomId", "")
    
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.split(" ", 1)[1].strip()

    if room_id == "YOGA_ROOM":
        script_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        script_path = os.path.join(script_dir, "louvre_laser_game (1).py")
        subprocess.Popen([sys.executable, script_path, token, room_id], cwd=script_dir)
        return jsonify({"success": True, "message": "Laser grid module initialized."})
    
    return jsonify({"success": False, "error": "No external module configured for this room."}), 400

# ---------------------------------------------------------------------------
# Routes - Memory-to-Image room (H2 Lounge) - image generation pipeline
# ---------------------------------------------------------------------------

@app.route("/api/memory/images", methods=["POST"])
@require_auth
def memory_images(team_id: str):
    """Pick a random image pair for the memory phase."""
    image_dir = os.path.join(os.path.dirname(__file__), "static", "images")
    if not os.path.exists(image_dir):
        return jsonify({"success": False, "error": "Image directory not found"}), 500

    exts = (".jpg", ".jpeg", ".png")
    pool = [
        f for f in os.listdir(image_dir)
        if f.lower().endswith(exts)
    ]
    if len(pool) < 2:
        return jsonify({"success": False, "error": "Need at least 2 images in static/images"}), 500

    pair = random.sample(pool, 2)
    image_set = {"left": pair[0], "right": pair[1]}

    auth_header = request.headers.get("Authorization", "")
    token = auth_header.split(" ", 1)[1].strip()
    IMAGE_SESSIONS[token] = {"image_set": image_set}

    return jsonify({
        "success": True,
        "left": f"/static/images/{pair[0]}",
        "right": f"/static/images/{pair[1]}",
        "displaySeconds": GAME_SETTINGS["rooms"]["H2_LOUNGE"]["timerSeconds"],
    })


@app.route("/api/memory/generate", methods=["POST"])
@require_auth
def memory_generate(team_id: str):
    """Generate images from team descriptions using Cloudflare Workers AI."""
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.split(" ", 1)[1].strip()

    session = IMAGE_SESSIONS.get(token)
    if not session:
        return jsonify({"success": False, "error": "No active memory session"}), 400

    data = request.get_json(silent=True) or {}
    prompt_left = data.get("promptLeft", "").strip() or "a random abstract colorful image"
    prompt_right = data.get("promptRight", "").strip() or "a random abstract colorful image"

    cf_account_id = os.getenv("CF_ACCOUNT_ID", "")
    cf_api_token = os.getenv("CF_API_TOKEN", "")
    cf_model = "@cf/black-forest-labs/flux-1-schnell"

    if not cf_account_id or not cf_api_token:
        return jsonify({"success": False, "error": "Cloudflare credentials not configured"}), 503

    cf_url = f"https://api.cloudflare.com/client/v4/accounts/{cf_account_id}/ai/run/{cf_model}"
    cf_headers = {
        "Authorization": f"Bearer {cf_api_token}",
        "Content-Type": "application/json",
    }

    generated = {}
    for side, prompt in [("left", prompt_left), ("right", prompt_right)]:
        try:
            resp = http_requests.post(cf_url, headers=cf_headers, json={"prompt": prompt}, timeout=60)
            if resp.status_code != 200:
                return jsonify({"success": False, "error": f"Generation failed for {side}: {resp.text[:300]}"}), 502

            result = resp.json()
            img_b64 = None
            if isinstance(result.get("result"), dict):
                img_b64 = result["result"].get("image")
            if not img_b64:
                return jsonify({"success": False, "error": f"No image data for {side}"}), 502

            filename = f"{token}_{side}.png"
            save_path = os.path.join(os.path.dirname(__file__), "static", "generated", filename)
            with open(save_path, "wb") as fh:
                fh.write(base64.b64decode(img_b64))

            generated[side] = f"/static/generated/{filename}"
        except Exception as exc:
            return jsonify({"success": False, "error": f"Generation error ({side}): {str(exc)}"}), 502

    session["generated_left"] = generated["left"]
    session["generated_right"] = generated["right"]

    return jsonify({"success": True, "generatedLeft": generated["left"], "generatedRight": generated["right"]})


# ---------------------------------------------------------------------------
# Routes - leaderboard / scores
# ---------------------------------------------------------------------------

SCORES_FILE = os.path.join(os.path.dirname(__file__), "scores.json")


def _load_scores() -> list:
    if not os.path.exists(SCORES_FILE):
        return []
    try:
        with open(SCORES_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []


def _save_scores(scores: list) -> None:
    with open(SCORES_FILE, "w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2, ensure_ascii=False)


@app.route("/api/scores", methods=["GET"])
def get_scores():
    """Return all team scores for the leaderboard."""
    return jsonify(_load_scores())


@app.route("/api/scores/summary", methods=["GET"])
def get_score_summary():
    """Return aggregated per-team scores across all rooms."""
    summary: dict[str, int] = {}
    for team_room_key, state in GAME_STATE.items():
        if state["completed"]:
            team_id = team_room_key.split("__")[0]
            summary[team_id] = summary.get(team_id, 0) + state["score"]
    ranked = sorted(summary.items(), key=lambda x: x[1], reverse=True)
    return jsonify([{"teamId": tid, "totalScore": score} for tid, score in ranked])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    host = os.getenv("HOST", "0.0.0.0")
    debug = os.getenv("FLASK_ENV", "development") == "development"
    print(f"[*] Heist backend starting on http://{host}:{port}")
    print(f"[*] Config: {CONFIG_PATH}")
    print(f"[*] CORS origins: {len(allowed_origins)} allowed")
    app.run(host=host, port=port, debug=debug)

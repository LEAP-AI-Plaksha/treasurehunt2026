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

from supabase_bridge import fetch_room_config, record_ml_result, require_team_jwt

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

# Memory-to-Image room: team_code -> { image_set, generated_left, generated_right }
# Keyed by team rather than by token: Supabase refreshes access tokens during a
# run, so the token is not a stable identifier for a crew.
IMAGE_SESSIONS: dict[str, dict] = {}

os.makedirs(os.path.join(os.path.dirname(__file__), "static", "generated"), exist_ok=True)

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
    """Launch an external python game script (like the OpenCV laser grid)."""
    import subprocess, sys
    data = request.get_json(silent=True) or {}
    room_id = data.get("roomId", "")
    
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.split(" ", 1)[1].strip()

    if room_id == "YOGA_ROOM":
        script_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        script_path = os.path.join(script_dir, "louvre_laser_game.py")
        subprocess.Popen([sys.executable, script_path, token, room_id], cwd=script_dir)
        return jsonify({"success": True, "message": "Laser grid module initialized."})
    
    return jsonify({"success": False, "error": "No external module configured for this room."}), 400

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

@app.route("/api/memory/images", methods=["POST"])
@require_team_jwt
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

    IMAGE_SESSIONS[team_id] = {"image_set": image_set}

    return jsonify({
        "success": True,
        "left": f"/static/images/{pair[0]}",
        "right": f"/static/images/{pair[1]}",
        # Read from Supabase so the timer is not maintained in two places.
        "displaySeconds": _room_timer_seconds("H2_LOUNGE", fallback=10),
    })


@app.route("/api/memory/generate", methods=["POST"])
@require_team_jwt
def memory_generate(team_id: str):
    """Generate images from team descriptions using Cloudflare Workers AI."""
    session = IMAGE_SESSIONS.get(team_id)
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
